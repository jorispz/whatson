import { useEffect, useState } from "react";
import type { Genre, Provider, Title } from "../types";
import { api, posterUrl, serviceSearchUrl } from "../api";
import { useMarks } from "../marks";

function reviewSearchUrl(title: string, year: number | null, mediaType: "movie" | "tv"): string {
  const parts = [title];
  if (year) parts.push(String(year));
  parts.push(mediaType === "tv" ? "series review" : "review");
  return `https://kagi.com/search?q=${encodeURIComponent(parts.join(" "))}`;
}

interface Props {
  title: Title;
  providers: Provider[];
  genres: Genre[];
  onClose: () => void;
}

export function TitleModal({ title, providers, genres, onClose }: Props): JSX.Element {
  const [trailerKey, setTrailerKey] = useState<string | null | undefined>(undefined);
  const [playing, setPlaying] = useState(false);
  const { getMark, toggle } = useMarks();
  const mark = getMark(title);

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
    setPlaying(false);
    api
      .trailer(title.mediaType, title.tmdbId)
      .then((res) => {
        if (!cancelled) setTrailerKey(res.youtubeKey);
      })
      .catch(() => {
        if (!cancelled) setTrailerKey(null);
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

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-start sm:items-center justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-panel rounded-xl overflow-hidden max-w-3xl w-full shadow-2xl ring-1 ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        {(backdrop || playing) && (
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
                {trailerKey && (
                  <button
                    onClick={() => setPlaying(true)}
                    className="absolute inset-0 flex items-center justify-center group"
                    aria-label="Play trailer"
                  >
                    <span className="flex items-center gap-2 bg-black/70 hover:bg-black/90 text-white rounded-full px-5 py-2.5 text-sm font-medium ring-1 ring-white/20 group-hover:ring-accent transition">
                      <span className="text-lg leading-none">▶</span>
                      Play trailer
                    </span>
                  </button>
                )}
              </>
            )}
          </div>
        )}
        <div className="p-6 flex gap-6">
          {poster && (
            <img
              src={poster}
              alt={title.title}
              className="hidden sm:block w-40 self-start rounded-md shadow-lg ring-1 ring-white/10 -mt-20 relative"
            />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-2xl font-semibold leading-tight">{title.title}</h2>
                <div className="mt-1 text-sm text-mute flex items-center gap-3 flex-wrap">
                  <span>{title.mediaType === "movie" ? "Movie" : "TV Series"}</span>
                  {title.releaseYear && <span>{title.releaseYear}</span>}
                  <span className="flex items-center gap-1">
                    <span className="text-yellow-400">★</span>
                    {title.voteAverage.toFixed(1)}
                    <span className="text-mute">({title.voteCount.toLocaleString()})</span>
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => toggle(title, "watchlist")}
                  title={mark === "watchlist" ? "Remove from watchlist" : "Add to watchlist"}
                  className={`rounded px-2 py-1 text-sm transition-colors ${
                    mark === "watchlist"
                      ? "bg-accent text-bg"
                      : "text-mute hover:text-ink hover:bg-white/5"
                  }`}
                >
                  🔖 {mark === "watchlist" ? "Saved" : "Save"}
                </button>
                <button
                  onClick={() => toggle(title, "seen")}
                  title={mark === "seen" ? "Unmark as seen" : "Mark as seen"}
                  className={`rounded px-2 py-1 text-sm transition-colors ${
                    mark === "seen"
                      ? "bg-emerald-500 text-bg"
                      : "text-mute hover:text-ink hover:bg-white/5"
                  }`}
                >
                  ✓ {mark === "seen" ? "Seen" : "Mark seen"}
                </button>
                <button
                  onClick={onClose}
                  className="rounded p-1 text-mute hover:text-ink hover:bg-white/5"
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>
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
                  {services.map((s) => {
                    const url = serviceSearchUrl(s.key, title);
                    const content = (
                      <>
                        {s.logo_path && (
                          <img
                            src={`https://image.tmdb.org/t/p/w45${s.logo_path}`}
                            alt=""
                            className="h-5 w-5 rounded"
                          />
                        )}
                        <span className="text-sm">{s.name}</span>
                        {url && <span className="text-xs text-mute">↗</span>}
                      </>
                    );
                    const className =
                      "flex items-center gap-2 bg-panel2 px-3 py-1.5 rounded-lg ring-1 ring-white/10 transition-colors hover:bg-panel2/70 hover:ring-accent";
                    return url ? (
                      <a
                        key={s.id}
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className={className}
                        title={`Search ${s.name}`}
                      >
                        {content}
                      </a>
                    ) : (
                      <div key={s.id} className={className}>
                        {content}
                      </div>
                    );
                  })}
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
      </div>
    </div>
  );
}
