export type MediaType = "movie" | "tv";

export interface Title {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  overview: string | null;
  releaseDate: string | null;
  releaseYear: number | null;
  posterPath: string | null;
  backdropPath: string | null;
  voteAverage: number;
  voteCount: number;
  popularity: number;
  originalLanguage: string;
  genreIds: number[];
  providerIds: number[];
  // Present on entries returned by /api/watchlist. False when the title has
  // left every tracked streamer but the user still has it on their watchlist,
  // so we render it from the snapshot stored in marks. Absent (treated as
  // available) on entries from the regular /api/titles grid.
  isAvailable?: boolean;
}

export interface TitlesResponse {
  total: number;
  limit: number;
  offset: number;
  results: Title[];
}

export interface Provider {
  id: number;
  key: string;
  name: string;
  logo_path: string | null;
}

export interface Genre {
  id: number;
  media_type: MediaType;
  name: string;
}

export interface Status {
  lastSyncAt: string | null;
  titleCount: number;
  syncing: boolean;
}

export type SortKey = "popularity" | "rating" | "year" | "title" | "random";

export interface NotificationEntry {
  id: number;
  tmdbId: number;
  mediaType: MediaType;
  providerIds: number[];
  titleSnapshot: string;
  posterPath: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface TmdbSearchResult {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  posterPath: string | null;
  releaseYear: number | null;
  overview: string | null;
  inCatalog: boolean;
  currentProviderIds: number[];
  watchlisted: boolean;
}

export interface Filters {
  q: string;
  includeOverview: boolean;
  mediaTypes: MediaType[];
  providerIds: number[];
  genreIds: number[];
  genreMode: "any" | "all";
  minRating: number;
  maxRating: number;
  minVotes: number;
  maxVotes: number | null;
  yearFrom: number | null;
  yearTo: number | null;
  sort: SortKey;
  randomSeed: number;
  hideSeen: boolean;
  watchlistOnly: boolean;
}
