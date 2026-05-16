import { Router, type Request } from "express";
import { config } from "./config.js";
import { db, defaultProfileId, getMeta } from "./db.js";
import { resolveViaJustWatch } from "./justwatch.js";
import { isSyncing, persistTitle, triggerSync } from "./sync.js";
import {
  fetchRecommendations,
  fetchTitleDetails,
  fetchTitleFull,
  pickBestTrailer,
  searchMulti,
} from "./tmdb.js";

export const api = Router();

interface TitleRow {
  tmdb_id: number;
  media_type: "movie" | "tv";
  title: string;
  overview: string | null;
  release_date: string | null;
  release_year: number | null;
  poster_path: string | null;
  backdrop_path: string | null;
  vote_average: number;
  vote_count: number;
  popularity: number;
  original_language: string;
  genre_ids: string | null;
  provider_ids: string | null;
}

interface ProviderRow {
  id: number;
  key: string;
  name: string;
  logo_path: string | null;
}

interface GenreRow {
  id: number;
  media_type: "movie" | "tv";
  name: string;
}

function parseIntList(s: string | null | undefined): number[] {
  if (!s) return [];
  return s
    .split(",")
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n));
}

function parseCsv(s: unknown): string[] {
  if (typeof s !== "string" || s.length === 0) return [];
  return s.split(",").filter(Boolean);
}

function parseCsvInt(s: unknown): number[] {
  return parseCsv(s)
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n));
}

// Fetch a list-valued column (e.g. genre_id, provider_id) for a page of
// (mediaType, tmdbId) pairs in a single batched query per media_type. Returns
// a map keyed by `${mediaType}:${tmdbId}`. Used instead of correlated
// per-row GROUP_CONCAT subqueries — same result, dramatically less I/O on
// a cold cache.
function fetchListByKeys(
  table: "title_genres" | "availability",
  valueColumn: "genre_id" | "provider_id",
  keys: { mediaType: "movie" | "tv"; tmdbId: number }[],
): Map<string, number[]> {
  const result = new Map<string, number[]>();
  if (keys.length === 0) return result;

  const movieIds: number[] = [];
  const tvIds: number[] = [];
  for (const k of keys) {
    if (k.mediaType === "movie") movieIds.push(k.tmdbId);
    else tvIds.push(k.tmdbId);
  }

  const collect = (mediaType: "movie" | "tv", ids: number[]): void => {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT tmdb_id, ${valueColumn} AS value FROM ${table}
          WHERE media_type = ? AND tmdb_id IN (${placeholders})`,
      )
      .all(mediaType, ...ids) as { tmdb_id: number; value: number }[];
    for (const row of rows) {
      const mapKey = `${mediaType}:${row.tmdb_id}`;
      let list = result.get(mapKey);
      if (!list) {
        list = [];
        result.set(mapKey, list);
      }
      list.push(row.value);
    }
  };
  collect("movie", movieIds);
  collect("tv", tvIds);
  return result;
}

function parseCompositeKeys(s: unknown): { mediaType: "movie" | "tv"; id: number }[] {
  return parseCsv(s)
    .map((pair) => {
      const [mt, idRaw] = pair.split(":");
      const id = Number(idRaw);
      if ((mt === "movie" || mt === "tv") && Number.isFinite(id)) {
        return { mediaType: mt, id };
      }
      return null;
    })
    .filter((x): x is { mediaType: "movie" | "tv"; id: number } => x !== null);
}

const detailsCache = new Map<
  string,
  {
    youtubeKey: string | null;
    runtime: number | null;
    certification: string | null;
    seasonCount: number | null;
    episodeCount: number | null;
    expires: number;
  }
>();
const DETAILS_TTL_MS = 24 * 60 * 60 * 1000;

const recsCache = new Map<string, { ids: number[]; expires: number }>();
const RECS_TTL_MS = 24 * 60 * 60 * 1000;
const RECS_MAX = 12;

// The titles table only changes inside a sync, so the unfiltered count is
// invariant between syncs. Cache it and key the cache on last_sync_at to
// invalidate automatically when a sync finishes.
let cachedUnfilteredTitlesTotal: number | null = null;
let cachedUnfilteredTitlesTotalStamp: string | undefined;

function unfilteredTitlesTotal(): number {
  const stamp = getMeta("last_sync_at");
  if (cachedUnfilteredTitlesTotal !== null && cachedUnfilteredTitlesTotalStamp === stamp) {
    return cachedUnfilteredTitlesTotal;
  }
  // Count only titles that are currently on a tracked streamer. The `titles`
  // table also holds watchlist-only entries (no availability rows) so a raw
  // COUNT(*) would over-report the browseable grid.
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM titles t
       WHERE EXISTS (
         SELECT 1 FROM availability a
         WHERE a.tmdb_id = t.tmdb_id AND a.media_type = t.media_type
       )`,
    )
    .get() as { n: number };
  cachedUnfilteredTitlesTotal = row.n;
  cachedUnfilteredTitlesTotalStamp = stamp;
  return row.n;
}

// Monetization preference when picking a JustWatch clickout URL for a title:
// subscription-included beats paid options.
const MONETIZATION_RANK: Record<string, number> = {
  flatrate: 5,
  free: 4,
  ads: 3,
  rent: 2,
  buy: 1,
};

interface JustWatchCxData {
  provider?: string;
  monetizationType?: string;
}

interface JustWatchTitleCtx {
  jwEntityId?: string;
}

function normalizeProviderName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Scan a TMDB watch-page HTML snippet for JustWatch clickout URLs pointing at
 * the requested provider. Returns the target URL (decoded from the clickout's
 * `&r=` param) with the highest monetization rank, or null if no match is
 * found. The `&r=` target is often still an affiliate tracker one hop removed
 * from the provider (e.g. `disneyplus.bn5x.net`) — see `resolveRedirects` for
 * the follow-up that finds the true provider URL.
 *
 * Match by provider name, not id: JustWatch's internal providerId (embedded in
 * the cx blob) does not always equal TMDB's provider_id. Disney+ in NL is 2706
 * on JustWatch but 337 on TMDB, so id matching silently drops every Disney+
 * clickout. Names from the two sources are consistent (both are sourced from
 * JustWatch), so a normalized name compare works for every provider.
 */
