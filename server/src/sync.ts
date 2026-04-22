import { db, setMeta } from "./db.js";
import { config } from "./config.js";
import {
  discoverByProvider,
  fetchGenres,
  fetchProvidersForRegion,
  type MediaType,
  type TmdbDiscoverResult,
  type TmdbProvider,
} from "./tmdb.js";

const PROVIDER_KEYS = ["netflix", "disneyPlus", "hboMax"] as const;
type ProviderKey = (typeof PROVIDER_KEYS)[number];

interface ResolvedProvider {
  key: ProviderKey;
  id: number;
  name: string;
  logo_path: string | null;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findProvider(list: TmdbProvider[], wantedName: string): TmdbProvider | undefined {
  const wanted = normalize(wantedName);
  const exact = list.find((p) => normalize(p.provider_name) === wanted);
  if (exact) return exact;
  // fallbacks for rebrands: "HBO Max" <-> "Max"
  if (wanted === "hbomax") {
    return (
      list.find((p) => normalize(p.provider_name) === "max") ??
      list.find((p) => normalize(p.provider_name).includes("hbomax"))
    );
  }
  return list.find((p) => normalize(p.provider_name).includes(wanted));
}

async function resolveProviders(): Promise<ResolvedProvider[]> {
  // Provider IDs are shared across movie/tv in TMDB's catalog, but we fetch the movie list
  // because it's the most comprehensive for NL.
  const list = await fetchProvidersForRegion("movie");
  const resolved: ResolvedProvider[] = [];
  for (const key of PROVIDER_KEYS) {
    const wanted = config.providerNames[key];
    const found = findProvider(list, wanted);
    if (!found) {
      throw new Error(`Could not resolve provider "${wanted}" in TMDB region ${config.region}`);
    }
    resolved.push({
      key,
      id: found.provider_id,
      name: found.provider_name,
      logo_path: found.logo_path,
    });
  }
  return resolved;
}

function yearFromDate(date: string | undefined): number | null {
  if (!date) return null;
  const y = Number(date.slice(0, 4));
  return Number.isFinite(y) && y > 1800 ? y : null;
}

const upsertTitle = db.prepare(`
  INSERT INTO titles (
    tmdb_id, media_type, title, original_title, overview, release_date, release_year,
    poster_path, backdrop_path, vote_average, vote_count, popularity, original_language
  ) VALUES (
    @tmdb_id, @media_type, @title, @original_title, @overview, @release_date, @release_year,
    @poster_path, @backdrop_path, @vote_average, @vote_count, @popularity, @original_language
  )
  ON CONFLICT(tmdb_id, media_type) DO UPDATE SET
    title = excluded.title,
    original_title = excluded.original_title,
    overview = excluded.overview,
    release_date = excluded.release_date,
    release_year = excluded.release_year,
    poster_path = excluded.poster_path,
    backdrop_path = excluded.backdrop_path,
    vote_average = excluded.vote_average,
    vote_count = excluded.vote_count,
    popularity = excluded.popularity,
    original_language = excluded.original_language
`);

const deleteTitleGenres = db.prepare(`DELETE FROM title_genres WHERE tmdb_id = ? AND media_type = ?`);
const insertTitleGenre = db.prepare(
  `INSERT OR IGNORE INTO title_genres (tmdb_id, media_type, genre_id) VALUES (?, ?, ?)`,
);
const insertAvailability = db.prepare(
  `INSERT OR IGNORE INTO availability (tmdb_id, media_type, provider_id) VALUES (?, ?, ?)`,
);

function persistTitle(item: TmdbDiscoverResult, mediaType: MediaType, providerId: number): void {
  const title = mediaType === "movie" ? item.title ?? item.original_title ?? "" : item.name ?? item.original_name ?? "";
  const originalTitle = mediaType === "movie" ? item.original_title ?? null : item.original_name ?? null;
  const releaseDate = mediaType === "movie" ? item.release_date ?? null : item.first_air_date ?? null;

  upsertTitle.run({
    tmdb_id: item.id,
    media_type: mediaType,
    title,
    original_title: originalTitle,
    overview: item.overview ?? null,
    release_date: releaseDate,
    release_year: yearFromDate(releaseDate ?? undefined),
    poster_path: item.poster_path,
    backdrop_path: item.backdrop_path,
    vote_average: item.vote_average ?? 0,
    vote_count: item.vote_count ?? 0,
    popularity: item.popularity ?? 0,
    original_language: item.original_language,
  });

  deleteTitleGenres.run(item.id, mediaType);
  for (const genreId of item.genre_ids ?? []) {
    insertTitleGenre.run(item.id, mediaType, genreId);
  }

  insertAvailability.run(item.id, mediaType, providerId);
}

async function syncGenres(): Promise<void> {
  const insert = db.prepare(`
    INSERT INTO genres (id, media_type, name) VALUES (?, ?, ?)
    ON CONFLICT(id, media_type) DO UPDATE SET name = excluded.name
  `);
  const mediaTypes: MediaType[] = ["movie", "tv"];
  for (const mt of mediaTypes) {
    const genres = await fetchGenres(mt);
    const tx = db.transaction((rows: typeof genres) => {
      for (const g of rows) insert.run(g.id, mt, g.name);
    });
    tx(genres);
  }
}

function upsertProviders(providers: ResolvedProvider[]): void {
  const insert = db.prepare(`
    INSERT INTO providers (id, key, name, logo_path) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET key = excluded.key, name = excluded.name, logo_path = excluded.logo_path
  `);
  const tx = db.transaction((rows: ResolvedProvider[]) => {
    for (const p of rows) insert.run(p.id, p.key, p.name, p.logo_path);
  });
  tx(providers);
}

export interface SyncProgress {
  provider: string;
  mediaType: MediaType;
  count: number;
}

export interface SyncResult {
  providers: ResolvedProvider[];
  totalTitles: number;
  totalAvailability: number;
  durationMs: number;
}

let inFlight: Promise<SyncResult> | null = null;

export function isSyncing(): boolean {
  return inFlight !== null;
}

export function triggerSync(onProgress?: (p: SyncProgress) => void): Promise<SyncResult> {
  if (inFlight) return inFlight;
  inFlight = runSync(onProgress).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runSync(onProgress?: (p: SyncProgress) => void): Promise<SyncResult> {
  const started = Date.now();

  const providers = await resolveProviders();
  upsertProviders(providers);

  await syncGenres();

  // Clear availability so titles that left a service disappear.
  db.prepare("DELETE FROM availability").run();

  for (const provider of providers) {
    for (const mediaType of ["movie", "tv"] as MediaType[]) {
      let count = 0;
      const batch: TmdbDiscoverResult[] = [];
      const BATCH_SIZE = 100;
      const flush = (): void => {
        if (batch.length === 0) return;
        const tx = db.transaction((items: TmdbDiscoverResult[]) => {
          for (const item of items) persistTitle(item, mediaType, provider.id);
        });
        tx(batch);
        batch.length = 0;
      };

      for await (const item of discoverByProvider(mediaType, provider.id)) {
        batch.push(item);
        count++;
        if (batch.length >= BATCH_SIZE) flush();
      }
      flush();
      onProgress?.({ provider: provider.name, mediaType, count });
    }
  }

  // Prune titles that no longer have any availability (left all services).
  db.prepare(`
    DELETE FROM titles
    WHERE NOT EXISTS (
      SELECT 1 FROM availability a
      WHERE a.tmdb_id = titles.tmdb_id AND a.media_type = titles.media_type
    )
  `).run();

  const totalTitles = (db.prepare("SELECT COUNT(*) AS n FROM titles").get() as { n: number }).n;
  const totalAvailability = (db.prepare("SELECT COUNT(*) AS n FROM availability").get() as { n: number }).n;
  const durationMs = Date.now() - started;

  setMeta("last_sync_at", new Date().toISOString());
  setMeta("last_sync_duration_ms", String(durationMs));
  setMeta("last_sync_titles", String(totalTitles));

  return { providers, totalTitles, totalAvailability, durationMs };
}
