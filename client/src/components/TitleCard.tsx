import { memo, useState } from "react";
import type { Provider, Title } from "../types";
import { openServiceLink, posterUrl } from "../api";
import type { Mark } from "../marks";

interface Props {
  title: Title;
  providers: Provider[];
  mark: Mark | undefined;
  onSelect: (title: Title) => void;
  onToggleMark: (title: Title, mark: Mark) => void;
}

export const TitleCard = memo(TitleCardInner);

function TitleCardInner({ title, providers, mark, onSelect, onToggleMark }: Props): JSX.Element {
  const poster = posterUrl(title.posterPath);
  const services = title.providerIds
    .map((id) => providers.find((p) => p.id === id))
    .filter((p): p is Provider => p !== undefined);

  return (
    <div
      style={{ contentVisibility: "auto", containIntrinsicSize: "420px" }}
      className={`group relative flex flex-col rounded-lg overflow-hidden bg-panel hover:bg-panel2 transition-colors ring-1 hover:ring-accent/50 ${
        mark === "seen" ? "ring-emerald-500/40 opacity-70" : mark === "watchlist" ? "ring-accent/50" : "ring-white/5"
      }`}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => onSelect(title)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(title);
          }
        }}
        className="text-left flex flex-col flex-1 cursor-pointer"
      >
      <div className="aspect-[2/3] w-full bg-panel2 relative">
        {poster ? (
          <img
            src={poster}
            alt={title.title}
            className="h-full w-full object-cover"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className="flex items-center justify-center h-full text-mute text-sm">No image</div>
        )}
        <div className="absolute top-2 right-2 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-xs font-medium">
          <span className="text-yellow-400">★</span>
          <span>{title.voteAverage.toFixed(1)}</span>
        </div>
      </div>
      <div className="p-3 flex-1 flex flex-col gap-1">
        <div className="font-medium text-sm leading-snug line-clamp-2">{title.title}</div>
        <div className="text-xs text-mute">
          {title.mediaType === "movie" ? "Movie" : "TV"} · {title.releaseYear ?? "—"}
        </div>
        <div className="mt-auto flex items-center gap-1 pt-2 flex-wrap">
          {services.map((s) => (
            <ProviderBadge key={s.id} provider={s} title={title} />
          ))}
        </div>
      </div>
      </div>
      <div className="absolute top-2 left-2 flex flex-col gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        <MarkButton
          active={mark === "watchlist"}
          title={mark === "watchlist" ? "Remove from watchlist" : "Add to watchlist"}
          onClick={() => onToggleMark(title, "watchlist")}
          activeClass="bg-accent text-bg"
        >
          🔖
        </MarkButton>
        <MarkButton
          active={mark === "seen"}
          title={mark === "seen" ? "Unmark as seen" : "Mark as seen"}
          onClick={() => onToggleMark(title, "seen")}
          activeClass="bg-emerald-500 text-bg"
        >
          ✓
        </MarkButton>
      </div>
      {mark && (
        <div className="absolute top-2 left-2 pointer-events-none group-hover:opacity-0 transition-opacity">
          <div
            className={`h-6 w-6 rounded-full flex items-center justify-center text-[11px] font-bold shadow ${
              mark === "seen" ? "bg-emerald-500 text-bg" : "bg-accent text-bg"
            }`}
          >
            {mark === "seen" ? "✓" : "🔖"}
          </div>
        </div>
      )}
    </div>
  );
}

function MarkButton({
  active,
  title,
  onClick,
  activeClass,
  children,
}: {
  active: boolean;
  title: string;
  onClick: () => void;
  activeClass: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={title}
      className={`h-7 w-7 rounded-full flex items-center justify-center text-xs shadow ring-1 ring-white/10 ${
        active ? activeClass : "bg-black/70 hover:bg-black/90 text-white"
      }`}
    >
      {children}
    </button>
  );
}

function ProviderBadge({ provider, title }: { provider: Provider; title: Title }): JSX.Element {
  const [resolving, setResolving] = useState(false);
  const logo = provider.logo_path ? `https://image.tmdb.org/t/p/w45${provider.logo_path}` : null;
  const className =
    "inline-flex items-center justify-center h-6 w-6 rounded overflow-hidden bg-white/5 ring-1 ring-white/10 hover:ring-accent transition-colors disabled:opacity-70";

  const onClick = async (e: React.MouseEvent): Promise<void> => {
    e.preventDefault();
    e.stopPropagation();
    if (resolving) return;
    setResolving(true);
    try {
      await openServiceLink(title, provider.key);
    } finally {
      setResolving(false);
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={resolving}
      title={`Open on ${provider.name}`}
      className={className}
    >
      {resolving ? (
        <span className="whatson-spinner text-mute" style={{ fontSize: "14px" }} aria-label="Opening…" />
      ) : logo ? (
        <img src={logo} alt={provider.name} className="h-full w-full object-cover" />
      ) : (
        <span className="text-[9px] text-mute w-full text-center">{provider.name.slice(0, 2)}</span>
      )}
    </button>
  );
}
