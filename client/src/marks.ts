import { useEffect, useState, useCallback } from "react";
import { api } from "./api";
import type { Title } from "./types";
import { refreshWatchlist } from "./watchlist";

export type Mark = "watchlist" | "seen";
export interface MarkSet {
  watchlist?: true;
  seen?: true;
}
export type Marks = Record<string, MarkSet>;

// Marks live in the server DB, scoped to the default profile.

const titleKey = (t: Pick<Title, "mediaType" | "tmdbId">): string => `${t.mediaType}-${t.tmdbId}`;

const listeners = new Set<(marks: Marks) => void>();
let current: Marks = {};

function notify(): void {
  listeners.forEach((l) => l(current));
}

async function loadFromServer(): Promise<void> {
  try {
    current = await api.marks.get();
  } catch (err) {
    console.error("marks load failed:", err);
    current = {};
  }
  notify();
}

// Kick off initial load as soon as the module is imported in the browser.
let loadPromise: Promise<void> | null = null;
if (typeof window !== "undefined") {
  loadPromise = loadFromServer();
}

export function exportMarksJson(): string {
  return JSON.stringify(current);
}

export async function importMarksMerge(
  json: string,
): Promise<{ imported: number; total: number }> {
  const parsed = JSON.parse(json) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("Not a marks object");
  const { imported } = await api.marks.importMerge(parsed as Record<string, unknown>);
  // Re-read the canonical state from the server so local matches exactly.
  current = await api.marks.get();
  notify();
  void refreshWatchlist();
  return { imported, total: Object.keys(current).length };
}

export function useMarks(): {
  marks: Marks;
  getMarks: (t: Pick<Title, "mediaType" | "tmdbId">) => MarkSet | undefined;
  hasMark: (t: Pick<Title, "mediaType" | "tmdbId">, mark: Mark) => boolean;
  toggle: (t: Pick<Title, "mediaType" | "tmdbId">, mark: Mark) => void;
} {
  const [marks, setMarks] = useState<Marks>(current);

  useEffect(() => {
    const onChange = (next: Marks): void => setMarks(next);
    listeners.add(onChange);
    // If the initial fetch hasn't landed yet, wait for it so the component
    // re-renders with server state instead of the empty snapshot.
    if (loadPromise) void loadPromise.then(() => setMarks(current));
    return () => {
      listeners.delete(onChange);
    };
  }, []);

  const toggle = useCallback((t: Pick<Title, "mediaType" | "tmdbId">, mark: Mark) => {
    const key = titleKey(t);
    const existing = current[key] ?? {};
    const nextEntry: MarkSet = { ...existing };
    if (existing[mark]) delete nextEntry[mark];
    else nextEntry[mark] = true;
    const next = { ...current };
    if (nextEntry.watchlist || nextEntry.seen) next[key] = nextEntry;
    else delete next[key];
    current = next;
    notify();
    void api.marks
      .put(t.mediaType, t.tmdbId, {
        watchlist: !!nextEntry.watchlist,
        seen: !!nextEntry.seen,
      })
      .then(() => {
        // Re-fetch the watchlist so the grid + notifications panel reflect
        // the change. Only matters when the watchlist flag itself flipped;
        // a seen-only toggle doesn't affect the watchlist set.
        if (mark === "watchlist") void refreshWatchlist();
      })
      .catch((err) => {
        console.error("mark save failed:", err);
      });
  }, []);

  const getMarks = useCallback(
    (t: Pick<Title, "mediaType" | "tmdbId">): MarkSet | undefined => marks[titleKey(t)],
    [marks],
  );

  const hasMark = useCallback(
    (t: Pick<Title, "mediaType" | "tmdbId">, mark: Mark): boolean => !!marks[titleKey(t)]?.[mark],
    [marks],
  );

  return { marks, getMarks, hasMark, toggle };
}
