// Estado global da aplicação
let currentMediaId = null;
let activePlayer = null;
let allMediaData = []; // Cache do catálogo para busca local rápida
let currentCategoryFilter = 'all'; // 'all', 'movie', 'series', 'anime'
let currentSubtitles = []; // Lista de legendas do torrent ativo

// Inicialização da página
document.addEventListener('DOMContentLoaded', () => {
  checkAuth();
  setupEventListeners();
});

// ==================== CONTROLE DE SESSÃO / AUTH ==================== //

function checkAuth() {
  const token = localStorage.getItem('token');
  const username = localStorage.getItem('username');
  
  const authScreen = document.getElementById('auth-screen');
  const appWrapper = document.getElementById('app-wrapper');

  if (token && username) {
    authScreen.classList.remove('active');
    appWrapper.classList.add('active');
    document.getElementById('user-display-name').textContent = username;
    document.getElementById('user-avatar-initial').textContent = username.substring(0, 2).toUpperCase();
    loadCatalog();
  } else {
    authScreen.classList.add('active');
    appWrapper.classList.remove('active');
    destroyActivePlayer();
  }
}

function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('username');
  showToast('Sessão encerrada com sucesso.', 'info');
  checkAuth();
}

// ==================== GERENCIADOR DE NOTIFICAÇÕES (TOAST) ==================== //

