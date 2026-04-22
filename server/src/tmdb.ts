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

export async function* discoverByProvider(
  mediaType: MediaType,
  providerId: number,
): AsyncGenerator<TmdbDiscoverResult, void, void> {
  let page = 1;
  let totalPages = 1;
  do {
    const res = await tmdb<TmdbPagedResponse<TmdbDiscoverResult>>(`/discover/${mediaType}`, {
      language: config.language,
      watch_region: config.region,
      with_watch_providers: providerId,
      with_watch_monetization_types: "flatrate",
      sort_by: "popularity.desc",
      include_adult: "false",
      page,
    });
    totalPages = Math.min(res.total_pages, 500);
    for (const item of res.results) yield item;
    page++;
  } while (page <= totalPages);
}
