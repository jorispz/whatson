import { useRef, useState } from "react";
import type { Filters, Genre, MediaType, Provider } from "../types";

interface Props {
  filters: Filters;
  providers: Provider[];
  genres: Genre[];
  onChange: (patch: Partial<Filters>) => void;
  onReset: () => void;
}

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
      {/* Search lives at the top of the main content area on mobile (see App.tsx) so the
          input is reachable without opening the drawer. Hide it here on those breakpoints
          to avoid duplication. */}
      <div className="hidden lg:block">
        <input
          type="search"
          value={filters.q}
          onChange={(e) => onChange({ q: e.target.value })}
          placeholder="Search title…"
          className="w-full bg-panel2 rounded-md px-3 py-2 ring-1 ring-white/10 focus:ring-accent outline-none"
        />
        <label className="flex items-center gap-2 mt-2 text-xs text-mute hover:text-ink cursor-pointer">
          <input
            type="checkbox"
            checked={filters.includeOverview}
            onChange={(e) => onChange({ includeOverview: e.target.checked })}
            className="accent-accent"
          />
          <span className={filters.includeOverview ? "text-ink" : ""}>Also search in summary</span>
        </label>
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

      <Section label={`Rating: ${filters.minRating.toFixed(1)} – ${filters.maxRating.toFixed(1)}`}>
        <RatingRange
          min={filters.minRating}
          max={filters.maxRating}
          onChange={(lo, hi) => onChange({ minRating: lo, maxRating: hi })}
        />
      </Section>

      <Section label={`Votes: ${formatVotesRange(filters.minVotes, filters.maxVotes)}`}>
        <VotesRange
          minVotes={filters.minVotes}
          maxVotes={filters.maxVotes}
          onChange={(lo, hi) => onChange({ minVotes: lo, maxVotes: hi })}
        />
      </Section>

      <Section label={`Year: ${filters.yearFrom ?? YEAR_MIN} – ${filters.yearTo ?? YEAR_MAX}`}>
        <YearRange
          yearFrom={filters.yearFrom}
          yearTo={filters.yearTo}
          onChange={(from, to) => onChange({ yearFrom: from, yearTo: to })}
        />
      </Section>

      <Section
        label="Genre"
        extra={
          <label className="flex items-center gap-1.5 text-xs text-mute cursor-pointer hover:text-ink normal-case tracking-normal">
            <input
              type="checkbox"
              checked={filters.genreMode === "all"}
              onChange={(e) => onChange({ genreMode: e.target.checked ? "all" : "any" })}
              className="accent-accent"
            />
            Require all selected
          </label>
        }
      >
        <div className="flex flex-wrap gap-1.5">
          {mergedGenres.map((g) => (
            <Chip key={g.id} active={filters.genreIds.includes(g.id)} onClick={() => toggleGenre(g.id)} small>
              {g.name}
            </Chip>
          ))}
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

      <button onClick={onReset} className="text-xs text-mute hover:text-ink underline self-start">
        Reset filters
      </button>
    </div>
  );
}

