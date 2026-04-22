import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Filters, Genre, Provider, SortKey, Status, Title, TitlesResponse } from "./types";
import { api } from "./api";
import { FiltersPanel } from "./components/Filters";
import { TitleCard } from "./components/TitleCard";
import { TitleModal } from "./components/TitleModal";
import { useMarks } from "./marks";

const PAGE_SIZE = 60;
const SURPRISE_SAMPLE_SIZE = 500;

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "year", label: "Release date" },
  { value: "popularity", label: "Popularity" },
  { value: "rating", label: "Rating" },
  { value: "title", label: "Title A–Z" },
  { value: "random", label: "Random" },
];

const newSeed = (): number => Math.floor(Math.random() * 2_000_000_000) + 1;

const DEFAULT_FILTERS: Filters = {
  q: "",
  includeOverview: false,
  mediaTypes: [],
  providerIds: [],
  genreIds: [],
  minRating: 5.5,
  maxRating: 10,
  yearFrom: null,
  yearTo: null,
  sort: "year",
  randomSeed: 1,
  hideSeen: false,
  watchlistOnly: false,
};

export function App(): JSX.Element {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [genres, setGenres] = useState<Genre[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [data, setData] = useState<TitlesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<Title | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const reqIdRef = useRef(0);
  const { marks, getMark, toggle } = useMarks();

  const watchlistKeys = useMemo(() => {
    const out: string[] = [];
    for (const [key, mark] of Object.entries(marks)) {
      // Local key format is "movie-123"; server expects "movie:123".
      if (mark === "watchlist") out.push(key.replace("-", ":"));
    }
    return out;
  }, [marks]);

  // Serialize so identity is stable when the actual set of watchlist IDs doesn't change
  // (prevents an unnecessary refetch when marking/unmarking 'seen').
  const onlyIdsSig = filters.watchlistOnly ? watchlistKeys.join(",") : "";
  const queryExtras = useMemo(
    () => ({ onlyIds: onlyIdsSig ? onlyIdsSig.split(",") : undefined }),
    [onlyIdsSig],
  );

  const emptyByMarks = filters.watchlistOnly && watchlistKeys.length === 0;

  // While scrolling, disable pointer events site-wide so hover states don't
  // trigger on each card the cursor passes over — avoids scroll shimmer.
  useEffect(() => {
    let timeoutId: number | null = null;
    const onScroll = (): void => {
      document.body.classList.add("is-scrolling");
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        document.body.classList.remove("is-scrolling");
        timeoutId = null;
      }, 150);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      document.body.classList.remove("is-scrolling");
    };
  }, []);

  // initial load
  useEffect(() => {
    void (async (): Promise<void> => {
      try {
        const [p, g, s] = await Promise.all([api.providers(), api.genres(), api.status()]);
        setProviders(p);
        setGenres(g);
        setStatus(s);
      } catch (err) {
        console.error(err);
      }
    })();
  }, []);

  // debounced filter -> query
  useEffect(() => {
    const id = ++reqIdRef.current;
    if (emptyByMarks) {
      setData({ total: 0, limit: PAGE_SIZE, offset: 0, results: [] });
      setLoading(false);
      return;
    }
    setLoading(true);
    const t = setTimeout(() => {
      api
        .titles(filters, PAGE_SIZE, 0, queryExtras)
        .then((res) => {
          if (reqIdRef.current === id) setData(res);
        })
        .catch((err) => {
          console.error(err);
        })
        .finally(() => {
          if (reqIdRef.current === id) setLoading(false);
        });
    }, 250);
    return () => clearTimeout(t);
  }, [filters, queryExtras, emptyByMarks]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (!data || data.results.length >= data.total || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await api.titles(filters, PAGE_SIZE, data.results.length, queryExtras);
      setData({ ...next, results: [...data.results, ...next.results] });
    } finally {
      setLoadingMore(false);
    }
  }, [data, filters, loadingMore, queryExtras]);

  const onSync = useCallback(async (): Promise<void> => {
    setSyncError(null);
    try {
      await api.sync();
      setStatus((s) => (s ? { ...s, syncing: true } : s));
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // poll status while syncing
  useEffect(() => {
    if (!status?.syncing) return;
    const poll = setInterval(async () => {
      try {
        const s = await api.status();
        setStatus(s);
        if (!s.syncing) {
          // sync finished — refresh the current view
          const next = await api.titles(filters, PAGE_SIZE, 0);
          setData(next);
        }
      } catch {
        /* ignore */
      }
    }, 2000);
    return () => clearInterval(poll);
  }, [status?.syncing, filters]);

  const updateFilters = useCallback((patch: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
  }, []);

  const resetFilters = useCallback(() => setFilters(DEFAULT_FILTERS), []);

  const activeFilterCount = useMemo(() => countActive(filters), [filters]);

  const visibleResults = useMemo(() => {
    if (!data) return [] as Title[];
    if (!filters.hideSeen) return data.results;
    return data.results.filter((t) => marks[`${t.mediaType}-${t.tmdbId}`] !== "seen");
  }, [data, filters.hideSeen, marks]);

  const surpriseMe = useCallback(async (): Promise<void> => {
    if (emptyByMarks) return;
    try {
      const sample = await api.titles(filters, SURPRISE_SAMPLE_SIZE, 0, queryExtras);
      const pool = filters.hideSeen
        ? sample.results.filter((t) => marks[`${t.mediaType}-${t.tmdbId}`] !== "seen")
        : sample.results;
      if (pool.length === 0) return;
      const pick = pool[Math.floor(Math.random() * pool.length)];
      if (pick) setSelected(pick);
    } catch (err) {
      console.error(err);
    }
  }, [filters, queryExtras, emptyByMarks, marks]);

  const isEmpty = !loading && data && visibleResults.length === 0;
  const needsSync = !loading && status && status.titleCount === 0 && !status.syncing;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-30 bg-bg/90 backdrop-blur border-b border-white/5">
        <div className="max-w-[1600px] mx-auto flex items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-3">
            <img src="/logo.png" alt="whatson" className="h-7 w-auto" />
          </div>
          <div className="flex items-center gap-2 text-xs text-mute flex-wrap justify-end">
            <label
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full ring-1 cursor-pointer ${
                filters.watchlistOnly
                  ? "bg-accent/20 ring-accent text-ink"
                  : "bg-panel2 ring-white/10 hover:text-ink hover:ring-white/30"
              }`}
            >
              <input
                type="checkbox"
                checked={filters.watchlistOnly}
                onChange={(e) => updateFilters({ watchlistOnly: e.target.checked })}
                className="accent-accent"
              />
              Watchlist
            </label>
            <label
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full ring-1 cursor-pointer ${
                filters.hideSeen
                  ? "bg-emerald-500/20 ring-emerald-500 text-ink"
                  : "bg-panel2 ring-white/10 hover:text-ink hover:ring-white/30"
              }`}
            >
              <input
                type="checkbox"
                checked={filters.hideSeen}
                onChange={(e) => updateFilters({ hideSeen: e.target.checked })}
                className="accent-accent"
              />
              Hide seen
            </label>
            <select
              value={filters.sort}
              onChange={(e) => {
                const sort = e.target.value as SortKey;
                updateFilters(sort === "random" ? { sort, randomSeed: newSeed() } : { sort });
              }}
              className="bg-panel2 rounded px-2 py-1 ring-1 ring-white/10 outline-none focus:ring-accent text-ink"
              title="Sort order"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {filters.sort === "random" && (
              <button
                onClick={() => updateFilters({ randomSeed: newSeed() })}
                className="rounded px-2 py-1 bg-panel2 ring-1 ring-white/10 hover:ring-accent"
                title="Reshuffle"
              >
                🔀
              </button>
            )}
            <button
              onClick={surpriseMe}
              disabled={!data || data.results.length === 0}
              className="rounded px-3 py-1.5 bg-panel2 ring-1 ring-white/10 hover:ring-accent disabled:opacity-40"
              title="Pick something random from these filters"
            >
              🎲 Surprise me
            </button>
            {status && (
              <span className="hidden lg:inline ml-1">
                {status.titleCount.toLocaleString()} titles
                {status.lastSyncAt && ` · synced ${timeAgo(status.lastSyncAt)}`}
              </span>
            )}
            <button
              onClick={onSync}
              disabled={status?.syncing}
              className="rounded px-3 py-1.5 bg-panel2 ring-1 ring-white/10 hover:ring-accent disabled:opacity-60"
            >
              {status?.syncing ? "Syncing…" : "Refresh"}
            </button>
          </div>
        </div>
        {syncError && (
          <div className="bg-red-900/40 text-red-200 text-xs px-4 py-1">{syncError}</div>
        )}
      </header>

      <div className="flex-1 max-w-[1600px] mx-auto w-full flex">
        <aside className="hidden lg:block w-72 shrink-0 border-r border-white/5 sticky top-[49px] self-start max-h-[calc(100vh-49px)] overflow-y-auto">
          <FiltersPanel
            filters={filters}
            providers={providers}
            genres={genres}
            onChange={updateFilters}
            onReset={resetFilters}
          />
        </aside>

        <main className="flex-1 min-w-0 p-4">
          <div className="lg:hidden mb-4">
            <MobileFilters
              filters={filters}
              providers={providers}
              genres={genres}
              onChange={updateFilters}
              onReset={resetFilters}
              activeCount={activeFilterCount}
            />
          </div>

          {needsSync && (
            <div className="rounded-lg bg-panel p-6 text-center">
              <div className="text-lg font-medium mb-1">Your catalog is empty</div>
              <div className="text-sm text-mute mb-4">
                Click Refresh (top right) or run <code className="text-ink">npm run sync</code> to populate it.
              </div>
            </div>
          )}

          {data && (
            <>
              <div className="mb-3 text-sm text-mute">
                {loading ? "Loading…" : `${data.total.toLocaleString()} titles`}
                {activeFilterCount > 0 && !loading && ` · ${activeFilterCount} filter${activeFilterCount === 1 ? "" : "s"}`}
              </div>

              {isEmpty && (
                <div className="rounded-lg bg-panel p-8 text-center text-mute">
                  Nothing matches your filters.
                </div>
              )}

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4">
                {visibleResults.map((t) => (
                  <TitleCard
                    key={`${t.mediaType}-${t.tmdbId}`}
                    title={t}
                    providers={providers}
                    mark={getMark(t)}
                    onSelect={setSelected}
                    onToggleMark={toggle}
                  />
                ))}
              </div>

              {data.results.length < data.total && (
                <div className="flex justify-center mt-6">
                  <button
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="rounded px-4 py-2 bg-panel ring-1 ring-white/10 hover:ring-accent text-sm disabled:opacity-60"
                  >
                    {loadingMore ? "Loading…" : `Load more (${(data.total - data.results.length).toLocaleString()} remaining)`}
                  </button>
                </div>
              )}
            </>
          )}
        </main>
      </div>

      <footer className="border-t border-white/5 px-4 py-3 text-xs text-mute text-center">
        This product uses the TMDB API but is not endorsed or certified by TMDB.{" "}
        <a href="https://www.themoviedb.org/" target="_blank" rel="noreferrer" className="underline hover:text-ink">
          TMDB
        </a>
      </footer>

      {selected && (
        <TitleModal
          title={selected}
          providers={providers}
          genres={genres}
          onClose={() => setSelected(null)}
          onSelect={setSelected}
        />
      )}
    </div>
  );
}

