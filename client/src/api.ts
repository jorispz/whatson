import type { Filters, Genre, Provider, Status, TitlesResponse } from "./types";

export function buildTitlesQuery(f: Filters, limit: number, offset: number): string {
  const params = new URLSearchParams();
  if (f.q.trim()) {
    params.set("q", f.q.trim());
    if (f.includeOverview) params.set("includeOverview", "true");
  }
  if (f.mediaTypes.length > 0) params.set("mediaType", f.mediaTypes.join(","));
  if (f.providerIds.length > 0) params.set("providers", f.providerIds.join(","));
  if (f.genreIds.length > 0) params.set("genres", f.genreIds.join(","));
  if (f.minRating > 0) params.set("minRating", String(f.minRating));
  if (f.yearFrom !== null) params.set("yearFrom", String(f.yearFrom));
  if (f.yearTo !== null) params.set("yearTo", String(f.yearTo));
  params.set("sort", f.sort);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  return params.toString();
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export const api = {
  titles: (f: Filters, limit: number, offset: number): Promise<TitlesResponse> =>
    fetchJson<TitlesResponse>(`/api/titles?${buildTitlesQuery(f, limit, offset)}`),
  providers: (): Promise<Provider[]> => fetchJson<Provider[]>("/api/providers"),
  genres: (): Promise<Genre[]> => fetchJson<Genre[]>("/api/genres"),
  status: (): Promise<Status> => fetchJson<Status>("/api/status"),
  sync: (): Promise<{ started: boolean }> => fetchJson("/api/sync", { method: "POST" }),
  trailer: (mediaType: "movie" | "tv", id: number): Promise<{ youtubeKey: string | null }> =>
    fetchJson(`/api/trailer/${mediaType}/${id}`),
};

export const posterUrl = (path: string | null, size: "w185" | "w342" | "w500" = "w342"): string | null =>
  path ? `https://image.tmdb.org/t/p/${size}${path}` : null;

// Per-service links. Netflix and Max honor search query params; Disney+'s SPA drops them,
// so we fall back to TMDB's JustWatch-powered watch page for that one.
export function serviceSearchUrl(
  providerKey: string,
  title: { title: string; tmdbId: number; mediaType: "movie" | "tv" },
): string | null {
  switch (providerKey) {
    case "netflix":
      return `https://www.netflix.com/search?q=${encodeURIComponent(title.title)}`;
    case "hboMax":
      return `https://play.max.com/search/result?q=${encodeURIComponent(title.title)}`;
    case "disneyPlus":
      return `https://www.themoviedb.org/${title.mediaType}/${title.tmdbId}/watch?locale=NL`;
    default:
      return null;
  }
}
