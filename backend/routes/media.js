import express from 'express';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { spawn } from 'child_process';
import ffprobe from 'ffprobe-static';
import db from '../db.js';
import { authenticateToken } from './auth.js';
import { addTorrent } from '../torrent-manager.js';
import { getTailscaleIp, getNgrokUrl, startNgrok, stopNgrok } from '../exposure-manager.js';

const router = express.Router();

// Função para extrair informações do link magnet instantaneamente antes de conectar aos peers
function parseMagnet(magnetUrl) {
  let infoHash = null;
  let name = null;

  try {
    const hashMatch = magnetUrl.match(/xt=urn:btih:([a-fA-F0-9]+)/i) || magnetUrl.match(/xt=urn:btih:([2-7a-zA-Z]+)/i);
    if (hashMatch) {
      infoHash = hashMatch[1].toLowerCase();
    }

    const nameMatch = magnetUrl.match(/dn=([^&]+)/i);
    if (nameMatch) {
      name = decodeURIComponent(nameMatch[1].replace(/\+/g, ' '));
    }
  } catch (e) {
    console.error('Erro ao fazer parse preliminar do magnet link:', e);
  }

  return { infoHash, name };
}

// Recupera a chave do TMDB do SQLite ou como fallback do .env
function getTmdbApiKey() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'tmdb_api_key'").get();
    if (row && row.value && row.value.trim() !== '' && row.value !== 'sua_chave_do_tmdb_aqui') {
      return row.value.trim();
    }
  } catch (e) {
    console.error('Erro ao ler TMDB Key do banco de dados:', e);
  }
  return process.env.TMDB_API_KEY;
}

// Função para limpar termos técnicos comuns de nomes de torrents para melhorar a busca nas APIs
function cleanTorrentName(name) {
  if (!name) return '';
  let clean = name;
  let truncateIndex = clean.length;

  // 1. Detecta o ano (ex: 2026, 2024, 1999)
  const yearMatch = clean.match(/(^|[\._\-\s])(19\d{2}|20[0-2]\d|2030)([\._\-\s]|$)/);
  if (yearMatch) {
    const yearIndex = clean.indexOf(yearMatch[2]);
    if (yearIndex > 0 && yearIndex < truncateIndex) {
      truncateIndex = yearIndex;
    }
  }

  // 2. Detecta termos de temporada (Inglês e Português) para truncar no ponto correto
  const seasonRegexes = [
    /s\d{1,2}e\d{1,2}/i,
    /s\d{1,2}/i,
    /season\s*\d{1,2}/i,
    /temporada\s*\d{1,2}/i,
    /\d{1,2}ª?\s*temporada/i,
    /\b[tT]\d{1,2}\b/
  ];

  seasonRegexes.forEach(regex => {
    const match = clean.match(regex);
    if (match) {
      const idx = clean.indexOf(match[0]);
      if (idx > 0 && idx < truncateIndex) {
        truncateIndex = idx;
      }
    }
  });

  if (truncateIndex < clean.length) {
    clean = clean.substring(0, truncateIndex);
  }

  // 3. Substituir pontos, underlines e traços por espaços
  clean = clean.replace(/[\._\-]/g, ' ');

  // 4. Remover tags entre colchetes e parênteses
  clean = clean.replace(/\[[^\]]*\]/g, ' ');
  clean = clean.replace(/\([^)]*\)/g, ' ');

  // 5. Termos técnicos comuns de torrents a serem removidos caso tenham restado antes/depois
  const keywords = [
    '1080p', '720p', '480p', '2160p', '4k', 'bluray', 'bdrip', 'brrip', 'webrip', 'web-dl', 'web', 'dl', 'h264', 'x264',
    'h265', 'x265', 'hevc', 'avc', 'aac', 'ac3', 'dd5 1', 'dts', 'dual', 'audio', 'multi', 'legendado', 'dublado', 'pt-br',
    'br', 'eng', 'sub', 'ita', 'fre', 'ger', 'spa', 'rip', 'remux', 'yify', 'rarbg', 'eztv', 'galaxyrg', 'tgx', 'season'
  ];
  
  clean = clean.toLowerCase();
  keywords.forEach(word => {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    clean = clean.replace(regex, ' ');
  });

  // 6. Limpar espaços múltiplos
  clean = clean.replace(/\s+/g, ' ').trim();
  return clean;
}

