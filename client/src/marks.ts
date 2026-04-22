import { useEffect, useState, useCallback } from "react";
import type { Title } from "./types";

export type Mark = "watchlist" | "seen";
export type Marks = Record<string, Mark>;

const STORAGE_KEY = "whatson.marks.v1";

const titleKey = (t: Pick<Title, "mediaType" | "tmdbId">): string => `${t.mediaType}-${t.tmdbId}`;

function readMarks(): Marks {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Marks) : {};
  } catch {
    return {};
  }
}

function writeMarks(marks: Marks): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(marks));
}

// Single shared subscriber set so all hook instances stay in sync.
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
  getMark: (t: Pick<Title, "mediaType" | "tmdbId">) => Mark | undefined;
  setMark: (t: Pick<Title, "mediaType" | "tmdbId">, mark: Mark | null) => void;
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

  const setMark = useCallback((t: Pick<Title, "mediaType" | "tmdbId">, mark: Mark | null) => {
    const key = titleKey(t);
    const next = { ...current };
    if (mark) next[key] = mark;
    else delete next[key];
    current = next;
    writeMarks(next);
    listeners.forEach((l) => l(next));
  }, []);

  const getMark = useCallback((t: Pick<Title, "mediaType" | "tmdbId">): Mark | undefined => marks[titleKey(t)], [marks]);

  const toggle = useCallback(
    (t: Pick<Title, "mediaType" | "tmdbId">, mark: Mark) => {
      const key = titleKey(t);
      setMark(t, current[key] === mark ? null : mark);
    },
    [setMark],
  );

  return { marks, getMark, setMark, toggle };
}
