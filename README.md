# united-movies-data

Public data pipeline for the (private) **Movie Picker** app. A scheduled GitHub Action
harvests several US airlines' public inflight catalogs, enriches each title with ratings
and awards, and publishes one JSON feed per airline to GitHub Pages. The app does a cheap
daily conditional fetch (ETag) per airline and caches it locally, so it stays useful even
offline mid-flight.

**Feeds:**

- Index (list of airlines): https://funkmesh.github.io/united-movies-data/index.json
- United: https://funkmesh.github.io/united-movies-data/united.json
- American: https://funkmesh.github.io/united-movies-data/american.json
- Delta: https://funkmesh.github.io/united-movies-data/delta.json
- `catalog.json` is kept as an alias of `united.json` for backward compatibility.

## How it works

`build-catalog.mjs` runs each airline's **source adapter** (`sources/*.mjs`), then shares
one enrichment pass and publishing step across all of them:

1. **Harvest** — each adapter returns the catalog in a common shape. The adapters are
   deliberately different, matching how each airline publishes its data:
   - **United** (`sources/united.mjs`) — runs `unitedprivatescreening.com` (a geemedia
     Angular SPA) in headless Chromium and collects the `content/items` JSON it fetches
     for itself (movies + TV).
   - **American** (`sources/american.mjs`) — fetches `entertainment.aa.com/en/movies`
     (a Next.js site, paginated `?page=N`) server-side and reads the movie records
     embedded in each page's flight payload. Provides an IMDb id per title. Movies only.
   - **Delta** (`sources/delta.mjs`) — fetches the server-rendered "current movies" page
     and parses out title + poster. It's a curated subset of the onboard catalog with no
     other metadata, so the rest is backfilled from OMDb.
2. **Enrich** — for each *new* title (titles already in an airline's published feed are
   reused; an in-run cache also shares results across airlines):
   - **OMDb** → IMDb rating, Rotten Tomatoes, Metacritic, an awards summary, and —
     where the airline omits them — descriptive fields (genres, director, cast, synopsis,
     language, maturity, year, runtime). Source-provided fields are never overwritten.
   - **Wikidata** (matched by IMDb id) → named awards (`{ name, category, year }`).
3. **Publish** — writes `dist/<id>.json` per airline as `{ id, displayName, version,
   generatedAt, month, movies }` (where `version` is a content hash excluding
   `generatedAt`), a `dist/index.json` manifest, and `dist/catalog.json` (United alias).
   The workflow only redeploys when some feed's `version` changes, so the Pages ETag
   stays stable and the app gets cheap `304 Not Modified` responses.

If one airline's harvest fails, its previously-published feed is kept and the run
continues; the run only fails if *every* airline fails.

## Adding an airline

Create `sources/<id>.mjs` exporting `{ id, displayName, async harvest() }`, where
`harvest()` returns an array of titles in the common shape (see `mapItem` /
`mapAmericanRecord` / `mapDeltaEntry` in `lib.mjs`). List it in `sources/index.mjs`.
Geemedia-backed sites can reuse `harvestGeemedia` from `sources/_geemedia.mjs`.

## Run locally

```sh
npm install
npm test
# all airlines:
OMDB_API_KEY=<key> PUPPETEER_EXECUTABLE_PATH="/path/to/Chrome" npm run build
# a single airline (American/Delta need no browser):
SOURCES=delta OMDB_API_KEY=<key> npm run build
```

## Configuration

- Secret `OMDB_API_KEY` (repo → Settings → Secrets → Actions) — free key from
  [omdbapi.com](https://www.omdbapi.com/apikey.aspx).
- `PAGES_BASE` (optional) — base URL of the published feeds, used to reuse prior
  enrichment. Defaults to the production GitHub Pages URL.
- `SOURCES` (optional) — comma list of airline ids to build (e.g. `united,delta`).
- Pages source: **GitHub Actions**.

Not affiliated with or endorsed by United, American, or Delta. Catalog data belongs to
the respective airlines / their content partners; ratings and awards from OMDb and
Wikidata.
