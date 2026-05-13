import { useEffect, useState } from "react";
import { api } from "./api";
import type { Title } from "./types";

// Shared watchlist state. Loaded once on app mount and refreshed whenever
// marks change (via marks.ts) or sync finishes. Used both by the grid's
// "Watchlist" mode and by the notifications panel's "Waiting for arrival"
// section — they're the same dataset, filtered differently.

const listeners = new Set<(entries: Title[]) => void>();
let current: Title[] = [];

function notify(): void {
  listeners.forEach((l) => l(current));
}

async function loadFromServer(): Promise<void> {
  try {
    const res = await api.watchlist();
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