function MobileFilters({
  filters,
  providers,
  genres,
  onChange,
  onReset,
  activeCount,
}: {
  filters: Filters;
  providers: Provider[];
  genres: Genre[];
  onChange: (patch: Partial<Filters>) => void;
  onReset: () => void;
  activeCount: number;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded bg-panel px-3 py-2 text-sm ring-1 ring-white/10 w-full text-left"
      >
        Filters{activeCount > 0 ? ` (${activeCount})` : ""}
      </button>
      {open && (
        <div className="fixed inset-0 z-40 bg-black/70" onClick={() => setOpen(false)}>
          <div
            className="absolute inset-y-0 left-0 w-80 bg-panel overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center p-4 border-b border-white/5">
              <div className="font-medium">Filters</div>
              <button onClick={() => setOpen(false)} className="text-mute hover:text-ink">
                ✕
              </button>
            </div>
            <FiltersPanel
              filters={filters}
              providers={providers}
              genres={genres}
              onChange={onChange}
              onReset={onReset}
            />
          </div>
        </div>
      )}
    </>
  );
}

function countActive(f: Filters): number {
  let n = 0;
  if (f.q.trim()) n++;
  if (f.mediaTypes.length > 0) n++;
  if (f.providerIds.length > 0) n++;
  if (f.genreIds.length > 0) n++;
  if (f.minRating > 0) n++;
  if (f.maxRating < 10) n++;
  if (f.yearFrom !== null) n++;
  if (f.yearTo !== null) n++;
  return n;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}