function showToast(message, type = 'info') {
  // Remove toasters antigos
  const existing = document.querySelector('.toast-notification');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast-notification ${type}`;
  
  let icon = 'fa-circle-info';
  if (type === 'success') icon = 'fa-circle-check';
  if (type === 'error') icon = 'fa-triangle-exclamation';
  if (type === 'warning') icon = 'fa-circle-exclamation';

  toast.innerHTML = `
    <i class="fa-solid ${icon}"></i>
    <span>${message}</span>
  `;
  
  document.body.appendChild(toast);

  // Auto-remove em 4 segundos
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(15px)';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ==================== GERENCIADOR DO PLAYER ÚNICO ==================== //

function destroyActivePlayer() {
  // Garante a interrupção completa e eliminação do player anterior para evitar execução dupla
  if (activePlayer) {
    try {
      activePlayer.pause();
      activePlayer.destroy();
    } catch (e) {
      console.error('Erro ao destruir Plyr:', e);
    }
    activePlayer = null;
  }
  
  // Limpa o nó do DOM e recoloca o placeholder padrão
  const root = document.getElementById('unique-player-root');
  if (root) {
    root.innerHTML = `
      <div class="player-placeholder">
        <i class="fa-solid fa-circle-play"></i>
        <p>Selecione um arquivo acima para iniciar o streaming P2P.</p>
      </div>
    `;
  }
  document.getElementById('playing-file-title').textContent = 'Nenhum vídeo selecionado';

  // Oculta o container de faixas de áudio
  const audioTracksContainer = document.getElementById('player-audio-tracks-container');
  if (audioTracksContainer) {
    audioTracksContainer.style.display = 'none';
  }
}

// Formata o nome do arquivo para mostrar o número correspondente do episódio de forma amigável
function formatEpisodeName(filename) {
  const clean = filename.replace(/\.(mp4|mkv|avi|webm|flv|mov)$/gi, '');
  
  // 1. Padrão S01E02 ou S1E2 ou S01.E02 etc.
  const sMatch = clean.match(/s(\d{1,2})[\.\s_\-]*e(\d{1,3})/i);
  if (sMatch) {
    const season = parseInt(sMatch[1], 10);
    const episode = parseInt(sMatch[2], 10);
    return `Temporada ${season} - Episódio ${episode}`;
  }
  
  // 2. Padrão Season 1 Episode 2
  const sMatch2 = clean.match(/season[\.\s_\-]*(\d{1,2})[\.\s_\-]*episode[\.\s_\-]*(\d{1,3})/i);
  if (sMatch2) {
    return `Temporada ${sMatch2[1]} - Episódio ${sMatch2[2]}`;
  }

  // 3. Padrão EP01 ou Ep 01 ou E01
  const epMatch = clean.match(/(?:ep|episodio|episode|e)[\.\s_\-]*(\d{1,3})/i);
  if (epMatch) {
    const ep = parseInt(epMatch[1], 10);
    return `Episódio ${ep}`;
  }

  // 4. Padrão de número solto (ex: "Nome da Série - 01")
  const numMatch = clean.match(/[\s_\-\.](\d{1,3})(?:\s|$|[\s_\-\.])/);
  if (numMatch) {
    const ep = parseInt(numMatch[1], 10);
    if (ep < 100) {
      return `Episódio ${ep}`;
    }
  }

  // Fallback: limpa os pontos do nome
  return clean.replace(/[\._]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Analisa o nome do arquivo para extrair o número da temporada e do episódio
function parseSeasonEpisode(filename) {
  const clean = filename.replace(/\.(mp4|mkv|avi|webm|flv|mov)$/gi, '').toLowerCase();
  
  // 1. Padrão S01E02 ou S1E2 ou S01.E02 etc.
  const sMatch = clean.match(/s(\d{1,2})[\.\s_\-]*e(\d{1,3})/);
  if (sMatch) {
    return { season: parseInt(sMatch[1], 10), episode: parseInt(sMatch[2], 10) };
  }
  
  // 2. Padrão Season 1 Episode 2
  const sMatch2 = clean.match(/season[\.\s_\-]*(\d{1,2})[\.\s_\-]*episode[\.\s_\-]*(\d{1,3})/);
  if (sMatch2) {
    return { season: parseInt(sMatch2[1], 10), episode: parseInt(sMatch2[2], 10) };
  }

  // 3. Padrão EP01 ou Ep 01 ou E01
  const epMatch = clean.match(/(?:ep|episodio|episode|e)[\.\s_\-]*(\d{1,3})/);
  if (epMatch) {
    return { season: 1, episode: parseInt(epMatch[1], 10) };
  }

  // 4. Padrão de número solto (ex: "Nome da Série - 01")
  const numMatch = clean.match(/[\s_\-\.](\d{1,3})(?:\s|$|[\s_\-\.])/);
  if (numMatch) {
    const ep = parseInt(numMatch[1], 10);
    if (ep < 100) {
      return { season: 1, episode: ep };
    }
  }

  return { season: 1, episode: 1 };
}

// Analisa a temporada a partir do título do torrent com precisão de bordas de palavra
function parseSeasonFromTitle(title) {
  if (!title) return 1;
  const clean = title.toLowerCase();

  // 1. S01, S1
  const sMatch = clean.match(/\bs(\d{1,2})\b/);
  if (sMatch) return parseInt(sMatch[1], 10);

  // 2. Season 1
  const sMatch2 = clean.match(/season\s*(\d{1,2})\b/);
  if (sMatch2) return parseInt(sMatch2[1], 10);

  // 3. Temporada 1
  const sMatch3 = clean.match(/temporada\s*(\d{1,2})\b/);
  if (sMatch3) return parseInt(sMatch3[1], 10);

  // 4. 1ª Temporada, 2ª Temporada
  const sMatch4 = clean.match(/\b(\d{1,2})ª?\s*temporada/);
  if (sMatch4) return parseInt(sMatch4[1], 10);

  // 5. T1, T2
  const sMatch5 = clean.match(/\bt(\d{1,2})\b/);
  if (sMatch5) return parseInt(sMatch5[1], 10);

  return 1;
}

async function initPlayer(media, streamMagnetId, fileIndex, fileName, targetAudioTrack = null, startTime = 0) {
  // 1. Destrói o player anterior de forma garantida
  destroyActivePlayer();

  // 2. Atualiza o título do vídeo atual no player usando o nome amigável ou título do filme
  const playingFileTitle = document.getElementById('playing-file-title');
  if (media.media_type === 'movie') {
    playingFileTitle.textContent = media.title || media.torrent_title || 'Filme';
  } else {
    playingFileTitle.textContent = formatEpisodeName(fileName);
  }

  // 3. Busca as configurações de transcodificação mais recentes do banco
  let transcodeAudio = false;
  try {
    const settingsRes = await fetch('/api/media/settings', {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
    });
    if (settingsRes.ok) {
      const sData = await settingsRes.json();
      transcodeAudio = sData.transcodeAudio || false;
    }
  } catch (e) {
    console.error('Erro ao buscar configurações de transcodificação:', e);
  }

  // 4. Monta a URL de stream do backend
  let streamUrl = `/api/stream/${streamMagnetId}/${fileIndex}`;
  if (transcodeAudio && targetAudioTrack !== null) {
    streamUrl += `?audioTrack=${targetAudioTrack}`;
    if (startTime > 0) {
      streamUrl += `&startTime=${startTime}`;
    }
  }

  // 5. Cria o novo elemento <video> no DOM
  const root = document.getElementById('unique-player-root');
  root.innerHTML = ''; // Remove o placeholder

  const videoElement = document.createElement('video');
  videoElement.id = 'jeelyflix-video-player';
  videoElement.className = 'plyr';
  videoElement.controls = true;
  videoElement.playsInline = true;
  videoElement.crossOrigin = 'anonymous'; // IMPORTANTE para evitar bloqueio de CORS ao carregar as legendas

  const sourceElement = document.createElement('source');
  sourceElement.src = streamUrl;
  
  // Associa o mime-type de acordo com o arquivo selecionado
  const ext = fileName.split('.').pop().toLowerCase();
  if (ext === 'webm') {
    sourceElement.type = 'video/webm';
  } else if (ext === 'mkv') {
    sourceElement.type = 'video/x-matroska';
  } else {
    sourceElement.type = 'video/mp4';
  }

  videoElement.appendChild(sourceElement);

  // 6. Injeta as legendas encontradas no torrent dinamicamente
  if (currentSubtitles && currentSubtitles.length > 0) {
    currentSubtitles.forEach((sub) => {
      const track = document.createElement('track');
      track.kind = 'captions';
      
      let label = sub.name;
      const lowerName = sub.name.toLowerCase();
      if (lowerName.includes('portuguese') || lowerName.includes('por') || lowerName.includes('pt-br') || lowerName.includes('ptbr')) {
        label = `Português (${sub.name})`;
        track.srclang = 'pt';
      } else if (lowerName.includes('english') || lowerName.includes('eng')) {
        label = `English (${sub.name})`;
        track.srclang = 'en';
      } else if (lowerName.includes('spanish') || lowerName.includes('esp')) {
        label = `Español (${sub.name})`;
        track.srclang = 'es';
      } else {
        track.srclang = 'xx';
      }
      
      track.label = label;
      track.src = `/api/stream/${streamMagnetId}/${sub.index}/subtitles`;

      const isPt = label.includes('Português');
      const videoNameWithoutExt = fileName.substring(0, fileName.lastIndexOf('.')) || fileName;
      const isMatchingVideo = lowerName.includes(videoNameWithoutExt.toLowerCase());
      if (isPt || isMatchingVideo) {
        track.default = true;
      }

      videoElement.appendChild(track);
    });
  }

  root.appendChild(videoElement);

  // 7. Instancia a biblioteca Plyr
  activePlayer = new Plyr(videoElement, {
    controls: [
      'play-large', 'play', 'progress', 'current-time', 'duration',
      'mute', 'volume', 'captions', 'settings', 'pip', 'airplay', 'fullscreen'
    ],
    tooltips: { controls: true, seek: true },
    i18n: {
      play: 'Reproduzir',
      pause: 'Pausar',
      mute: 'Mudar para mudo',
      unmute: 'Ativar som',
      settings: 'Configurações',
      speed: 'Velocidade',
      normal: 'Normal',
      quality: 'Qualidade',
      loop: 'Loop',
      captions: 'Legendas',
      disabled: 'Desativado',
      enabled: 'Ativado'
    }
  });

  // 8. Lógica de faixas de áudio dinâmicas e transcodificação
  const audioTracksContainer = document.getElementById('player-audio-tracks-container');
  const audioTracksButtons = document.getElementById('audio-tracks-buttons');
  
  if (audioTracksContainer && audioTracksButtons) {
    audioTracksContainer.style.display = 'none';
    audioTracksButtons.innerHTML = '';

    if (transcodeAudio) {
      // Busca as trilhas do FFprobe via backend
      try {
        const tracksRes = await fetch(`/api/media/${streamMagnetId}/files/${fileIndex}/tracks`, {
          headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        });
        if (tracksRes.ok) {
          const tData = await tracksRes.json();
          const streams = tData.streams || [];
          
          if (streams.length > 0) {
            audioTracksContainer.style.display = 'flex';
            audioTracksContainer.style.flexDirection = 'row';
            audioTracksContainer.style.alignItems = 'center';
            audioTracksContainer.style.gap = '12px';
            
            streams.forEach((stream) => {
              const btn = document.createElement('button');
              btn.type = 'button';
              
              // Se nenhuma faixa foi selecionada ainda, a primeira (index 0) é a ativa
              const isActive = (targetAudioTrack === null && stream.index === 0) || (targetAudioTrack !== null && stream.index === parseInt(targetAudioTrack, 10));
              btn.className = isActive ? 'btn btn-primary' : 'btn btn-secondary';
              btn.style.padding = '4px 12px';
              btn.style.fontSize = '0.8rem';
              btn.style.height = 'auto';
              btn.style.minHeight = 'unset';
              
              // Traduz idiomas conhecidos
              let langLabel = stream.language.toUpperCase();
              if (langLabel === 'POR' || langLabel === 'PTB' || langLabel === 'PT') langLabel = 'Português';
              else if (langLabel === 'ENG' || langLabel === 'EN') langLabel = 'Inglês';
              else if (langLabel === 'SPA' || langLabel === 'ES') langLabel = 'Espanhol';
              else if (langLabel === 'JPN' || langLabel === 'JA') langLabel = 'Japonês';
              
              btn.textContent = `${langLabel} (${stream.title})`;

              btn.addEventListener('click', () => {
                const currentTime = activePlayer ? activePlayer.currentTime : 0;
                console.log(`[Transcode] Mudando para áudio #${stream.index} a partir de ${currentTime}s...`);
                initPlayer(media, streamMagnetId, fileIndex, fileName, stream.index, currentTime);
              });

              audioTracksButtons.appendChild(btn);
            });
          }
        }
      } catch (e) {
        console.error('Erro ao carregar faixas de áudio via ffprobe:', e);
      }
    } else {
      // Se a transcodificação estiver desativada, exibe o aviso do Chrome e as opções do VLC
      audioTracksContainer.style.display = 'flex';
      audioTracksContainer.style.flexDirection = 'column';
      audioTracksContainer.style.alignItems = 'flex-start';
      audioTracksContainer.style.gap = '8px';
      audioTracksContainer.style.width = '100%';
      
      const infoTip = document.createElement('div');
      infoTip.style.fontSize = '0.85rem';
      infoTip.style.color = 'var(--text-muted)';
      infoTip.style.lineHeight = '1.5';
      infoTip.style.width = '100%';
      
      const fullStreamUrl = `${window.location.origin}/api/stream/${streamMagnetId}/${fileIndex}`;
      const vlcUrl = `vlc://${fullStreamUrl.replace(/^https?:\/\//, '')}`;

      infoTip.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 6px; width: 100%;">
          <span style="display: flex; align-items: center; gap: 6px;">
            <i class="fa-solid fa-circle-info" style="color: var(--primary); font-size: 0.95rem;"></i>
            <strong>Dica de Áudio e Legendas:</strong> Ative a "Transcodificação de Áudio" nas configurações para trocar faixas no navegador, ou reproduza fora dele:
          </span>
          <div style="display: flex; flex-wrap: wrap; gap: 10px; margin-top: 2px;">
            <a href="${vlcUrl}" class="btn btn-primary" style="padding: 5px 12px; font-size: 0.78rem; height: auto; min-height: unset; display: inline-flex; align-items: center; gap: 6px; text-decoration: none;">
              <i class="fa-solid fa-up-right-from-square"></i> Abrir no Player VLC
            </a>
            <button type="button" id="btn-copy-stream-link" class="btn btn-secondary" style="padding: 5px 12px; font-size: 0.78rem; height: auto; min-height: unset; display: inline-flex; align-items: center; gap: 6px;">
              <i class="fa-solid fa-copy"></i> Copiar Link do Stream
            </button>
          </div>
        </div>
      `;

      audioTracksButtons.appendChild(infoTip);

      document.getElementById('btn-copy-stream-link').addEventListener('click', () => {
        navigator.clipboard.writeText(fullStreamUrl).then(() => {
          showToast('Link de streaming copiado! Cole no VLC (Ctrl+N) ou PotPlayer.', 'success');
        }).catch(() => {
          showToast('Não foi possível copiar o link automaticamente.', 'error');
        });
      });
    }
  }

  // 9. Tratamento de Seek para Streams Transcodificados
  if (transcodeAudio && targetAudioTrack !== null) {
    let lastTime = startTime;
    
    activePlayer.on('timeupdate', () => {
      if (!videoElement.seeking) {
        lastTime = videoElement.currentTime;
      }
    });

    activePlayer.on('seeking', () => {
      const newTime = videoElement.currentTime;
      if (Math.abs(newTime - lastTime) > 3) {
        console.log(`[Transcode Seek] Reiniciando transcodificação a partir de ${newTime}s...`);
        initPlayer(media, streamMagnetId, fileIndex, fileName, targetAudioTrack, newTime);
      }
    });
  }

  // Tenta iniciar a reprodução automática amigavelmente
  activePlayer.on('ready', () => {
    activePlayer.play().catch(() => {
      console.log('Autoplay bloqueado pelo navegador, aguardando clique.');
    });
  });
}

// ==================== CHAMADAS DE API E RENDERIZAÇÃO ==================== //

// Carrega todas as mídias do catálogo
async function loadCatalog() {
  const mediaGrid = document.getElementById('media-grid');
  mediaGrid.innerHTML = `
    <div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted);">
      <i class="fa-solid fa-spinner fa-spin fa-2x" style="color: var(--primary); margin-bottom: 10px;"></i>
      <p>Buscando catálogo no banco de dados...</p>
    </div>
  `;

  try {
    const res = await fetch('/api/media', {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
    });
    
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        logout();
        return;
      }
      throw new Error('Falha ao obter catálogo');
    }

    allMediaData = await res.json();
    renderCatalogGrid(allMediaData);

  } catch (err) {
    mediaGrid.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--danger);">
        <i class="fa-solid fa-triangle-exclamation fa-2x" style="margin-bottom: 10px;"></i>
        <p>Não foi possível carregar o catálogo: ${err.message}</p>
      </div>
    `;
  }
}

