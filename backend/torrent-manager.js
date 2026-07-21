import WebTorrent from 'webtorrent';
import path from 'path';
import { fileURLToPath } from 'url';

// Calcular caminhos absolutos para ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let client = null;

// Lista de trackers públicos de alta disponibilidade para acelerar conexões P2P e resgatar magnet links sem trackers integrados
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:80/announce',
  'http://tracker.opentrackr.org:1337/announce',
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.files.fm:7072/announce'
];

// Inicializa a instância única (Singleton) do WebTorrent
export function getClient() {
  if (!client) {
    client = new WebTorrent({
      maxConns: 60, // Limite de conexões otimizado
    });
  }
  return client;
}

// Corrige erros comuns em URLs de magnet (ex: /anunciar em vez de /announce)
function sanitizeMagnetUrl(magnetUrl) {
  if (!magnetUrl) return magnetUrl;
  return magnetUrl.replace(/\/anunciar\b/gi, '/announce');
}

// Extrai o infoHash em formato hex de 40 caracteres ou string base32 do magnet link
function extractInfoHash(magnetUrl) {
  try {
    const match = magnetUrl.match(/xt=urn:btih:([a-fA-F0-9]{40})/i) || magnetUrl.match(/xt=urn:btih:([a-fA-F0-9]{32})/i) || magnetUrl.match(/xt=urn:btih:([2-7a-zA-Z]{32})/i);
    if (match) {
      return match[1].toLowerCase();
    }
  } catch (e) {
    console.error('Erro ao parsear magnet link:', e);
  }
  return null;
}

// Helper interno para verificar se o objeto Torrent tem metadados/arquivos carregados
function isTorrentReady(t) {
  if (!t) return false;
  return Boolean(t.ready || (t.files && t.files.length > 0));
}

// Adiciona um link magnet e aguarda o carregamento dos metadados
export async function addTorrent(rawMagnetUrl, timeoutMs = 25000) {
  const wt = getClient();
  const magnetUrl = sanitizeMagnetUrl(rawMagnetUrl);
  const infoHash = extractInfoHash(magnetUrl);

  // 1. Se o torrent já estiver no cliente, recupera e verifica se já está pronto
  if (infoHash) {
    try {
      const existing = (await wt.get(infoHash)) || (await wt.get(magnetUrl)) || wt.torrents.find(t => 
        (t.infoHash && t.infoHash.toLowerCase() === infoHash) || t.magnetURI === magnetUrl
      );

      if (existing) {
        if (isTorrentReady(existing)) {
          return existing;
        }

        // Se existe mas ainda está carregando metadados, aguarda eventos 'ready' ou 'metadata'
        return new Promise((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            if (!isTorrentReady(existing)) {
              reject(new Error('Tempo limite esgotado para obter metadados do Torrent (Sem peers/seeders ativos).'));
            } else {
              resolve(existing);
            }
          }, timeoutMs);

          const onReady = () => {
            clearTimeout(timeoutId);
            resolve(existing);
          };

          existing.once('ready', onReady);
          existing.once('metadata', onReady);

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

  // Helper interno para verificar se o objeto Torrent tem metadados/arquivos carregados
  function setupTorrentOnDemand(t) {
    if (!t) return;
    try {
      if (t.deselect && t.pieces) {
        // Cancela o download completo automático de todos os arquivos em segundo plano.
        // O WebTorrent passará a baixar APENAS os trechos de vídeo solicitados pelo player em tempo real.
        t.deselect(0, t.pieces.length - 1, 0);
      }
    } catch (e) {}
  }

  // 2. Se o torrent não existe no cliente, adiciona com a lista expandida de trackers e deselect: true
  return new Promise(async (resolve, reject) => {
    try {
      const cachePath = path.resolve(__dirname, 'cache');
      const torrent = wt.add(magnetUrl, { 
        path: cachePath,
        announce: DEFAULT_TRACKERS,
        deselect: true // Não pré-baixa os arquivos inteiros em segundo plano
      });

      if (isTorrentReady(torrent)) {
        setupTorrentOnDemand(torrent);
        return resolve(torrent);
      }

      const timeoutId = setTimeout(() => {
        if (!isTorrentReady(torrent)) {
          reject(new Error('Tempo limite esgotado para obter metadados do Torrent (Sem peers/seeders ativos).'));
        } else {
          setupTorrentOnDemand(torrent);
          resolve(torrent);
        }
      }, timeoutMs);

      const onReady = () => {
        clearTimeout(timeoutId);
        setupTorrentOnDemand(torrent);
        resolve(torrent);
      };

      torrent.once('ready', onReady);
      torrent.once('metadata', onReady);

      torrent.once('error', (err) => {
        clearTimeout(timeoutId);
        try {
          torrent.destroy();
        } catch (e) {}
        reject(err);
      });
    } catch (e) {
      // Trata exceção síncrona de duplicata (caso o WebTorrent recuse adicionar novamente)
      if (e.message && e.message.includes('duplicate')) {
        const dup = (await wt.get(infoHash)) || (await wt.get(magnetUrl)) || wt.torrents.find(t => 
          (t.infoHash && t.infoHash.toLowerCase() === infoHash) || t.magnetURI === magnetUrl
        );
        if (dup) {
          setupTorrentOnDemand(dup);
          if (isTorrentReady(dup)) {
            return resolve(dup);
          }
          dup.once('ready', () => {
            setupTorrentOnDemand(dup);
            resolve(dup);
          });
          dup.once('metadata', () => {
            setupTorrentOnDemand(dup);
            resolve(dup);
          });
          return;
        }
      }
      reject(e);
    }
  });
}

// Recupera um torrent ativo no cliente pelo infoHash
export async function getTorrent(infoHash) {
  const wt = getClient();
  if (!infoHash) return null;
  const hash = infoHash.toLowerCase();
  return (await wt.get(hash)) || wt.torrents.find(t => t.infoHash && t.infoHash.toLowerCase() === hash);
}