function pickDirectUrl(html: string, providerName: string): string | null {
  const wanted = normalizeProviderName(providerName);
  const re = /href="https:\/\/click\.justwatch\.com\/a\?cx=([^&"]+)&r=([^"&]+)(?:&[^"]*)?"/g;
  let best: { target: string; rank: number } | null = null;
  for (const m of html.matchAll(re)) {
    const cxRaw = m[1];
    const rRaw = m[2];
    if (!cxRaw || !rRaw) continue;
    try {
      const decoded = JSON.parse(Buffer.from(cxRaw, "base64").toString("utf8")) as {
        data?: { data?: JustWatchCxData }[];
      };
      const entry = decoded.data?.[0]?.data;
      if (!entry?.provider || normalizeProviderName(entry.provider) !== wanted) continue;
      const rank = MONETIZATION_RANK[entry.monetizationType ?? ""] ?? 0;
      if (!best || rank > best.rank) {
        best = { target: decodeURIComponent(rRaw), rank };
      }
    } catch {
      /* not a parseable cx, skip */
    }
  }
  return best?.target ?? null;
}

/**
 * Pull the JustWatch entity id out of any cx blob on the page. Every clickout
 * carries `{ jwEntityId }` for the title regardless of which provider it
 * advertises, so finding even one match (e.g. an Apple TV rent offer) gives
 * us a free node id for the JustWatch GraphQL fallback — no extra search
 * round-trip needed. Returns null when the page has zero JustWatch clickouts.
 */
function pickJwEntityId(html: string): string | null {
  const re = /href="https:\/\/click\.justwatch\.com\/a\?cx=([^&"]+)/g;
  for (const m of html.matchAll(re)) {
    const cxRaw = m[1];
    if (!cxRaw) continue;
    try {
      const decoded = JSON.parse(Buffer.from(cxRaw, "base64").toString("utf8")) as {
        data?: { data?: JustWatchTitleCtx }[];
      };
      for (const entry of decoded.data ?? []) {
        if (entry?.data?.jwEntityId) return entry.data.jwEntityId;
      }
    } catch {
      /* skip */
    }
  }
  return null;
}

/**
 * Hosts and a search-URL builder per provider key. Used to verify that
 * redirect resolution actually landed on the streamer and, when it didn't,
 * to fall back to the streamer's on-site search.
 */
interface ProviderSite {
  hosts: string[];
  search: (query: string) => string;
}

const PROVIDER_SITES: Record<string, ProviderSite> = {
  netflix: {
    hosts: ["netflix.com"],
    search: (q) => `https://www.netflix.com/search?q=${encodeURIComponent(q)}`,
  },
  disneyPlus: {
    hosts: ["disneyplus.com"],
    search: (q) => `https://www.disneyplus.com/search?q=${encodeURIComponent(q)}`,
  },
  hboMax: {
    hosts: ["max.com", "hbomax.com"],
    search: (q) => `https://play.max.com/search?q=${encodeURIComponent(q)}`,
  },
  ziggoTv: {
    hosts: ["ziggo.tv", "ziggogo.tv"],
    search: (q) => `https://www.ziggogo.tv/search?q=${encodeURIComponent(q)}`,
  },
};

function matchesProviderHost(url: string, site: ProviderSite): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return site.hosts.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/**
 * Follow HTTP redirects to find the final URL. JustWatch's `&r=` target is
 * commonly an affiliate tracker (bn5x.net, prf.hn, etc.) that redirects again
 * to the real provider page; ad-blockers block those hosts, breaking the
 * click flow. Returns the resolved URL, or the input URL if resolution fails.
 */
async function resolveRedirects(url: string, timeoutMs = 5000): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: ac.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    return res.url || url;
  } catch {
    return url;
  } finally {
    clearTimeout(timer);
  }
}

api.get("/deeplink/:mediaType/:id/:providerKey", async (req, res) => {
  const { mediaType, id: idRaw, providerKey } = req.params;
  if (mediaType !== "movie" && mediaType !== "tv") {
    res.status(400).json({ error: "invalid mediaType" });
    return;
  }
  const id = Number(idRaw);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const providerRow = db
    .prepare("SELECT name FROM providers WHERE key = ?")
    .get(providerKey) as { name: string } | undefined;
  if (!providerRow) {
    res.status(400).json({ error: "unknown providerKey" });
    return;
  }

  try {
    const page = await fetch(`https://www.themoviedb.org/${mediaType}/${id}/watch?locale=NL`, {
      headers: {
        "User-Agent": "whatson/0.1 (personal non-commercial)",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en,en-US;q=0.9",
      },
    });
    if (!page.ok) {
      console.error("deeplink fetch failed:", page.status, page.statusText);
      res.status(502).json({ error: "upstream error" });
      return;
    }
    const html = await page.text();
    const clickoutTarget = pickDirectUrl(html, providerRow.name);
    let url = clickoutTarget ? await resolveRedirects(clickoutTarget) : null;
    const site = PROVIDER_SITES[providerKey];
    const stripQuery = (raw: string): string => {
      // Strip affiliate tracking query/fragment that rides along on the redirect
      // chain. Disney+ in particular won't deep-link into its app from URLs with
      // a query string — its intent filter does a strict path-pattern match.
      try {
        const u = new URL(raw);
        return `${u.protocol}//${u.host}${u.pathname}`;
      } catch {
        return raw;
      }
    };
    if (site && url && matchesProviderHost(url, site)) {
      url = stripQuery(url);
    }
    const titleRow = db
      .prepare("SELECT title FROM titles WHERE tmdb_id = ? AND media_type = ?")
      .get(id, mediaType) as { title: string } | undefined;
    if (site && titleRow?.title && (!url || !matchesProviderHost(url, site))) {
      // TMDB's HTML watch page and TMDB's /watch/providers JSON occasionally
      // disagree about which providers carry a title (different cache windows
      // on TMDB's side). Querying JustWatch directly closes the gap when our
      // HTML-scrape path comes up empty for this provider.
      const jwUrl = await resolveViaJustWatch({
        title: titleRow.title,
        tmdbId: id,
        mediaType,
        providerName: providerRow.name,
        country: config.region,
        knownNodeId: pickJwEntityId(html),
      });
      if (jwUrl && matchesProviderHost(jwUrl, site)) {
        url = stripQuery(jwUrl);
      }
    }
    if (site && titleRow?.title && (!url || !matchesProviderHost(url, site))) {
      url = site.search(titleRow.title);
    }
    res.json({ url });
  } catch (err) {
    console.error("deeplink resolve failed:", err);
    res.status(502).json({ error: "upstream error" });
  }
});

