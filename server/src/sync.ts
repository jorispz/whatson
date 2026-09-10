import { db, setMeta, warmReadCache } from "./db.js";
import { config } from "./config.js";
import {
  discoverAllForProvider,
  fetchGenres,
  fetchProvidersForRegion,
  fetchTitleFull,
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

/**
 * Resolve the tracked providers' TMDB ids by name. Provider ids are shared
 * across movie/tv, but TMDB's per-region lists are not always complete (the
 * NL movie list has been observed to come back empty while the tv list was
 * fine), so both are merged. A provider missing from both falls back to the
 * row stored by the previous sync, so a TMDB data hiccup on one endpoint
 * doesn't block refreshing the whole catalog.
 */
async function resolveProviders(): Promise<ResolvedProvider[]> {
  const [movies, tv] = await Promise.all([fetchProvidersForRegion("movie"), fetchProvidersForRegion("tv")]);
  const byId = new Map<number, TmdbProvider>();
  for (const p of [...movies, ...tv]) byId.set(p.provider_id, p);
  const list = [...byId.values()];

  const stored = db.prepare("SELECT id, key, name, logo_path FROM providers WHERE key = ?");
  const resolved: ResolvedProvider[] = [];
  for (const key of PROVIDER_KEYS) {
    const wanted = config.providerNames[key];
    const found = findProvider(list, wanted);
    if (found) {
      resolved.push({ key, id: found.provider_id, name: found.provider_name, logo_path: found.logo_path });
      continue;
    }
    const previous = stored.get(key) as Omit<ResolvedProvider, "key"> | undefined;
    if (!previous) {
      throw new Error(`Could not resolve provider "${wanted}" in TMDB region ${config.region}`);
    }
    console.warn(`sync: "${wanted}" missing from TMDB's ${config.region} provider lists; reusing stored id ${previous.id}`);
    resolved.push({ key, ...previous });
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

// Persist a title (and its genres) into the local catalog. When providerId is
// null the title row goes in without an availability row — used to back
// watchlist entries that aren't on any tracked streamer.
export function persistTitle(
  item: TmdbDiscoverResult,
  mediaType: MediaType,
  providerId: number | null = null,
): void {
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

  if (providerId !== null) {
    insertAvailability.run(item.id, mediaType, providerId, "flatrate");
  }
}

/**
 * Fetch full TMDB metadata for every watchlist title that the provider walks
 * did not cover — i.e. titles people are tracking that aren't on any tracked
 * streamer right now. Keeps popularity / rating / release_year fresh on
 * watchlist-only entries so the watchlist sorts correctly, and heals legacy
 * orphan marks. Failures are logged and skipped: one missing TMDB entry
 * shouldn't take down the whole sync.
 */
async function fetchWatchlistOnlyTitles(
  covered: Set<string>,
): Promise<{ mediaType: MediaType; item: TmdbDiscoverResult }[]> {
  const rows = db
    .prepare("SELECT DISTINCT media_type, tmdb_id FROM marks WHERE watchlist = 1")
    .all() as { media_type: MediaType; tmdb_id: number }[];
  const out: { mediaType: MediaType; item: TmdbDiscoverResult }[] = [];
  let failed = 0;
  for (const { media_type, tmdb_id } of rows) {
    if (covered.has(`${media_type}:${tmdb_id}`)) continue;
    try {
      out.push({ mediaType: media_type, item: await fetchTitleFull(media_type, tmdb_id) });
    } catch (err) {
      failed++;
      console.error(`watchlist refresh: ${media_type}/${tmdb_id} failed:`, err);
    }
  }
  if (out.length > 0 || failed > 0) {
    console.log(`watchlist refresh: ${out.length} ok${failed ? `, ${failed} failed` : ""}`);
  }
  return out;
}

const upsertGenre = db.prepare(`
  INSERT INTO genres (id, media_type, name) VALUES (?, ?, ?)
  ON CONFLICT(id, media_type) DO UPDATE SET name = excluded.name
`);

function upsertProviders(providers: ResolvedProvider[]): void {
  const insert = db.prepare(`
    INSERT INTO providers (id, key, name, logo_path) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET key = excluded.key, name = excluded.name, logo_path = excluded.logo_path
  `);
  for (const p of providers) insert.run(p.id, p.key, p.name, p.logo_path);
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

interface ProviderWalk {
  provider: ResolvedProvider;
  mediaType: MediaType;
  items: TmdbDiscoverResult[];
}

/**
 * Two phases. Everything that talks to TMDB happens first and touches nothing
 * in the database; then the catalog is rebuilt inside a single transaction.
 * A failed or interrupted fetch therefore leaves the previous catalog intact,
 * and readers never observe the half-rebuilt state that a delete-then-refill
 * across awaits would expose.
 */
async function runSync(onProgress?: (p: SyncProgress) => void): Promise<SyncResult> {
  const started = Date.now();

  const providers = await resolveProviders();
  const genres = await Promise.all(
    (["movie", "tv"] as MediaType[]).map(async (mt) => ({ mediaType: mt, list: await fetchGenres(mt) })),
  );

  const walks: ProviderWalk[] = [];
  const covered = new Set<string>();
  for (const provider of providers) {
    for (const mediaType of ["movie", "tv"] as MediaType[]) {
      const items = await discoverAllForProvider(mediaType, provider.id);
      walks.push({ provider, mediaType, items });
      for (const item of items) covered.add(`${mediaType}:${item.id}`);
      onProgress?.({ provider: provider.name, mediaType, count: items.length });
    }
  }
  const watchlistOnly = await fetchWatchlistOnlyTitles(covered);

  const rebuild = db.transaction((): { totalTitles: number; totalAvailability: number } => {
    upsertProviders(providers);
    for (const { mediaType, list } of genres) {
      for (const g of list) upsertGenre.run(g.id, mediaType, g.name);
    }

    // Clear availability so titles that left a service disappear.
    db.prepare("DELETE FROM availability").run();
    for (const { provider, mediaType, items } of walks) {
      for (const item of items) persistTitle(item, mediaType, provider.id);
    }
    for (const { mediaType, item } of watchlistOnly) persistTitle(item, mediaType);

    fireWatchlistArrivals();

    // Prune titles that no longer have any availability AND aren't backed by
    // a watchlist mark. Watchlist-only titles intentionally live in the
    // catalog (without availability rows) so the watchlist grid can sort and
    // filter on real popularity / rating / year data.
    db.prepare(`
      DELETE FROM titles
      WHERE NOT EXISTS (
        SELECT 1 FROM availability a
        WHERE a.tmdb_id = titles.tmdb_id AND a.media_type = titles.media_type
      )
      AND NOT EXISTS (
        SELECT 1 FROM marks m
        WHERE m.watchlist = 1
          AND m.tmdb_id = titles.tmdb_id AND m.media_type = titles.media_type
      )
    `).run();

    const totalTitles = (db.prepare("SELECT COUNT(*) AS n FROM titles").get() as { n: number }).n;
    const totalAvailability = (db.prepare("SELECT COUNT(*) AS n FROM availability").get() as { n: number }).n;
    setMeta("last_sync_at", new Date().toISOString());
    setMeta("last_sync_duration_ms", String(Date.now() - started));
    setMeta("last_sync_titles", String(totalTitles));
    return { totalTitles, totalAvailability };
  });
  const { totalTitles, totalAvailability } = rebuild();
  const durationMs = Date.now() - started;

  // Sync rewrites availability and a chunk of titles; reload the hot read
  // pages so the first /api/titles after a sync isn't cold.
  warmReadCache();

  return { providers, totalTitles, totalAvailability, durationMs };
}

interface ArrivalRow {
  profile_id: number;
  tmdb_id: number;
  media_type: "movie" | "tv";
  title: string | null;
  poster_path: string | null;
  provider_ids: string | null;
}

/**
 * After the catalog has been rebuilt, fire notifications for watchlist
 * marks whose title is now on a tracked streamer for the first time since
 * they were added (or since they last left). The mark row stays — unlike
 * the legacy wishlist this isn't a one-shot tracker; the user still wants
 * to watch the title after being notified.
 *
 * For all watchlist marks, refresh last_seen_available: a timestamp if the
 * title is currently available (so it doesn't fire again on the next sync),
 * NULL otherwise (armed for the next arrival).
 *
 * Step ordering matters: arrival selection must run before the UPDATE pass,
 * otherwise we'd arm-then-immediately-fire freshly added marks for titles
 * that are already in the catalog.
 */
function fireWatchlistArrivals(): void {
  const tx = db.transaction(() => {
    const arrivals = db
      .prepare(
        `
        SELECT m.profile_id, m.media_type, m.tmdb_id, m.title, m.poster_path,
               (SELECT GROUP_CONCAT(a.provider_id) FROM availability a
                WHERE a.media_type = m.media_type AND a.tmdb_id = m.tmdb_id) AS provider_ids
        FROM marks m
        WHERE m.watchlist = 1
          AND m.last_seen_available IS NULL
          AND EXISTS (
            SELECT 1 FROM availability a
            WHERE a.media_type = m.media_type AND a.tmdb_id = m.tmdb_id
          )
      `,
      )
      .all() as ArrivalRow[];

    const insertNotification = db.prepare(`
      INSERT INTO notifications (profile_id, tmdb_id, media_type, provider_ids, title_snapshot, poster_path)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const a of arrivals) {
      insertNotification.run(
        a.profile_id,
        a.tmdb_id,
        a.media_type,
        a.provider_ids ?? "",
        a.title ?? "",
        a.poster_path,
      );
    }

    db.prepare(
      `
      UPDATE marks SET last_seen_available = CASE
        WHEN EXISTS (
          SELECT 1 FROM availability a
          WHERE a.media_type = marks.media_type AND a.tmdb_id = marks.tmdb_id
        ) THEN datetime('now')
        ELSE NULL
      END
      WHERE watchlist = 1
    `,
    ).run();

    if (arrivals.length > 0) {
      console.log(`watchlist: fired ${arrivals.length} arrival notification(s)`);
    }
  });
  tx();
}
