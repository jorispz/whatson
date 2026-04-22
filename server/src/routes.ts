import { Router } from "express";
import { db, getMeta } from "./db.js";
import { isSyncing, triggerSync } from "./sync.js";
import { fetchVideos, pickBestTrailer } from "./tmdb.js";

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

const trailerCache = new Map<string, { key: string | null; expires: number }>();
const TRAILER_TTL_MS = 24 * 60 * 60 * 1000;

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
  const mediaTypes = parseCsv(req.query.mediaType).filter((x): x is "movie" | "tv" => x === "movie" || x === "tv");
  const providerIds = parseCsvInt(req.query.providers);
  const genreIds = parseCsvInt(req.query.genres);
  const minRating = req.query.minRating !== undefined ? Number(req.query.minRating) : null;
  const minVotes = req.query.minVotes !== undefined ? Number(req.query.minVotes) : 50;
  const yearFrom = req.query.yearFrom !== undefined ? Number(req.query.yearFrom) : null;
  const yearTo = req.query.yearTo !== undefined ? Number(req.query.yearTo) : null;
  const sort =
    typeof req.query.sort === "string" && ["popularity", "rating", "year", "title"].includes(req.query.sort)
      ? (req.query.sort as "popularity" | "rating" | "year" | "title")
      : "popularity";
  const limit = Math.min(Math.max(Number(req.query.limit ?? 60), 1), 200);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);

  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (q) {
    where.push("(t.title LIKE @q OR t.original_title LIKE @q)");
    params.q = `%${q}%`;
  }
  if (mediaTypes.length > 0) {
    where.push(`t.media_type IN (${mediaTypes.map((_, i) => `@mt${i}`).join(",")})`);
    mediaTypes.forEach((v, i) => (params[`mt${i}`] = v));
  }
  if (minRating !== null && Number.isFinite(minRating)) {
    where.push("t.vote_average >= @minRating");
    params.minRating = minRating;
  }
  if (Number.isFinite(minVotes) && minVotes > 0) {
    where.push("t.vote_count >= @minVotes");
    params.minVotes = minVotes;
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

  const orderBy =
    sort === "rating"
      ? "t.vote_average DESC, t.vote_count DESC"
      : sort === "year"
        ? "t.release_year DESC NULLS LAST, t.popularity DESC"
        : sort === "title"
          ? "t.title COLLATE NOCASE ASC"
          : "t.popularity DESC";

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
