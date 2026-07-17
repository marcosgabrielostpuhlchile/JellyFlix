import express from 'express';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
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

  const noTranscode = req.query.noTranscode === 'true';
  const audioTrackIdx = req.query.audioTrack;
  const transcodeRow = db.prepare("SELECT value FROM settings WHERE key = 'transcode_audio'").get();
  const transcodeEnabled = transcodeRow && transcodeRow.value === '1';

  try {
    const magnet = db.prepare('SELECT * FROM magnets WHERE id = ?').get(id);
    if (!magnet) {
      return res.status(404).json({ error: 'Magnet não cadastrado.' });
    }

    // Se a transcodificação estiver ativa e houver uma faixa de áudio selecionada (e não for a chamada interna do FFmpeg)
    if (!noTranscode && transcodeEnabled && audioTrackIdx !== undefined) {
      const audioIdx = parseInt(audioTrackIdx, 10);
      const startTime = parseFloat(req.query.startTime || 0);

      // Define a URL interna para o FFmpeg ler o stream direto (com noTranscode=true)
      const internalStreamUrl = `http://localhost:${process.env.PORT || 3000}/api/stream/${id}/${fileIndex}?noTranscode=true`;

      console.log(`[Transcode] Iniciando FFmpeg para áudio #${audioIdx} a partir de ${startTime}s...`);

      // Configura os cabeçalhos de resposta para streaming contínuo de MP4 fragmentado
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Transfer-Encoding': 'chunked',
        'Access-Control-Allow-Origin': '*'
      });

      // Spawna o FFmpeg usando o binário local do ffmpeg-static
      const ffmpegProcess = spawn(ffmpegPath, [
        '-ss', startTime.toString(), // Seek rápido na entrada
        '-i', internalStreamUrl,     // URL local de stream direto do torrent
        '-map', '0:v:0',              // Copia o primeiro stream de vídeo
        '-map', `0:a:${audioIdx}`,    // Mapeia a trilha de áudio selecionada
        '-c:v', 'copy',               // Copia vídeo sem processar (0% CPU de vídeo)
        '-c:a', 'aac',                // Transcodifica áudio para AAC
        '-b:a', '192k',               // Bitrate do áudio
        '-f', 'mp4',                  // Output em MP4 fragmentado
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        'pipe:1'                      // Saída via stdout
      ]);

      ffmpegProcess.stdout.pipe(res);

      let killed = false;
      const cleanup = () => {
        if (!killed) {
          killed = true;
          console.log('[Transcode] Encerrando processo do FFmpeg.');
          try {
            ffmpegProcess.kill('SIGKILL');
          } catch (e) {
            console.error('[Transcode] Erro ao matar FFmpeg:', e.message);
          }
        }
      };

      req.on('close', cleanup);
      res.on('finish', cleanup);
      ffmpegProcess.on('close', cleanup);

      ffmpegProcess.stderr.on('data', data => {
        const msg = data.toString();
        if (msg.includes('Error')) {
          console.error('[FFmpeg Error]', msg.trim());
        }
      });

      return;
    }

    // Lógica original de Direct Stream (Direct Play)
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

// ROTA PARA LEITURA E CONVERSÃO DE LEGENDAS (SRT para WebVTT)
router.get('/:id/:fileIndex/subtitles', async (req, res) => {
  const { id, fileIndex } = req.params;
  const idx = parseInt(fileIndex, 10);

  try {
    const magnet = db.prepare('SELECT * FROM magnets WHERE id = ?').get(id);
    if (!magnet) {
      return res.status(404).json({ error: 'Magnet não cadastrado.' });
    }

    const torrent = await addTorrent(magnet.magnet_url);
    const file = torrent.files[idx];
    if (!file) {
      return res.status(404).json({ error: 'Arquivo de legenda não encontrado.' });
    }

    // Lê o conteúdo do arquivo de legenda do torrent
    const stream = file.createReadStream();
    const chunks = [];
    
    stream.on('data', chunk => chunks.push(chunk));
    
    stream.on('end', () => {
      const buffer = Buffer.concat(chunks);
      
      // Decodifica de forma segura: tenta UTF-8 e se falhar (bytes inválidos) usa Windows-1252 (Latin1)
      let text = '';
      try {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        text = decoder.decode(buffer);
      } catch (e) {
        // Fallback para legendas em português codificadas em ANSI / Windows-1252
        const latinDecoder = new TextDecoder('windows-1252');
        text = latinDecoder.decode(buffer);
      }

      // Se for formato SRT, faz a conversão de timestamps para VTT na hora
      if (file.name.toLowerCase().endsWith('.srt')) {
        text = srtToVtt(text);
      }

      res.writeHead(200, {
        'Content-Type': 'text/vtt; charset=utf-8',
        'Access-Control-Allow-Origin': '*' // Evita bloqueio de CORS no navegador
      });
      res.end(text);
    });

    stream.on('error', err => {
      console.error('[Subtitle Stream] Erro no stream da legenda:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Erro ao ler arquivo de legenda: ' + err.message });
      }
    });

  } catch (err) {
    console.error('Erro ao carregar legenda do torrent:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Erro ao carregar legenda: ' + err.message });
    }
  }
});

function srtToVtt(srtText) {
  let vtt = 'WEBVTT\n\n';
  // Substitui as vírgulas por pontos nos timestamps (ex: 00:01:20,300 -> 00:01:20.300)
  const converted = srtText.replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2');
  vtt += converted;
  return vtt;
}

export default router;
