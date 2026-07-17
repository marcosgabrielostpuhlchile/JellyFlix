import WebTorrent from 'webtorrent';
import path from 'path';
import { fileURLToPath } from 'url';

// Calcular caminhos absolutos para ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let client = null;

// Inicializa a instância única (Singleton) do WebTorrent
export function getClient() {
  if (!client) {
    client = new WebTorrent({
      maxConns: 55, // Limite de conexões para evitar sobrecarga
    });
  }
  return client;
}

// Adiciona um link magnet e aguarda o carregamento dos metadados
export async function addTorrent(magnetUrl, timeoutMs = 15000) {
  const wt = getClient();
  
  // Extrai o infoHash do magnet para verificar se já existe no cliente
  let infoHash = null;
  try {
    const match = magnetUrl.match(/xt=urn:btih:([a-fA-F0-9]+)/i) || magnetUrl.match(/xt=urn:btih:([2-7a-zA-Z]+)/i);
    if (match) {
      infoHash = match[1].toLowerCase();
    }
  } catch (e) {
    console.error('Erro ao parsear magnet link:', e);
  }

  // Se o torrent já estiver no cliente, retorna-o imediatamente
  // Se o torrent já estiver no cliente, aguarda a resolução dos metadados caso ainda não estejam prontos
  if (infoHash) {
    try {
      const existing = await wt.get(infoHash);
      if (existing) {
        if (existing.metadata) {
          return existing;
        }
        // Se existe mas ainda está conectando, espera pelo evento 'metadata'
        return new Promise((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            if (!existing.metadata) {
              reject(new Error('Tempo limite esgotado para obter metadados do Torrent (Sem peers/seeders ativos).'));
            }
          }, timeoutMs);

          existing.once('metadata', () => {
            clearTimeout(timeoutId);
            resolve(existing);
          });

          existing.once('error', (err) => {
            clearTimeout(timeoutId);
            reject(err);
          });
        });
      }
    } catch (err) {
      console.log('[WebTorrent] Erro ao recuperar torrent existente:', err.message);
    }
  }

  return new Promise((resolve, reject) => {
    try {
      const cachePath = path.resolve(__dirname, 'cache');
      const torrent = wt.add(magnetUrl, { path: cachePath });

      // Se os metadados já estiverem prontos, resolve
      if (torrent.metadata) {
        return resolve(torrent);
      }

      // Responder ao cliente após o timeout para não travar a requisição, mas mantendo a conexão ativa em background
      const timeoutId = setTimeout(() => {
        if (!torrent.metadata) {
          reject(new Error('Tempo limite esgotado para obter metadados do Torrent (Sem peers/seeders ativos).'));
        }
      }, timeoutMs);

      torrent.once('metadata', () => {
        clearTimeout(timeoutId);
        resolve(torrent);
      });

      torrent.once('error', (err) => {
        clearTimeout(timeoutId);
        try {
          torrent.destroy();
        } catch (e) {}
        reject(err);
      });
    } catch (e) {
      reject(e);
    }
  });
}

// Recupera um torrent ativo no cliente pelo infoHash
export async function getTorrent(infoHash) {
  const wt = getClient();
  return await wt.get(infoHash.toLowerCase());
}
