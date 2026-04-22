import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS titles (
    tmdb_id       INTEGER NOT NULL,
    media_type    TEXT    NOT NULL CHECK (media_type IN ('movie','tv')),
    title         TEXT    NOT NULL,
    original_title TEXT,
    overview      TEXT,
    release_date  TEXT,
    release_year  INTEGER,
    poster_path   TEXT,
    backdrop_path TEXT,
    vote_average  REAL,
    vote_count    INTEGER,
    popularity    REAL,
    original_language TEXT,
    PRIMARY KEY (tmdb_id, media_type)
  );

  CREATE INDEX IF NOT EXISTS idx_titles_popularity ON titles(popularity DESC);
  CREATE INDEX IF NOT EXISTS idx_titles_vote ON titles(vote_average DESC);
  CREATE INDEX IF NOT EXISTS idx_titles_year ON titles(release_year DESC);
  CREATE INDEX IF NOT EXISTS idx_titles_media ON titles(media_type);

  CREATE TABLE IF NOT EXISTS title_genres (
    tmdb_id    INTEGER NOT NULL,
    media_type TEXT    NOT NULL,
    genre_id   INTEGER NOT NULL,
    PRIMARY KEY (tmdb_id, media_type, genre_id),
    FOREIGN KEY (tmdb_id, media_type) REFERENCES titles(tmdb_id, media_type) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_title_genres_genre ON title_genres(genre_id);

  CREATE TABLE IF NOT EXISTS availability (
    tmdb_id     INTEGER NOT NULL,
    media_type  TEXT    NOT NULL,
    provider_id INTEGER NOT NULL,
    monetization TEXT  NOT NULL DEFAULT 'flatrate',
    PRIMARY KEY (tmdb_id, media_type, provider_id),
    FOREIGN KEY (tmdb_id, media_type) REFERENCES titles(tmdb_id, media_type) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_availability_provider ON availability(provider_id);

  CREATE TABLE IF NOT EXISTS genres (
    id    INTEGER NOT NULL,
    media_type TEXT NOT NULL CHECK (media_type IN ('movie','tv')),
    name  TEXT NOT NULL,
    PRIMARY KEY (id, media_type)
  );

  CREATE TABLE IF NOT EXISTS providers (
    id   INTEGER PRIMARY KEY,
    key  TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    logo_path TEXT
  );

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Migration: add monetization column to pre-existing availability tables. CREATE TABLE
// IF NOT EXISTS above is a no-op when the table already exists, so we need an explicit
// ALTER. Must happen before any index referencing the column is created.
const availabilityCols = db.prepare("PRAGMA table_info(availability)").all() as { name: string }[];
if (!availabilityCols.some((c) => c.name === "monetization")) {
  db.exec(`ALTER TABLE availability ADD COLUMN monetization TEXT NOT NULL DEFAULT 'flatrate'`);
}

db.exec(`CREATE INDEX IF NOT EXISTS idx_availability_monetization ON availability(monetization)`);

export function setMeta(key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}

export function getMeta(key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}
