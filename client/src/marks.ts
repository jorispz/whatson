import { useEffect, useState, useCallback } from "react";
import type { Title } from "./types";

export type Mark = "watchlist" | "seen";
export interface MarkSet {
  watchlist?: true;
  seen?: true;
}
export type Marks = Record<string, MarkSet>;

const STORAGE_KEY = "whatson.marks.v1";

const titleKey = (t: Pick<Title, "mediaType" | "tmdbId">): string => `${t.mediaType}-${t.tmdbId}`;

function normalizeEntry(v: unknown): MarkSet | null {
  // Legacy format: value was a single mark name. Upgrade to a set with that
  // mark enabled — nothing is lost on read, and the next write persists the
  // new shape.
  if (typeof v === "string") {
    if (v === "watchlist" || v === "seen") return { [v]: true } as MarkSet;
    return null;
  }
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const out: MarkSet = {};
    if (obj.watchlist === true) out.watchlist = true;
    if (obj.seen === true) out.seen = true;
    return out.watchlist || out.seen ? out : null;
  }
  return null;
}

function readMarks(): Marks {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Marks = {};
    for (const [k, v] of Object.entries(parsed)) {
      const n = normalizeEntry(v);
      if (n) out[k] = n;
    }
    return out;
  } catch {
    return {};
  }
}

function writeMarks(marks: Marks): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(marks));
}

const listeners = new Set<(marks: Marks) => void>();
let current: Marks = typeof window === "undefined" ? {} : readMarks();

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY) {
      current = readMarks();
      listeners.forEach((l) => l(current));
    }
  });
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
    writeMarks(next);
    listeners.forEach((l) => l(next));
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
