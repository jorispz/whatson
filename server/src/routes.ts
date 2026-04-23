import { Router } from "express";
import { db, getMeta } from "./db.js";
import { isSyncing, triggerSync } from "./sync.js";
import { fetchRecommendations, fetchVideos, pickBestTrailer } from "./tmdb.js";

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

const trailerCache = new Map<string, { key: string | null; expires: number }>();
const TRAILER_TTL_MS = 24 * 60 * 60 * 1000;

const recsCache = new Map<string, { ids: number[]; expires: number }>();
const RECS_TTL_MS = 24 * 60 * 60 * 1000;
const RECS_MAX = 12;

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

api.get("/trailer/:mediaType/:id", async (req, res) => {
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
  const cached = trailerCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    res.json({ youtubeKey: cached.key });
    return;
  }
  try {
    const videos = await fetchVideos(mediaType, id);
    const trailer = pickBestTrailer(videos);
    const key = trailer?.key ?? null;
    trailerCache.set(cacheKey, { key, expires: Date.now() + TRAILER_TTL_MS });
    res.json({ youtubeKey: key });
  } catch (err) {
    console.error("trailer fetch failed:", err);
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
    // match ANY of the selected genres
    where.push(`EXISTS (
      SELECT 1 FROM title_genres tg
      WHERE tg.tmdb_id = t.tmdb_id AND tg.media_type = t.media_type
        AND tg.genre_id IN (${genreIds.map((_, i) => `@g${i}`).join(",")})
    )`);
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

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const countRow = db
    .prepare(`SELECT COUNT(*) AS n FROM titles t ${whereSql}`)
    .get(params) as { n: number };

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
          WHERE av.tmdb_id = t.tmdb_id AND av.media_type = t.media_type) AS provider_ids
      FROM titles t
      ${whereSql}
      ORDER BY ${orderBy}
      LIMIT @limit OFFSET @offset
    `,
    )
    .all({ ...params, limit, offset }) as TitleRow[];

  const results = rows.map((r) => ({
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

  res.json({
    total: countRow.n,
    limit,
    offset,
    results,
  });
});
