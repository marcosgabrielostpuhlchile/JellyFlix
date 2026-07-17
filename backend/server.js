import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Importa e inicializa o banco de dados SQLite
import db from './db.js';
import { initExposure } from './exposure-manager.js';

// Importa as rotas (incluindo extensão .js obrigatória no ESM)
import { router as authRouter } from './routes/auth.js';
import mediaRouter from './routes/media.js';
import streamRouter from './routes/stream.js';

dotenv.config();

// Captura erros globais de fluxo para evitar queda do processo do servidor
process.on('uncaughtException', (err) => {
  console.error('[Servidor - Alerta] Erro não capturado (Uncaught Exception):', err.message || err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Servidor - Alerta] Rejeição de Promise não tratada:', reason.message || reason || 'Desconhecida');
});

// Calcular caminhos absolutos para ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(express.json());

// Servir arquivos estáticos do frontend
app.use(express.static(path.join(__dirname, '../frontend')));

// Registro de rotas da API
app.use('/api/auth', authRouter);
app.use('/api/media', mediaRouter);
app.use('/api/stream', streamRouter);

// SPA Fallback: Qualquer rota não reconhecida serve o index.html do frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Inicia o Servidor Express
app.listen(PORT, async () => {
  console.log(`==================================================`);
  console.log(`  JeelyFlix Backend rodando na porta ${PORT}`);
  console.log(`  Acesse em: http://localhost:${PORT}`);
  console.log(`==================================================`);

  // Inicializa o modo de exposição configurado (localhost, tailscale, ngrok)
  try {
    await initExposure();
  } catch (err) {
    console.error('[Exposure] Erro ao inicializar exposição no startup:', err.message);
  }
});