// Lógica de Enriquecimento de Metadados em Segundo Plano
async function enrichMetadata(magnetId, overrideSource = null, overrideId = null) {
  const magnet = db.prepare('SELECT * FROM magnets WHERE id = ?').get(magnetId);
  if (!magnet) return;

  db.prepare("UPDATE magnets SET status = 'indexing' WHERE id = ?").run(magnetId);

  try {
    let source = overrideSource;
    let externalId = overrideId;
    let title = magnet.title || 'Mídia Desconhecida';
    let mediaType = magnet.media_type || 'unknown';

    // Se não houver override manual, tenta buscar automaticamente
    if (!source || !externalId) {
      const cleanTitle = cleanTorrentName(title);
      
      // Heurística simples para classificar como Anime
      const isAnime = title.toLowerCase().includes('anime') || 
                      title.toLowerCase().includes('subs') || 
                      /\[[a-za-z0-9\-]+\]/i.test(magnet.title);

      if (isAnime) {
        // Tenta Jikan (MyAnimeList)
        const jikanRes = await axios.get(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(cleanTitle)}&limit=1`);
        if (jikanRes.data.data && jikanRes.data.data.length > 0) {
          source = 'jikan';
          externalId = jikanRes.data.data[0].mal_id.toString();
          mediaType = 'anime';
        }
      }

      // Se não for anime ou a busca do Jikan falhou e temos chave do TMDB
      const tmdbKey = getTmdbApiKey();
      if (!source && tmdbKey && tmdbKey !== 'sua_chave_do_tmdb_aqui') {
        const tmdbRes = await axios.get(`https://api.themoviedb.org/3/search/multi?api_key=${tmdbKey}&query=${encodeURIComponent(cleanTitle)}&language=pt-BR`);
        if (tmdbRes.data.results && tmdbRes.data.results.length > 0) {
          const res = tmdbRes.data.results[0];
          source = 'tmdb';
          externalId = res.id.toString();
          mediaType = res.media_type === 'tv' ? 'series' : 'movie';
        }
      }
    }

    // Busca os detalhes completos com base na fonte identificada
    if (source === 'jikan' && externalId) {
      const detailsRes = await axios.get(`https://api.jikan.moe/v4/anime/${externalId}`);
      const anime = detailsRes.data.data;

      let cast = '';
      try {
        const charRes = await axios.get(`https://api.jikan.moe/v4/anime/${externalId}/characters`);
        if (charRes.data.data) {
          cast = charRes.data.data
            .slice(0, 5)
            .map(c => `${c.character.name} (${c.voice_actors.find(va => va.language === 'Japanese')?.person.name || 'N/A'})`)
            .join(', ');
        }
      } catch (err) {
        console.error('Erro ao buscar elenco do Anime:', err.message);
      }

      const genres = anime.genres ? anime.genres.map(g => g.name).join(', ') : '';
      const studios = anime.studios ? anime.studios.map(s => s.name).join(', ') : '';

      db.prepare(`
        INSERT OR REPLACE INTO metadata 
        (magnet_id, external_id, source, title, original_title, synopsis, poster_path, backdrop_path, rating, release_date, genres, studio_or_creators, cast_list)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        magnetId,
        externalId,
        'jikan',
        anime.title,
        anime.title_japanese || anime.title_english || '',
        anime.synopsis || 'Sem sinopse disponível.',
        anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || '',
        anime.images?.jpg?.large_image_url || '', // Usado poster grande como backdrop fallback
        anime.score || 0.0,
        anime.aired?.string || '',
        genres,
        studios,
        cast
      );

      db.prepare("UPDATE magnets SET status = 'indexed', media_type = 'anime' WHERE id = ?").run(magnetId);
    } 
    else if (source === 'tmdb' && externalId) {
      const tmdbKey = getTmdbApiKey();
      if (!tmdbKey || tmdbKey === 'sua_chave_do_tmdb_aqui') {
        throw new Error('Chave do TMDB não configurada.');
      }

      // Se for override manual, a mídia pode ter sido alterada pelo usuário
      let typePath = (mediaType === 'series' || mediaType === 'anime') ? 'tv' : 'movie';
      const url = `https://api.themoviedb.org/3/${typePath}/${externalId}?api_key=${tmdbKey}&language=pt-BR&append_to_response=credits`;
      console.log(`[TMDB Debug] magnetId: ${magnetId}, mediaType: ${mediaType}, typePath: ${typePath}, externalId: ${externalId}, URL: ${url.substring(0, 50)}...`);
      const detailsRes = await axios.get(url);
      const details = detailsRes.data;

      const genres = details.genres ? details.genres.map(g => g.name).join(', ') : '';
      let creators = '';
      if (mediaType === 'series') {
        creators = details.created_by && details.created_by.length > 0
          ? details.created_by.map(c => c.name).join(', ')
          : (details.production_companies ? details.production_companies.map(p => p.name).join(', ') : '');
      } else {
        creators = details.production_companies ? details.production_companies.map(p => p.name).join(', ') : '';
      }

      const cast = details.credits?.cast
        ? details.credits.cast.slice(0, 6).map(c => c.name).join(', ')
        : '';

      const poster = details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : '';
      const backdrop = details.backdrop_path ? `https://image.tmdb.org/t/p/original${details.backdrop_path}` : '';

      db.prepare(`
        INSERT OR REPLACE INTO metadata 
        (magnet_id, external_id, source, title, original_title, synopsis, poster_path, backdrop_path, rating, release_date, genres, studio_or_creators, cast_list)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        magnetId,
        externalId,
        'tmdb',
        details.title || details.name,
        details.original_title || details.original_name || '',
        details.overview || 'Sem sinopse disponível.',
        poster,
        backdrop,
        details.vote_average || 0.0,
        details.release_date || details.first_air_date || '',
        genres,
        creators,
        cast
      );

      db.prepare("UPDATE magnets SET status = 'indexed', media_type = ? WHERE id = ?").run(mediaType, magnetId);
    } 
    else {
      throw new Error('Nenhum resultado automático nas APIs externas.');
    }
  } catch (err) {
    console.error(`Erro ao indexar metadados do magnet ${magnetId}:`, err.message);
    
    // Inserção de fallback caso todas as APIs falhem
    try {
      db.prepare(`
        INSERT OR REPLACE INTO metadata 
        (magnet_id, title, original_title, synopsis, poster_path, backdrop_path, rating, release_date, genres, studio_or_creators, cast_list, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        magnetId,
        magnet.title || 'Mídia Desconhecida',
        '',
        'Não foi possível extrair metadados das APIs externas. Você pode usar a "Identificação Manual" para associar um ID do TMDB ou MyAnimeList.',
        '', 
        '', 
        0.0,
        '',
        '',
        '',
        '',
        'none'
      );
      db.prepare("UPDATE magnets SET status = 'failed' WHERE id = ?").run(magnetId);
    } catch (e) {
      console.error('Falha crítica ao gravar metadados fallback:', e.message);
    }
  }
}

// 1. LISTAR MÍDIAS DO CATÁLOGO (Protegido)
router.get('/', authenticateToken, (req, res) => {
  try {
    const list = db.prepare(`
      SELECT m.id, m.magnet_url, m.info_hash, m.title as torrent_title, m.media_type, m.status,
             meta.title, meta.original_title, meta.synopsis, meta.poster_path, meta.backdrop_path,
             meta.rating, meta.release_date, meta.genres, meta.studio_or_creators, meta.cast_list, meta.external_id, meta.source
      FROM magnets m
      LEFT JOIN metadata meta ON m.id = meta.magnet_id
      ORDER BY m.created_at DESC
    `).all();

    // Roda reindexação em segundo plano para qualquer mídia que tenha falhado anteriormente
    list.forEach(m => {
      if (m.status === 'failed') {
        enrichMetadata(m.id).then(() => {
          console.log(`[Auto-Reindex] Mídia ID ${m.id} reindexada com sucesso em segundo plano.`);
        }).catch(err => {
          console.error(`[Auto-Reindex] Erro ao reindexar ID ${m.id}:`, err.message);
        });
      }
    });

    res.json(list);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar mídias.' });
  }
});

// 2. ADICIONAR NOVO LINK MAGNET (Protegido)
router.post('/', authenticateToken, async (req, res) => {
  const { magnetUrl, mediaType } = req.body;

  if (!magnetUrl || !magnetUrl.startsWith('magnet:?')) {
    return res.status(400).json({ error: 'Magnet link inválido.' });
  }

  try {
    // 1. Extrair hash e nome do magnet link de forma instantânea
    const { infoHash, name } = parseMagnet(magnetUrl);
    const title = name || 'Mídia Pendente';

    // 2. Insere a mídia com status inicial "indexing" e dados preliminares do magnet
    const stmt = db.prepare('INSERT INTO magnets (magnet_url, info_hash, title, media_type, status) VALUES (?, ?, ?, ?, ?)');
    const info = stmt.run(magnetUrl, infoHash, title, mediaType || 'unknown', 'indexing');
    const magnetId = info.lastInsertRowid;

    // Resposta imediata para liberar a tela
    res.status(201).json({ id: magnetId, status: 'indexing', message: 'Magnet cadastrado. Buscando metadados do TMDB/Jikan...' });

    // 3. Busca metadados externos imediatamente (usando o título limpo extraído do magnet)
    enrichMetadata(magnetId).then(() => {
      // 4. Inicia a tentativa de carregar o torrent em segundo plano no WebTorrent
      // para puxar os metadados do torrent e cachear os arquivos
      addTorrent(magnetUrl).then(async (torrent) => {
        console.log(`[WebTorrent Connect Background] Torrent ${magnetId} carregado. Atualizando título real: ${torrent.name}`);
        
        // Obtém o estado atual antes da atualização
        const currentMagnet = db.prepare('SELECT status, title FROM magnets WHERE id = ?').get(magnetId);
        
        // Atualiza info hash e nome real obtido da rede P2P
        db.prepare('UPDATE magnets SET info_hash = ?, title = ? WHERE id = ?')
          .run(torrent.infoHash, torrent.name, magnetId);
        
        // Se o status era falha ou se o título anterior era o provisório "Mídia Pendente", reindexa
        if (currentMagnet && (currentMagnet.status === 'failed' || currentMagnet.title === 'Mídia Pendente' || currentMagnet.status === 'indexing')) {
          await enrichMetadata(magnetId);
        }
      }).catch((err) => {
        console.log(`[WebTorrent Connect Background] Não foi possível conectar ao torrent ${magnetId} ainda (Aguardando seeders):`, err.message);
      });
    });

  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Este link magnet já foi cadastrado no catálogo.' });
    }
    res.status(500).json({ error: 'Erro ao salvar link magnet.' });
  }
});

// ROTA AUXILIAR PARA BUSCAR DETALHES EXTERNOS POR NOME NA API DO TMDB/JIKAN (Protegido)
router.get('/search-external', authenticateToken, async (req, res) => {
  const { query, source, type } = req.query;

  if (!query) {
    return res.status(400).json({ error: 'Parâmetro query é obrigatório.' });
  }

  try {
    if (source === 'jikan') {
      const url = `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=8`;
      const apiRes = await axios.get(url);
      const results = (apiRes.data.data || []).map(item => ({
        id: item.mal_id,
        title: item.title,
        year: item.aired && item.aired.from ? item.aired.from.substring(0, 4) : 'N/A',
        mediaType: 'anime'
      }));
      res.json(results);
    } else {
      const tmdbKey = getTmdbApiKey();
      if (!tmdbKey || tmdbKey === 'sua_chave_do_tmdb_aqui') {
        return res.status(400).json({ error: 'Chave TMDB não configurada no servidor.' });
      }
      const typePath = (type === 'series' || type === 'anime') ? 'tv' : 'movie';
      const url = `https://api.themoviedb.org/3/search/${typePath}?api_key=${tmdbKey}&query=${encodeURIComponent(query)}&language=pt-BR`;
      const apiRes = await axios.get(url);
      const results = (apiRes.data.results || []).slice(0, 8).map(item => ({
        id: item.id,
        title: item.title || item.name,
        year: item.release_date || item.first_air_date ? (item.release_date || item.first_air_date).substring(0, 4) : 'N/A',
        mediaType: type
      }));
      res.json(results);
    }
  } catch (err) {
    console.error('Erro na busca externa por nome:', err.message);
    res.status(500).json({ error: 'Erro ao buscar metadados externos: ' + err.message });
  }
});

// OBTEM CONFIGURAÇÕES (Protegido)
router.get('/settings', authenticateToken, (req, res) => {
  try {
    const tmdbRow = db.prepare("SELECT value FROM settings WHERE key = 'tmdb_api_key'").get();
    const typeRow = db.prepare("SELECT value FROM settings WHERE key = 'exposure_type'").get();
    const tokenRow = db.prepare("SELECT value FROM settings WHERE key = 'ngrok_token'").get();
    const transcodeRow = db.prepare("SELECT value FROM settings WHERE key = 'transcode_audio'").get();
    const autoDeleteRow = db.prepare("SELECT value FROM settings WHERE key = 'auto_delete_watched'").get();

    const tmdbApiKey = tmdbRow ? tmdbRow.value : '';
    const exposureType = typeRow ? typeRow.value : 'localhost';
    const ngrokToken = tokenRow ? tokenRow.value : '';
    const transcodeAudio = transcodeRow ? transcodeRow.value === '1' : false;
    const autoDeleteWatched = autoDeleteRow ? autoDeleteRow.value === '1' : false;

    res.json({
      tmdbApiKey,
      exposureType,
      ngrokToken,
      transcodeAudio,
      autoDeleteWatched,
      isFfmpegAvailable: true, // Auto-instalado localmente via npm
      tailscaleIp: getTailscaleIp(),
      ngrokUrl: getNgrokUrl()
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar configurações: ' + err.message });
  }
});

// SALVA CONFIGURAÇÕES (Protegido)
router.post('/settings', authenticateToken, async (req, res) => {
  const { tmdbApiKey, exposureType, ngrokToken, transcodeAudio, autoDeleteWatched } = req.body;
  try {
    // 1. Salva as configurações no banco
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('tmdb_api_key', ?)").run(tmdbApiKey || '');
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('exposure_type', ?)").run(exposureType || 'localhost');
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ngrok_token', ?)").run(ngrokToken || '');
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('transcode_audio', ?)").run(transcodeAudio ? '1' : '0');
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('auto_delete_watched', ?)").run(autoDeleteWatched ? '1' : '0');

    let activeNgrokUrl = null;
    let errMessage = null;

    // 2. Aplica a mudança de exposição
    if (exposureType === 'ngrok') {
      try {
        activeNgrokUrl = await startNgrok(ngrokToken);
      } catch (e) {
        errMessage = e.message;
      }
    } else {
      stopNgrok();
    }

    if (errMessage) {
      return res.status(400).json({
        error: `Configurações salvas no banco, mas falhou ao iniciar Ngrok: ${errMessage}`,
        tailscaleIp: getTailscaleIp(),
        ngrokUrl: null
      });
    }

    res.json({
      message: 'Configurações salvas com sucesso!',
      tailscaleIp: getTailscaleIp(),
      ngrokUrl: activeNgrokUrl
    });
  } catch (err) {
    console.error('Erro ao salvar configurações:', err.message);
    res.status(500).json({ error: 'Erro ao salvar configurações: ' + err.message });
  }
});

// EXPURGA OS ARQUIVOS DO CACHE DE UM MAGNET (Protegido)
router.delete('/:id/cache', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const magnet = db.prepare('SELECT * FROM magnets WHERE id = ?').get(id);
    if (!magnet) {
      return res.status(404).json({ error: 'Magnet não encontrado.' });
    }

    // 1. Encerra e destrói o torrent ativo no WebTorrent se estiver rodando
    try {
      const wt = (await import('../torrent-manager.js')).getClient();
      const infoHash = magnet.info_hash ? magnet.info_hash.toLowerCase() : null;
      const existing = infoHash ? ((await wt.get(infoHash)) || wt.torrents.find(t => t.infoHash && t.infoHash.toLowerCase() === infoHash)) : null;
      if (existing) {
        existing.destroy({ destroyStore: true });
        console.log(`[Cache Cleanup] Torrent #${id} removido da memória do cliente WebTorrent.`);
      }
    } catch (e) {
      console.log('[Cache Cleanup] Aviso ao remover torrent da memória:', e.message);
    }

    // 2. Apaga a pasta/arquivos físicos do cache
    const cacheDir = path.resolve(process.cwd(), 'cache');
    let deletedAny = false;

    if (magnet.files) {
      try {
        const cached = JSON.parse(magnet.files);
        const videoFiles = Array.isArray(cached) ? cached : (cached.videoFiles || []);
        for (const f of videoFiles) {
          if (f.path) {
            const relativeTopFolder = f.path.split(/[\/\\]/)[0];
            const topFolderPath = path.join(cacheDir, relativeTopFolder);
            if (relativeTopFolder && fs.existsSync(topFolderPath) && topFolderPath !== cacheDir) {
              fs.rmSync(topFolderPath, { recursive: true, force: true });
              deletedAny = true;
            }
          }
        }
      } catch (e) {}
    }

    if (magnet.title) {
      const titleFolder = path.join(cacheDir, magnet.title);
      if (fs.existsSync(titleFolder)) {
        fs.rmSync(titleFolder, { recursive: true, force: true });
        deletedAny = true;
      }
    }

    console.log(`[Cache Purge] Cache da mídia #${id} (${magnet.title}) expurgado com sucesso do disco.`);
    res.json({ success: true, message: 'Arquivos do cache excluídos com sucesso.', deletedAny });
  } catch (err) {
    console.error('[Cache Purge] Erro ao excluir arquivos do cache:', err.message);
    res.status(500).json({ error: 'Erro ao excluir cache: ' + err.message });
  }
});

    res.json({
      message: 'Configurações salvas com sucesso.',
      tailscaleIp: getTailscaleIp(),
      ngrokUrl: activeNgrokUrl || getNgrokUrl()
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar configurações: ' + err.message });
  }
});