api.get("/recommendations/:mediaType/:id", async (req, res) => {
  const { mediaType, id: idRaw } = req.params;
  if (mediaType !== "movie" && mediaType !== "tv") {
    res.status(400).json({ error: "invalid mediaType" });
    return;
  }
  const id = Number(idRaw);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const cacheKey = `${mediaType}:${id}`;
  let ids: number[];
  const cached = recsCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    ids = cached.ids;
  } else {
    try {
      ids = await fetchRecommendations(mediaType, id);
      recsCache.set(cacheKey, { ids, expires: Date.now() + RECS_TTL_MS });
    } catch (err) {
      console.error("recommendations fetch failed:", err);
      res.status(502).json({ error: "upstream error" });
      return;
    }
  }

  if (ids.length === 0) {
    res.json({ results: [] });
    return;
  }

  // Intersect with our local catalog so we only return titles available on the user's services.
  // Preserve TMDB's ordering (which reflects their recommendation strength).
  const placeholders = ids.map((_, i) => `@id${i}`).join(",");
  const params: Record<string, unknown> = { mt: mediaType };
  ids.forEach((v, i) => (params[`id${i}`] = v));

  const rows = db
    .prepare(
      `
      SELECT
        t.tmdb_id, t.media_type, t.title, t.overview, t.release_date, t.release_year,
        t.poster_path, t.backdrop_path, t.vote_average, t.vote_count, t.popularity,
        t.original_language,
        (SELECT GROUP_CONCAT(genre_id) FROM title_genres tg
          WHERE tg.tmdb_id = t.tmdb_id AND tg.media_type = t.media_type) AS genre_ids,
        (SELECT GROUP_CONCAT(provider_id) FROM availability av
          WHERE av.tmdb_id = t.tmdb_id AND av.media_type = t.media_type
            AND av.monetization = 'flatrate') AS provider_ids
      FROM titles t
      WHERE t.media_type = @mt AND t.tmdb_id IN (${placeholders})
        AND EXISTS (
          SELECT 1 FROM availability av
          WHERE av.tmdb_id = t.tmdb_id AND av.media_type = t.media_type
            AND av.monetization = 'flatrate'
        )
    `,
    )
    .all(params) as TitleRow[];

  const byId = new Map(rows.map((r) => [r.tmdb_id, r]));
  const ordered = ids
    .map((tmdbId) => byId.get(tmdbId))
    .filter((r): r is TitleRow => r !== undefined)
    .slice(0, RECS_MAX)
    .map((r) => ({
      tmdbId: r.tmdb_id,
      mediaType: r.media_type,
      title: r.title,
      overview: r.overview,
      releaseDate: r.release_date,
      releaseYear: r.release_year,
      posterPath: r.poster_path,
      backdropPath: r.backdrop_path,
      voteAverage: r.vote_average,
      voteCount: r.vote_count,
      popularity: r.popularity,
      originalLanguage: r.original_language,
      genreIds: parseIntList(r.genre_ids),
      providerIds: parseIntList(r.provider_ids),
    }));

  res.json({ results: ordered });
});

api.get("/details/:mediaType/:id", async (req, res) => {
  const { mediaType, id: idRaw } = req.params;
  if (mediaType !== "movie" && mediaType !== "tv") {
    res.status(400).json({ error: "invalid mediaType" });
    return;
  }
  const id = Number(idRaw);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const cacheKey = `${mediaType}:${id}`;
  const cached = detailsCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    res.json({
      youtubeKey: cached.youtubeKey,
      runtime: cached.runtime,
      certification: cached.certification,
      seasonCount: cached.seasonCount,
      episodeCount: cached.episodeCount,
    });
    return;
  }
  try {
    const details = await fetchTitleDetails(mediaType, id);
    const trailer = pickBestTrailer(details.videos);
    const youtubeKey = trailer?.key ?? null;
    detailsCache.set(cacheKey, {
      youtubeKey,
      runtime: details.runtime,
      certification: details.certification,
      seasonCount: details.seasonCount,
      episodeCount: details.episodeCount,
      expires: Date.now() + DETAILS_TTL_MS,
    });
    res.json({
      youtubeKey,
      runtime: details.runtime,
      certification: details.certification,
      seasonCount: details.seasonCount,
      episodeCount: details.episodeCount,
    });
  } catch (err) {
    console.error("details fetch failed:", err);
    res.status(502).json({ error: "upstream error" });
  }
});

api.get("/providers", (_req, res) => {
  const rows = db.prepare("SELECT id, key, name, logo_path FROM providers ORDER BY name").all() as ProviderRow[];
  res.json(rows);
});

api.get("/genres", (_req, res) => {
  const rows = db.prepare("SELECT id, media_type, name FROM genres ORDER BY name").all() as GenreRow[];
  res.json(rows);
});

