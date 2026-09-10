import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Filters, Genre, Provider, SortKey, Status, Title, TitlesResponse, TmdbSearchResult } from "./types";
import { api } from "./api";
import { FiltersPanel } from "./components/Filters";
import { TitleCard } from "./components/TitleCard";
import { TitleModal } from "./components/TitleModal";
import { TmdbResultCard } from "./components/TmdbResultCard";
import { NotificationsPanel } from "./components/NotificationsPanel";
import { exportMarksJson, importMarksMerge, useMarks } from "./marks";
import { setActiveProfile, useProfileState } from "./profile";
import { ProfilePicker } from "./components/ProfilePicker";
import { SettingsModal } from "./components/SettingsModal";
import { refreshWatchlist, setWatchlistSort, useWatchlist } from "./watchlist";
import { refreshNotifications, useNotifications } from "./notifications";
import { useDialog } from "./useDialog";

const PAGE_SIZE = 60;

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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<Title | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [tmdbExpanded, setTmdbExpanded] = useState(false);
  const [tmdbResults, setTmdbResults] = useState<TmdbSearchResult[] | null>(null);
  const [tmdbLoading, setTmdbLoading] = useState(false);
  // Bumped when the sync poller sees a sync finish, so the current view is
  // re-queried through the same guarded effect as any filter change.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const reqIdRef = useRef(0);
  const prevQueryRef = useRef(DEFAULT_FILTERS.q);
  const tmdbReqIdRef = useRef(0);
  const { marks, getMarks, toggle } = useMarks();
  const profileState = useProfileState();
  const { entries: watchlistEntries, ready: watchlistReady } = useWatchlist();
  const armedWatchlistEntries = useMemo(
    () => watchlistEntries.filter((e) => e.isAvailable === false),
    [watchlistEntries],
  );
  const isWatchlisted = useCallback(
    (mediaType: "movie" | "tv", tmdbId: number): boolean =>
      !!getMarks({ mediaType, tmdbId })?.watchlist,
    [getMarks],
  );
  const {
    items: notifications,
    unreadCount,
    markRead,
    markAllRead,
    dismiss: dismissNotification,
  } = useNotifications();

  // Fingerprint of the filter fields that actually drive the server query.
  // hideSeen is a pure client-side filter — toggling it shouldn't refetch or
  // scroll the grid back to the top. watchlistOnly stays in the signature so
  // switching modes re-queries (and scrolls to top) like any other change.
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

  // Debounced filter -> query. In Watchlist mode the grid renders straight
  // from the watchlist store (see gridData below), so nothing is fetched here.
  useEffect(() => {
    const id = ++reqIdRef.current;
    // Only typing needs debouncing; a chip click or sort change should apply
    // immediately.
    const typed = filters.q !== prevQueryRef.current;
    prevQueryRef.current = filters.q;
    if (filters.watchlistOnly) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    const t = setTimeout(
      () => {
        api
          .titles(filters, PAGE_SIZE, 0)
          .then((res) => {
            if (reqIdRef.current === id) setData(res);
          })
          .catch((err) => {
            console.error(err);
            if (reqIdRef.current === id) setLoadError(err instanceof Error ? err.message : String(err));
          })
          .finally(() => {
            if (reqIdRef.current === id) setLoading(false);
          });
      },
      typed ? 250 : 0,
    );
    return () => clearTimeout(t);
    // `filters` is read inside but hideSeen doesn't affect the server query,
    // so we depend on queryFilterSig instead to avoid a useless refetch when
    // Hide seen is toggled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryFilterSig, refreshNonce]);

  // What the grid renders. Watchlist mode is served by the shared watchlist
  // store, which marks.ts refreshes only after the server has acknowledged a
  // flag change, so the grid can never show a set the server has moved past.
  const gridData = useMemo((): TitlesResponse | null => {
    if (!filters.watchlistOnly) return data;
    if (!watchlistReady) return null;
    return { total: watchlistEntries.length, limit: watchlistEntries.length, offset: 0, results: watchlistEntries };
  }, [filters.watchlistOnly, data, watchlistReady, watchlistEntries]);
  const gridLoading = filters.watchlistOnly ? !watchlistReady : loading;

  const loadMore = useCallback(async (): Promise<void> => {
    if (filters.watchlistOnly || !data || data.results.length >= data.total || loadingMore) return;
    // A filter change while this page is in flight bumps reqIdRef; the stale
    // page must then be dropped rather than appended to the new result set.
    const id = reqIdRef.current;
    setLoadingMore(true);
    try {
      const next = await api.titles(filters, PAGE_SIZE, data.results.length);
      if (reqIdRef.current !== id) return;
      setData((prev) => (prev ? { ...next, results: [...prev.results, ...next.results] } : next));
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingMore(false);
    }
  }, [data, filters, loadingMore]);

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
          // sync finished — refresh the current view and notification state
          setRefreshNonce((n) => n + 1);
          void refreshNotifications();
          void refreshWatchlist();
        }
      } catch {
        /* ignore */
      }
    }, 2000);
    return () => clearInterval(poll);
  }, [status?.syncing]);

  // Collapse and clear the TMDB section when the query empties.
  useEffect(() => {
    if (!filters.q.trim()) {
      setTmdbExpanded(false);
      setTmdbResults(null);
    }
  }, [filters.q]);

  // When the TMDB section is expanded, debounce re-fetch on query changes.
  useEffect(() => {
    if (!tmdbExpanded) return;
    const q = filters.q.trim();
    if (!q) return;
    const id = ++tmdbReqIdRef.current;
    setTmdbLoading(true);
    const t = setTimeout(() => {
      api
        .tmdbSearch(q)
        .then((res) => {
          if (tmdbReqIdRef.current === id) setTmdbResults(res.results);
        })
        .catch((err) => {
          console.error("tmdb search failed:", err);
          if (tmdbReqIdRef.current === id) setTmdbResults([]);
        })
        .finally(() => {
          if (tmdbReqIdRef.current === id) setTmdbLoading(false);
        });
    }, 250);
    return () => clearTimeout(t);
  }, [tmdbExpanded, filters.q]);

  const runTmdbSearch = useCallback(() => {
    if (!filters.q.trim()) return;
    setTmdbExpanded(true);
  }, [filters.q]);

  const updateFilters = useCallback((patch: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
  }, []);

  const resetFilters = useCallback(() => setFilters({ ...DEFAULT_FILTERS, randomSeed: dateSeed() }), []);

  const activeFilterCount = useMemo(() => countActive(filters), [filters]);

  const visibleResults = useMemo(() => {
    if (!gridData) return [] as Title[];
    if (!filters.hideSeen) return gridData.results;
    return gridData.results.filter((t) => !marks[`${t.mediaType}-${t.tmdbId}`]?.seen);
  }, [gridData, filters.hideSeen, marks]);

  // Make the TitleModal participate in the browser back stack so the natural
  // mobile back gesture closes the modal instead of leaving the app. One
  // history entry per modal session — recommendation-hopping doesn't stack.
  // The "already pushed" check reads history.state rather than `selected` so
  // this callback keeps a stable identity (it's a prop on every TitleCard).
  const openModal = useCallback((t: Title) => {
    if (!(window.history.state as { whatsonModal?: boolean } | null)?.whatsonModal) {
      window.history.pushState({ whatsonModal: true }, "");
    }
    setSelected(t);
  }, []);

  // Let the server pick one random title under the current filters instead of
  // downloading a 500-title sample. Seen titles are excluded server-side when
  // Hide seen is on; the watchlist grid picks from the store it renders.
  const surpriseMe = useCallback(async (): Promise<void> => {
    try {
      const notSeen = (t: Title): boolean => !marks[`${t.mediaType}-${t.tmdbId}`]?.seen;
      let pool: Title[];
      if (filters.watchlistOnly) {
        pool = filters.hideSeen ? watchlistEntries.filter(notSeen) : watchlistEntries;
      } else {
        const excludeIds = filters.hideSeen
          ? Object.entries(marks)
              .filter(([, m]) => m.seen)
              .map(([key]) => key.replace("-", ":"))
          : undefined;
        const res = await api.titles({ ...filters, sort: "random", randomSeed: newSeed() }, 1, 0, { excludeIds });
        pool = res.results;
      }
      const pick = pool[Math.floor(Math.random() * pool.length)];
      if (pick) openModal(pick);
    } catch (err) {
      console.error(err);
    }
  }, [filters, watchlistEntries, marks, openModal]);
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
  // filters carry over poorly between the two contexts. Sort + randomSeed
  // do carry over, so the watchlist follows the sort selector in the top
  // bar without an extra "watchlist sort" control.
  const setMode = useCallback(
    (watchlistOnly: boolean) => {
      setFilters((prev) => ({
        ...DEFAULT_FILTERS,
        sort: prev.sort,
        randomSeed: prev.randomSeed,
        watchlistOnly,
      }));
    },
    [],
  );

  // Keep the watchlist module's sort in sync with the grid's sort selector,
  // so background refreshes (after mark toggles, after sync) reuse the user's
  // current choice and the notifications panel's armed list stays consistent.
  useEffect(() => {
    void setWatchlistSort(filters.sort, filters.randomSeed);
  }, [filters.sort, filters.randomSeed]);

  // Open a title in the existing TitleModal by tmdbId, looking it up via the
  // titles endpoint. Used by notifications + the "Open" actions on TMDB
  // results that are already in the catalog.
  const openTitleById = useCallback(
    async (mediaType: "movie" | "tv", tmdbId: number): Promise<void> => {
      try {
        const res = await api.titles(DEFAULT_FILTERS, 1, 0, { onlyIds: [`${mediaType}:${tmdbId}`] });
        const found = res.results[0];
        if (found) openModal(found);
      } catch (err) {
        console.error("openTitleById failed:", err);
      }
    },
    [openModal],
  );

  const isEmpty = !gridLoading && gridData && visibleResults.length === 0;
  // Hide seen can blank out a whole page while more pages exist; say so
  // instead of claiming nothing matches.
  const allHiddenBySeen = isEmpty && gridData !== null && gridData.results.length > 0;
  const needsSync = !loading && status && status.titleCount === 0 && !status.syncing;

  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const closeNotifications = useCallback(() => setNotificationsOpen(false), []);

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
            <div className="flex items-center gap-3 min-w-0">
              <div className="inline-flex items-center rounded-full bg-panel2 ring-1 ring-white/10 p-0.5 text-xs shrink-0">
                <button
                  type="button"
                  onClick={() => setMode(false)}
                  aria-pressed={!filters.watchlistOnly}
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
                  aria-pressed={filters.watchlistOnly}
                  className={`px-3 py-1 rounded-full transition-colors ${
                    filters.watchlistOnly
                      ? "bg-accent/80 text-bg"
                      : "text-mute hover:text-ink"
                  }`}
                >
                  Watchlist
                </button>
              </div>
              {gridData && (
                <span className="hidden sm:inline text-xs text-mute">
                  {gridData.total.toLocaleString()} titles
                  {activeFilterCount > 0 && (
                    <span className="hidden md:inline">
                      {" "}· {activeFilterCount} filter{activeFilterCount === 1 ? "" : "s"}
                    </span>
                  )}
                </span>
              )}
            </div>
            <div className="lg:hidden shrink-0 flex items-center gap-2">
              <MobileFilters
                filters={filters}
                providers={providers}
                genres={genres}
                onChange={updateFilters}
                onReset={resetFilters}
                activeCount={activeFilterCount}
                onSurprise={surpriseMe}
                canSurprise={!!gridData && gridData.results.length > 0}
              />
              <BellButton
                unread={unreadCount}
                onClick={() => setNotificationsOpen((v) => !v)}
              />
              <button
                onClick={() => setSettingsOpen(true)}
                title="Settings"
                aria-label="Settings"
                className="rounded-full p-1.5 text-mute hover:text-ink hover:bg-white/5"
              >
                <SettingsIcon />
              </button>
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
              aria-label="Sort order"
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
                aria-label="Reshuffle"
              >
                🔀
              </button>
            )}
            <button
              onClick={surpriseMe}
              disabled={!gridData || gridData.results.length === 0}
              className="rounded px-3 py-1.5 bg-panel2 ring-1 ring-white/10 hover:ring-accent disabled:opacity-40"
              title="Pick something random from these filters"
            >
              🎲 Surprise me
            </button>
            <BellButton unread={unreadCount} onClick={() => setNotificationsOpen((v) => !v)} />
            <button
              onClick={() => setSettingsOpen(true)}
              title="Settings"
              aria-label="Settings"
              className="rounded p-1.5 text-mute hover:text-ink hover:bg-white/5"
            >
              ⚙
            </button>
            </div>
          </div>
        </div>
        <div className="lg:hidden max-w-[1600px] mx-auto px-4 pb-3">
          <input
            type="search"
            value={filters.q}
            onChange={(e) => updateFilters({ q: e.target.value })}
            placeholder="Search title…"
            aria-label="Search title"
            className="w-full bg-panel2 rounded-md px-3 py-2 text-sm ring-1 ring-white/10 focus:ring-accent outline-none"
          />
          <label className="flex items-center gap-2 mt-2 text-xs text-mute hover:text-ink cursor-pointer">
            <input
              type="checkbox"
              checked={filters.includeOverview}
              onChange={(e) => updateFilters({ includeOverview: e.target.checked })}
              className="accent-accent"
            />
            <span className={filters.includeOverview ? "text-ink" : ""}>Also search in summary</span>
          </label>
        </div>
        {syncError && (
          <div className="bg-red-900/40 text-red-200 text-xs px-4 py-1">{syncError}</div>
        )}
        {loadError && (
          <div className="bg-red-900/40 text-red-200 text-xs px-4 py-1" role="alert">
            Couldn’t load titles: {loadError}
          </div>
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

        <main className="flex-1 min-w-0 px-4 pt-2 pb-4 lg:pt-4">
          {needsSync && (
            <div className="rounded-lg bg-panel p-6 text-center">
              <div className="text-lg font-medium mb-1">Your catalog is empty</div>
              <div className="text-sm text-mute mb-4">
                Click Refresh (top right) or run <code className="text-ink">npm run sync</code> to populate it.
              </div>
            </div>
          )}

          {gridData && (
            <>
              {isEmpty && (
                <div className="rounded-lg bg-panel p-8 text-center text-mute">
                  {allHiddenBySeen ? "Everything on this page is marked as seen." : "Nothing matches your filters."}
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

              {gridData.results.length < gridData.total && (
                <div className="flex justify-center mt-6">
                  <button
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="rounded px-4 py-2 bg-panel ring-1 ring-white/10 hover:ring-accent text-sm disabled:opacity-60"
                  >
                    {loadingMore ? "Loading…" : `Load more (${(gridData.total - gridData.results.length).toLocaleString()} remaining)`}
                  </button>
                </div>
              )}

              {filters.q.trim() && !tmdbExpanded && (
                <div className="flex justify-center mt-6">
                  <button
                    onClick={runTmdbSearch}
                    className="rounded px-4 py-2 bg-panel ring-1 ring-white/10 hover:ring-accent text-sm"
                    title="Search TMDB for titles outside your streamers, and track them to be notified when they arrive"
                  >
                    Find “{filters.q.trim()}” on TMDB
                  </button>
                </div>
              )}

              {tmdbExpanded && (
                <div className="mt-8">
                  <div className="flex items-baseline justify-between mb-3">
                    <h2 className="text-sm font-medium text-mute">More on TMDB</h2>
                    {tmdbLoading && <span className="text-xs text-mute">Searching…</span>}
                  </div>
                  {tmdbResults && tmdbResults.length === 0 && !tmdbLoading && (
                    <div className="rounded-lg bg-panel p-6 text-center text-mute text-sm">
                      No matches on TMDB for “{filters.q.trim()}”.
                    </div>
                  )}
                  {tmdbResults && tmdbResults.length > 0 && (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4">
                      {tmdbResults.map((r) => (
                        <TmdbResultCard
                          key={`${r.mediaType}-${r.tmdbId}`}
                          result={r}
                          providers={providers}
                          watchlisted={isWatchlisted(r.mediaType, r.tmdbId)}
                          onToggleWatchlist={() =>
                            toggle({ mediaType: r.mediaType, tmdbId: r.tmdbId }, "watchlist")
                          }
                          onOpenInCatalog={(mt, id) => void openTitleById(mt, id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          <footer className="mt-8 text-xs text-mute flex items-center justify-center gap-2 flex-wrap">
            <span>This product uses the TMDB API but is not endorsed or certified by TMDB.</span>
            <a href="https://www.themoviedb.org/" target="_blank" rel="noreferrer" aria-label="TMDB">
              <img src="/tmdb-logo.svg" alt="TMDB" className="h-3 opacity-80 hover:opacity-100" />
            </a>
          </footer>
        </main>
      </div>

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
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] bg-panel2 text-sm text-ink px-4 py-2 rounded-lg shadow-lg ring-1 ring-white/10"
        >
          {toast}
        </div>
      )}

      {profileState.needsPick && (
        <ProfilePicker profiles={profileState.profiles} onPick={setActiveProfile} />
      )}

      {settingsOpen && (
        <SettingsModal
          profiles={profileState.profiles}
          activeId={profileState.activeId}
          status={status}
          onSync={onSync}
          onClose={closeSettings}
        />
      )}

      {notificationsOpen && (
        <NotificationsPanel
          items={notifications}
          armedEntries={armedWatchlistEntries}
          providers={providers}
          onClose={closeNotifications}
          onMarkRead={(id) => void markRead(id)}
          onMarkAllRead={() => void markAllRead()}
          onDismiss={(id) => void dismissNotification(id)}
          onRemoveFromWatchlist={(mt, id) => toggle({ mediaType: mt, tmdbId: id }, "watchlist")}
          onOpenTitle={(mt, id) => void openTitleById(mt, id)}
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
  onSurprise,
  canSurprise,
}: {
  filters: Filters;
  providers: Provider[];
  genres: Genre[];
  onChange: (patch: Partial<Filters>) => void;
  onReset: () => void;
  activeCount: number;
  onSurprise: () => void;
  canSurprise: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-expanded={open}
        className="rounded-full bg-panel2 px-3 py-1 text-xs ring-1 ring-white/10 text-ink hover:ring-accent"
      >
        Filters{activeCount > 0 ? ` (${activeCount})` : ""}
      </button>
      {open && createPortal(<MobileDrawer onClose={close} {...{ filters, providers, genres, onChange, onReset, onSurprise, canSurprise }} />, document.body)}
    </>
  );
}

function MobileDrawer({
  filters,
  providers,
  genres,
  onChange,
  onReset,
  onSurprise,
  canSurprise,
  onClose: close,
}: {
  filters: Filters;
  providers: Provider[];
  genres: Genre[];
  onChange: (patch: Partial<Filters>) => void;
  onReset: () => void;
  onSurprise: () => void;
  canSurprise: boolean;
  onClose: () => void;
}): JSX.Element {
  const { panelRef, backdropProps } = useDialog<HTMLDivElement>(close);
  return (
    <div className="fixed inset-0 z-40 bg-black/70" {...backdropProps}>
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        className="absolute inset-y-0 left-0 w-80 bg-panel overflow-y-auto flex flex-col outline-none"
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
              aria-label="Sort order"
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
                aria-label="Reshuffle"
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
        </div>
      </div>
    </div>
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

function BellButton({ unread, onClick }: { unread: number; onClick: () => void }): JSX.Element {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={unread > 0 ? `${unread} new arrival${unread === 1 ? "" : "s"}` : "Notifications"}
      aria-label="Notifications"
      className="relative rounded-full p-1.5 text-mute hover:text-ink hover:bg-white/5"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="w-5 h-5"
        aria-hidden="true"
      >
        <path d="M18 16v-5a6 6 0 0 0-12 0v5l-2 2h16z" />
        <path d="M10 20a2 2 0 0 0 4 0" />
      </svg>
      {unread > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] px-1 rounded-full bg-accent text-bg text-[10px] font-semibold leading-[16px] text-center">
          {unread > 9 ? "9+" : unread}
        </span>
      )}
    </button>
  );
}

function SettingsIcon(): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-5 h-5"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
