import type {
  Filters,
  Genre,
  NotificationEntry,
  Provider,
  SortKey,
  Status,
  Title,
  TitleDetails,
  TitlesResponse,
  TmdbSearchResult,
} from "./types";
import type { Marks } from "./marks";
import { PROFILE_STORAGE_KEY } from "./storageKeys";

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

// The active profile id is read from localStorage on every request so a
// switch performed elsewhere (or in another tab) doesn't need to thread state
// through every API call site. The server answers 404 "unknown profile" if
// the stored id no longer exists; profile.ts reconciles and reloads.
function activeProfileHeader(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
  return raw ? { "X-Whatson-Profile": raw } : {};
}

type JsonInit = Omit<RequestInit, "headers"> & { headers?: Record<string, string> };

// Every route reports failures as { error } JSON; surface that text so the UI
// can show "name already taken" rather than "409 Conflict".
async function fetchJson<T>(url: string, init?: JsonInit): Promise<T> {
  const headers = { ...activeProfileHeader(), ...(init?.headers ?? {}) };
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error) message = body.error;
    } catch {
      /* not a JSON body */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export interface ProfileDto {
  id: number;
  key: string;
  name: string;
  created_at: string;
}

export const api = {
  titles: (f: Filters, limit: number, offset: number, extras?: TitlesQueryExtras): Promise<TitlesResponse> =>
    fetchJson<TitlesResponse>(`/api/titles?${buildTitlesQuery(f, limit, offset, extras)}`),
  providers: (): Promise<Provider[]> => fetchJson<Provider[]>("/api/providers"),
  genres: (): Promise<Genre[]> => fetchJson<Genre[]>("/api/genres"),
  status: (): Promise<Status> => fetchJson<Status>("/api/status"),
  sync: (): Promise<{ started: boolean }> => fetchJson("/api/sync", { method: "POST" }),
  details: (mediaType: "movie" | "tv", id: number): Promise<TitleDetails> =>
    fetchJson(`/api/details/${mediaType}/${id}`),
  recommendations: (mediaType: "movie" | "tv", id: number): Promise<{ results: Title[] }> =>
    fetchJson(`/api/recommendations/${mediaType}/${id}`),
  deeplink: (
    mediaType: "movie" | "tv",
    id: number,
    providerKey: string,
  ): Promise<{ url: string | null }> => fetchJson(`/api/deeplink/${mediaType}/${id}/${providerKey}`),
  watchlist: (sort: SortKey, randomSeed: number): Promise<{ entries: Title[] }> => {
    const params = new URLSearchParams({ sort });
    if (sort === "random") params.set("randomSeed", String(randomSeed));
    return fetchJson(`/api/watchlist?${params.toString()}`);
  },
  marks: {
    get: (): Promise<Marks> => fetchJson("/api/marks"),
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
  profiles: {
    list: (): Promise<ProfileDto[]> => fetchJson("/api/profiles"),
    create: (name: string): Promise<ProfileDto> =>
      fetchJson("/api/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }),
    rename: (id: number, name: string): Promise<ProfileDto> =>
      fetchJson(`/api/profiles/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }),
    remove: (id: number): Promise<{ ok: true }> =>
      fetchJson(`/api/profiles/${id}`, { method: "DELETE" }),
  },
  tmdbSearch: (q: string): Promise<{ results: TmdbSearchResult[] }> =>
    fetchJson(`/api/tmdb-search?q=${encodeURIComponent(q)}`),
  notifications: {
    list: (): Promise<{ items: NotificationEntry[] }> => fetchJson("/api/notifications"),
    markRead: (id: number, read: boolean): Promise<{ ok: true }> =>
      fetchJson(`/api/notifications/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ read }),
      }),
    markAllRead: (): Promise<{ ok: true }> =>
      fetchJson("/api/notifications/read-all", { method: "POST" }),
    dismiss: (id: number): Promise<{ ok: true }> =>
      fetchJson(`/api/notifications/${id}`, { method: "DELETE" }),
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
 * TMDB's watch-page HTML) and open it. Falls back to the service's search URL
 * if the resolver returns null or errors.
 *
 * On desktop opens in a new tab via a programmatic anchor click (window.open
 * returns null in Chrome/Safari with noopener, breaking success checks).
 *
 * On touch devices we navigate the same tab and rely on App Links / Universal
 * Links to hand off to the installed provider app.
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
  if (typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches) {
    window.location.href = url;
    return;
  }
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
