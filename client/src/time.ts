// Relative "x ago" label. Accepts ISO strings and SQLite's datetime('now')
// format ("YYYY-MM-DD HH:MM:SS", UTC without a Z).
export function relativeTime(iso: string): string {
  const normalized = iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`;
  const then = new Date(normalized).getTime();
  if (!Number.isFinite(then)) return "";
  const diff = Date.now() - then;
  const m = Math.round(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  return `${mo}mo ago`;
}
