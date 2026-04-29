import { useEffect, useRef, useState } from "react";
import type { Genre, Provider, Title } from "../types";
import { api, openServiceLink, posterUrl } from "../api";
import { useMarks } from "../marks";

function reviewSearchUrl(title: string, year: number | null, mediaType: "movie" | "tv"): string {
  const parts = [title];
  if (year) parts.push(String(year));
  parts.push(mediaType === "tv" ? "series review" : "review");
  return `https://kagi.com/search?q=${encodeURIComponent(parts.join(" "))}`;
}

function formatRuntime(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function formatTvLength(seasons: number | null, episodes: number | null): string | null {
  const sLabel = seasons !== null ? `${seasons} ${seasons === 1 ? "season" : "seasons"}` : null;
  const eLabel = episodes !== null ? `${episodes} ${episodes === 1 ? "episode" : "episodes"}` : null;
  if (sLabel && eLabel) return `${sLabel} · ${eLabel}`;
  return sLabel ?? eLabel;
}

interface Props {
  title: Title;
  providers: Provider[];
  genres: Genre[];
  onClose: () => void;
  onSelect: (title: Title) => void;
}

export function TitleModal({ title, providers, genres, onClose, onSelect }: Props): JSX.Element {
  const [trailerKey, setTrailerKey] = useState<string | null | undefined>(undefined);
  const [runtime, setRuntime] = useState<number | null>(null);
  const [certification, setCertification] = useState<string | null>(null);
  const [seasonCount, setSeasonCount] = useState<number | null>(null);
  const [episodeCount, setEpisodeCount] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [recs, setRecs] = useState<Title[] | null>(null);
  // True until the /api/details fetch resolves. Used to reserve layout space
  // for the runtime / certification pills so they don't pop in and grow the
  // meta row.
  const detailsLoading = trailerKey === undefined;
  const scrollRef = useRef<HTMLDivElement>(null);
  const recsScrollRef = useRef<HTMLDivElement>(null);
  const { hasMark, toggle } = useMarks();
  const savedWatchlist = hasMark(title, "watchlist");
  const seen = hasMark(title, "seen");

  // When the selected title changes (e.g. via a recommendation), scroll the
  // modal back to the top so the user sees the new content.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    if (recsScrollRef.current) recsScrollRef.current.scrollLeft = 0;
  }, [title.mediaType, title.tmdbId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setTrailerKey(undefined);
    setRuntime(null);
    setCertification(null);
    setSeasonCount(null);
    setEpisodeCount(null);
    setPlaying(false);
    setRecs(null);
    api
      .details(title.mediaType, title.tmdbId)
      .then((res) => {
        if (cancelled) return;
        setTrailerKey(res.youtubeKey);
        setRuntime(res.runtime);
        setCertification(res.certification);
        setSeasonCount(res.seasonCount);
        setEpisodeCount(res.episodeCount);
      })
      .catch(() => {
        if (!cancelled) setTrailerKey(null);
      });
    api
      .recommendations(title.mediaType, title.tmdbId)
      .then((res) => {
        if (!cancelled) setRecs(res.results);
      })
      .catch(() => {
        if (!cancelled) setRecs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [title.mediaType, title.tmdbId]);

  const services = title.providerIds
    .map((id) => providers.find((p) => p.id === id))
    .filter((p): p is Provider => p !== undefined);
  const titleGenres = title.genreIds
    .map((id) => genres.find((g) => g.id === id && g.media_type === title.mediaType))
    .filter((g): g is Genre => g !== undefined);

  const backdrop = title.backdropPath ? `https://image.tmdb.org/t/p/w780${title.backdropPath}` : null;
  const poster = posterUrl(title.posterPath, "w342");
  const hasHeader = backdrop || playing;

  return (
    <div
      ref={scrollRef}
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm overflow-y-auto"
      onClick={onClose}
    >
      <div className="min-h-full flex items-start sm:items-center justify-center p-4">
      <div
        className="bg-panel rounded-xl overflow-hidden max-w-3xl w-full shadow-2xl ring-1 ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        {hasHeader && (
          <div className="aspect-video bg-panel2 relative">
            {playing && trailerKey ? (
              <iframe
                className="absolute inset-0 h-full w-full"
                src={`https://www.youtube.com/embed/${trailerKey}?autoplay=1&rel=0`}
                title="Trailer"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            ) : (
              <>
                {backdrop && (
                  <>
                    <img src={backdrop} alt="" className="h-full w-full object-cover opacity-70" />
                    <div className="absolute inset-0 bg-gradient-to-t from-panel via-panel/40 to-transparent" />
                  </>
                )}
                {/* Mount the button as soon as the header is up, but keep it
                    invisible + non-interactive until trailerKey resolves to a
                    real key. Fading in via transition feels less abrupt than
                    a sudden mount. */}
                <button
                  onClick={() => setPlaying(true)}
                  disabled={!trailerKey}
                  aria-hidden={!trailerKey}
                  tabIndex={trailerKey ? 0 : -1}
                  className={`absolute inset-0 flex items-center justify-center group transition-opacity duration-300 ${
                    trailerKey ? "opacity-100" : "opacity-0 pointer-events-none"
                  }`}
                  aria-label="Play trailer"
                >
                  <span className="flex items-center gap-2 bg-black/70 hover:bg-black/90 text-white rounded-full px-5 py-2.5 text-sm font-medium ring-1 ring-white/20 group-hover:ring-accent transition">
                    <span className="text-lg leading-none">▶</span>
                    Play trailer
                  </span>
                </button>
              </>
            )}
          </div>
        )}
        <div className="p-6 flex gap-6">
          {poster && (
            <img
              src={poster}
              alt={title.title}
              className={`hidden sm:block w-40 self-start rounded-md shadow-lg ring-1 ring-white/10 relative ${
                hasHeader ? "-mt-20" : ""
              }`}
            />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-1 flex-wrap">
                <button
                  onClick={() => toggle(title, "seen")}
                  title={seen ? "Unmark as seen" : "Mark as seen"}
                  className={`rounded px-2 py-1 text-sm whitespace-nowrap transition-colors ${
                    seen
                      ? "bg-emerald-500 text-bg"
                      : "text-mute hover:text-ink hover:bg-white/5"
                  }`}
                >
                  ✓ {seen ? "Seen" : "Mark as seen"}
                </button>
                <button
                  onClick={() => toggle(title, "watchlist")}
                  title={savedWatchlist ? "Remove from watchlist" : "Add to watchlist"}
                  className={`rounded px-2 py-1 text-sm whitespace-nowrap transition-colors ${
                    savedWatchlist
                      ? "bg-accent text-bg"
                      : "text-mute hover:text-ink hover:bg-white/5"
                  }`}
                >
                  🔖 {savedWatchlist ? "Saved" : "Add to watchlist"}
                </button>
              </div>
              <button
                onClick={onClose}
                className="rounded p-1 text-mute hover:text-ink hover:bg-white/5 shrink-0"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <h2 className="mt-2 text-2xl font-semibold leading-tight">{title.title}</h2>
            <div className="mt-1 text-sm text-mute flex items-center gap-3 flex-wrap">
              <span>{title.mediaType === "movie" ? "Movie" : "TV Series"}</span>
              {title.releaseYear && <span>{title.releaseYear}</span>}
              <span className="flex items-center gap-1">
                <span className="text-yellow-400">★</span>
                {title.voteAverage.toFixed(1)}
                <span className="text-mute">({title.voteCount.toLocaleString()})</span>
              </span>
              {(() => {
                const isTv = title.mediaType === "tv";
                const text = isTv
                  ? formatTvLength(seasonCount, episodeCount)
                  : runtime !== null
                    ? formatRuntime(runtime)
                    : null;
                if (text === null && !detailsLoading) return null;
                const placeholder = isTv ? "5 seasons · 50 episodes" : "1h 30m";
                const minWidth = isTv ? "min-w-[11rem]" : "min-w-[3.5rem]";
                return (
                  <span className={`inline-block ${minWidth} ${text === null ? "invisible" : ""}`}>
                    {text ?? placeholder}
                  </span>
                );
              })()}
              {(certification || detailsLoading) && (
                <span
                  className={`inline-flex items-center px-1.5 rounded ring-1 ring-white/15 text-[11px] text-ink/80 leading-5 ${
                    !certification ? "invisible" : ""
                  }`}
                >
                  {certification ?? "AL"}
                </span>
              )}
            </div>

            {titleGenres.length > 0 && (
              <div className="mt-3 flex gap-1.5 flex-wrap">
                {titleGenres.map((g) => (
                  <span
                    key={g.id}
                    className="text-xs px-2 py-0.5 rounded-full bg-white/5 ring-1 ring-white/10 text-mute"
                  >
                    {g.name}
                  </span>
                ))}
              </div>
            )}

            {title.overview && <p className="mt-4 text-sm leading-relaxed text-ink/90">{title.overview}</p>}

            {services.length > 0 && (
              <div className="mt-5">
                <div className="text-xs uppercase tracking-wider text-mute mb-2">Available on</div>
                <div className="flex gap-2 flex-wrap">
                  {services.map((s) => (
                    <ServiceButton key={s.id} service={s} title={title} />
                  ))}
                </div>
              </div>
            )}

            <div className="mt-5 flex gap-4 text-xs text-mute">
              <a
                className="hover:text-ink underline"
                href={reviewSearchUrl(title.title, title.releaseYear, title.mediaType)}
                target="_blank"
                rel="noreferrer"
              >
                Search reviews ↗
              </a>
              <a
                className="hover:text-ink underline"
                href={`https://www.themoviedb.org/${title.mediaType}/${title.tmdbId}`}
                target="_blank"
                rel="noreferrer"
              >
                View on TMDB ↗
              </a>
            </div>
          </div>
        </div>

        {(recs === null || recs.length > 0) && (
          <div className="border-t border-white/5 px-6 py-4">
            <div className="text-xs uppercase tracking-wider text-mute mb-3">More like this</div>
            <div ref={recsScrollRef} className="flex gap-3 overflow-x-auto pb-1">
              {recs === null
                ? Array.from({ length: 6 }).map((_, i) => (
                    <div
                      key={i}
                      aria-hidden="true"
                      className="shrink-0 w-28 rounded-md overflow-hidden bg-panel2 ring-1 ring-white/5 animate-pulse"
                    >
                      <div className="aspect-[2/3] bg-white/5" />
                      <div className="p-2 space-y-1.5">
                        <div className="h-3 bg-white/5 rounded" />
                        <div className="h-2 bg-white/5 rounded w-2/3" />
                      </div>
                    </div>
                  ))
                : recs.map((r) => (
                <button
                  key={`${r.mediaType}-${r.tmdbId}`}
                  onClick={() => onSelect(r)}
                  className="shrink-0 w-28 text-left rounded-md overflow-hidden bg-panel2 ring-1 ring-white/5 hover:ring-accent/60 transition-colors"
                  title={r.title}
                >
                  <div className="aspect-[2/3] bg-panel2">
                    {r.posterPath ? (
                      <img
                        src={`https://image.tmdb.org/t/p/w185${r.posterPath}`}
                        alt={r.title}
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="flex items-center justify-center h-full text-xs text-mute">No image</div>
                    )}
                  </div>
                  <div className="p-2">
                    <div className="text-xs font-medium line-clamp-2 leading-snug">{r.title}</div>
                    <div className="text-[10px] text-mute mt-0.5 flex items-center gap-1.5">
                      <span>{r.releaseYear ?? "—"}</span>
                      <span className="text-yellow-400">★</span>
                      <span>{r.voteAverage.toFixed(1)}</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

function ServiceButton({ service, title }: { service: Provider; title: Title }): JSX.Element {
  const [resolving, setResolving] = useState(false);
  const onClick = async (): Promise<void> => {
    if (resolving) return;
    setResolving(true);
    try {
      await openServiceLink(title, service.key);
    } finally {
      setResolving(false);
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={resolving}
      title={`Open ${title.title} on ${service.name}`}
      className="flex items-center gap-2 bg-panel2 px-3 py-1.5 rounded-lg ring-1 ring-white/10 transition-colors hover:bg-panel2/70 hover:ring-accent disabled:opacity-70"
    >
      {resolving ? (
        <span className="whatson-spinner text-mute" style={{ fontSize: "16px" }} aria-label="Opening…" />
      ) : (
        service.logo_path && (
          <img src={`/providers/${service.key}.jpg`} alt="" className="h-5 w-5 rounded" />
        )
      )}
      <span className="text-sm">{service.name}</span>
      {!resolving && <span className="text-xs text-mute">↗</span>}
    </button>
  );
}
