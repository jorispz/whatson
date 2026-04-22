# whatson

Local web app to browse what's available on your Netflix, Disney+, and HBO Max subscriptions in the Netherlands. Data from TMDB.

## Setup

1. Get a free TMDB API key at https://www.themoviedb.org/settings/api (v3 auth, the shorter one).
2. Copy `.env.example` to `.env` and paste your key.
3. Install dependencies:
   ```
   npm install
   ```
4. Populate the local catalog (first sync takes a couple of minutes):
   ```
   npm run sync
   ```
5. Start the app:
   ```
   npm run dev
   ```
   Then open http://localhost:5173.

## Commands

- `npm run dev` — start server + Vite dev server with HMR
- `npm run sync` — refresh the local catalog from TMDB
- `npm run build` — production build
- `npm start` — run the production server (serves built client)

## Notes

- Data is stored in `server/data/whatson.db` (SQLite). Delete the file to start fresh.
- Availability data is sourced from JustWatch via TMDB and can lag by a day or two.
- The "HBO Max" provider is resolved by name at sync time, so rebrands (Max ↔ HBO Max) are handled automatically.