// 3. IDENTIFICAÇÃO MANUAL (Protegido)
router.post('/:id/identify', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { source, externalId, mediaType } = req.body;

  if (!source || !externalId) {
    console.log(`[API POST identify error] Faltando parâmetros: source=${source}, externalId=${externalId}`);
    return res.status(400).json({ error: 'Source (tmdb/jikan) e externalId são obrigatórios.' });
  }

  console.log(`[API POST identify request] id: ${id}, source: ${source}, externalId: ${externalId}, mediaType: ${mediaType}`);

  try {
    const magnet = db.prepare('SELECT * FROM magnets WHERE id = ?').get(id);
    if (!magnet) {
      return res.status(404).json({ error: 'Magnet não encontrado.' });
    }

    // Se o tipo de mídia foi alterado manualmente pelo usuário (filme -> série)
    if (mediaType) {
      db.prepare('UPDATE magnets SET media_type = ? WHERE id = ?').run(mediaType, id);
    }

    // Executa a reindexação de forma síncrona antes de responder para garantir que o BD esteja atualizado
    await enrichMetadata(id, source, externalId);

    res.json({ message: 'Mídia reindexada com sucesso!' });
  } catch (err) {
    console.error('Erro ao identificar manual:', err);
    res.status(500).json({ error: 'Erro ao reindexar metadados da mídia.' });
  }
});