api.get("/status", (_req, res) => {
  const lastSync = getMeta("last_sync_at") ?? null;
  const titleCount = (db.prepare("SELECT COUNT(*) AS n FROM titles").get() as { n: number }).n;
  res.json({
    lastSyncAt: lastSync,
    titleCount,
    syncing: isSyncing(),
  });
});

api.post("/sync", async (_req, res) => {
  if (isSyncing()) {
    res.status(409).json({ error: "sync already running" });
    return;
  }
  triggerSync().catch((err) => {
    console.error("Sync failed:", err);
  });
  res.status(202).json({ started: true });
});

api.get("/titles", (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const includeOverview = req.query.includeOverview === "true" || req.query.includeOverview === "1";
  const mediaTypes = parseCsv(req.query.mediaType).filter((x): x is "movie" | "tv" => x === "movie" || x === "tv");
  const providerIds = parseCsvInt(req.query.providers);
  const genreIds = parseCsvInt(req.query.genres);
  const genreMode = req.query.genreMode === "all" ? "all" : "any";
  const minRating = req.query.minRating !== undefined ? Number(req.query.minRating) : null;
  const maxRating = req.query.maxRating !== undefined ? Number(req.query.maxRating) : null;
  const minVotes = req.query.minVotes !== undefined ? Number(req.query.minVotes) : 0;
  const maxVotes = req.query.maxVotes !== undefined ? Number(req.query.maxVotes) : null;
  const yearFrom = req.query.yearFrom !== undefined ? Number(req.query.yearFrom) : null;
  const yearTo = req.query.yearTo !== undefined ? Number(req.query.yearTo) : null;
  const sort =
    typeof req.query.sort === "string" &&
    ["popularity", "rating", "year", "title", "random"].includes(req.query.sort)
      ? (req.query.sort as "popularity" | "rating" | "year" | "title" | "random")
      : "popularity";
  const randomSeed =
    sort === "random" && req.query.randomSeed !== undefined ? Number(req.query.randomSeed) || 1 : 1;
  const limit = Math.min(Math.max(Number(req.query.limit ?? 60), 1), 200);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);

  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (q) {
    const terms = q.split(/\s+/).filter(Boolean).slice(0, 8);
    terms.forEach((term, i) => {
      const paramName = `q${i}`;
      const fields = includeOverview
        ? `t.title LIKE @${paramName} OR t.original_title LIKE @${paramName} OR t.overview LIKE @${paramName}`
        : `t.title LIKE @${paramName} OR t.original_title LIKE @${paramName}`;
      where.push(`(${fields})`);
      params[paramName] = `%${term}%`;
    });
  }
  if (mediaTypes.length > 0) {
    where.push(`t.media_type IN (${mediaTypes.map((_, i) => `@mt${i}`).join(",")})`);
    mediaTypes.forEach((v, i) => (params[`mt${i}`] = v));
  }
  if (minRating !== null && Number.isFinite(minRating)) {
    where.push("t.vote_average >= @minRating");
    params.minRating = minRating;
  }
  if (maxRating !== null && Number.isFinite(maxRating)) {
    where.push("t.vote_average <= @maxRating");
    params.maxRating = maxRating;
  }
  if (Number.isFinite(minVotes) && minVotes > 0) {
    where.push("t.vote_count >= @minVotes");
    params.minVotes = minVotes;
  }
  if (maxVotes !== null && Number.isFinite(maxVotes)) {
    where.push("t.vote_count <= @maxVotes");
    params.maxVotes = maxVotes;
  }
  if (yearFrom !== null && Number.isFinite(yearFrom)) {
    where.push("t.release_year >= @yearFrom");
    params.yearFrom = yearFrom;
  }
  if (yearTo !== null && Number.isFinite(yearTo)) {
    where.push("t.release_year <= @yearTo");
    params.yearTo = yearTo;
  }
  if (providerIds.length > 0) {
    where.push(`EXISTS (
      SELECT 1 FROM availability av
      WHERE av.tmdb_id = t.tmdb_id AND av.media_type = t.media_type
        AND av.provider_id IN (${providerIds.map((_, i) => `@p${i}`).join(",")})
    )`);
    providerIds.forEach((v, i) => (params[`p${i}`] = v));
  }
  if (genreIds.length > 0) {
    const placeholders = genreIds.map((_, i) => `@g${i}`).join(",");
    if (genreMode === "all" && genreIds.length > 1) {
      // Title must carry every selected genre.
      where.push(`(
        SELECT COUNT(*) FROM title_genres tg
        WHERE tg.tmdb_id = t.tmdb_id AND tg.media_type = t.media_type
          AND tg.genre_id IN (${placeholders})
      ) = ${genreIds.length}`);
    } else {
      // Title must carry any selected genre.
      where.push(`EXISTS (
        SELECT 1 FROM title_genres tg
        WHERE tg.tmdb_id = t.tmdb_id AND tg.media_type = t.media_type
          AND tg.genre_id IN (${placeholders})
      )`);
    }
    genreIds.forEach((v, i) => (params[`g${i}`] = v));
  }

  const onlyKeys = parseCompositeKeys(req.query.onlyIds);
  if (onlyKeys.length > 0) {
    where.push(
      `(${onlyKeys
        .map((_, i) => `(t.media_type = @om${i} AND t.tmdb_id = @oi${i})`)
        .join(" OR ")})`,
    );
    onlyKeys.forEach((k, i) => {
      params[`om${i}`] = k.mediaType;
      params[`oi${i}`] = k.id;
    });
  }

  const excludeKeys = parseCompositeKeys(req.query.excludeIds);
  if (excludeKeys.length > 0) {
    where.push(
      `NOT (${excludeKeys
        .map((_, i) => `(t.media_type = @xm${i} AND t.tmdb_id = @xi${i})`)
        .join(" OR ")})`,
    );
    excludeKeys.forEach((k, i) => {
      params[`xm${i}`] = k.mediaType;
      params[`xi${i}`] = k.id;
    });
  }

  const orderBy =
    sort === "rating"
      ? "t.vote_average DESC, t.vote_count DESC"
      : sort === "year"
        ? "t.release_year DESC NULLS LAST, t.popularity DESC"
        : sort === "title"
          ? "t.title COLLATE NOCASE ASC"
          : sort === "random"
            ? "(((t.tmdb_id + @randomSeed) * 2654435761) & 2147483647)"
            : "t.popularity DESC";
  if (sort === "random") params.randomSeed = randomSeed;

  // The grid only ever browses what's currently on a tracked streamer.
  // Watchlist-only catalog entries (no availability rows) are excluded
  // here unconditionally; they only surface via /api/watchlist.
  const userFilterCount = where.length;
  where.push(
    `EXISTS (SELECT 1 FROM availability a
              WHERE a.tmdb_id = t.tmdb_id AND a.media_type = t.media_type)`,
  );
  const whereSql = `WHERE ${where.join(" AND ")}`;

  const total =
    userFilterCount === 0
      ? unfilteredTitlesTotal()
      : (db.prepare(`SELECT COUNT(*) AS n FROM titles t ${whereSql}`).get(params) as { n: number })
          .n;

  const rows = db
    .prepare(
      `
      SELECT
        t.tmdb_id, t.media_type, t.title, t.overview, t.release_date, t.release_year,
        t.poster_path, t.backdrop_path, t.vote_average, t.vote_count, t.popularity,
        t.original_language
      FROM titles t
      ${whereSql}
      ORDER BY ${orderBy}
      LIMIT @limit OFFSET @offset
    `,
    )
    .all({ ...params, limit, offset }) as Omit<TitleRow, "genre_ids" | "provider_ids">[];

  const pageKeys = rows.map((r) => ({ mediaType: r.media_type, tmdbId: r.tmdb_id }));
  const genresByKey = fetchListByKeys("title_genres", "genre_id", pageKeys);
  const providersByKey = fetchListByKeys("availability", "provider_id", pageKeys);

  const results = rows.map((r) => {
    const key = `${r.media_type}:${r.tmdb_id}`;
    return {
      tmdbId: r.tmdb_id,
      mediaType: r.media_type,
      title: r.title,
      overview: r.overview,
      releaseDate: r.release_date,
      releaseYear: r.release_year,
      posterPath: r.poster_path,
      backdropPath: r.backdrop_path,
      voteAverage: r.vote_average,
      voteCount: r.vote_count,
      popularity: r.popularity,
      originalLanguage: r.original_language,
      genreIds: genresByKey.get(key) ?? [],
      providerIds: providersByKey.get(key) ?? [],
    };
  });

  res.json({
    total,
    limit,
    offset,
    results,
  });
});

