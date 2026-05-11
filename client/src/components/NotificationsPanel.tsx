import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { NotificationEntry, Provider, WishlistEntry } from "../types";
import { posterUrl } from "../api";

interface Props {
  items: NotificationEntry[];
  entries: WishlistEntry[];
  providers: Provider[];
  onClose: () => void;
  onMarkRead: (id: number) => void;
  onMarkAllRead: () => void;
  onDismiss: (id: number) => void;
  onUntrack: (mediaType: "movie" | "tv", tmdbId: number) => void;
  onOpenTitle: (mediaType: "movie" | "tv", tmdbId: number) => void;
}

export function NotificationsPanel({
  items,
  entries,
  providers,
  onClose,
  onMarkRead,
  onMarkAllRead,
  onDismiss,
  onUntrack,
  onOpenTitle,
}: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    // Defer to next tick so the click that opened the panel doesn't immediately close it.
    const t = setTimeout(() => document.addEventListener("click", onDocClick), 0);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const unread = items.filter((n) => !n.readAt).length;
  const handleNotificationClick = (n: NotificationEntry): void => {
    if (!n.readAt) onMarkRead(n.id);
    onClose();
    onOpenTitle(n.mediaType, n.tmdbId);
  };

  const handleEntryOpen = (entry: WishlistEntry): void => {
    onClose();
    onOpenTitle(entry.mediaType, entry.tmdbId);
  };

  return createPortal(
    <div
      ref={ref}
      className="fixed inset-x-2 top-[60px] z-40 mx-auto max-w-md rounded-lg bg-panel ring-1 ring-white/10 shadow-xl overflow-hidden flex flex-col max-h-[80vh] sm:inset-auto sm:right-4 sm:top-[52px] sm:w-96"
    >
      <div className="flex-1 overflow-y-auto">
        <div className="px-4 py-2 flex items-center justify-between border-b border-white/5">
          <div className="text-sm font-medium">Inbox</div>
          {unread > 0 && (
            <button
              onClick={onMarkAllRead}
              className="text-xs text-mute hover:text-ink"
            >
              Mark all read
            </button>
          )}
        </div>
        {items.length === 0 ? (
          <div className="px-4 py-6 text-sm text-mute">No new arrivals yet.</div>
        ) : (
          <ul>
            {items.map((n) => {
              const services = n.providerIds
                .map((id) => providers.find((p) => p.id === id))
                .filter((p): p is Provider => p !== undefined);
              const poster = posterUrl(n.posterPath, "w185");
              return (
                <li
                  key={n.id}
                  className={`flex gap-3 px-4 py-2 border-b border-white/5 last:border-b-0 ${n.readAt ? "opacity-60" : ""}`}
                >
                  <button
                    onClick={() => handleNotificationClick(n)}
                    className="flex flex-1 gap-3 text-left items-start min-w-0 hover:opacity-90"
                  >
                    <div className="h-14 w-10 shrink-0 rounded overflow-hidden bg-panel2">
                      {poster && (
                        <img src={poster} alt="" className="h-full w-full object-cover" loading="lazy" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium leading-snug">{n.titleSnapshot}</div>
                      <div className="text-xs text-mute truncate">
                        Now on {services.length > 0 ? services.map((s) => s.name).join(", ") : "one of your streamers"}
                      </div>
                      <div className="text-[11px] text-mute mt-0.5">{relativeTime(n.createdAt)}</div>
                    </div>
                  </button>
                  <button
                    onClick={() => onDismiss(n.id)}
                    title="Dismiss"
                    aria-label="Dismiss"
                    className="self-start text-mute hover:text-ink text-sm leading-none px-1"
                  >
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <div className="px-4 py-2 flex items-center justify-between border-y border-white/5 mt-2">
          <div className="text-sm font-medium">Tracking</div>
          <div className="text-xs text-mute">{entries.length === 0 ? "—" : `${entries.length} title${entries.length === 1 ? "" : "s"}`}</div>
        </div>
        {entries.length === 0 ? (
          <div className="px-4 py-6 text-sm text-mute">
            Nothing tracked yet — search a title, then use “Find on TMDB” at the bottom of the results to add one.
          </div>
        ) : (
          <ul>
            {entries.map((e) => {
              const poster = posterUrl(e.posterPath, "w185");
              const isAvailable = e.currentProviderIds.length > 0;
              const tmdbUrl = `https://www.themoviedb.org/${e.mediaType}/${e.tmdbId}`;
              return (
                <li key={`${e.mediaType}-${e.tmdbId}`} className="flex gap-3 px-4 py-2 border-b border-white/5 last:border-b-0">
                  <a
                    href={tmdbUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Open on TMDB"
                    className="h-14 w-10 shrink-0 rounded overflow-hidden bg-panel2 ring-1 ring-transparent hover:ring-accent/50"
                  >
                    {poster && <img src={poster} alt="" className="h-full w-full object-cover" loading="lazy" />}
                  </a>
                  <div className="flex-1 min-w-0">
                    <a
                      href={tmdbUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Open on TMDB"
                      className="text-sm font-medium leading-snug hover:text-accent"
                    >
                      {e.title}
                    </a>
                    <div className="text-xs text-mute">
                      {e.mediaType === "movie" ? "Movie" : "TV"} · {e.releaseYear ?? "—"}
                    </div>
                    {isAvailable && (
                      <button
                        onClick={() => handleEntryOpen(e)}
                        className="text-xs text-accent hover:underline mt-0.5"
                      >
                        Available now — open
                      </button>
                    )}
                  </div>
                  <button
                    onClick={() => onUntrack(e.mediaType, e.tmdbId)}
                    title="Stop tracking"
                    aria-label="Stop tracking"
                    className="self-start text-mute hover:text-ink text-sm leading-none px-1"
                  >
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>,
    document.body,
  );
}

function relativeTime(iso: string): string {
  // SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" in UTC without a Z;
  // be lenient and treat that as UTC.
  const normalized = iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`;
  const then = new Date(normalized).getTime();
  if (!Number.isFinite(then)) return "";
  const diff = Date.now() - then;
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  return `${mo}mo ago`;
}