// 4. DELETAR MAGNET DO CATÁLOGO (Protegido)
router.delete('/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  try {
    const stmt = db.prepare('DELETE FROM magnets WHERE id = ?');
    const info = stmt.run(id);
    if (info.changes === 0) {
      return res.status(404).json({ error: 'Mídia não encontrada.' });
    }
    res.json({ message: 'Mídia deletada com sucesso.' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao deletar mídia.' });
  }
});

// 5. LISTAR ARQUIVOS DENTRO DO TORRENT (Protegido)
router.get('/:id/files', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const magnet = db.prepare('SELECT * FROM magnets WHERE id = ?').get(id);
    if (!magnet) {
      return res.status(404).json({ error: 'Magnet não encontrado.' });
    }

    let torrent;
    let files = [];
    let subtitles = [];
    let loadFromCache = false;

    try {
      // Carrega o torrent (limite de 6 segundos para listar arquivos se não houver seeders)
      torrent = await addTorrent(magnet.magnet_url, 6000);
    } catch (err) {
      // Se falhou ao conectar (timeout), tenta buscar do cache no banco de dados
      if (magnet.files) {
        try {
          const cached = JSON.parse(magnet.files);
          if (Array.isArray(cached)) {
            // Retrocompatibilidade: cache legado era só array de vídeos
            files = cached.filter(f => f.length >= 50 * 1024 * 1024);
            subtitles = [];
          } else {
            // Novo formato estruturado
            files = cached.videoFiles || [];
            subtitles = cached.subtitleFiles || [];
          }
          loadFromCache = true;
          console.log(`[Files Cache] Mídia ID ${id} carregada a partir do cache local devido a timeout de seeders.`);
        } catch (e) {
          return res.status(500).json({ error: 'Erro ao ler cache de arquivos: ' + e.message });
        }
      } else {
        // Se não tem cache, propaga o erro de timeout
        return res.status(500).json({ error: 'Tempo limite esgotado para obter metadados do Torrent (Sem peers/seeders ativos).' });
      }
    }

    if (!loadFromCache && torrent) {
      // Se o magnet no banco ainda está com o título provisório ou não indexado, atualiza e enriquece
      if (magnet.title === 'Mídia Pendente' || !magnet.info_hash || magnet.status === 'failed' || magnet.status === 'indexing') {
        try {
          db.prepare('UPDATE magnets SET info_hash = ?, title = ?, status = ? WHERE id = ?')
            .run(torrent.infoHash, torrent.name, 'indexed', id);
          
          // Roda síncrono para garantir que o BD esteja preenchido antes de responder
          await enrichMetadata(id);
        } catch (e) {
          console.error('Erro ao atualizar título real do torrent em /files:', e.message);
        }
      }
      
      // Mapeia todos os arquivos do torrent
      const videoExtensions = ['.mp4', '.mkv', '.avi', '.webm', '.flv', '.mov'];
      const subtitleExtensions = ['.srt', '.vtt'];

      const allFiles = torrent.files.map((file, index) => ({
        index,
        name: file.name,
        length: file.length,
        path: file.path,
        isVideo: videoExtensions.some(ext => file.name.toLowerCase().endsWith(ext)),
        isSubtitle: subtitleExtensions.some(ext => file.name.toLowerCase().endsWith(ext))
      }));

      // Filtra apenas vídeos >= 50MB e as legendas
      files = allFiles.filter(f => f.isVideo && f.length >= 50 * 1024 * 1024);
      subtitles = allFiles.filter(f => f.isSubtitle);

      // Salva a estrutura de arquivos no cache do banco de dados
      try {
        db.prepare('UPDATE magnets SET files = ? WHERE id = ?').run(JSON.stringify({ videoFiles: files, subtitleFiles: subtitles }), id);
      } catch (e) {
        console.error('Erro ao salvar cache de arquivos no BD:', e.message);
      }
    }
    
    // Busca o registro atualizado do banco de dados (com os metadados ricos recém-carregados)
    const updatedMedia = db.prepare(`
      SELECT m.id, m.magnet_url, m.info_hash, m.title as torrent_title, m.media_type, m.status,
             meta.title, meta.original_title, meta.synopsis, meta.poster_path, meta.backdrop_path,
             meta.rating, meta.release_date, meta.genres, meta.studio_or_creators, meta.cast_list, meta.external_id, meta.source
      FROM magnets m
      LEFT JOIN metadata meta ON m.id = meta.magnet_id
      WHERE m.id = ?
    `).get(id);

    res.json({
      title: loadFromCache ? magnet.title : torrent.name,
      infoHash: loadFromCache ? magnet.info_hash : torrent.infoHash,
      files,
      subtitles,
      updatedMedia
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erro ao carregar estrutura do torrent.' });
  }
});