interface MarkRow {
  tmdb_id: number;
  media_type: "movie" | "tv";
  watchlist: number;
  seen: number;
}

function markKey(mediaType: "movie" | "tv", tmdbId: number): string {
  return `${mediaType}-${tmdbId}`;
}

function rowsToMarksObject(rows: MarkRow[]): Record<string, { watchlist?: true; seen?: true }> {
  const out: Record<string, { watchlist?: true; seen?: true }> = {};
  for (const r of rows) {
    const entry: { watchlist?: true; seen?: true } = {};
    if (r.watchlist) entry.watchlist = true;
    if (r.seen) entry.seen = true;
    if (entry.watchlist || entry.seen) out[markKey(r.media_type, r.tmdb_id)] = entry;
  }
  return out;
}

/**
 * Resolve which profile this request is acting on. Clients send the active
 * profile id via X-Whatson-Profile; missing / unknown / malformed values
 * fall back to the seeded default profile so older clients (and curl) keep
 * working unchanged.
 */
function activeProfileId(req: Request): number {
  const raw = req.header("x-whatson-profile");
  if (raw) {
    const id = Number(raw);
    if (Number.isFinite(id) && id > 0) {
      const exists = db.prepare("SELECT 1 FROM profiles WHERE id = ?").get(id);
      if (exists) return id;
    }
  }
  return defaultProfileId();
}

interface ProfileRow {
  id: number;
  key: string;
  name: string;
  created_at: string;
}

function getProfile(id: number): ProfileRow | undefined {
  return db.prepare("SELECT id, key, name, created_at FROM profiles WHERE id = ?").get(id) as
    | ProfileRow
    | undefined;
}

function nameTaken(name: string, exceptId?: number): boolean {
  const row = db
    .prepare(
      exceptId !== undefined
        ? "SELECT 1 FROM profiles WHERE lower(name) = lower(?) AND id != ?"
        : "SELECT 1 FROM profiles WHERE lower(name) = lower(?)",
    )
    .get(...(exceptId !== undefined ? [name, exceptId] : [name]));
  return Boolean(row);
}

function newProfileKey(): string {
  // Random non-'default' key; we don't expose this to the user, but it's
  // useful for disambiguation in logs / future features.
  return `p_${Math.random().toString(36).slice(2, 10)}`;
}

api.get("/profiles", (_req, res) => {
  const rows = db
    .prepare("SELECT id, key, name, created_at FROM profiles ORDER BY created_at, id")
    .all() as ProfileRow[];
  res.json(rows);
});

api.post("/profiles", (req, res) => {
  const body = (req.body ?? {}) as { name?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    res.status(400).json({ error: "name required" });
    return;
  }
  if (nameTaken(name)) {
    res.status(409).json({ error: "name already taken" });
    return;
  }
  const info = db
    .prepare("INSERT INTO profiles (key, name) VALUES (?, ?)")
    .run(newProfileKey(), name);
  const created = getProfile(Number(info.lastInsertRowid));
  res.status(201).json(created);
});

