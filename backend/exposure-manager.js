import { spawn } from 'child_process';
import os from 'os';
import axios from 'axios';
import db from './db.js';

let ngrokProcess = null;
let currentNgrokUrl = null;

// Função para buscar o IP do Tailscale nas interfaces de rede
export function getTailscaleIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      // O bloco de IPs do Tailscale fica na faixa CGNAT 100.64.0.0/10
      if (net.family === 'IPv4' && net.address.startsWith('100.')) {
        return net.address;
      }
    }
  }
  return null;
}

// Função para parar o túnel do ngrok se estiver rodando
export function stopNgrok() {
  if (ngrokProcess) {
    try {
      ngrokProcess.kill();
      console.log('[Exposure] Túnel ngrok encerrado com sucesso.');
    } catch (e) {
      console.error('[Exposure] Erro ao encerrar ngrok:', e.message);
    }
    ngrokProcess = null;
  }
  currentNgrokUrl = null;
}

// Função interna para iniciar o processo ngrok e pegar a URL
function launchNgrokTunnel(resolve, reject) {
  try {
    // Inicia o túnel ngrok na porta 3000
    ngrokProcess = spawn('ngrok', ['http', '3000']);

    // Aguarda 3.5 segundos para o ngrok abrir o túnel e liberar a API local
    setTimeout(async () => {
      try {
        const response = await axios.get('http://127.0.0.1:4040/api/tunnels');
        const tunnels = response.data.tunnels;
        if (tunnels && tunnels.length > 0) {
          // Prioriza o túnel HTTPS se existir
          const httpsTunnel = tunnels.find(t => t.proto === 'https');
          currentNgrokUrl = httpsTunnel ? httpsTunnel.public_url : tunnels[0].public_url;
          console.log('[Exposure] Túnel ngrok ativado com sucesso:', currentNgrokUrl);
          resolve(currentNgrokUrl);
        } else {
          reject(new Error('Nenhum túnel ativo foi retornado pela API local do ngrok.'));
        }
      } catch (err) {
        reject(new Error('Não foi possível obter a URL pública da API do ngrok. Verifique se o ngrok está instalado globalmente e no seu PATH do sistema.'));
      }
    }, 3500);

    ngrokProcess.on('error', (err) => {
      console.error('[Exposure] Falha ao iniciar o ngrok CLI:', err.message);
      reject(new Error('O executável do ngrok não foi encontrado no sistema. Verifique se adicionou o ngrok ao PATH do Windows.'));
    });

  } catch (e) {
    reject(e);
  }
}

// Inicia o túnel do ngrok
export async function startNgrok(authToken = null) {
  stopNgrok();

  return new Promise((resolve, reject) => {
    console.log('[Exposure] Iniciando túnel ngrok...');
    
    // Se o usuário passou um token, configura-o antes no CLI
    if (authToken && authToken.trim()) {
      try {
        const configProc = spawn('ngrok', ['config', 'add-authtoken', authToken.trim()]);
        configProc.on('close', (code) => {
          launchNgrokTunnel(resolve, reject);
        });
        configProc.on('error', (err) => {
          // Se falhou ao configurar token mas o ngrok existe, tenta rodar direto
          launchNgrokTunnel(resolve, reject);
        });
        return;
      } catch (e) {
        console.error('[Exposure] Erro ao rodar comando de token do ngrok:', e.message);
      }
    }

    launchNgrokTunnel(resolve, reject);
  });
}

// Inicializa o modo de exposição gravado no banco na inicialização do servidor
export async function initExposure() {
  const typeRow = db.prepare("SELECT value FROM settings WHERE key = 'exposure_type'").get();
  const type = typeRow ? typeRow.value : 'localhost';

  console.log(`[Exposure] Inicializando modo de exposição padrão: ${type.toUpperCase()}`);

  if (type === 'ngrok') {
    const tokenRow = db.prepare("SELECT value FROM settings WHERE key = 'ngrok_token'").get();
    const token = tokenRow ? tokenRow.value : null;
    try {
      await startNgrok(token);
    } catch (e) {
      console.error('[Exposure] Falha na inicialização automática do ngrok:', e.message);
    }
  }
}

export function getNgrokUrl() {
  return currentNgrokUrl;
}
