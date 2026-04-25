# whatson

Local web app to browse what's available on your Netflix, Disney+, HBO Max, and Ziggo TV subscriptions in the Netherlands. Data from TMDB.

![whatson screenshot](docs/screenshot.png)

> Personal, non-commercial project. Not affiliated with or endorsed by
> Netflix, Disney+, HBO Max, Ziggo, or TMDB. All service names, logos, and
> title artwork are the property of their respective owners.

## Why

Streaming services' recommendation engines chase what's popular right
now. The long tail — decades-old films, foreign gems, one-hit-wonder TV,
anything with fewer than ten thousand ratings — sits buried underneath.
whatson exposes your services' *entire* catalog as a flat, filterable
grid, tuned for deliberate digging rather than passive scrolling.

- **Random sort by default**, with a per-day seed — every visit
  resurfaces different corners of the catalog, but the order stays
  stable within a session so you don't lose your place.
- **Votes range filter** — cap min *and* max rating counts to carve out
  the obscure-but-signal (e.g. 10–1,000 ratings: widely unknown yet
  rated enough that the score means something).
- **Year slider** across 1900 onwards — pin down "the 70s" or any
  arbitrary era when you're in that mood.
- **Genre AND mode** — intersect multiple genres instead of unioning
  them, so "Horror + Comedy" actually returns the rare crossovers
  rather than everything in either bucket.
- **Watchlist and seen marks** — kept locally in your browser, so you
  can build up your own discovery queue.

## Setup

1. Get a free TMDB API Read Access Token at https://www.themoviedb.org/settings/api (v4 auth, the long JWT-style one).
2. Copy `.env.example` to `.env` and paste the token into `TMDB_ACCESS_TOKEN`.
3. Install dependencies:
   ```
   npm install
   ```
4. Start the app:
   ```
   npm run dev
   ```
   Then open http://localhost:5173. The server syncs the catalog from TMDB
   automatically on first run (takes under a minute); refreshes on a 24h
   timer after that, plus whenever you click "Refresh" in the UI.

## Commands

- `npm run dev` — start server + Vite dev server with HMR
- `npm run build` — production build
- `npm start` — run the production server (serves built client)

## Notes

- Data is stored in `server/data/whatson.db` (SQLite). Delete the file to start fresh.
- Availability data is sourced from JustWatch via TMDB and can lag by a day or two.
- The "HBO Max" provider is resolved by name at sync time, so rebrands (Max ↔ HBO Max) are handled automatically.
- Provider deep links are flaky and best-effort. The server scrapes
  TMDB's watch page for JustWatch click-out URLs, follows the affiliate
  redirect chain, and falls back to the streamer's on-site search if the
  resolved URL doesn't end up on the streamer's domain. Even when
  resolution succeeds, mobile behavior varies per provider: some apps
  open straight to the title, some land on their home screen, some
  leave a stale browser tab behind after handing off via Android App
  Links / iOS Universal Links. Treat the click as "take me to roughly
  the right place," not as a guaranteed deep link.

## License

[MIT](LICENSE) — code only. Title metadata, posters, provider logos, and
catalog data are © TMDB and the respective services; this project fetches
them through the TMDB API under their standard attribution terms.
