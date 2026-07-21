import express from 'express';
import fs from 'fs';
import path from 'path';
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
  const targetQuality = req.query.quality; // '1080p', '720p', '480p', '360p' ou 'original'
  const transcodeRow = db.prepare("SELECT value FROM settings WHERE key = 'transcode_audio'").get();

  try {
    const magnet = db.prepare('SELECT * FROM magnets WHERE id = ?').get(id);
    if (!magnet) {
      return res.status(404).json({ error: 'Magnet não cadastrado.' });
    }

    // Verifica se o arquivo é MKV/AVI/FLV/WMV (Formatos não suportados nativamente pelo HTML5 sem remux em MP4)
    let isNonNativeContainer = false;
    if (magnet.files) {
      try {
        const cached = JSON.parse(magnet.files);
        const videoFiles = Array.isArray(cached) ? cached : (cached.videoFiles || []);
        const fileMeta = videoFiles[idx] || videoFiles.find(f => f.index === idx);
        if (fileMeta && fileMeta.name) {
          const ext = path.extname(fileMeta.name).toLowerCase();
          if (ext === '.mkv' || ext === '.avi' || ext === '.flv' || ext === '.wmv' || ext === '.ts') {
            isNonNativeContainer = true;
          }
        }
      } catch (e) {}
    }

    const transcodeEnabled = (transcodeRow && transcodeRow.value === '1') || audioTrackIdx !== undefined || (targetQuality && targetQuality !== 'original') || isNonNativeContainer;

    // Se a transcodificação/remux estiver ativa e não for a chamada interna do FFmpeg
    if (!noTranscode && transcodeEnabled) {
      const startTime = parseFloat(req.query.startTime || 0);

      // Define a URL interna para o FFmpeg ler o stream direto (com noTranscode=true)
      const internalStreamUrl = `http://localhost:${process.env.PORT || 3000}/api/stream/${id}/${fileIndex}?noTranscode=true`;

      console.log(`[Transcode] Iniciando FFmpeg. Qualidade: ${targetQuality || 'Original'}, Faixa: ${audioTrackIdx !== undefined ? '#' + audioTrackIdx : 'padrão (0:a:0)'} a partir de ${startTime}s...`);

      // Configura os cabeçalhos de resposta para streaming contínuo de MP4 fragmentado
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Transfer-Encoding': 'chunked',
        'Access-Control-Allow-Origin': '*'
      });

      const ffmpegArgs = [
        '-ss', startTime.toString(), // Seek rápido na entrada
        '-i', internalStreamUrl,     // URL local de stream direto do torrent
        '-map', '0:v:0?',            // Copia o primeiro stream de vídeo (opcional se não houver vídeo)
      ];

      if (audioTrackIdx !== undefined) {
        const audioIdx = parseInt(audioTrackIdx, 10);
        ffmpegArgs.push('-map', `0:${audioIdx}?`); // Mapeia o stream absoluto correto
      } else {
        ffmpegArgs.push('-map', '0:a:0?'); // Fallback opcional para o primeiro áudio disponível (padrão)
      }

      // Configura escalonamento de vídeo conforme a qualidade selecionada
      if (targetQuality && targetQuality !== 'original') {
        let height = 720;
        let crf = 24;
        if (targetQuality === '1080p') { height = 1080; crf = 22; }
        else if (targetQuality === '720p') { height = 720; crf = 24; }
        else if (targetQuality === '480p') { height = 480; crf = 26; }
        else if (targetQuality === '360p') { height = 360; crf = 28; }

        ffmpegArgs.push(
          '-vf', `scale=-2:${height}`,
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-crf', crf.toString()
        );
      } else {
        ffmpegArgs.push('-c:v', 'copy'); // Copia vídeo sem reprocessar (0% CPU)
      }

      ffmpegArgs.push(
        '-c:a', 'aac',                // Transcodifica áudio para AAC
        '-b:a', '192k',               // Bitrate do áudio
        '-f', 'mp4',                  // Output em MP4 fragmentado
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        'pipe:1'                      // Saída via stdout
      );

      // Spawna o FFmpeg usando o binário local do ffmpeg-static
      const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs);

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

    // Lógica de Direct Stream (Verifica cache local em disco primeiro para resposta instantânea)
    let torrent;
    let localFilePath = null;
    let fileSize = 0;
    let fileName = '';

    // 1. Tenta verificar se o arquivo já foi baixado/salvo no disco local
    if (magnet.files) {
      try {
        const cached = JSON.parse(magnet.files);
        const videoFiles = Array.isArray(cached) ? cached : (cached.videoFiles || []);
        const fileMeta = videoFiles[idx] || videoFiles.find(f => f.index === idx);
        if (fileMeta) {
          const cacheDir = path.resolve(process.cwd(), 'cache');
          
          const possiblePaths = [
            path.join(cacheDir, fileMeta.path || ''),
            path.join(cacheDir, magnet.title || '', fileMeta.name || ''),
            path.join(cacheDir, fileMeta.name || '')
          ];

          for (const p of possiblePaths) {
            if (p && fs.existsSync(p)) {
              localFilePath = p;
              fileSize = fs.statSync(p).size;
              fileName = fileMeta.name || path.basename(p);
              console.log(`[Local Stream Instant] Servindo mídia do disco local: ${p}`);
              break;
            }
          }
        }
      } catch (e) {
        console.error('[Local Stream Check] Erro ao checar disco local:', e.message);
      }
    }

    // 2. Se o arquivo não está no disco local, conecta via WebTorrent P2P
    if (!localFilePath) {
      try {
        torrent = await addTorrent(magnet.magnet_url, 25000);
        const file = torrent.files[idx];
        if (!file) {
          return res.status(404).json({ error: 'Arquivo de vídeo não encontrado neste torrent.' });
        }
        fileSize = file.length;
        fileName = file.name;
      } catch (err) {
        // Tenta recuperar do cliente WebTorrent se já houver torrent instanciado
        const wt = (await import('../torrent-manager.js')).getClient();
        const infoHash = magnet.info_hash ? magnet.info_hash.toLowerCase() : null;
        const existing = infoHash ? ((await wt.get(infoHash)) || wt.torrents.find(t => t.infoHash && t.infoHash.toLowerCase() === infoHash)) : null;
        if (existing && existing.files && existing.files[idx]) {
          torrent = existing;
          fileSize = existing.files[idx].length;
          fileName = existing.files[idx].name;
        } else {
          throw err;
        }
      }
    }

    const mimeType = getMimeType(fileName);
    const range = req.headers.range;

    // Helper para criar o stream de leitura (seja via WebTorrent ou fs)
    const createStream = (options) => {
      if (localFilePath) {
        return fs.createReadStream(localFilePath, options);
      }
      return torrent.files[idx].createReadStream(options);
    };

    // Se o navegador não enviou cabeçalho Range, transmite o arquivo completo
    if (!range) {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes'
      });
      const stream = createStream();
      stream.on('error', (err) => {
        console.log('[Stream Info] Stream completo interrompido/fechado:', err.message);
      });
      stream.pipe(res);

      req.on('close', () => {
        if (stream.destroy) stream.destroy();
      });
    } else {
      // Transmissão de fatia parcial (Range Request / HTTP 206)
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      // Se a faixa solicitada for inválida
      if (start >= fileSize || end >= fileSize) {
        res.writeHead(416, {
          'Content-Range': `bytes */${fileSize}`
        });
        return res.end();
      }

      const chunkSize = (end - start) + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mimeType
      });

      // Cria um stream de leitura limitado à faixa solicitada
      const stream = createStream({ start, end });
      stream.on('error', (err) => {
        console.log('[Stream Info] Stream parcial (range) interrompido/fechado:', err.message);
      });
      stream.pipe(res);

      // Fecha o fluxo e limpa buffers quando o usuário fecha ou pausa o player
      req.on('close', () => {
        if (stream.destroy) stream.destroy();
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