api.patch("/profiles/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const existing = getProfile(id);
  if (!existing) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const body = (req.body ?? {}) as { name?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    res.status(400).json({ error: "name required" });
    return;
  }
  if (nameTaken(name, id)) {
    res.status(409).json({ error: "name already taken" });
    return;
  }
  db.prepare("UPDATE profiles SET name = ? WHERE id = ?").run(name, id);
  res.json(getProfile(id));
});

api.delete("/profiles/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const existing = getProfile(id);
  if (!existing) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const count = (
    db.prepare("SELECT COUNT(*) AS n FROM profiles").get() as { n: number }
  ).n;
  if (count <= 1) {
    res.status(400).json({ error: "cannot delete the last remaining profile" });
    return;
  }
  // Marks cascade via FK ON DELETE CASCADE.
  db.prepare("DELETE FROM profiles WHERE id = ?").run(id);
  res.json({ ok: true });
});

api.get("/marks", (req, res) => {
  const rows = db
    .prepare("SELECT tmdb_id, media_type, watchlist, seen FROM marks WHERE profile_id = ?")
    .all(activeProfileId(req)) as MarkRow[];
  res.json(rowsToMarksObject(rows));
});

api.put("/marks/:mediaType/:tmdbId", async (req, res) => {
  const { mediaType, tmdbId: idRaw } = req.params;
  if (mediaType !== "movie" && mediaType !== "tv") {
    res.status(400).json({ error: "invalid mediaType" });
    return;
  }
  const tmdbId = Number(idRaw);
  if (!Number.isFinite(tmdbId)) {
    res.status(400).json({ error: "invalid tmdbId" });
    return;
  }
  const body = (req.body ?? {}) as { watchlist?: unknown; seen?: unknown };
  const watchlist = body.watchlist === true ? 1 : 0;
  const seen = body.seen === true ? 1 : 0;
  const profileId = activeProfileId(req);
  if (!watchlist && !seen) {
    db.prepare(
      "DELETE FROM marks WHERE profile_id = ? AND media_type = ? AND tmdb_id = ?",
    ).run(profileId, mediaType, tmdbId);
  } else {
    const snapshotStmt = db.prepare(
      "SELECT title, poster_path, release_year FROM titles WHERE tmdb_id = ? AND media_type = ?",
    );
    let snapshot = snapshotStmt.get(tmdbId, mediaType) as
      | { title: string; poster_path: string | null; release_year: number | null }
      | undefined;
    // Title isn't in our catalog (e.g. added from a TMDB-only search hit
    // because it's not on any tracked streamer). Fetch the full metadata
    // from TMDB and persist it to `titles` right now — no availability row —
    // so the watchlist entry has backdrop / rating / genres / etc.
    // immediately, not just on the next sync. If TMDB is unreachable, fall
    // through with NULL snapshot rather than failing the mark; the user can
    // re-add later (or wait for sync) to populate it.
    if (!snapshot && watchlist) {
      try {
        const full = await fetchTitleFull(mediaType, tmdbId);
        persistTitle(full, mediaType);
        snapshot = snapshotStmt.get(tmdbId, mediaType) as
          | { title: string; poster_path: string | null; release_year: number | null }
          | undefined;
      } catch (err) {
        console.error("marks put: TMDB fetch failed:", err);
      }
    }
    const currentlyAvailable = db
      .prepare("SELECT 1 FROM availability WHERE tmdb_id = ? AND media_type = ? LIMIT 1")
      .get(tmdbId, mediaType);
    // last_seen_available semantics:
    //   timestamp = "we already know this is available, no notification pending"
    //   NULL      = "armed: fire a notification next time this appears in availability"
    // For seen-only marks (watchlist=0) the column is irrelevant — keep it NULL.
    const lastSeenAvailable = watchlist ? (currentlyAvailable ? new Date().toISOString() : null) : null;
    db.prepare(
      `
      INSERT INTO marks (profile_id, tmdb_id, media_type, watchlist, seen, updated_at,
                         title, poster_path, release_year, last_seen_available)
      VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?)
      ON CONFLICT(profile_id, media_type, tmdb_id) DO UPDATE SET
        watchlist = excluded.watchlist,
        seen = excluded.seen,
        updated_at = excluded.updated_at,
        title        = COALESCE(marks.title,        excluded.title),
        poster_path  = COALESCE(marks.poster_path,  excluded.poster_path),
        release_year = COALESCE(marks.release_year, excluded.release_year),
        last_seen_available = COALESCE(marks.last_seen_available, excluded.last_seen_available)
    `,
    ).run(
      profileId,
      tmdbId,
      mediaType,
      watchlist,
      seen,
      snapshot?.title ?? null,
      snapshot?.poster_path ?? null,
      snapshot?.release_year ?? null,
      lastSeenAvailable,
    );
  }
  res.json({ ok: true });
});

/**
 * Additive merge import: for each entry, OR the incoming flags onto any
 * existing row. Never removes marks — matches the client's merge semantics
 * for the Cmd+Shift+M shortcut.
 */
