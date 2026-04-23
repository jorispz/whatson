# whatson

Local web app to browse what's available on your Netflix, Disney+, HBO Max, and Ziggo TV subscriptions in the Netherlands. Data from TMDB.

![whatson screenshot](docs/screenshot.png)

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
