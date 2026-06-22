# united-movies-data

Public data pipeline for the (private) **United Movie Picker** app. A scheduled
GitHub Action harvests United's public inflight catalog, enriches each title with
ratings and awards, and publishes a single JSON feed to GitHub Pages. The app does a
cheap daily conditional fetch (ETag) and caches it locally, so it stays useful even
offline mid-flight.

**Feed:** https://funkmesh.github.io/united-movies-data/catalog.json

## How it works

`build-catalog.mjs`:

1. **Harvest** — runs `unitedprivatescreening.com` (an Angular SPA) in headless
   Chromium and collects the `content/items` JSON the page fetches for itself, keeping
   the `template === "movie"` entries.
2. **Enrich** — for each *new* title (titles already in the published feed are reused):
   - **OMDb** → IMDb rating, Rotten Tomatoes, Metacritic, and an awards summary.
   - **Wikidata** (matched by IMDb id) → named awards (`{ name, category, year }`).
3. **Publish** — writes `dist/catalog.json` as `{ version, generatedAt, month, movies }`,
   where `version` is a content hash that excludes `generatedAt`. The workflow only
   redeploys when `version` changes, so the Pages ETag stays stable and the app gets
   cheap `304 Not Modified` responses.

## Run locally

```sh
npm install
npm test
OMDB_API_KEY=<key> PUPPETEER_EXECUTABLE_PATH="/path/to/Chrome" npm run build
```

## Configuration

- Secret `OMDB_API_KEY` (repo → Settings → Secrets → Actions) — free key from
  [omdbapi.com](https://www.omdbapi.com/apikey.aspx).
- Pages source: **GitHub Actions**.

Not affiliated with or endorsed by United Airlines. Catalog data belongs to United /
its content partners; ratings/awards from OMDb and Wikidata.
