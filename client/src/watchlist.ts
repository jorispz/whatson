import { useEffect, useState } from "react";
import { api } from "./api";
import type { SortKey, Title } from "./types";

// Shared watchlist state. Loaded once on app mount and refreshed whenever
// marks change (via marks.ts) or sync finishes. Used both by the grid's
// "Watchlist" mode and by the notifications panel's "Waiting for arrival"
// section — they're the same dataset, filtered differently.
//
// The current sort key (and randomSeed for random) is kept module-local so
// background refreshes (e.g. after a mark toggle) reuse whatever the user
// last selected on the grid, instead of resetting to a default.

const listeners = new Set<(entries: Title[]) => void>();
let current: Title[] = [];
let currentSort: SortKey = "popularity";
let currentRandomSeed = 1;

function notify(): void {
  listeners.forEach((l) => l(current));
}

async function loadFromServer(): Promise<void> {
  try {
    const res = await api.watchlist(currentSort, currentRandomSeed);
    current = res.entries;
  } catch (err) {
    console.error("watchlist load failed:", err);
    current = [];
  }
  notify();
}

let loadPromise: Promise<void> | null = null;
if (typeof window !== "undefined") {
  loadPromise = loadFromServer();
}

export function refreshWatchlist(): Promise<void> {
  loadPromise = loadFromServer();
  return loadPromise;
}

// Update the sort key the module uses for fetches. If anything actually
// changed, kick off a refetch and return that promise so callers can await it.
export function setWatchlistSort(sort: SortKey, randomSeed: number): Promise<void> {
  if (sort === currentSort && randomSeed === currentRandomSeed) {
    return loadPromise ?? Promise.resolve();
  }
  currentSort = sort;
  currentRandomSeed = randomSeed;
  loadPromise = loadFromServer();
  return loadPromise;
}

export function useWatchlist(): { entries: Title[]; refresh: () => Promise<void> } {
  const [entries, setEntries] = useState<Title[]>(current);
  useEffect(() => {
    const onChange = (next: Title[]): void => setEntries(next);
    listeners.add(onChange);
    if (loadPromise) void loadPromise.then(() => setEntries(current));
    return () => {
      listeners.delete(onChange);
    };
  }, []);
  return { entries, refresh: refreshWatchlist };
}