api.post("/marks/import", (req, res) => {
  const body = req.body;
  if (!body || typeof body !== "object") {
    res.status(400).json({ error: "invalid body" });
    return;
  }
  const profileId = activeProfileId(req);
  const snapshotStmt = db.prepare(
    "SELECT title, poster_path, release_year FROM titles WHERE tmdb_id = ? AND media_type = ?",
  );
  const availabilityStmt = db.prepare(
    "SELECT 1 FROM availability WHERE tmdb_id = ? AND media_type = ? LIMIT 1",
  );
  const stmt = db.prepare(
    `
    INSERT INTO marks (profile_id, tmdb_id, media_type, watchlist, seen, updated_at,
                       title, poster_path, release_year, last_seen_available)
    VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?)
    ON CONFLICT(profile_id, media_type, tmdb_id) DO UPDATE SET
      watchlist  = max(marks.watchlist, excluded.watchlist),
      seen       = max(marks.seen,      excluded.seen),
      updated_at = excluded.updated_at,
      title        = COALESCE(marks.title,        excluded.title),
      poster_path  = COALESCE(marks.poster_path,  excluded.poster_path),
      release_year = COALESCE(marks.release_year, excluded.release_year),
      last_seen_available = COALESCE(marks.last_seen_available, excluded.last_seen_available)
  `,
  );
  let imported = 0;
  const tx = db.transaction(() => {
    for (const [key, rawValue] of Object.entries(body as Record<string, unknown>)) {
      const dash = key.indexOf("-");
      if (dash < 0) continue;
      const mt = key.slice(0, dash);
      const tmdbId = Number(key.slice(dash + 1));
      if ((mt !== "movie" && mt !== "tv") || !Number.isFinite(tmdbId)) continue;
      let watchlist = 0;
      let seen = 0;
      if (typeof rawValue === "string") {
        // Legacy single-mark format: "watchlist" | "seen".
        if (rawValue === "watchlist") watchlist = 1;
        else if (rawValue === "seen") seen = 1;
      } else if (rawValue && typeof rawValue === "object") {
        const v = rawValue as { watchlist?: unknown; seen?: unknown };
        if (v.watchlist === true) watchlist = 1;
        if (v.seen === true) seen = 1;
      }
      if (!watchlist && !seen) continue;
      const snapshot = snapshotStmt.get(tmdbId, mt) as
        | { title: string; poster_path: string | null; release_year: number | null }
        | undefined;
      const currentlyAvailable = watchlist ? availabilityStmt.get(tmdbId, mt) : null;
      const lastSeenAvailable =
        watchlist && currentlyAvailable ? new Date().toISOString() : null;
      stmt.run(
        profileId,
        tmdbId,
        mt,
        watchlist,
        seen,
        snapshot?.title ?? null,
        snapshot?.poster_path ?? null,
        snapshot?.release_year ?? null,
        lastSeenAvailable,
      );
      imported++;
    }
  });
  tx();
  const total = (
    db.prepare("SELECT COUNT(*) AS n FROM marks WHERE profile_id = ?").get(profileId) as {
      n: number;
    }
  ).n;
  res.json({ imported, total });
});

interface WatchlistRow {
  tmdb_id: number;
  media_type: "movie" | "tv";
  title: string | null;
  poster_path: string | null;
  release_year: number | null;
  overview: string | null;
  release_date: string | null;
  backdrop_path: string | null;
  vote_average: number | null;
  vote_count: number | null;
  popularity: number | null;
  original_language: string | null;
  in_catalog: number;
  added_at: string;
}

// Watchlist entries (marks.watchlist = 1), joined with the catalog where the
// title is still around. For titles that have left every tracked streamer the
// catalog row is gone, so we render from the snapshot columns on marks and
// flag the entry as unavailable. Returned shape mirrors Title so the same
// grid renderer can show both live and orphan entries.
//
// Accepts the same sort param as /api/titles. Orphan rows have NULL for
// rating/popularity/etc so they cluster at the bottom of DESC sorts and at
// the top of title-ascending — same NULLS LAST trick used by /api/titles.
api.get("/watchlist", (req, res) => {
  const profileId = activeProfileId(req);
  const sort =
    typeof req.query.sort === "string" &&
    ["popularity", "rating", "year", "title", "random"].includes(req.query.sort)
      ? (req.query.sort as "popularity" | "rating" | "year" | "title" | "random")
      : "popularity";
  const randomSeed =
    sort === "random" && req.query.randomSeed !== undefined ? Number(req.query.randomSeed) || 1 : 1;
  const orderBy =
    sort === "rating"
      ? "vote_average DESC NULLS LAST, vote_count DESC NULLS LAST"
      : sort === "year"
        ? "release_year DESC NULLS LAST, popularity DESC NULLS LAST"
        : sort === "title"
          ? "title COLLATE NOCASE ASC"
          : sort === "random"
            ? "(((m.tmdb_id + @randomSeed) * 2654435761) & 2147483647)"
            : "popularity DESC NULLS LAST";
  const params: Record<string, unknown> = { pid: profileId };
  if (sort === "random") params.randomSeed = randomSeed;
  const rows = db
    .prepare(
      `
      SELECT m.tmdb_id, m.media_type,
             COALESCE(t.title,        m.title)        AS title,
             COALESCE(t.poster_path,  m.poster_path)  AS poster_path,
             COALESCE(t.release_year, m.release_year) AS release_year,
             t.overview          AS overview,
             t.release_date      AS release_date,
             t.backdrop_path     AS backdrop_path,
             t.vote_average      AS vote_average,
             t.vote_count        AS vote_count,
             t.popularity        AS popularity,
             t.original_language AS original_language,
             CASE WHEN EXISTS (
               SELECT 1 FROM availability a
               WHERE a.tmdb_id = m.tmdb_id AND a.media_type = m.media_type
             ) THEN 1 ELSE 0 END AS in_catalog,
             m.updated_at AS added_at
      FROM marks m
      LEFT JOIN titles t
        ON t.tmdb_id = m.tmdb_id AND t.media_type = m.media_type
      WHERE m.profile_id = @pid AND m.watchlist = 1
      ORDER BY ${orderBy}
    `,
    )
    .all(params) as WatchlistRow[];

  const pageKeys = rows.map((r) => ({ mediaType: r.media_type, tmdbId: r.tmdb_id }));
  const providersByKey = fetchListByKeys("availability", "provider_id", pageKeys);
  const genresByKey = fetchListByKeys("title_genres", "genre_id", pageKeys);

  const entries = rows.map((r) => {
    const key = `${r.media_type}:${r.tmdb_id}`;
    return {
      tmdbId: r.tmdb_id,
      mediaType: r.media_type,
      title: r.title ?? "",
      overview: r.overview,
      releaseDate: r.release_date,
      releaseYear: r.release_year,
      posterPath: r.poster_path,
      backdropPath: r.backdrop_path,
      voteAverage: r.vote_average ?? 0,
      voteCount: r.vote_count ?? 0,
      popularity: r.popularity ?? 0,
      originalLanguage: r.original_language ?? "",
      genreIds: genresByKey.get(key) ?? [],
      providerIds: providersByKey.get(key) ?? [],
      isAvailable: r.in_catalog === 1,
      addedAt: r.added_at,
    };
  });

  res.json({ entries });
});