// Renderiza os cards de mídia no grid
function renderCatalogGrid(items) {
  const mediaGrid = document.getElementById('media-grid');
  
  // 1. Aplica o filtro de categoria lateral (Filmes, Séries, Animes)
  let filteredItems = items;
  if (currentCategoryFilter !== 'all') {
    filteredItems = items.filter(item => item.media_type === currentCategoryFilter);
  }

  // 2. Agrupa/deduplica itens com o mesmo ID externo (mesma série/filme no TMDB) para não repetir capas na index
  const seenExternalIds = new Set();
  const uniqueItems = [];

  filteredItems.forEach(item => {
    if (item.external_id) {
      const extId = item.external_id.toString();
      if (!seenExternalIds.has(extId)) {
        seenExternalIds.add(extId);
        uniqueItems.push(item);
      }
    } else {
      uniqueItems.push(item);
    }
  });

  // Atualiza o contador de mídias exibidas na barra de título
  document.getElementById('catalog-counter').textContent = `${uniqueItems.length} Mídias`;
  
  if (uniqueItems.length === 0) {
    mediaGrid.className = 'media-grid'; // Garante estilo grid para a mensagem vazia
    mediaGrid.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 60px; color: var(--text-muted);">
        <i class="fa-solid fa-magnet fa-3x" style="color: var(--border-color); margin-bottom: 15px;"></i>
        <p>Nenhuma mídia encontrada nesta categoria.</p>
        <p style="font-size: 0.85rem; margin-top: 5px;">Clique no botão superior para adicionar um Magnet Link.</p>
      </div>
    `;
    return;
  }

  // Função auxiliar para renderizar um card de mídia
  function createCardElement(media) {
    const card = document.createElement('article');
    card.className = 'media-card';
    
    // Poster ou Fallback estilizado
    let posterHtml = '';
    if (media.poster_path) {
      posterHtml = `<img class="card-poster" src="${media.poster_path}" alt="${media.title || media.torrent_title}" loading="lazy">`;
    } else {
      posterHtml = `
        <div class="card-fallback-poster">
          <i class="fa-solid fa-film"></i>
          <span>${media.title || media.torrent_title || 'Sem título'}</span>
        </div>
      `;
    }

    // Badge de tipo (Filme, Série ou Anime)
    const typeLabel = media.media_type === 'movie' ? 'Filme' : media.media_type === 'series' ? 'Série' : media.media_type === 'anime' ? 'Anime' : 'Outro';
    
    // Nota/Rating
    const ratingHtml = media.rating ? `<span class="card-rating"><i class="fa-solid fa-star"></i> ${media.rating.toFixed(1)}</span>` : '';

    // Status da indexação
    let statusText = 'Pendente';
    if (media.status === 'indexed') statusText = 'Indexado';
    if (media.status === 'indexing') statusText = 'Buscando Metadados';
    if (media.status === 'failed') statusText = 'Metadados não Encontrados';

    card.innerHTML = `
      ${posterHtml}
      <span class="card-badge ${media.media_type || 'movie'}">${typeLabel}</span>
      ${ratingHtml}
      <div class="card-info">
        <h3>${media.title || media.torrent_title || 'Sem título'}</h3>
        <span class="release">${media.release_date ? media.release_date.substring(0, 4) : 'Ano N/A'}</span>
        <span class="status-badge ${media.status}">${statusText}</span>
      </div>
    `;

    card.addEventListener('click', () => showDetails(media));
    return card;
  }

  // 3. Verifica se há uma busca por texto ativa
  const searchValue = document.getElementById('catalog-search').value.trim();
  const searchActive = searchValue.length > 0;

  if (searchActive) {
    // Modo de busca: renderizar em grade plana (media-grid)
    mediaGrid.className = 'media-grid';
    mediaGrid.innerHTML = '';
    uniqueItems.forEach(media => {
      const card = createCardElement(media);
      mediaGrid.appendChild(card);
    });
  } else {
    // Modo normal: agrupar por gêneros no estilo Netflix
    mediaGrid.className = ''; // Remove grid estilo para empilhar as linhas em bloco
    mediaGrid.innerHTML = '';

    // Agrupamento de mídias por gêneros
    const genreMap = {};
    uniqueItems.forEach(media => {
      const genres = media.genres ? media.genres.split(',').map(g => g.trim()) : [];
      if (genres.length === 0 || (genres.length === 1 && !genres[0])) {
        if (!genreMap['Sem Gênero']) genreMap['Sem Gênero'] = [];
        genreMap['Sem Gênero'].push(media);
      } else {
        genres.forEach(g => {
          if (g) {
            if (!genreMap[g]) genreMap[g] = [];
            genreMap[g].push(media);
          }
        });
      }
    });

    // Ordenação dos gêneros (com "Sem Gênero" por último)
    const sortedGenres = Object.keys(genreMap).sort();
    const noGenreIndex = sortedGenres.indexOf('Sem Gênero');
    if (noGenreIndex > -1) {
      sortedGenres.splice(noGenreIndex, 1);
      sortedGenres.push('Sem Gênero');
    }

    // Cria as fileiras horizontais de gêneros
    sortedGenres.forEach(genreName => {
      const row = document.createElement('div');
      row.className = 'genre-row';

      const h3 = document.createElement('h3');
      h3.className = 'genre-title';
      h3.textContent = genreName;
      row.appendChild(h3);

      const slider = document.createElement('div');
      slider.className = 'genre-slider';

      // Renderiza e insere os cards correspondentes neste gênero
      genreMap[genreName].forEach(media => {
        const card = createCardElement(media);
        slider.appendChild(card);
      });

      row.appendChild(slider);
      mediaGrid.appendChild(row);
    });
  }
}

// Abre e preenche a tela de Detalhes da Mídia
async function showDetails(media) {
  // Salva ID ativo no escopo global
  currentMediaId = media.id;
  resetDeleteButton();

  // Remove seletor de temporadas anterior se existir para não duplicar
  const existingSelect = document.getElementById('season-selector-dropdown');
  if (existingSelect) existingSelect.remove();

  // Oculta catálogo/configurações e exibe detalhes
  document.getElementById('catalog-section').classList.remove('active');
  document.getElementById('settings-section').classList.remove('active');
  const detailsSec = document.getElementById('details-section');
  detailsSec.classList.add('active');

  // Ajusta o layout do player (oculta a barra de arquivos se for filme)
  const playerContainerSec = document.querySelector('.player-container-section');
  const isMovie = media.media_type === 'movie';
  if (isMovie) {
    playerContainerSec.classList.add('no-files');
  } else {
    playerContainerSec.classList.remove('no-files');
  }

  // Preenche dados visuais
  document.getElementById('detail-title').textContent = media.title || media.torrent_title || 'Sem título';
  document.getElementById('detail-original-title').textContent = media.original_title ? `Título Original: ${media.original_title}` : '';
  document.getElementById('detail-rating').innerHTML = `<i class="fa-solid fa-star"></i> ${media.rating ? media.rating.toFixed(1) : '0.0'}`;
  document.getElementById('detail-release').innerHTML = `<i class="fa-solid fa-calendar"></i> ${media.release_date || 'Desconhecida'}`;
  document.getElementById('detail-genres').textContent = media.genres || 'Sem gêneros informados';
  document.getElementById('detail-synopsis').textContent = media.synopsis || 'Nenhuma sinopse disponível para esta mídia.';
  document.getElementById('detail-studio').textContent = media.studio_or_creators || 'Desconhecido';
  document.getElementById('detail-cast').textContent = media.cast_list || 'Desconhecido';

  // Configura tipo de Badge
  const badge = document.getElementById('detail-badge');
  badge.className = 'badge ' + (media.media_type || 'movie');
  const typeMap = { 'movie': 'Filme', 'series': 'Série', 'anime': 'Anime', 'unknown': 'Desconhecido' };
  badge.textContent = typeMap[media.media_type || 'unknown'] || 'Mídia';

  // Imagens (Poster e Backdrop Hero)
  const posterImg = document.getElementById('detail-poster');
  if (media.poster_path) {
    posterImg.src = media.poster_path;
  } else {
    posterImg.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="220" height="330"><rect width="220" height="330" fill="%23131622"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="%2364748b" font-family="sans-serif" font-size="14">Sem Poster</text></svg>';
  }

  const heroDiv = document.getElementById('details-hero');
  if (media.backdrop_path) {
    heroDiv.style.backgroundImage = `url('${media.backdrop_path}')`;
  } else {
    heroDiv.style.backgroundImage = 'none';
  }

  // Reseta player e lista de arquivos
  destroyActivePlayer();
  const filesList = document.getElementById('torrent-files-list');
  filesList.innerHTML = `<li style="cursor: default; text-align: center;"><i class="fa-solid fa-circle-notch fa-spin"></i> Conectando ao Torrent...</li>`;

  // 1. Identificar todos os torrents relacionados a esta mesma série (mesmo TMDB ID)
  let relatedMagnets = [];
  if (media.external_id) {
    relatedMagnets = allMediaData.filter(m => m.external_id === media.external_id);
  }
  if (relatedMagnets.length === 0) {
    relatedMagnets = [media];
  }

  try {
    // 2. Carrega os arquivos de todos os torrents relacionados em paralelo
    const fetchPromises = relatedMagnets.map(async (m) => {
      try {
        const res = await fetch(`/api/media/${m.id}/files`, {
          headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        });
        if (res.ok) {
          const json = await res.json();
          return { magnetId: m.id, files: json.files, subtitles: json.subtitles, updatedMedia: json.updatedMedia };
        }
      } catch (e) {
        console.error(`Erro ao carregar arquivos do torrent ID ${m.id}:`, e);
      }
      return null;
    });

    const results = await Promise.all(fetchPromises);
    
    // 3. Compilar todos os arquivos e legendas encontrados e extrair os metadados mais recentes
    const allFiles = [];
    const allSubtitles = [];
    let latestUpdatedMedia = null;

    results.forEach(res => {
      if (res) {
        if (res.updatedMedia) {
          latestUpdatedMedia = res.updatedMedia;
        }

        // Compila as legendas disponíveis no torrent
        if (res.subtitles) {
          res.subtitles.forEach(sub => {
            allSubtitles.push({
              magnetId: res.magnetId,
              index: sub.index,
              name: sub.name,
              path: sub.path
            });
          });
        }

        if (res.files) {
          // Determinar a temporada correspondente a este torrent
          const magnet = relatedMagnets.find(m => m.id === res.magnetId);
          const torrentTitle = magnet ? (magnet.torrent_title || magnet.title || '') : '';

          res.files.forEach(file => {
            // Ignora arquivos muito leves (< 50MB) que não são episódios ou filmes
            if (file.length && file.length < 50 * 1024 * 1024) return;

            const parsed = parseSeasonEpisode(file.name);
            
            let seasonNum = parsed.season;
            let episodeNum = parsed.episode;
            
            // Se o arquivo não indicou nenhuma temporada (ou seja, manteve o default 1),
            // mas o título do torrent indica outra temporada (ex: "2ª Temporada"), usamos a do título!
            const filenameHasSeason = /s\d{1,2}|season\s*\d{1,2}|temporada\s*\d{1,2}/i.test(file.name);
            if (!filenameHasSeason) {
              const torrentSeason = parseSeasonFromTitle(torrentTitle);
              seasonNum = torrentSeason;
            }

            allFiles.push({
              magnetId: res.magnetId,
              fileIndex: file.index,
              name: file.name,
              length: file.length,
              season: seasonNum,
              episode: episodeNum
            });
          });
        }
      }
    });

    // Salva as legendas no escopo global para o player instanciar depois
    currentSubtitles = allSubtitles;

    // Recalcula o tipo de mídia após receber metadados atualizados do backend
    const updatedMediaType = (latestUpdatedMedia && latestUpdatedMedia.media_type) || media.media_type;
    const isMovieNow = updatedMediaType === 'movie';
    const playerContainerSec = document.querySelector('.player-container-section');
    if (isMovieNow) {
      playerContainerSec.classList.add('no-files');
    } else {
      playerContainerSec.classList.remove('no-files');
    }

    // Se o backend atualizou a mídia (ex: descobriu o nome real do torrent e indexou), atualiza o DOM em tempo real
    if (latestUpdatedMedia && latestUpdatedMedia.title && latestUpdatedMedia.title !== media.title) {
      const localIdx = allMediaData.findIndex(m => m.id === media.id);
      if (localIdx !== -1) {
        allMediaData[localIdx] = latestUpdatedMedia;
      }
      
      document.getElementById('detail-title').textContent = latestUpdatedMedia.title;
      document.getElementById('detail-original-title').textContent = latestUpdatedMedia.original_title ? `Título Original: ${latestUpdatedMedia.original_title}` : '';
      document.getElementById('detail-rating').innerHTML = `<i class="fa-solid fa-star"></i> ${latestUpdatedMedia.rating ? latestUpdatedMedia.rating.toFixed(1) : '0.0'}`;
      document.getElementById('detail-release').innerHTML = `<i class="fa-solid fa-calendar"></i> ${latestUpdatedMedia.release_date || 'Desconhecida'}`;
      document.getElementById('detail-genres').textContent = latestUpdatedMedia.genres || 'Sem gêneros informados';
      document.getElementById('detail-synopsis').textContent = latestUpdatedMedia.synopsis || 'Nenhuma sinopse disponível para esta mídia.';
      document.getElementById('detail-studio').textContent = latestUpdatedMedia.studio_or_creators || 'Desconhecido';
      document.getElementById('detail-cast').textContent = latestUpdatedMedia.cast_list || 'Desconhecido';

      const badge = document.getElementById('detail-badge');
      badge.className = 'badge ' + (latestUpdatedMedia.media_type || 'movie');
      const typeMap = { 'movie': 'Filme', 'series': 'Série', 'anime': 'Anime', 'unknown': 'Desconhecido' };
      badge.textContent = typeMap[latestUpdatedMedia.media_type || 'unknown'] || 'Mídia';

      const posterImg = document.getElementById('detail-poster');
      if (latestUpdatedMedia.poster_path) {
        posterImg.src = latestUpdatedMedia.poster_path;
        posterImg.alt = latestUpdatedMedia.title;
      }

      const heroDiv = document.getElementById('details-hero');
      if (latestUpdatedMedia.backdrop_path) {
        heroDiv.style.backgroundImage = `url('${latestUpdatedMedia.backdrop_path}')`;
      }
    }

    filesList.innerHTML = '';

    if (allFiles.length === 0) {
      filesList.innerHTML = `
        <li style="cursor: default; text-align: center; color: var(--danger);">
          <i class="fa-solid fa-triangle-exclamation"></i> Nenhum arquivo de vídeo compatível encontrado.
        </li>
      `;
      return;
    }

    // 4. Se for filme, reproduz automaticamente o primeiro arquivo de vídeo encontrado (ocultando a seção de arquivos)
    if (isMovieNow) {
      const movieFile = allFiles[0];
      initPlayer(media, movieFile.magnetId, movieFile.fileIndex, movieFile.name);
    } else {
      // 5. Se for série/anime, agrupa todos os episódios encontrados por temporada
      const seasonsMap = {};
      allFiles.forEach(file => {
        const s = file.season;
        if (!seasonsMap[s]) seasonsMap[s] = [];
        seasonsMap[s].push(file);
      });

      // Ordenar episódios numericamente
      Object.keys(seasonsMap).forEach(s => {
        seasonsMap[s].sort((a, b) => a.episode - b.episode);
      });

      const sortedSeasons = Object.keys(seasonsMap).map(Number).sort((a, b) => a - b);

      // 6. Criar o dropdown seletor de temporadas
      const select = document.createElement('select');
      select.id = 'season-selector-dropdown';
      select.style.width = '100%';
      select.style.marginBottom = '15px';
      select.style.background = '#121623';
      select.style.color = '#fff';
      select.style.border = '1px solid var(--border-color)';
      select.style.borderRadius = '8px';
      select.style.padding = '10px';
      select.style.fontFamily = 'inherit';
      select.style.fontSize = '0.9rem';

      sortedSeasons.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s;
        opt.textContent = `Temporada ${s}`;
        select.appendChild(opt);
      });

      // Insere o select logo acima da lista de episódios
      filesList.parentNode.insertBefore(select, filesList);

      const renderSeasonEpisodes = (seasonNum) => {
        filesList.innerHTML = '';
        const episodes = seasonsMap[seasonNum] || [];
        episodes.forEach(file => {
          const li = document.createElement('li');
          li.dataset.index = file.fileIndex;
          li.dataset.magnet = file.magnetId;
          
          const sizeGB = (file.length / (1024 * 1024 * 1024)).toFixed(2);
          
          li.innerHTML = `
            <span class="file-name"><i class="fa-solid fa-play-circle" style="color: var(--primary); margin-right: 6px;"></i> Episódio ${file.episode}</span>
            <span class="file-size">${sizeGB} GB</span>
          `;

          li.addEventListener('click', () => {
            document.querySelectorAll('#torrent-files-list li').forEach(el => el.classList.remove('active'));
            li.classList.add('active');
            
            initPlayer(media, file.magnetId, file.fileIndex, file.name);
          });

          filesList.appendChild(li);
        });
      };

      select.addEventListener('change', (e) => {
        renderSeasonEpisodes(parseInt(e.target.value, 10));
      });

      // Renderiza a primeira temporada disponível por padrão
      if (sortedSeasons.length > 0) {
        renderSeasonEpisodes(sortedSeasons[0]);
      }
    }

  } catch (err) {
    filesList.innerHTML = `
      <li style="cursor: default; text-align: center; color: var(--danger); padding: 20px;">
        <i class="fa-solid fa-circle-exclamation" style="margin-bottom: 5px; font-size: 1.2rem;"></i>
        <div>Erro de Conexão Torrent</div>
        <div style="font-size: 0.75rem; margin-top: 5px; opacity: 0.8;">${err.message}</div>
      </li>
    `;
  }
}

// Voltar para o grid principal do catálogo
function backToCatalog() {
  destroyActivePlayer();
  resetDeleteButton();
  document.getElementById('details-section').classList.remove('active');
  document.getElementById('settings-section').classList.remove('active');
  document.getElementById('catalog-section').classList.add('active');
  
  // Atualizar itens ativos na sidebar com base na categoria ativa
  document.querySelectorAll('.sidebar-nav li').forEach(li => li.classList.remove('active'));
  
  const filterToNavId = {
    'all': 'nav-catalog',
    'movie': 'nav-movies',
    'series': 'nav-series',
    'anime': 'nav-animes'
  };
  const activeNavId = filterToNavId[currentCategoryFilter] || 'nav-catalog';
  const activeNavEl = document.getElementById(activeNavId);
  if (activeNavEl) {
    activeNavEl.parentElement.classList.add('active');
  }

  loadCatalog(); // Recarrega para obter atualizações em segundo plano
}

// Reseta o estado visual do botão de exclusão
function resetDeleteButton() {
  const btn = document.getElementById('btn-delete-media');
  if (btn) {
    btn.disabled = false;
    btn.classList.remove('confirm-state');
    btn.innerHTML = '<i class="fa-solid fa-trash"></i> Excluir do Catálogo';
    btn.style.background = '';
  }
}

// Exibe a tela de configurações e busca a chave cadastrada
// Exibe a tela de configurações e busca a chave cadastrada
async function showSettings() {
  destroyActivePlayer();
  document.getElementById('details-section').classList.remove('active');
  document.getElementById('catalog-section').classList.remove('active');
  document.getElementById('settings-section').classList.add('active');

  // Atualizar itens ativos na sidebar
  document.querySelectorAll('.sidebar-nav li').forEach(li => li.classList.remove('active'));
  document.getElementById('nav-settings').parentElement.classList.add('active');

  const keyInput = document.getElementById('settings-tmdb-key');
  const exposureSelect = document.getElementById('settings-exposure-type');
  const ngrokTokenInput = document.getElementById('settings-ngrok-token');
  const ngrokGroup = document.getElementById('ngrok-token-group');
  const infoPanel = document.getElementById('exposure-info-panel');

  keyInput.value = '';
  keyInput.placeholder = 'Carregando chave de API...';
  ngrokTokenInput.value = '';
  infoPanel.style.display = 'none';

  try {
    const res = await fetch('/api/media/settings', {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
    });
    if (res.ok) {
      const data = await res.json();
      keyInput.value = data.tmdbApiKey || '';
      keyInput.placeholder = 'Cole sua API Key do TMDB aqui';
      
      exposureSelect.value = data.exposureType || 'localhost';
      ngrokTokenInput.value = data.ngrokToken || '';

      // Controla a visibilidade do campo de token do ngrok
      if (exposureSelect.value === 'ngrok') {
        ngrokGroup.style.display = 'block';
      } else {
        ngrokGroup.style.display = 'none';
      }

      // Atualiza o estado da transcodificação
      const transcodeCheckbox = document.getElementById('settings-transcode-audio');
      if (transcodeCheckbox) {
        transcodeCheckbox.checked = data.transcodeAudio || false;
      }

      // Atualiza as informações do painel de exposição
      updateExposureInfoPanel(data);
    } else {
      keyInput.placeholder = 'Falha ao carregar configurações do servidor.';
    }
  } catch (err) {
    console.error('Erro ao carregar configurações:', err);
    keyInput.placeholder = 'Erro ao carregar configurações do servidor.';
  }
}

// Atualiza o painel com as URLs e status corretos da exposição do servidor
function updateExposureInfoPanel(data) {
  const infoPanel = document.getElementById('exposure-info-panel');
  const publicUrlText = document.getElementById('exposure-public-url');
  const statusIndicator = document.getElementById('exposure-status-indicator');
  const copyBtn = document.getElementById('btn-copy-exposure-url');

  infoPanel.style.display = 'block';
  statusIndicator.style.background = '#10b981'; // Verde padrão para ativo
  copyBtn.disabled = false;

  const type = data.exposureType || 'localhost';

  if (type === 'localhost') {
    publicUrlText.textContent = 'http://localhost:3000';
    publicUrlText.style.color = 'var(--primary)';
  } else if (type === 'tailscale') {
    if (data.tailscaleIp) {
      publicUrlText.textContent = `http://${data.tailscaleIp}:3000`;
      publicUrlText.style.color = 'var(--primary)';
    } else {
      publicUrlText.textContent = 'Tailscale Offline (Interface de rede VPN 100.x não encontrada)';
      publicUrlText.style.color = 'var(--danger, #f43f5e)';
      statusIndicator.style.background = '#f43f5e'; // Vermelho
      copyBtn.disabled = true;
    }
  } else if (type === 'ngrok') {
    if (data.ngrokUrl) {
      publicUrlText.textContent = data.ngrokUrl;
      publicUrlText.style.color = 'var(--primary)';
    } else {
      publicUrlText.textContent = 'Túnel Ngrok Inativo (Insira seu Authtoken e clique em Salvar)';
      publicUrlText.style.color = 'var(--warning, #f59e0b)';
      statusIndicator.style.background = '#f59e0b'; // Laranja
      copyBtn.disabled = true;
    }
  }
}

