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

export async function fetchVideos(mediaType: MediaType, id: number): Promise<TmdbVideo[]> {
  const res = await tmdb<{ results: TmdbVideo[] }>(`/${mediaType}/${id}/videos`, { language: config.language });
  return res.results;
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

export type DiscoverSort =
  | "popularity.desc"
  | "original_title.asc"
  | "primary_release_date.desc";

async function discoverPage(
  mediaType: MediaType,
  providerId: number,
  monetization: Monetization,
  sort: DiscoverSort,
  page: number,
): Promise<TmdbPagedResponse<TmdbDiscoverResult>> {
  return tmdb<TmdbPagedResponse<TmdbDiscoverResult>>(`/discover/${mediaType}`, {
    language: config.language,
    watch_region: config.region,
    with_watch_providers: providerId,
    with_watch_monetization_types: monetization,
    sort_by: sort,
    include_adult: "false",
    page,
  });
}

async function walkDiscover(
  mediaType: MediaType,
  providerId: number,
  monetization: Monetization,
  sort: DiscoverSort,
  into: Map<number, TmdbDiscoverResult>,
): Promise<number> {
  let totalPages = 1;
  let totalResults = 0;
  for (let page = 1; page <= totalPages && page <= 500; page++) {
    const res = await discoverPage(mediaType, providerId, monetization, sort, page);
    totalPages = res.total_pages;
    totalResults = res.total_results;
    for (const item of res.results) into.set(item.id, item);
  }
  return totalResults;
}

/**
 * Walk every title the given provider has for the configured region.
 *
 * TMDB's `sort_by=popularity.desc` is not stable across pages under sustained
 * load: popularity scores are re-ranked while we paginate, so some titles
 * appear on multiple pages and others get silently displaced. We walk
 * `popularity.desc` first (fast, hot cache) and cross-check against
 * `total_results`; if any titles are still missing, we top up with the stable
 * alphabetical sort, then a date-based one.
 */
export async function discoverAllForProvider(
  mediaType: MediaType,
  providerId: number,
  monetization: Monetization = "flatrate",
): Promise<TmdbDiscoverResult[]> {
  const seen = new Map<number, TmdbDiscoverResult>();
  const expected = await walkDiscover(mediaType, providerId, monetization, "popularity.desc", seen);
  if (expected > 0 && seen.size < expected) {
    await walkDiscover(mediaType, providerId, monetization, "original_title.asc", seen);
  }
  if (expected > 0 && seen.size < expected) {
    await walkDiscover(mediaType, providerId, monetization, "primary_release_date.desc", seen);
  }
  return [...seen.values()];
}