function Section({
  label,
  extra,
  children,
}: {
  label: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-xs uppercase tracking-wider text-mute">{label}</div>
        {extra}
      </div>
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

const RATING_STEP = 0.5;
const RATING_MAX = 10;

const YEAR_MIN = 1900;
const YEAR_MAX = new Date().getFullYear();

function RatingRange({
  min,
  max,
  onChange,
}: {
  min: number;
  max: number;
  onChange: (lo: number, hi: number) => void;
}): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragStart, setDragStart] = useState<{ x: number; lo: number; hi: number; width: number } | null>(null);

  const loPct = (min / RATING_MAX) * 100;
  const hiPct = (max / RATING_MAX) * 100;

  const snap = (v: number): number => Math.round(v / RATING_STEP) * RATING_STEP;

  const onFillDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const track = trackRef.current;
    if (!track) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragStart({ x: e.clientX, lo: min, hi: max, width: track.getBoundingClientRect().width });
  };

  const onFillMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragStart) return;
    const deltaVal = ((e.clientX - dragStart.x) / dragStart.width) * RATING_MAX;
    const span = dragStart.hi - dragStart.lo;
    let newLo = dragStart.lo + deltaVal;
    let newHi = dragStart.hi + deltaVal;
    if (newLo < 0) {
      newLo = 0;
      newHi = span;
    }
    if (newHi > RATING_MAX) {
      newHi = RATING_MAX;
      newLo = RATING_MAX - span;
    }
    onChange(snap(newLo), snap(newHi));
  };

  const onFillUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    setDragStart(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div ref={trackRef} className="range-dual">
      <div className="absolute inset-x-0 h-1 bg-panel2 rounded-full" />
      <div
        className="absolute h-full flex items-center cursor-grab active:cursor-grabbing"
        style={{
          left: `${loPct}%`,
          right: `${100 - hiPct}%`,
          touchAction: "none",
        }}
        onPointerDown={onFillDown}
        onPointerMove={onFillMove}
        onPointerUp={onFillUp}
        onPointerCancel={onFillUp}
        aria-label="Drag to shift rating range"
      >
        <div className="h-1 w-full bg-accent rounded-full" />
      </div>
      <input
        type="range"
        min={0}
        max={RATING_MAX}
        step={RATING_STEP}
        value={min}
        onChange={(e) => onChange(Math.min(Number(e.target.value), max), max)}
        aria-label="Minimum rating"
      />
      <input
        type="range"
        min={0}
        max={RATING_MAX}
        step={RATING_STEP}
        value={max}
        onChange={(e) => onChange(min, Math.max(Number(e.target.value), min))}
        aria-label="Maximum rating"
      />
    </div>
  );
}

function YearRange({
  yearFrom,
  yearTo,
  onChange,
}: {
  yearFrom: number | null;
  yearTo: number | null;
  onChange: (from: number | null, to: number | null) => void;
}): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragStart, setDragStart] = useState<{ x: number; lo: number; hi: number; width: number } | null>(null);

  const span = YEAR_MAX - YEAR_MIN;
  const lo = yearFrom ?? YEAR_MIN;
  const hi = yearTo ?? YEAR_MAX;
  const loPct = ((lo - YEAR_MIN) / span) * 100;
  const hiPct = ((hi - YEAR_MIN) / span) * 100;

  // At either endpoint, emit null so the filter reads as "unbounded" — matches
  // the existing server contract and keeps activeFilterCount honest.
  const emit = (newLo: number, newHi: number): void => {
    onChange(newLo <= YEAR_MIN ? null : newLo, newHi >= YEAR_MAX ? null : newHi);
  };

  const onFillDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const track = trackRef.current;
    if (!track) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragStart({ x: e.clientX, lo, hi, width: track.getBoundingClientRect().width });
  };

  const onFillMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragStart) return;
    const deltaVal = ((e.clientX - dragStart.x) / dragStart.width) * span;
    const width = dragStart.hi - dragStart.lo;
    let newLo = dragStart.lo + deltaVal;
    let newHi = dragStart.hi + deltaVal;
    if (newLo < YEAR_MIN) {
      newLo = YEAR_MIN;
      newHi = YEAR_MIN + width;
    }
    if (newHi > YEAR_MAX) {
      newHi = YEAR_MAX;
      newLo = YEAR_MAX - width;
    }
    emit(Math.round(newLo), Math.round(newHi));
  };

  const onFillUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    setDragStart(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div ref={trackRef} className="range-dual">
      <div className="absolute inset-x-0 h-1 bg-panel2 rounded-full" />
      <div
        className="absolute h-full flex items-center cursor-grab active:cursor-grabbing"
        style={{ left: `${loPct}%`, right: `${100 - hiPct}%`, touchAction: "none" }}
        onPointerDown={onFillDown}
        onPointerMove={onFillMove}
        onPointerUp={onFillUp}
        onPointerCancel={onFillUp}
        aria-label="Drag to shift year range"
      >
        <div className="h-1 w-full bg-accent rounded-full" />
      </div>
      <input
        type="range"
        min={YEAR_MIN}
        max={YEAR_MAX}
        step={1}
        value={lo}
        onChange={(e) => emit(Math.min(Number(e.target.value), hi), hi)}
        aria-label="Minimum year"
      />
      <input
        type="range"
        min={YEAR_MIN}
        max={YEAR_MAX}
        step={1}
        value={hi}
        onChange={(e) => emit(lo, Math.max(Number(e.target.value), lo))}
        aria-label="Maximum year"
      />
    </div>
  );
}

