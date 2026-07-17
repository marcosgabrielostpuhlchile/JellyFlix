# 🎬 JeelyFlix

O **JeelyFlix** é um Web App premium para streaming P2P direto de links magnet (torrents). Ele resolve os metadados das mídias automaticamente, agrupa episódios de séries por temporada e permite transmitir vídeos direto no navegador em um player premium com recursos avançados.

---

## ✨ Funcionalidades

- **Streaming P2P Instantâneo:** Assista a vídeos diretamente de magnet links sem precisar baixar o arquivo completo primeiro.
- **Indexação Inteligente (TMDB & Jikan API):** O sistema limpa os títulos dos torrents, remove tags de qualidade/ano e busca sinopse, elenco, poster e backdrop oficial automaticamente.
- **Agrupamento Multi-Torrent por Temporadas:** Agrupa múltiplos links torrent de temporadas diferentes sob um único card na página inicial e exibe um menu dropdown de seleção de temporadas na tela de detalhes.
- **Filtro de Arquivos Leves:** Oculta automaticamente arquivos promocionais, trailers ou arquivos de amostras (samples) menores que 50MB.
- **Cache Resiliente de Arquivos (SQLite):** Salva a listagem de arquivos localmente. Se o torrent estiver offline ou demorando para responder aos peers, a lista de episódios carrega instantaneamente do cache local.
- **Painel de Exposição de Rede:**
  - **Localhost:** Acesso local padrão.
  - **Tailscale VPN:** Detecta automaticamente o endereço IP da máquina na rede segura Tailscale para assistir em celulares/TVs na mesma rede VPN.
  - **Ngrok Tunnel:** Dispara e desliga túneis públicos HTTPS seguros do Ngrok diretamente da tela de configurações com status e botão de cópia do link.
- **Player Premium (Plyr.js):** Controle avançado de reprodução, velocidade, volume e atalhos de teclado.
- **Autenticação Segura:** Sistema de Login e Registro JWT integrado.

---

## 🛠️ Tecnologias Utilizadas

### Frontend
- HTML5 (Estrutura Semântica)
- CSS3 (Variáveis, Grid, Flexbox, Animações e Design Glassmorphic)
- JavaScript (ES6 Modules, Vanilla JS, SPA)
- [Plyr.js](https://plyr.io/) (Player de vídeo premium)

### Backend
- Node.js (ES Modules)
- Express.js (Rotas e API RESTful)
- WebTorrent (Cliente de Torrent em segundo plano)
- better-sqlite3 (Banco de dados leve e veloz)
- Axios (Busca de metadados das APIs)

---

## 🚀 Como Executar o Projeto

### Pré-requisitos
- Node.js instalado (versão 18 ou superior recomendada).

### Passo a Passo

1. **Instale as dependências na pasta do backend:**
   ```bash
   cd backend
   npm install
   ```

2. **Crie um arquivo `.env` na pasta `backend` com as configurações:**
   ```env
   PORT=3000
   DATABASE_PATH=database.sqlite
   JWT_SECRET=sua_chave_secreta_jwt
   ```

3. **Inicie o servidor de desenvolvimento:**
   ```bash
   npm run dev
   ```

4. **Acesse a aplicação no seu navegador:**
   - Abra [http://localhost:3000](http://localhost:3000).
   - Registre uma conta nova ou faça login e comece a adicionar seus magnets!