// ==================== EVENT LISTENERS E ASSINATURA DE FORMS ==================== //

function setupEventListeners() {
  
  // 1. Alternador da Tela de Autenticação (Login vs Registro)
  const authToggleBtn = document.getElementById('auth-toggle-btn');
  let isRegisterView = false;
  authToggleBtn.addEventListener('click', () => {
    isRegisterView = !isRegisterView;
    const title = document.getElementById('auth-title');
    const subtitle = document.getElementById('auth-subtitle');
    const submitBtn = document.getElementById('auth-submit-btn');
    const toggleText = document.getElementById('auth-toggle-text');

    if (isRegisterView) {
      title.textContent = 'Registrar Conta';
      subtitle.textContent = 'Crie uma nova conta para assistir';
      submitBtn.textContent = 'Registrar';
      toggleText.textContent = 'Já tem uma conta?';
      authToggleBtn.textContent = 'Fazer Login';
    } else {
      title.textContent = 'Fazer Login';
      subtitle.textContent = 'Entre com seus dados para acessar o catálogo';
      submitBtn.textContent = 'Entrar';
      toggleText.textContent = 'Não tem uma conta?';
      authToggleBtn.textContent = 'Registrar-se';
    }
  });

  // 2. Formulário de Autenticação (Submit)
  const authForm = document.getElementById('auth-form');
  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('auth-username').value;
    const password = document.getElementById('auth-password').value;
    
    const endpoint = isRegisterView ? '/api/auth/register' : '/api/auth/login';

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro na requisição');

      localStorage.setItem('token', data.token);
      localStorage.setItem('username', data.username);
      
      showToast(isRegisterView ? 'Conta criada com sucesso!' : 'Login efetuado com sucesso!', 'success');
      authForm.reset();
      checkAuth();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // 3. Botão Logout
  document.getElementById('nav-logout').addEventListener('click', logout);

  // 3.1 Navegação para Configurações
  document.getElementById('nav-settings').addEventListener('click', (e) => {
    e.preventDefault();
    showSettings();
  });

  // 3.2 Salvar formulário de Configurações
  const settingsForm = document.getElementById('settings-form');
  settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const tmdbApiKey = document.getElementById('settings-tmdb-key').value.trim();
    const exposureType = document.getElementById('settings-exposure-type').value;
    const ngrokToken = document.getElementById('settings-ngrok-token').value.trim();
    const transcodeAudio = document.getElementById('settings-transcode-audio').checked;

    // Feedback visual do botão de envio
    const submitBtn = settingsForm.querySelector('button[type="submit"]');
    const originalText = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Salvando Configurações...';

    try {
      const res = await fetch('/api/media/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({ tmdbApiKey, exposureType, ngrokToken, transcodeAudio })
      });
      
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao salvar configurações');

      showToast(data.message || 'Configurações salvas com sucesso!', 'success');
      
      // Atualiza as informações do painel de exposição com a resposta
      updateExposureInfoPanel({
        exposureType,
        tailscaleIp: data.tailscaleIp,
        ngrokUrl: data.ngrokUrl
      });
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalText;
    }
  });

  // Alternador dinâmico do campo de token do Ngrok dependendo do select
  const exposureSelect = document.getElementById('settings-exposure-type');
  const ngrokGroup = document.getElementById('ngrok-token-group');
  exposureSelect.addEventListener('change', () => {
    if (exposureSelect.value === 'ngrok') {
      ngrokGroup.style.display = 'block';
    } else {
      ngrokGroup.style.display = 'none';
    }
  });

  // Copiar link de exposição de acesso para a área de transferência
  document.getElementById('btn-copy-exposure-url').addEventListener('click', () => {
    const url = document.getElementById('exposure-public-url').textContent;
    if (url && !url.includes('Inativo') && !url.includes('Offline')) {
      navigator.clipboard.writeText(url).then(() => {
        showToast('Link de acesso copiado para a área de transferência!', 'success');
      }).catch(err => {
        showToast('Não foi possível copiar o link automaticamente.', 'error');
      });
    }
  });

  // 4. Alternador Manual de Sidebar (Setas)
  const sidebar = document.getElementById('app-sidebar');
  const sidebarToggle = document.getElementById('sidebar-toggle');
  sidebarToggle.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
  });

  // 5. Botões de Abertura/Fechamento do Modal Adicionar Magnet
  const addModal = document.getElementById('add-magnet-modal');
  const openAddBtn = document.getElementById('btn-open-add-modal');
  const closeAddBtn = document.getElementById('btn-close-add-modal');
  const cancelAddBtn = document.getElementById('btn-cancel-add-modal');
  const navAddSide = document.getElementById('nav-add-magnet-side');

  const openAddModal = () => {
    addModal.classList.add('active');
    document.getElementById('magnet-url').focus();
  };
  const closeAddModal = () => {
    addModal.classList.remove('active');
    document.getElementById('add-magnet-form').reset();
  };

  openAddBtn.addEventListener('click', openAddModal);
  navAddSide.addEventListener('click', (e) => {
    e.preventDefault();
    openAddModal();
  });
  closeAddBtn.addEventListener('click', closeAddModal);
  cancelAddBtn.addEventListener('click', closeAddModal);

  // 6. Envio do formulário de Adicionar Magnet
  const addMagnetForm = document.getElementById('add-magnet-form');
  addMagnetForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const magnetUrl = document.getElementById('magnet-url').value;
    const mediaType = document.getElementById('magnet-type').value;

    try {
      const res = await fetch('/api/media', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({ magnetUrl, mediaType })
      });
      
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao salvar magnet');

      showToast(data.message || 'Mídia adicionada com sucesso!', 'success');
      closeAddModal();
      loadCatalog();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // 7. Pesquisa do catálogo local
  const searchInput = document.getElementById('catalog-search');
  searchInput.addEventListener('input', () => {
    const text = searchInput.value.toLowerCase().trim();
    if (!text) {
      renderCatalogGrid(allMediaData);
      return;
    }
    const filtered = allMediaData.filter(item => {
      const title = (item.title || '').toLowerCase();
      const oTitle = (item.original_title || '').toLowerCase();
      const tTitle = (item.torrent_title || '').toLowerCase();
      return title.includes(text) || oTitle.includes(text) || tTitle.includes(text);
    });
    renderCatalogGrid(filtered);
  });

  // 8. Botão Voltar para o Catálogo e Categorias da Sidebar
  document.getElementById('btn-back-to-catalog').addEventListener('click', backToCatalog);

  // Função auxiliar para transicionar de categoria/seção na sidebar
  function switchCategory(filter, navEl) {
    destroyActivePlayer();
    resetDeleteButton();

    currentCategoryFilter = filter;
    document.getElementById('catalog-search').value = '';

    // Exibe catálogo, oculta outros
    document.getElementById('details-section').classList.remove('active');
    document.getElementById('settings-section').classList.remove('active');
    document.getElementById('catalog-section').classList.add('active');

    // Atualizar itens ativos na sidebar
    document.querySelectorAll('.sidebar-nav li').forEach(li => li.classList.remove('active'));
    navEl.parentElement.classList.add('active');

    // Renderiza o grid com as mídias ativas
    renderCatalogGrid(allMediaData);
  }

  document.getElementById('nav-catalog').addEventListener('click', (e) => {
    e.preventDefault();
    switchCategory('all', document.getElementById('nav-catalog'));
  });

  document.getElementById('nav-movies').addEventListener('click', (e) => {
    e.preventDefault();
    switchCategory('movie', document.getElementById('nav-movies'));
  });

  document.getElementById('nav-series').addEventListener('click', (e) => {
    e.preventDefault();
    switchCategory('series', document.getElementById('nav-series'));
  });

  document.getElementById('nav-animes').addEventListener('click', (e) => {
    e.preventDefault();
    switchCategory('anime', document.getElementById('nav-animes'));
  });

  // 9. Deletar mídia ativa (com confirmação inline moderna de dois passos, evitando bloqueios de pop-up do navegador)
  const btnDeleteMedia = document.getElementById('btn-delete-media');
  let deleteConfirmTimeout = null;

  btnDeleteMedia.addEventListener('click', async () => {
    if (!currentMediaId) return;

    const isConfirming = btnDeleteMedia.classList.contains('confirm-state');

    if (!isConfirming) {
      // Primeiro clique: entra em estado de confirmação
      btnDeleteMedia.classList.add('confirm-state');
      btnDeleteMedia.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i> Confirmar Exclusão?';
      btnDeleteMedia.style.background = '#e11d48'; // Destaque vermelho
      
      // Cancela o timeout anterior se houver
      if (deleteConfirmTimeout) clearTimeout(deleteConfirmTimeout);

      // Reseta após 4 segundos se não clicar novamente
      deleteConfirmTimeout = setTimeout(() => {
        resetDeleteButton();
      }, 4000);
    } else {
      // Segundo clique: executa a exclusão
      if (deleteConfirmTimeout) clearTimeout(deleteConfirmTimeout);
      
      btnDeleteMedia.disabled = true;
      btnDeleteMedia.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Excluindo...';

      try {
        const res = await fetch(`/api/media/${currentMediaId}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        });
        
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao excluir mídia');

        showToast(data.message || 'Mídia removida com sucesso!', 'success');
        resetDeleteButton();
        backToCatalog();
      } catch (err) {
        showToast(err.message, 'error');
        resetDeleteButton();
      }
    }
  });

  // 10. Modais de Identificação Manual (TMDB / Jikan)
  const identifyModal = document.getElementById('identify-modal');
  const openIdentifyBtn = document.getElementById('btn-open-identify-modal');
  const closeIdentifyBtn = document.getElementById('btn-close-identify-modal');
  const cancelIdentifyBtn = document.getElementById('btn-cancel-identify-modal');

  const openIdentifyModal = () => {
    identifyModal.classList.add('active');
    document.getElementById('identify-search-input').focus();
  };
  const closeIdentifyModal = () => {
    identifyModal.classList.remove('active');
    document.getElementById('identify-form').reset();
    document.getElementById('search-results-group').style.display = 'none';
    document.getElementById('identify-results-select').innerHTML = '';
  };

  openIdentifyBtn.addEventListener('click', openIdentifyModal);
  closeIdentifyBtn.addEventListener('click', closeIdentifyModal);
  cancelIdentifyBtn.addEventListener('click', closeIdentifyModal);

  // 10.1 Buscar Mídias Externas por Nome
  const btnSearchMetadata = document.getElementById('btn-search-metadata');
  btnSearchMetadata.addEventListener('click', async () => {
    const query = document.getElementById('identify-search-input').value.trim();
    const source = document.getElementById('identify-source').value;
    const type = document.getElementById('identify-type').value;

    if (!query) {
      showToast('Por favor, digite o nome da mídia que deseja buscar.', 'warning');
      return;
    }

    btnSearchMetadata.disabled = true;
    btnSearchMetadata.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Buscando...';

    try {
      const res = await fetch(`/api/media/search-external?query=${encodeURIComponent(query)}&source=${source}&type=${type}`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha na busca.');

      const resultsSelect = document.getElementById('identify-results-select');
      const resultsGroup = document.getElementById('search-results-group');

      resultsSelect.innerHTML = '';

      if (data.length === 0) {
        resultsGroup.style.display = 'none';
        showToast('Nenhuma mídia encontrada com este nome.', 'warning');
      } else {
        resultsGroup.style.display = 'block';
        
        const defaultOpt = document.createElement('option');
        defaultOpt.value = '';
        defaultOpt.textContent = '-- Selecione o Item Correto --';
        resultsSelect.appendChild(defaultOpt);

        data.forEach(item => {
          const opt = document.createElement('option');
          opt.value = item.id;
          opt.textContent = `${item.title} (${item.year})`;
          resultsSelect.appendChild(opt);
        });
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btnSearchMetadata.disabled = false;
      btnSearchMetadata.innerHTML = 'Buscar';
    }
  });

  // 10.2 Seleção Automática do ID ao mudar o select de resultados
  const resultsSelect = document.getElementById('identify-results-select');
  resultsSelect.addEventListener('change', () => {
    const selectedId = resultsSelect.value;
    if (selectedId) {
      document.getElementById('identify-id').value = selectedId;
    }
  });

  // Envio da Reindexação manual
  const identifyForm = document.getElementById('identify-form');
  identifyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const source = document.getElementById('identify-source').value;
    const externalId = document.getElementById('identify-id').value;
    const mediaType = document.getElementById('identify-type').value;

    if (!currentMediaId) return;

    // Desativa botão de envio para mostrar feedback visual
    const submitBtn = identifyForm.querySelector('button[type="submit"]');
    const originalText = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Reindexando...';

    try {
      const res = await fetch(`/api/media/${currentMediaId}/identify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({ source, externalId, mediaType })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao reindexar');

      showToast(data.message || 'Mídia reindexada com sucesso!', 'success');
      closeIdentifyModal();
      
      // Busca os metadados atualizados imediatamente do backend
      try {
        const catRes = await fetch('/api/media', {
          headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        });
        if (catRes.ok) {
          allMediaData = await catRes.json();
          const updatedItem = allMediaData.find(item => item.id === currentMediaId);
          if (updatedItem) {
            showDetails(updatedItem);
          }
        }
      } catch (e) {
        console.error('Erro ao recarregar detalhes:', e);
      }

    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalText;
    }
  });
}
