import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
// Default ~8 MB is too small on the Pi: the daily sync write-storm evicts the
// hot read pages, so the first /api/titles after a sync is cold. 64 MB holds
// the whole hot working set comfortably.
db.pragma("cache_size = -65536");

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

  -- Profiles exist to scope marks for a future multi-profile feature. For
  -- now there's a single seeded 'default' row and all operations target it.
  CREATE TABLE IF NOT EXISTS profiles (
    id         INTEGER PRIMARY KEY,
    key        TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  INSERT OR IGNORE INTO profiles (id, key, name) VALUES (1, 'default', 'Default');

  CREATE TABLE IF NOT EXISTS marks (
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    tmdb_id    INTEGER NOT NULL,
    media_type TEXT    NOT NULL CHECK (media_type IN ('movie','tv')),
    watchlist  INTEGER NOT NULL DEFAULT 0,
    seen       INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (profile_id, media_type, tmdb_id)
  );

  CREATE INDEX IF NOT EXISTS idx_marks_profile ON marks(profile_id);

  -- Wishlist: titles a profile wants to be notified about when they arrive
  -- on one of the tracked streamers. last_seen_available is the arming
  -- mechanism: NULL means "not currently available, will fire on arrival";
  -- a timestamp means "currently available, no notification pending". The
  -- sync clears the timestamp when a title leaves all tracked streamers so
  -- a later re-arrival fires fresh.
  CREATE TABLE IF NOT EXISTS wishlist (
    profile_id          INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    tmdb_id             INTEGER NOT NULL,
    media_type          TEXT    NOT NULL CHECK (media_type IN ('movie','tv')),
    title               TEXT    NOT NULL,
    poster_path         TEXT,
    release_year        INTEGER,
    overview            TEXT,
    original_language   TEXT,
    last_seen_available TEXT,
    added_at            TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (profile_id, media_type, tmdb_id)
  );

  CREATE INDEX IF NOT EXISTS idx_wishlist_title ON wishlist(media_type, tmdb_id);

  CREATE TABLE IF NOT EXISTS notifications (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id     INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    tmdb_id        INTEGER NOT NULL,
    media_type     TEXT    NOT NULL CHECK (media_type IN ('movie','tv')),
    provider_ids   TEXT    NOT NULL,
    title_snapshot TEXT    NOT NULL,
    poster_path    TEXT,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    read_at        TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_notifications_profile ON notifications(profile_id, read_at, created_at DESC);
`);

/**
 * Fallback profile id used when a request doesn't specify one. Picks the
 * oldest profile by creation order — works regardless of whether the seeded
 * 'default' row still exists, so any profile can be deleted as long as at
 * least one remains.
 */
export function defaultProfileId(): number {
  const row = db
    .prepare("SELECT id FROM profiles ORDER BY created_at, id LIMIT 1")
    .get() as { id: number } | undefined;
  if (!row) throw new Error("no profiles in database");
  return row.id;
}

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

// Touches the pages needed for the common /api/titles read path so SQLite's
// own cache (and the OS page cache) is warm. Cheap (<100ms). Run once at
// startup and again after each sync — both moments leave the read pages cold.
export function warmReadCache(): void {
  db.prepare("SELECT COUNT(*) FROM titles").get();
  db.prepare("SELECT tmdb_id, media_type FROM titles ORDER BY popularity DESC LIMIT 60").all();
  db.prepare("SELECT tmdb_id, media_type, genre_id FROM title_genres").all();
  db.prepare("SELECT tmdb_id, media_type, provider_id FROM availability").all();
}

warmReadCache();