// ROTA PARA EXTRAIR TRILHAS DE ÁUDIO DE UM EPISÓDIO/FILME (Protegido)
router.get('/:id/files/:fileIndex/tracks', authenticateToken, async (req, res) => {
  const { id, fileIndex } = req.params;
  
  try {
    const magnet = db.prepare('SELECT * FROM magnets WHERE id = ?').get(id);
    if (!magnet) {
      return res.status(404).json({ error: 'Magnet não cadastrado.' });
    }

    // A URL local para fazer streaming do torrent
    // ffmpeg/ffprobe pode ler de http://localhost:PORT/api/stream/:id/:fileIndex
    const streamUrl = `http://localhost:${process.env.PORT || 3000}/api/stream/${id}/${fileIndex}`;

    // Executa o ffprobe local do ffprobe-static via spawn
    const ffprobeProcess = spawn(ffprobe.path, [
      '-v', 'error',
      '-select_streams', 'a', // Seleciona apenas trilhas de áudio
      '-show_entries', 'stream=index,codec_name:stream_tags=language,title',
      '-of', 'json',
      streamUrl
    ]);

    let output = '';
    let errorOutput = '';

    ffprobeProcess.stdout.on('data', data => {
      output += data.toString();
    });

    ffprobeProcess.stderr.on('data', data => {
      errorOutput += data.toString();
    });

    ffprobeProcess.on('close', code => {
      if (code !== 0) {
        console.error('[ffprobe] Erro no ffprobe:', errorOutput);
        return res.status(500).json({ error: 'Falha ao analisar canais de áudio: ' + errorOutput });
      }

      try {
        const json = JSON.parse(output);
        const audioStreams = (json.streams || []).map((stream, idx) => {
          const tags = stream.tags || {};
          return {
            index: idx, // Índice sequencial amigável
            streamIndex: stream.index, // Índice físico do stream no ffmpeg
            codec: stream.codec_name,
            language: tags.language || 'desconhecido',
            title: tags.title || `Áudio ${idx + 1}`
          };
        });
        res.json({ streams: audioStreams });
      } catch (e) {
        res.status(500).json({ error: 'Falha ao ler saída do ffprobe: ' + e.message });
      }
    });

  } catch (err) {
    console.error('Erro ao analisar trilhas de áudio:', err.message);
    res.status(500).json({ error: 'Erro ao analisar áudio: ' + err.message });
  }
});

export default router;
