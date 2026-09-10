import { useEffect, useState } from "react";
import { api } from "./api";
import type { SortKey, Title } from "./types";

// Shared watchlist state: the single source for the grid's Watchlist mode and
// for the notifications panel's "Waiting for arrival" section. Refreshed by
// marks.ts after a watchlist flag flips and by App after a sync finishes.
//
// The sort key (and randomSeed for random) is module-local so background
// refreshes reuse whatever the user last selected on the grid. Nothing is
// fetched until App calls setWatchlistSort on mount, so the first request
// already carries the right sort instead of a default that is immediately
// replaced.

export interface WatchlistState {
  entries: Title[];
  /** False until the first fetch has settled. */
  ready: boolean;
}

const listeners = new Set<(state: WatchlistState) => void>();
let current: WatchlistState = { entries: [], ready: false };
let currentSort: SortKey = "popularity";
let currentRandomSeed = 1;
let loadPromise: Promise<void> | null = null;
let generation = 0;

function notify(): void {
  listeners.forEach((l) => l(current));
}

// Only the most recently issued request may update state; an older response
// arriving late (e.g. after spamming reshuffle) is dropped.
async function loadFromServer(): Promise<void> {
  const gen = ++generation;
  let next: WatchlistState;
  try {
    const res = await api.watchlist(currentSort, currentRandomSeed);
    next = { entries: res.entries, ready: true };
  } catch (err) {
    console.error("watchlist load failed:", err);
    next = { entries: [], ready: true };
  }
  if (gen !== generation) return;
  current = next;
  notify();
}

export function refreshWatchlist(): Promise<void> {
  loadPromise = loadFromServer();
  return loadPromise;
}

// Update the sort key the module uses for fetches. Loads on first call, and
// refetches whenever the sort actually changed.
export function setWatchlistSort(sort: SortKey, randomSeed: number): Promise<void> {
  if (loadPromise && sort === currentSort && randomSeed === currentRandomSeed) return loadPromise;
  currentSort = sort;
  currentRandomSeed = randomSeed;
  return refreshWatchlist();
}

export function useWatchlist(): WatchlistState & { refresh: () => Promise<void> } {
  const [state, setState] = useState<WatchlistState>(current);
  useEffect(() => {
    const onChange = (next: WatchlistState): void => setState(next);
    listeners.add(onChange);
    // Pick up anything that changed between render and subscribe.
    onChange(current);
    return () => {
      listeners.delete(onChange);
    };
  }, []);
  return { ...state, refresh: refreshWatchlist };
}
