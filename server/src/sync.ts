import { db, setMeta, warmReadCache } from "./db.js";
import { config } from "./config.js";
import {
  discoverAllForProvider,
  fetchGenres,
  fetchProvidersForRegion,
  type MediaType,
  type TmdbDiscoverResult,
  type TmdbProvider,
} from "./tmdb.js";

const PROVIDER_KEYS = ["netflix", "disneyPlus", "hboMax", "ziggoTv"] as const;
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
  `INSERT OR IGNORE INTO availability (tmdb_id, media_type, provider_id, monetization) VALUES (?, ?, ?, ?)`,
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

  insertAvailability.run(item.id, mediaType, providerId, "flatrate");
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
      const items = await discoverAllForProvider(mediaType, provider.id);
      const tx = db.transaction((rows: TmdbDiscoverResult[]) => {
        for (const row of rows) persistTitle(row, mediaType, provider.id);
      });
      tx(items);
      onProgress?.({ provider: provider.name, mediaType, count: items.length });
    }
  }

  fireWishlistArrivals();

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

  // Sync rewrites availability and a chunk of titles; reload the hot read
  // pages so the first /api/titles after a sync isn't cold.
  warmReadCache();

  return { providers, totalTitles, totalAvailability, durationMs };
}

interface ArrivalRow {
  profile_id: number;
  tmdb_id: number;
  media_type: "movie" | "tv";
  title: string;
  poster_path: string | null;
  provider_ids: string | null;
}

/**
 * After the catalog has been rebuilt, fire notifications for wishlist
 * entries whose title is now on a tracked streamer for the first time
 * since they were added (or since they last left). Auto-removes the
 * wishlist row on fire. For rows that did not fire, refreshes the
 * last_seen_available timestamp (still available) or clears it (no
 * longer available, arming a future re-arrival notification).
 *
 * Step ordering matters: arrival selection must run before the
 * UPDATE pass, otherwise we'd arm-then-immediately-fire freshly added
 * wishlist entries that are already in the catalog.
 */
function fireWishlistArrivals(): void {
  const tx = db.transaction(() => {
    const arrivals = db
      .prepare(
        `
        SELECT w.profile_id, w.media_type, w.tmdb_id, w.title, w.poster_path,
               (SELECT GROUP_CONCAT(a.provider_id) FROM availability a
                WHERE a.media_type = w.media_type AND a.tmdb_id = w.tmdb_id) AS provider_ids
        FROM wishlist w
        WHERE w.last_seen_available IS NULL
          AND EXISTS (
            SELECT 1 FROM availability a
            WHERE a.media_type = w.media_type AND a.tmdb_id = w.tmdb_id
          )
      `,
      )
      .all() as ArrivalRow[];

    const insertNotification = db.prepare(`
      INSERT INTO notifications (profile_id, tmdb_id, media_type, provider_ids, title_snapshot, poster_path)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const deleteWishlist = db.prepare(
      `DELETE FROM wishlist WHERE profile_id = ? AND media_type = ? AND tmdb_id = ?`,
    );
    for (const a of arrivals) {
      insertNotification.run(a.profile_id, a.tmdb_id, a.media_type, a.provider_ids ?? "", a.title, a.poster_path);
      deleteWishlist.run(a.profile_id, a.media_type, a.tmdb_id);
    }

    db.prepare(
      `
      UPDATE wishlist SET last_seen_available = CASE
        WHEN EXISTS (
          SELECT 1 FROM availability a
          WHERE a.media_type = wishlist.media_type AND a.tmdb_id = wishlist.tmdb_id
        ) THEN datetime('now')
        ELSE NULL
      END
    `,
    ).run();

    if (arrivals.length > 0) {
      console.log(`wishlist: fired ${arrivals.length} arrival notification(s)`);
    }
  });
  tx();
}
