import express from 'express';
import db from '../db.js';
import { addTorrent } from '../torrent-manager.js';

const router = express.Router();

// Determina o tipo de mídia baseado na extensão do arquivo para que o player interprete corretamente
function getMimeType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  switch (ext) {
    case 'mp4': return 'video/mp4';
    case 'webm': return 'video/webm';
    case 'mkv': return 'video/x-matroska';
    case 'avi': return 'video/x-msvideo';
    case 'mov': return 'video/quicktime';
    default: return 'video/mp4'; // fallback padrão
  }
}

// ROTA DE STREAMING DO VÍDEO SELECIONADO
router.get('/:id/:fileIndex', async (req, res) => {
  const { id, fileIndex } = req.params;
  const idx = parseInt(fileIndex, 10);

  try {
    const magnet = db.prepare('SELECT * FROM magnets WHERE id = ?').get(id);
    if (!magnet) {
      return res.status(404).json({ error: 'Magnet não cadastrado.' });
    }

    // Carrega/Recupera o torrent no cliente WebTorrent
    const torrent = await addTorrent(magnet.magnet_url);
    const file = torrent.files[idx];
    
    if (!file) {
      return res.status(404).json({ error: 'Arquivo de vídeo não encontrado neste torrent.' });
    }

    const mimeType = getMimeType(file.name);
    const range = req.headers.range;

    // Se o navegador não enviou cabeçalho Range, transmite o arquivo completo
    if (!range) {
      res.writeHead(200, {
        'Content-Length': file.length,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes'
      });
      const stream = file.createReadStream();
      stream.on('error', (err) => {
        console.log('[Stream Info] Stream completo interrompido/fechado:', err.message);
      });
      stream.pipe(res);

      req.on('close', () => {
        stream.destroy();
      });
    } else {
      // Transmissão de fatia parcial (Range Request / HTTP 206)
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : file.length - 1;

      // Se a faixa solicitada for inválida
      if (start >= file.length || end >= file.length) {
        res.writeHead(416, {
          'Content-Range': `bytes */${file.length}`
        });
        return res.end();
      }

      const chunkSize = (end - start) + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${file.length}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mimeType
      });

      // Cria um stream de leitura limitado à faixa solicitada
      // WebTorrent automaticamente prioriza o download das partes solicitadas
      const stream = file.createReadStream({ start, end });
      stream.on('error', (err) => {
        console.log('[Stream Info] Stream parcial (range) interrompido/fechado:', err.message);
      });
      stream.pipe(res);

      // Fecha o fluxo e limpa buffers quando o usuário fecha ou pausa o player
      req.on('close', () => {
        stream.destroy();
      });
    }
  } catch (err) {
    console.error('Erro no streaming de torrent:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Falha crítica ao transmitir mídia: ' + err.message });
    }
  }
});

export default router;
