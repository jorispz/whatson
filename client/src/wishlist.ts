import { useEffect, useState, useCallback } from "react";
import { api } from "./api";
import type { WishlistEntry } from "./types";

const listeners = new Set<(entries: WishlistEntry[]) => void>();
let current: WishlistEntry[] = [];

const key = (mediaType: "movie" | "tv", tmdbId: number): string => `${mediaType}-${tmdbId}`;

function notify(): void {
  listeners.forEach((l) => l(current));
}

async function loadFromServer(): Promise<void> {
  try {
    const res = await api.wishlist.list();
    current = res.entries;
  } catch (err) {
    console.error("wishlist load failed:", err);
    current = [];
  }
  notify();
}

let loadPromise: Promise<void> | null = null;
if (typeof window !== "undefined") {
  loadPromise = loadFromServer();
}

export function refreshWishlist(): Promise<void> {
  loadPromise = loadFromServer();
  return loadPromise;
}

export function useWishlist(): {
  entries: WishlistEntry[];
  isTracked: (mediaType: "movie" | "tv", tmdbId: number) => boolean;
  add: (mediaType: "movie" | "tv", tmdbId: number) => Promise<void>;
  remove: (mediaType: "movie" | "tv", tmdbId: number) => Promise<void>;
  refresh: () => Promise<void>;
} {
  const [entries, setEntries] = useState<WishlistEntry[]>(current);

  useEffect(() => {
    const onChange = (next: WishlistEntry[]): void => setEntries(next);
    listeners.add(onChange);
    if (loadPromise) void loadPromise.then(() => setEntries(current));
    return () => {
      listeners.delete(onChange);
    };
  }, []);

  const isTracked = useCallback(
    (mediaType: "movie" | "tv", tmdbId: number): boolean =>
      entries.some((e) => e.mediaType === mediaType && e.tmdbId === tmdbId),
    [entries],
  );

  const add = useCallback(async (mediaType: "movie" | "tv", tmdbId: number): Promise<void> => {
    try {
      const entry = await api.wishlist.add(mediaType, tmdbId);
      // Avoid duplicates if a server response arrives after a refresh.
      const k = key(mediaType, tmdbId);
      current = [entry, ...current.filter((e) => key(e.mediaType, e.tmdbId) !== k)];
      notify();
    } catch (err) {
      console.error("wishlist add failed:", err);
      throw err;
    }
  }, []);

  const remove = useCallback(async (mediaType: "movie" | "tv", tmdbId: number): Promise<void> => {
    const k = key(mediaType, tmdbId);
    const prev = current;
    current = current.filter((e) => key(e.mediaType, e.tmdbId) !== k);
    notify();
    try {
      await api.wishlist.remove(mediaType, tmdbId);
    } catch (err) {
      console.error("wishlist remove failed:", err);
      current = prev;
      notify();
      throw err;
    }
  }, []);

  return { entries, isTracked, add, remove, refresh: refreshWishlist };
}
