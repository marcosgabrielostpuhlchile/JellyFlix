import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

// Obter caminhos relativos no ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.resolve(__dirname, process.env.DATABASE_PATH || 'database.sqlite');
const db = new Database(dbPath);

// Ativar chaves estrangeiras
db.pragma('foreign_keys = ON');

// Criar tabelas necessárias para o sistema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS magnets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    magnet_url TEXT UNIQUE NOT NULL,
    info_hash TEXT UNIQUE,
    title TEXT,
    media_type TEXT DEFAULT 'unknown', -- 'movie', 'series', 'anime', 'unknown'
    status TEXT DEFAULT 'pending', -- 'pending', 'indexing', 'indexed', 'failed'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS metadata (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    magnet_id INTEGER UNIQUE NOT NULL,
    external_id TEXT, -- ID do TMDB ou MyAnimeList (Jikan)
    source TEXT, -- 'tmdb' ou 'jikan'
    title TEXT,
    original_title TEXT,
    synopsis TEXT,
    poster_path TEXT,
    backdrop_path TEXT,
    rating REAL,
    release_date TEXT,
    genres TEXT, -- Comma-separated
    studio_or_creators TEXT,
    cast_list TEXT, -- Elenco principal
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(magnet_id) REFERENCES magnets(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Migração para adicionar a coluna 'files' (cache de arquivos do torrent) caso não exista
try {
  db.exec('ALTER TABLE magnets ADD COLUMN files TEXT');
} catch (e) {
  // Coluna já existe, ignorar
}

export default db;
