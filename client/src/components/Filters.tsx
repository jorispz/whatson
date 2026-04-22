import type { Filters, Genre, MediaType, Provider, SortKey } from "../types";

interface Props {
  filters: Filters;
  providers: Provider[];
  genres: Genre[];
  onChange: (patch: Partial<Filters>) => void;
  onReset: () => void;
}

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "popularity", label: "Popularity" },
  { value: "rating", label: "Rating" },
  { value: "year", label: "Newest" },
  { value: "title", label: "Title A–Z" },
];

export function FiltersPanel({ filters, providers, genres, onChange, onReset }: Props): JSX.Element {
  const mergedGenres = mergeGenres(genres);

  const toggleMediaType = (mt: MediaType): void => {
    const has = filters.mediaTypes.includes(mt);
    onChange({ mediaTypes: has ? filters.mediaTypes.filter((x) => x !== mt) : [...filters.mediaTypes, mt] });
  };

  const toggleProvider = (id: number): void => {
    const has = filters.providerIds.includes(id);
    onChange({ providerIds: has ? filters.providerIds.filter((x) => x !== id) : [...filters.providerIds, id] });
  };

  const toggleGenre = (id: number): void => {
    const has = filters.genreIds.includes(id);
    onChange({ genreIds: has ? filters.genreIds.filter((x) => x !== id) : [...filters.genreIds, id] });
  };

  return (
    <div className="flex flex-col gap-6 p-4 text-sm">
      <div>
        <input
          type="search"
          value={filters.q}
          onChange={(e) => onChange({ q: e.target.value })}
          placeholder="Search title…"
          className="w-full bg-panel2 rounded-md px-3 py-2 ring-1 ring-white/10 focus:ring-accent outline-none"
        />
      </div>

      <Section label="Type">
        <div className="flex gap-1.5">
          <Chip active={filters.mediaTypes.includes("movie")} onClick={() => toggleMediaType("movie")}>
            Movies
          </Chip>
          <Chip active={filters.mediaTypes.includes("tv")} onClick={() => toggleMediaType("tv")}>
            TV
          </Chip>
        </div>
      </Section>

      <Section label="Service">
        <div className="flex flex-col gap-1.5">
          {providers.map((p) => (
            <label
              key={p.id}
              className="flex items-center gap-2 cursor-pointer hover:text-ink text-mute"
            >
              <input
                type="checkbox"
                checked={filters.providerIds.includes(p.id)}
                onChange={() => toggleProvider(p.id)}
                className="accent-accent"
              />
              {p.logo_path && (
                <img src={`https://image.tmdb.org/t/p/w45${p.logo_path}`} alt="" className="h-4 w-4 rounded" />
              )}
              <span className={filters.providerIds.includes(p.id) ? "text-ink" : ""}>{p.name}</span>
            </label>
          ))}
        </div>
      </Section>

      <Section label={`Minimum rating: ${filters.minRating.toFixed(1)}`}>
        <input
          type="range"
          min={0}
          max={9}
          step={0.5}
          value={filters.minRating}
          onChange={(e) => onChange({ minRating: Number(e.target.value) })}
          className="w-full accent-accent"
        />
      </Section>

      <Section label="Year">
        <div className="flex gap-2 items-center">
          <input
            type="number"
            placeholder="from"
            value={filters.yearFrom ?? ""}
            onChange={(e) => onChange({ yearFrom: e.target.value ? Number(e.target.value) : null })}
            className="w-20 bg-panel2 rounded px-2 py-1 ring-1 ring-white/10 outline-none focus:ring-accent"
          />
          <span className="text-mute">–</span>
          <input
            type="number"
            placeholder="to"
            value={filters.yearTo ?? ""}
            onChange={(e) => onChange({ yearTo: e.target.value ? Number(e.target.value) : null })}
            className="w-20 bg-panel2 rounded px-2 py-1 ring-1 ring-white/10 outline-none focus:ring-accent"
          />
        </div>
      </Section>

      <Section label="Genre">
        <div className="flex flex-wrap gap-1.5 max-h-64 overflow-y-auto">
          {mergedGenres.map((g) => (
            <Chip key={g.id} active={filters.genreIds.includes(g.id)} onClick={() => toggleGenre(g.id)} small>
              {g.name}
            </Chip>
          ))}
        </div>
      </Section>

      <Section label="Your list">
        <label className="flex items-center gap-2 text-mute hover:text-ink cursor-pointer">
          <input
            type="checkbox"
            checked={filters.watchlistOnly}
            onChange={(e) => onChange({ watchlistOnly: e.target.checked })}
            className="accent-accent"
          />
          <span className={filters.watchlistOnly ? "text-ink" : ""}>Show only my watchlist</span>
        </label>
        <label className="flex items-center gap-2 text-mute hover:text-ink cursor-pointer mt-1">
          <input
            type="checkbox"
            checked={filters.hideSeen}
            onChange={(e) => onChange({ hideSeen: e.target.checked })}
            className="accent-accent"
          />
          <span className={filters.hideSeen ? "text-ink" : ""}>Hide seen</span>
        </label>
      </Section>

      <Section label="Sort by">
        <select
          value={filters.sort}
          onChange={(e) => onChange({ sort: e.target.value as SortKey })}
          className="w-full bg-panel2 rounded px-2 py-1.5 ring-1 ring-white/10 outline-none focus:ring-accent"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Section>

      <button onClick={onReset} className="text-xs text-mute hover:text-ink underline self-start">
        Reset filters
      </button>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-mute mb-2">{label}</div>
      {children}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
  small,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  small?: boolean;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`rounded-full ring-1 transition-colors ${small ? "px-2.5 py-0.5 text-xs" : "px-3 py-1 text-sm"} ${
        active
          ? "bg-accent/20 ring-accent text-ink"
          : "bg-panel2 ring-white/10 text-mute hover:text-ink hover:ring-white/30"
      }`}
    >
      {children}
    </button>
  );
}

// TMDB has separate genre lists for movies and TV; merge by name so the UI has one list.
function mergeGenres(genres: Genre[]): { id: number; name: string }[] {
  const byName = new Map<string, number>();
  for (const g of genres) {
    if (!byName.has(g.name)) byName.set(g.name, g.id);
  }
  return Array.from(byName.entries())
    .map(([name, id]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
