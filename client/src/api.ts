import type { Filters, Genre, Provider, Status, Title, TitlesResponse } from "./types";

export interface TitlesQueryExtras {
  onlyIds?: string[];
  excludeIds?: string[];
}

export function buildTitlesQuery(
  f: Filters,
  limit: number,
  offset: number,
  extras?: TitlesQueryExtras,
): string {
  const params = new URLSearchParams();
  if (f.q.trim()) {
    params.set("q", f.q.trim());
    if (f.includeOverview) params.set("includeOverview", "true");
  }
  if (f.mediaTypes.length > 0) params.set("mediaType", f.mediaTypes.join(","));
  if (f.providerIds.length > 0) params.set("providers", f.providerIds.join(","));
  if (f.genreIds.length > 0) {
    params.set("genres", f.genreIds.join(","));
    if (f.genreIds.length > 1 && f.genreMode === "all") params.set("genreMode", "all");
  }
  if (f.minRating > 0) params.set("minRating", String(f.minRating));
  if (f.maxRating < 10) params.set("maxRating", String(f.maxRating));
  if (f.minVotes > 0) params.set("minVotes", String(f.minVotes));
  if (f.maxVotes !== null) params.set("maxVotes", String(f.maxVotes));
  if (f.yearFrom !== null) params.set("yearFrom", String(f.yearFrom));
  if (f.yearTo !== null) params.set("yearTo", String(f.yearTo));
  if (extras?.onlyIds && extras.onlyIds.length > 0) params.set("onlyIds", extras.onlyIds.join(","));
  if (extras?.excludeIds && extras.excludeIds.length > 0) params.set("excludeIds", extras.excludeIds.join(","));
  params.set("sort", f.sort);
  if (f.sort === "random") params.set("randomSeed", String(f.randomSeed));
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
  titles: (f: Filters, limit: number, offset: number, extras?: TitlesQueryExtras): Promise<TitlesResponse> =>
    fetchJson<TitlesResponse>(`/api/titles?${buildTitlesQuery(f, limit, offset, extras)}`),
  providers: (): Promise<Provider[]> => fetchJson<Provider[]>("/api/providers"),
  genres: (): Promise<Genre[]> => fetchJson<Genre[]>("/api/genres"),
  status: (): Promise<Status> => fetchJson<Status>("/api/status"),
  sync: (): Promise<{ started: boolean }> => fetchJson("/api/sync", { method: "POST" }),
  details: (
    mediaType: "movie" | "tv",
    id: number,
  ): Promise<{ youtubeKey: string | null; runtime: number | null }> =>
    fetchJson(`/api/details/${mediaType}/${id}`),
  recommendations: (mediaType: "movie" | "tv", id: number): Promise<{ results: Title[] }> =>
    fetchJson(`/api/recommendations/${mediaType}/${id}`),
  deeplink: (
    mediaType: "movie" | "tv",
    id: number,
    providerKey: string,
  ): Promise<{ url: string | null }> => fetchJson(`/api/deeplink/${mediaType}/${id}/${providerKey}`),
  marks: {
    get: (): Promise<Record<string, { watchlist?: true; seen?: true }>> =>
      fetchJson("/api/marks"),
    put: (
      mediaType: "movie" | "tv",
      tmdbId: number,
      set: { watchlist: boolean; seen: boolean },
    ): Promise<{ ok: true }> =>
      fetchJson(`/api/marks/${mediaType}/${tmdbId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(set),
      }),
    importMerge: (
      payload: Record<string, unknown>,
    ): Promise<{ imported: number; total: number }> =>
      fetchJson("/api/marks/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
  },
};

export const posterUrl = (path: string | null, size: "w185" | "w342" | "w500" = "w342"): string | null =>
  path ? `https://image.tmdb.org/t/p/${size}${path}` : null;

// Fallback URLs used if the on-click deep-link resolver fails. Netflix and Max
// honor search query params; Disney+'s SPA drops them, so we fall back to TMDB's
// JustWatch-powered watch page for that one.
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
    case "ziggoTv":
      return `https://www.themoviedb.org/${title.mediaType}/${title.tmdbId}/watch?locale=NL`;
    default:
      return null;
  }
}

/**
 * Resolve a proper deep link via the server (extracts the direct URL from
 * TMDB's watch-page HTML) and open it in a new tab. Falls back to the
 * service's search URL if the resolver returns null or errors.
 *
 * Uses a programmatic anchor-click rather than window.open, because
 * `window.open(url, "_blank", "noopener")` returns null in Chrome/Safari —
 * which would make any return-value check misread the success as a blocked
 * popup and navigate the current tab on top of the new one.
 */
export async function openServiceLink(
  title: { title: string; tmdbId: number; mediaType: "movie" | "tv" },
  providerKey: string,
): Promise<void> {
  let url: string | null = null;
  try {
    const res = await api.deeplink(title.mediaType, title.tmdbId, providerKey);
    url = res.url;
  } catch {
    /* fall through to fallback */
  }
  if (!url) url = serviceSearchUrl(providerKey, title);
  if (!url) return;
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