interface NotificationRow {
  id: number;
  tmdb_id: number;
  media_type: "movie" | "tv";
  provider_ids: string;
  title_snapshot: string;
  poster_path: string | null;
  created_at: string;
  read_at: string | null;
}

function rowToNotificationDto(r: NotificationRow): {
  id: number;
  tmdbId: number;
  mediaType: "movie" | "tv";
  providerIds: number[];
  titleSnapshot: string;
  posterPath: string | null;
  createdAt: string;
  readAt: string | null;
} {
  return {
    id: r.id,
    tmdbId: r.tmdb_id,
    mediaType: r.media_type,
    providerIds: parseIntList(r.provider_ids),
    titleSnapshot: r.title_snapshot,
    posterPath: r.poster_path,
    createdAt: r.created_at,
    readAt: r.read_at,
  };
}

api.get("/notifications", (req, res) => {
  const rows = db
    .prepare(
      `
      SELECT id, tmdb_id, media_type, provider_ids, title_snapshot, poster_path, created_at, read_at
      FROM notifications
      WHERE profile_id = ?
      ORDER BY created_at DESC
    `,
    )
    .all(activeProfileId(req)) as NotificationRow[];
  res.json({ items: rows.map(rowToNotificationDto) });
});

api.post("/notifications/read-all", (req, res) => {
  db.prepare(
    "UPDATE notifications SET read_at = datetime('now') WHERE profile_id = ? AND read_at IS NULL",
  ).run(activeProfileId(req));
  res.json({ ok: true });
});

api.patch("/notifications/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const body = (req.body ?? {}) as { read?: unknown };
  if (body.read === true) {
    db.prepare(
      "UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND profile_id = ? AND read_at IS NULL",
    ).run(id, activeProfileId(req));
  } else if (body.read === false) {
    db.prepare(
      "UPDATE notifications SET read_at = NULL WHERE id = ? AND profile_id = ?",
    ).run(id, activeProfileId(req));
  }
  res.json({ ok: true });
});

api.delete("/notifications/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  db.prepare("DELETE FROM notifications WHERE id = ? AND profile_id = ?").run(
    id,
    activeProfileId(req),
  );
  res.json({ ok: true });
});

api.get("/tmdb-search", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q) {
    res.json({ results: [] });
    return;
  }
  let hits;
  try {
    hits = await searchMulti(q);
  } catch (err) {
    console.error("tmdb-search failed:", err);
    res.status(502).json({ error: "upstream error" });
    return;
  }
  if (hits.length === 0) {
    res.json({ results: [] });
    return;
  }

  const profileId = activeProfileId(req);

  // Look up local catalog + watchlist status for all hits in one shot.
  const inCatalog = new Map<string, number[]>();
  {
    const params: Record<string, unknown> = {};
    const conds = hits.map((h, i) => {
      params[`mt${i}`] = h.media_type;
      params[`id${i}`] = h.id;
      return `(t.media_type = @mt${i} AND t.tmdb_id = @id${i})`;
    });
    // `titles` can also hold watchlist-only rows (no availability). For the
    // search-result `inCatalog` flag we only care about titles currently on a
    // tracked streamer, so gate the lookup on EXISTS availability.
    const rows = db
      .prepare(
        `
        SELECT t.media_type, t.tmdb_id,
               (SELECT GROUP_CONCAT(a.provider_id) FROM availability a
                WHERE a.media_type = t.media_type AND a.tmdb_id = t.tmdb_id) AS provider_ids
        FROM titles t
        WHERE (${conds.join(" OR ")})
          AND EXISTS (
            SELECT 1 FROM availability a
            WHERE a.media_type = t.media_type AND a.tmdb_id = t.tmdb_id
          )
      `,
      )
      .all(params) as { media_type: "movie" | "tv"; tmdb_id: number; provider_ids: string | null }[];
    for (const row of rows) {
      inCatalog.set(`${row.media_type}:${row.tmdb_id}`, parseIntList(row.provider_ids));
    }
  }

  const watchlisted = new Set<string>();
  {
    const params: Record<string, unknown> = { pid: profileId };
    const conds = hits.map((h, i) => {
      params[`mt${i}`] = h.media_type;
      params[`id${i}`] = h.id;
      return `(media_type = @mt${i} AND tmdb_id = @id${i})`;
    });
    const rows = db
      .prepare(
        `SELECT media_type, tmdb_id FROM marks
          WHERE profile_id = @pid AND watchlist = 1 AND (${conds.join(" OR ")})`,
      )
      .all(params) as { media_type: "movie" | "tv"; tmdb_id: number }[];
    for (const row of rows) watchlisted.add(`${row.media_type}:${row.tmdb_id}`);
  }

  const results = hits.map((h) => {
    const key = `${h.media_type}:${h.id}`;
    const catalog = inCatalog.get(key);
    const title = h.media_type === "movie" ? h.title ?? h.original_title ?? "" : h.name ?? h.original_name ?? "";
    const date = h.media_type === "movie" ? h.release_date : h.first_air_date;
    const year = date ? Number(date.slice(0, 4)) : null;
    return {
      tmdbId: h.id,
      mediaType: h.media_type,
      title,
      posterPath: h.poster_path,
      releaseYear: Number.isFinite(year) && year && year > 1800 ? year : null,
      overview: h.overview ?? null,
      inCatalog: catalog !== undefined,
      currentProviderIds: catalog ?? [],
      watchlisted: watchlisted.has(key),
    };
  });

  res.json({ results });
});
