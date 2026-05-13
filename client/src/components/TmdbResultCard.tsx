import type { Provider, TmdbSearchResult } from "../types";
import { posterUrl } from "../api";

interface Props {
  result: TmdbSearchResult;
  providers: Provider[];
  watchlisted: boolean;
  onToggleWatchlist: () => void;
  onOpenInCatalog: (mediaType: "movie" | "tv", tmdbId: number) => void;
}

export function TmdbResultCard({
  result,
  providers,
  watchlisted,
  onToggleWatchlist,
  onOpenInCatalog,
}: Props): JSX.Element {
  const poster = posterUrl(result.posterPath);
  const services = result.currentProviderIds
    .map((id) => providers.find((p) => p.id === id))
    .filter((p): p is Provider => p !== undefined);
  const tmdbUrl = `https://www.themoviedb.org/${result.mediaType}/${result.tmdbId}`;

  return (
    <div
      style={{ contentVisibility: "auto", containIntrinsicSize: "420px" }}
      className="flex flex-col rounded-lg overflow-hidden bg-panel ring-1 ring-white/5"
    >
      <a
        href={tmdbUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="aspect-[2/3] w-full bg-panel2 relative block ring-1 ring-transparent hover:ring-accent/50 transition-colors"
        title="Open on TMDB"
      >
        {poster ? (
          <img src={poster} alt={result.title} className="h-full w-full object-cover" loading="lazy" decoding="async" />
        ) : (
          <div className="flex items-center justify-center h-full text-mute text-sm">No image</div>
        )}
      </a>
      <div className="p-3 flex-1 flex flex-col gap-1">
        <a
          href={tmdbUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-sm leading-snug line-clamp-2 hover:text-accent"
          title="Open on TMDB"
        >
          {result.title}
        </a>
        <div className="text-xs text-mute">
          {result.mediaType === "movie" ? "Movie" : "TV"} · {result.releaseYear ?? "—"}
        </div>
        <div className="mt-auto pt-2 flex flex-col gap-2">
          {result.inCatalog && (
            <div className="flex items-center gap-1 flex-wrap">
              {services.map((s) => {
                const logo = s.logo_path ? `/providers/${s.key}.jpg` : null;
                return (
                  <span
                    key={s.id}
                    title={s.name}
                    className="inline-flex items-center justify-center h-6 w-6 rounded overflow-hidden bg-white/5 ring-1 ring-white/10"
                  >
                    {logo ? (
                      <img src={logo} alt={s.name} className="h-full w-full object-cover" />
                    ) : (
                      <span className="text-[9px] text-mute">{s.name.slice(0, 2)}</span>
                    )}
                  </span>
                );
              })}
            </div>
          )}
          <div className="flex gap-1">
            <button
              onClick={onToggleWatchlist}
              title={watchlisted ? "Remove from watchlist" : "Add to watchlist"}
              aria-label={watchlisted ? "Remove from watchlist" : "Add to watchlist"}
              className={`${result.inCatalog ? "shrink-0" : "flex-1"} rounded px-2 py-1.5 text-xs ring-1 ${
                watchlisted
                  ? "bg-accent/20 text-accent ring-accent/40 hover:bg-accent/30"
                  : "bg-panel2 ring-white/10 hover:ring-accent"
              }`}
            >
              {result.inCatalog ? "🔖" : watchlisted ? "🔖 On watchlist" : "🔖 Add to watchlist"}
            </button>
            {result.inCatalog && (
              <button
                onClick={() => onOpenInCatalog(result.mediaType, result.tmdbId)}
                className="flex-1 rounded px-2 py-1.5 text-xs bg-panel2 ring-1 ring-white/10 hover:ring-accent"
              >
                Open
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
