import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Filters, Genre, Provider, SortKey, Status, Title, TitlesResponse } from "./types";
import { api } from "./api";
import { FiltersPanel } from "./components/Filters";
import { TitleCard } from "./components/TitleCard";
import { TitleModal } from "./components/TitleModal";
import { exportMarksJson, importMarksMerge, useMarks } from "./marks";

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

const dateSeed = (): number => {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
};

const DEFAULT_FILTERS: Filters = {
  q: "",
  includeOverview: false,
  mediaTypes: [],
  providerIds: [],
  genreIds: [],
  genreMode: "all",
  minRating: 0,
  maxRating: 10,
  minVotes: 0,
  maxVotes: null,
  yearFrom: null,
  yearTo: null,
  sort: "random",
  randomSeed: dateSeed(),
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
  const [toast, setToast] = useState<string | null>(null);
  const reqIdRef = useRef(0);
  const { marks, getMarks, toggle } = useMarks();

  const watchlistKeys = useMemo(() => {
    const out: string[] = [];
    for (const [key, set] of Object.entries(marks)) {
      // Local key format is "movie-123"; server expects "movie:123".
      if (set.watchlist) out.push(key.replace("-", ":"));
    }
    return out;
  }, [marks]);

  // Serialize so identity is stable when the actual set of watchlist IDs
  // doesn't change (prevents an unnecessary refetch when marking / unmarking
  // 'seen' while Watchlist mode is on).
  const onlyIdsSig = filters.watchlistOnly ? watchlistKeys.join(",") : "";
  const queryExtras = useMemo(
    () => ({ onlyIds: onlyIdsSig ? onlyIdsSig.split(",") : undefined }),
    [onlyIdsSig],
  );

  const emptyByMarks = filters.watchlistOnly && watchlistKeys.length === 0;

  // Fingerprint of the filter fields that actually drive the server query.
  // hideSeen is a pure client-side filter — toggling it shouldn't refetch or
  // scroll the grid back to the top. Watchlist mode does swap the result set
  // (via onlyIds) so it stays part of the signature.
  const queryFilterSig = useMemo(() => {
    const { hideSeen: _hideSeen, ...rest } = filters;
    return JSON.stringify(rest);
  }, [filters]);

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

  // Hidden mark sync shortcuts: Cmd/Ctrl+Shift+E exports marks to clipboard,
  // Cmd/Ctrl+Shift+M imports from clipboard (merging additively). Unadvertised;
  // used when bouncing marks between two browser installs.
  //
  // `navigator.clipboard` only exists in secure contexts (HTTPS / localhost),
  // so over HTTP on a LAN we fall back to execCommand('copy') for export and a
  // window.prompt for import. Ugly but it keeps the feature usable on the Pi.
  useEffect(() => {
    const copyToClipboard = async (text: string): Promise<void> => {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.top = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      try {
        if (!document.execCommand("copy")) throw new Error("execCommand copy failed");
      } finally {
        document.body.removeChild(ta);
      }
    };
    const readFromClipboard = async (): Promise<string> => {
      if (navigator.clipboard?.readText) return await navigator.clipboard.readText();
      const input = window.prompt("Paste marks JSON to merge:");
      if (input === null) throw new Error("cancelled");
      return input;
    };
    const onKey = async (e: KeyboardEvent): Promise<void> => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || !e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key === "e") {
        e.preventDefault();
        try {
          const json = exportMarksJson();
          await copyToClipboard(json);
          const count = Object.keys(JSON.parse(json) as Record<string, unknown>).length;
          setToast(`Copied ${count} mark${count === 1 ? "" : "s"} to clipboard`);
        } catch (err) {
          setToast(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (key === "m") {
        e.preventDefault();
        try {
          const text = await readFromClipboard();
          const { imported, total } = await importMarksMerge(text);
          setToast(`Imported ${imported} mark${imported === 1 ? "" : "s"} (${total} total)`);
        } catch (err) {
          setToast(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Auto-dismiss the toast after a few seconds.
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(id);
  }, [toast]);

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

  // Any filter change replaces the result set — scroll back to the top so the
  // new results aren't hidden below the previous scroll position.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [queryFilterSig]);

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
    // `filters` is read inside but hideSeen doesn't affect the server query,
    // so we depend on queryFilterSig instead to avoid a useless refetch when
    // Hide seen is toggled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryFilterSig, queryExtras, emptyByMarks]);

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

  const resetFilters = useCallback(() => setFilters({ ...DEFAULT_FILTERS, randomSeed: dateSeed() }), []);

  const activeFilterCount = useMemo(() => countActive(filters), [filters]);

  const visibleResults = useMemo(() => {
    if (!data) return [] as Title[];
    if (!filters.hideSeen) return data.results;
    return data.results.filter((t) => !marks[`${t.mediaType}-${t.tmdbId}`]?.seen);
  }, [data, filters.hideSeen, marks]);

  const surpriseMe = useCallback(async (): Promise<void> => {
    if (emptyByMarks) return;
    try {
      const sample = await api.titles(filters, SURPRISE_SAMPLE_SIZE, 0, queryExtras);
      const pool = filters.hideSeen
        ? sample.results.filter((t) => !marks[`${t.mediaType}-${t.tmdbId}`]?.seen)
        : sample.results;
      if (pool.length === 0) return;
      const pick = pool[Math.floor(Math.random() * pool.length)];
      if (pick) openModal(pick);
    } catch (err) {
      console.error(err);
    }
  }, [filters, queryExtras, emptyByMarks, marks]);

  // Make the TitleModal participate in the browser back stack so the natural
  // mobile back gesture closes the modal instead of leaving the app. One
  // history entry per modal session — recommendation-hopping doesn't stack.
  const openModal = useCallback(
    (t: Title) => {
      if (!selected) window.history.pushState({ whatsonModal: true }, "");
      setSelected(t);
    },
    [selected],
  );
  const closeModal = useCallback(() => {
    if ((window.history.state as { whatsonModal?: boolean } | null)?.whatsonModal) {
      // popstate fires from history.back(); that handler clears `selected`.
      window.history.back();
    } else {
      setSelected(null);
    }
  }, []);
  useEffect(() => {
    const onPopState = (): void => setSelected(null);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Switching between Results and Watchlist mode resets the filter sidebar —
  // filters carry over poorly between the two contexts.
  const setMode = useCallback(
    (watchlistOnly: boolean) => {
      setFilters({ ...DEFAULT_FILTERS, randomSeed: dateSeed(), watchlistOnly });
    },
    [],
  );

  const isEmpty = !loading && data && visibleResults.length === 0;
  const needsSync = !loading && status && status.titleCount === 0 && !status.syncing;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-30 bg-bg/90 backdrop-blur border-b border-white/5">
        <div className="max-w-[1600px] mx-auto flex items-center">
          <div className="flex items-center gap-3 lg:w-72 lg:shrink-0 px-4 py-3">
            <div className="h-7 w-8 sm:w-auto overflow-hidden shrink-0">
              <img src="/logo.png" alt="whatson" className="h-7 max-w-none block" />
            </div>
          </div>
          <div className="flex-1 flex items-center gap-4 justify-between min-w-0 px-4 py-3">
            <div className="inline-flex items-center rounded-full bg-panel2 ring-1 ring-white/10 p-0.5 text-xs shrink-0">
              <button
                type="button"
                onClick={() => setMode(false)}
                className={`px-3 py-1 rounded-full transition-colors ${
                  !filters.watchlistOnly
                    ? "bg-white/10 text-ink"
                    : "text-mute hover:text-ink"
                }`}
              >
                Results
              </button>
              <button
                type="button"
                onClick={() => setMode(true)}
                className={`px-3 py-1 rounded-full transition-colors ${
                  filters.watchlistOnly
                    ? "bg-accent/80 text-bg"
                    : "text-mute hover:text-ink"
                }`}
              >
                Watchlist
              </button>
            </div>
            <div className="lg:hidden shrink-0">
              <MobileFilters
                filters={filters}
                providers={providers}
                genres={genres}
                onChange={updateFilters}
                onReset={resetFilters}
                activeCount={activeFilterCount}
                onSurprise={surpriseMe}
                canSurprise={!!data && data.results.length > 0}
                onRefresh={onSync}
                syncing={!!status?.syncing}
              />
            </div>
            <div className="hidden lg:flex items-center gap-2 text-xs text-mute flex-wrap justify-end">
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
                    markSet={getMarks(t)}
                    onSelect={openModal}
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
          onClose={closeModal}
          onSelect={openModal}
        />
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] bg-panel2 text-sm text-ink px-4 py-2 rounded-lg shadow-lg ring-1 ring-white/10">
          {toast}
        </div>
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
  onSurprise,
  canSurprise,
  onRefresh,
  syncing,
}: {
  filters: Filters;
  providers: Provider[];
  genres: Genre[];
  onChange: (patch: Partial<Filters>) => void;
  onReset: () => void;
  activeCount: number;
  onSurprise: () => void;
  canSurprise: boolean;
  onRefresh: () => void;
  syncing: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const close = (): void => setOpen(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-full bg-panel2 px-3 py-1 text-xs ring-1 ring-white/10 text-ink hover:ring-accent"
      >
        Filters{activeCount > 0 ? ` (${activeCount})` : ""}
      </button>
      {open && createPortal(
        <div className="fixed inset-0 z-40 bg-black/70" onClick={close}>
          <div
            className="absolute inset-y-0 left-0 w-80 bg-panel overflow-y-auto flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center p-4 border-b border-white/5">
              <div className="font-medium">Menu</div>
              <button onClick={close} className="text-mute hover:text-ink" aria-label="Close">
                ✕
              </button>
            </div>
            <div className="p-4 border-b border-white/5 space-y-3">
              <div className="text-xs uppercase tracking-wider text-mute">View</div>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.hideSeen}
                  onChange={(e) => onChange({ hideSeen: e.target.checked })}
                  className="accent-accent"
                />
                Hide seen
              </label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-mute shrink-0">Sort</span>
                <select
                  value={filters.sort}
                  onChange={(e) => {
                    const sort = e.target.value as SortKey;
                    onChange(sort === "random" ? { sort, randomSeed: newSeed() } : { sort });
                  }}
                  className="flex-1 bg-panel2 rounded px-2 py-1.5 ring-1 ring-white/10 outline-none focus:ring-accent text-ink text-sm"
                >
                  {SORT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {filters.sort === "random" && (
                  <button
                    onClick={() => onChange({ randomSeed: newSeed() })}
                    className="rounded px-2 py-1.5 bg-panel2 ring-1 ring-white/10 hover:ring-accent shrink-0"
                    title="Reshuffle"
                  >
                    🔀
                  </button>
                )}
              </div>
            </div>
            <FiltersPanel
              filters={filters}
              providers={providers}
              genres={genres}
              onChange={onChange}
              onReset={onReset}
            />
            <div className="mt-auto p-4 border-t border-white/5 flex gap-2">
              <button
                onClick={() => {
                  onSurprise();
                  close();
                }}
                disabled={!canSurprise}
                className="flex-1 rounded px-3 py-2 bg-panel2 ring-1 ring-white/10 hover:ring-accent text-sm disabled:opacity-40"
              >
                🎲 Surprise me
              </button>
              <button
                onClick={onRefresh}
                disabled={syncing}
                className="flex-1 rounded px-3 py-2 bg-panel2 ring-1 ring-white/10 hover:ring-accent text-sm disabled:opacity-60"
              >
                {syncing ? "Syncing…" : "Refresh"}
              </button>
            </div>
          </div>
        </div>,
        document.body,
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
  if (f.minVotes > 0) n++;
  if (f.maxVotes !== null) n++;
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
