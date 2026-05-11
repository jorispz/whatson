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

export interface WishlistEntry {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  posterPath: string | null;
  releaseYear: number | null;
  overview: string | null;
  originalLanguage: string | null;
  addedAt: string;
  currentProviderIds: number[];
}

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
  tracked: boolean;
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