// Discrete stops for the votes range slider. The topmost stop is "10k+": for
// the max handle it means "no upper bound" (null sent to the server); for the
// min handle it means "at least 10k votes".
const VOTE_STOPS = [0, 10, 100, 1000, 10000];
const VOTE_STOP_LABELS = ["0", "10", "100", "1k", "10k+"];
const VOTE_LAST_IDX = VOTE_STOPS.length - 1;

function minVotesIndex(value: number): number {
  for (let i = VOTE_LAST_IDX; i >= 0; i--) {
    if ((VOTE_STOPS[i] as number) <= value) return i;
  }
  return 0;
}

function maxVotesIndex(value: number | null): number {
  if (value === null) return VOTE_LAST_IDX;
  for (let i = 0; i < VOTE_STOPS.length; i++) {
    if ((VOTE_STOPS[i] as number) === value) return i;
  }
  return VOTE_LAST_IDX;
}

function formatVotesRange(min: number, max: number | null): string {
  const loLabel = VOTE_STOP_LABELS[minVotesIndex(min)] ?? "0";
  const hiLabel = VOTE_STOP_LABELS[maxVotesIndex(max)] ?? "10k+";
  return `${loLabel} – ${hiLabel}`;
}

function VotesRange({
  minVotes,
  maxVotes,
  onChange,
}: {
  minVotes: number;
  maxVotes: number | null;
  onChange: (lo: number, hi: number | null) => void;
}): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragStart, setDragStart] = useState<{ x: number; loIdx: number; hiIdx: number; width: number } | null>(null);

  const loIdx = minVotesIndex(minVotes);
  const hiIdx = maxVotesIndex(maxVotes);

  const clampIdx = (i: number): number => Math.max(0, Math.min(VOTE_LAST_IDX, Math.round(i)));

  const setFromIndices = (newLo: number, newHi: number): void => {
    const minValue = (VOTE_STOPS[newLo] ?? 0) as number;
    const maxValue = newHi === VOTE_LAST_IDX ? null : ((VOTE_STOPS[newHi] ?? 0) as number);
    onChange(minValue, maxValue);
  };

  const onFillDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const track = trackRef.current;
    if (!track) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragStart({ x: e.clientX, loIdx, hiIdx, width: track.getBoundingClientRect().width });
  };

  const onFillMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragStart) return;
    const deltaIdx = ((e.clientX - dragStart.x) / dragStart.width) * VOTE_LAST_IDX;
    const span = dragStart.hiIdx - dragStart.loIdx;
    let newLo = dragStart.loIdx + deltaIdx;
    let newHi = dragStart.hiIdx + deltaIdx;
    if (newLo < 0) {
      newLo = 0;
      newHi = span;
    }
    if (newHi > VOTE_LAST_IDX) {
      newHi = VOTE_LAST_IDX;
      newLo = VOTE_LAST_IDX - span;
    }
    setFromIndices(clampIdx(newLo), clampIdx(newHi));
  };

  const onFillUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    setDragStart(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const loPct = (loIdx / VOTE_LAST_IDX) * 100;
  const hiPct = (hiIdx / VOTE_LAST_IDX) * 100;

  return (
    <div ref={trackRef} className="range-dual">
      <div className="absolute inset-x-0 h-1 bg-panel2 rounded-full" />
      <div
        className="absolute h-full flex items-center cursor-grab active:cursor-grabbing"
        style={{
          left: `${loPct}%`,
          right: `${100 - hiPct}%`,
          touchAction: "none",
        }}
        onPointerDown={onFillDown}
        onPointerMove={onFillMove}
        onPointerUp={onFillUp}
        onPointerCancel={onFillUp}
        aria-label="Drag to shift votes range"
      >
        <div className="h-1 w-full bg-accent rounded-full" />
      </div>
      <input
        type="range"
        min={0}
        max={VOTE_LAST_IDX}
        step={1}
        value={loIdx}
        onChange={(e) => {
          const next = Math.min(Number(e.target.value), hiIdx);
          setFromIndices(next, hiIdx);
        }}
        aria-label="Minimum votes"
      />
      <input
        type="range"
        min={0}
        max={VOTE_LAST_IDX}
        step={1}
        value={hiIdx}
        onChange={(e) => {
          const next = Math.max(Number(e.target.value), loIdx);
          setFromIndices(loIdx, next);
        }}
        aria-label="Maximum votes"
      />
    </div>
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
