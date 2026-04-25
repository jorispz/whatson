import { config } from "./config.js";

const BASE = "https://api.themoviedb.org/3";

export type MediaType = "movie" | "tv";

export interface TmdbGenre {
  id: number;
  name: string;
}

export interface TmdbProvider {
  provider_id: number;
  provider_name: string;
  logo_path: string | null;
  display_priority: number;
}

export interface TmdbDiscoverResult {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  overview: string;
  release_date?: string;
  first_air_date?: string;
  poster_path: string | null;
  backdrop_path: string | null;
  vote_average: number;
  vote_count: number;
  popularity: number;
  genre_ids: number[];
  original_language: string;
}

interface TmdbPagedResponse<T> {
  page: number;
  total_pages: number;
  total_results: number;
  results: T[];
}

async function tmdb<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${config.tmdbAccessToken}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`TMDB ${res.status} ${res.statusText} for ${path}: ${body}`);
  }
  return (await res.json()) as T;
}

export async function fetchGenres(mediaType: MediaType): Promise<TmdbGenre[]> {
  const res = await tmdb<{ genres: TmdbGenre[] }>(`/genre/${mediaType}/list`, { language: config.language });
  return res.genres;
}

export async function fetchProvidersForRegion(mediaType: MediaType): Promise<TmdbProvider[]> {
  const res = await tmdb<{ results: TmdbProvider[] }>(`/watch/providers/${mediaType}`, {
    watch_region: config.region,
    language: config.language,
  });
  return res.results;
}

export interface TmdbVideo {
  key: string;
  site: string;
  type: string;
  official: boolean;
  published_at: string;
  size: number;
  name: string;
}

export async function fetchRecommendations(mediaType: MediaType, id: number): Promise<number[]> {
  const res = await tmdb<{ results: { id: number }[] }>(`/${mediaType}/${id}/recommendations`, {
    language: config.language,
    page: 1,
  });
  return res.results.map((r) => r.id);
}

export interface TmdbTitleDetails {
  videos: TmdbVideo[];
  runtime: number | null;
  certification: string | null;
}

interface TmdbReleaseDates {
  results?: {
    iso_3166_1: string;
    release_dates: { certification: string }[];
  }[];
}

interface TmdbContentRatings {
  results?: { iso_3166_1: string; rating: string }[];
}

// Approximate translations from US ratings to NL Kijkwijzer-style age codes
// so a Dutch user doesn't have to mentally interpret "PG-13" or "TV-MA".
// The systems differ in detail; these are pragmatic equivalents, not exact.
const US_TO_NL_MOVIE: Record<string, string> = {
  G: "AL",
  PG: "6",
  "PG-13": "12",
  R: "16",
  "NC-17": "18",
};
const US_TO_NL_TV: Record<string, string> = {
  "TV-Y": "AL",
  "TV-Y7": "6",
  "TV-G": "AL",
  "TV-PG": "6",
  "TV-14": "14",
  "TV-MA": "16",
};

export async function fetchTitleDetails(mediaType: MediaType, id: number): Promise<TmdbTitleDetails> {
  const append = mediaType === "movie" ? "videos,release_dates" : "videos,content_ratings";
  const res = await tmdb<{
    runtime?: number;
    episode_run_time?: number[];
    videos?: { results: TmdbVideo[] };
    release_dates?: TmdbReleaseDates;
    content_ratings?: TmdbContentRatings;
  }>(`/${mediaType}/${id}`, { language: config.language, append_to_response: append });

  let runtime: number | null = null;
  if (mediaType === "movie") {
    if (typeof res.runtime === "number" && res.runtime > 0) runtime = res.runtime;
  } else {
    const first = res.episode_run_time?.[0];
    if (typeof first === "number" && first > 0) runtime = first;
  }

  // Prefer the local (NL) certification; fall back to US translated into
  // the NL age equivalent so the modal shows something a Dutch user can
  // read at a glance.
  const findCert = (country: string): string | null => {
    if (mediaType === "movie") {
      const row = res.release_dates?.results?.find((r) => r.iso_3166_1 === country);
      const cert = row?.release_dates.find((d) => d.certification.length > 0)?.certification;
      return cert ?? null;
    }
    const row = res.content_ratings?.results?.find((r) => r.iso_3166_1 === country);
    return row?.rating && row.rating.length > 0 ? row.rating : null;
  };
  let certification = findCert("NL");
  if (!certification) {
    const us = findCert("US");
    if (us) {
      const map = mediaType === "movie" ? US_TO_NL_MOVIE : US_TO_NL_TV;
      certification = map[us] ?? null;
    }
  }

  return { videos: res.videos?.results ?? [], runtime, certification };
}

export function pickBestTrailer(videos: TmdbVideo[]): TmdbVideo | null {
  const youtube = videos.filter((v) => v.site === "YouTube");
  const byScore = (v: TmdbVideo): number => {
    let s = 0;
    if (v.type === "Trailer") s += 10;
    else if (v.type === "Teaser") s += 5;
    if (v.official) s += 3;
    if (v.size >= 1080) s += 2;
    else if (v.size >= 720) s += 1;
    return s;
  };
  const sorted = [...youtube].sort((a, b) => byScore(b) - byScore(a));
  return sorted[0] ?? null;
}

export type Monetization = "flatrate" | "rent" | "buy" | "free" | "ads";

/**
 * Walk every title the given provider has for the configured region.
 *
 * We sort by `original_title.asc` (alphabetical) — NOT `popularity.desc`,
 * which TMDB re-ranks mid-walk causing duplicate titles across pages and
 * silently displacing unique ones. Alphabetical order is stable, so a
 * single walk yields every title exactly once.
 */
export async function discoverAllForProvider(
  mediaType: MediaType,
  providerId: number,
  monetization: Monetization = "flatrate",
): Promise<TmdbDiscoverResult[]> {
  const seen = new Map<number, TmdbDiscoverResult>();
  let totalPages = 1;
  for (let page = 1; page <= totalPages && page <= 500; page++) {
    const res = await tmdb<TmdbPagedResponse<TmdbDiscoverResult>>(`/discover/${mediaType}`, {
      language: config.language,
      watch_region: config.region,
      with_watch_providers: providerId,
      with_watch_monetization_types: monetization,
      sort_by: "original_title.asc",
      include_adult: "false",
      page,
    });
    totalPages = res.total_pages;
    for (const item of res.results) seen.set(item.id, item);
  }
  return [...seen.values()];
}
