// Builds the enriched catalog feeds the app consumes — one per airline.
//
// 1. Harvest each airline's public catalog via its source adapter (sources/*.mjs).
//    Adapters are heterogeneous: United runs its Angular SPA in headless Chrome;
//    American and Delta are fetched and parsed server-side.
// 2. Enrich each *new* title with OMDb ratings (IMDb / Rotten Tomatoes / Metacritic)
//    + an awards summary, named awards from Wikidata (matched by IMDb id), and — for
//    sources that omit them — descriptive fields (genres/cast/synopsis/…) backfilled
//    from OMDb. Enrichment for titles already in an airline's published feed is reused,
//    and an in-run cache shares results across airlines, so we only hit the APIs for
//    genuinely new titles.
// 3. Write dist/<id>.json per airline as `{ id, displayName, version, generatedAt,
//    month, movies }` (version is a content hash excluding generatedAt), a
//    dist/index.json manifest, and dist/catalog.json as a United alias (back-compat).
//    Emit `changed` so the workflow only redeploys when some feed actually changed.
//
// If one airline's harvest fails, its previously-published feed is kept and the run
// continues; the run only fails if every airline fails.
//
// Env: OMDB_API_KEY (required for enrichment; absent => ratings/awards left null).
//      PAGES_BASE   (optional; base URL of the published feeds, for prior-feed reuse).
//      SOURCES      (optional; comma list of airline ids to build, e.g. "delta").

import { createHash } from "node:crypto";
import { writeFile, mkdir, appendFile } from "node:fs/promises";
import {
  mapOMDb, mapWikidataAwards, enrichKey, cleanTitle, yearWithin,
  pickSearchMatch, omdbDescriptive, backfill, indexPrevious, lookupPrevious,
  assignMatchIds,
} from "./lib.mjs";
import SOURCES from "./sources/index.mjs";

const PAGES_BASE = process.env.PAGES_BASE || "https://funkmesh.github.io/united-movies-data";
const OMDB_KEY = process.env.OMDB_API_KEY || "";
const WIKIDATA_UA = "inflight-movie-picker/1.0 (catalog enrichment; https://github.com/funkmesh/united-movies-data)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadPrevious(id) {
  try {
    const resp = await fetch(`${PAGES_BASE}/${id}.json`, { headers: { "User-Agent": WIKIDATA_UA } });
    if (!resp.ok) return null;
    const json = await resp.json();
    const index = indexPrevious(json.movies ?? []);
    console.log(`  loaded ${(json.movies ?? []).length} previously-published ${id} titles for reuse`);
    return { version: json.version, generatedAt: json.generatedAt, index, raw: json };
  } catch {
    console.log(`  no previous ${id} feed (first run or unreachable)`);
    return null;
  }
}

async function omdbRequest(params) {
  const url = new URL("https://www.omdbapi.com/");
  url.searchParams.set("apikey", OMDB_KEY);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") url.searchParams.set(key, value);
  }
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

const found = (j) => j && j.Response !== "False";

/// Resolve a title to its OMDb record (raw JSON). When the source already gives us an
/// IMDb id (American), match by id directly — most accurate. Otherwise use the layered
/// title match so "Star Wars: A New Hope" (OMDb "Episode IV"), "The Running Man (2025)"
/// (a year baked into the title), and "Phantom Thread" (2017 vs OMDb 2018) still resolve.
async function omdb(movie) {
  if (!OMDB_KEY) return null;
  if (movie.imdbID) {
    const j = await omdbRequest({ i: movie.imdbID });
    return found(j) ? j : null;
  }
  const title = cleanTitle(movie.title);
  const type = movie.kind === "series" ? "series" : "movie";
  const year = movie.year;

  let j = await omdbRequest({ t: title, y: year, type });
  if (found(j)) return j;

  j = await omdbRequest({ t: title, type });
  if (found(j) && yearWithin(j.Year, year)) return j;

  const search = await omdbRequest({ s: title, type });
  const imdbID = pickSearchMatch(search?.Search, year);
  if (imdbID) {
    j = await omdbRequest({ i: imdbID });
    if (found(j)) return j;
  }
  return null;
}

async function wikidataAwards(imdbID) {
  if (!imdbID) return [];
  const query = `SELECT ?awardLabel ?year WHERE {
    ?film wdt:P345 "${imdbID}".
    ?film p:P166 ?st. ?st ps:P166 ?award.
    OPTIONAL { ?st pq:P585 ?date. BIND(YEAR(?date) AS ?year) }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
  } LIMIT 100`;
  const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`;
  try {
    const resp = await fetch(url, { headers: { Accept: "application/sparql-results+json", "User-Agent": WIKIDATA_UA } });
    if (!resp.ok) return [];
    const json = await resp.json();
    return mapWikidataAwards(json.results?.bindings ?? []);
  } catch {
    return [];
  }
}

/** Fetch + assemble the enrichment for one title (rating fields, OMDb descriptive data
 * for backfill, and Wikidata awards). Shape is cached and reused across airlines. */
async function fetchEnrichment(movie) {
  const j = await omdb(movie);
  if (!j) return { rating: null, descriptive: {}, awards: [] };
  const rating = mapOMDb(j);
  const descriptive = omdbDescriptive(j);
  let awards = [];
  if (rating?.imdbID) {
    awards = await wikidataAwards(rating.imdbID);
    await sleep(200); // be polite to Wikidata
  }
  return { rating, descriptive, awards };
}

/** Apply an enrichment result to a movie: rating fields + descriptive backfill. Keeps a
 * source-provided IMDb id even if OMDb returned no record. */
function applyEnrichment(movie, enr) {
  const r = enr.rating;
  Object.assign(movie, {
    imdbRating: r?.imdbRating ?? null,
    rating: r?.rating ?? r?.imdbRating ?? null,
    rottenTomatoes: r?.rottenTomatoes ?? null,
    metascore: r?.metascore ?? null,
    imdbID: r?.imdbID ?? movie.imdbID ?? null,
    awardsSummary: r?.awardsSummary ?? null,
    oscarWins: r?.oscarWins ?? null,
    awardWins: r?.awardWins ?? null,
    awards: enr.awards ?? [],
  });
  backfill(movie, enr.descriptive);
}

async function enrich(movies, previous, cache) {
  let fetched = 0, cacheHits = 0, reused = 0;
  for (const movie of movies) {
    const prior = lookupPrevious(previous?.index, movie);
    if (prior && prior.imdbRating != null) {
      // Reuse only titles we already have a rating for; everything else (never matched,
      // or matched but unrated) is retried each run so improved matching and newly-added
      // ratings get picked up. Descriptive fields from the prior feed are reused too.
      Object.assign(movie, {
        imdbRating: prior.imdbRating ?? null,
        rating: prior.rating ?? prior.imdbRating ?? null,
        rottenTomatoes: prior.rottenTomatoes ?? null,
        metascore: prior.metascore ?? null,
        imdbID: prior.imdbID ?? movie.imdbID ?? null,
        awardsSummary: prior.awardsSummary ?? null,
        oscarWins: prior.oscarWins ?? null,
        awardWins: prior.awardWins ?? null,
        awards: prior.awards ?? [],
      });
      backfill(movie, {
        year: prior.year, runtimeMinutes: prior.runtimeMinutes, genres: prior.genres,
        director: prior.director, cast: prior.cast, synopsis: prior.synopsis,
        language: prior.language, maturityRating: prior.maturityRating,
      });
      reused++;
      continue;
    }

    const key = enrichKey(movie);
    let enr = cache.get(key);
    if (enr) {
      cacheHits++;
    } else {
      enr = await fetchEnrichment(movie);
      cache.set(key, enr);
      if (enr.rating?.imdbID) cache.set(`i:${enr.rating.imdbID}`, enr); // share across airlines
      fetched++;
      await sleep(120); // be polite to OMDb
    }
    applyEnrichment(movie, enr);
  }
  console.log(`  enriched ${fetched} new via OMDb/Wikidata (${cacheHits} cache hits, ${reused} reused)`);
}

function stableStringify(value) {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
      : v
  );
}

/** Phase 1: harvest + enrich one airline, returning the enriched titles *without*
 * hashing them yet — so a cross-airline `matchId` pass can run before feeds are
 * versioned and written. On harvest failure, carries the previously-published feed
 * to reuse (so a transient failure doesn't wipe data). */
async function harvestAirline(adapter, cache) {
  const { id, displayName } = adapter;
  console.log(`\n=== ${displayName} (${id}) ===`);
  const previous = await loadPrevious(id);
  try {
    // Adapters return either an array of titles or { items, envelope } where envelope
    // carries extra airline-specific feed fields (e.g. American's IFE system legend).
    const harvested = await adapter.harvest();
    const movies = Array.isArray(harvested) ? harvested : (harvested?.items ?? []);
    const envelope = Array.isArray(harvested) ? {} : (harvested?.envelope ?? {});
    if (movies.length === 0) throw new Error("harvest returned 0 items");
    movies.sort((a, b) => a.title.localeCompare(b.title));
    const movieCount = movies.filter((m) => m.kind === "movie").length;
    console.log(`  harvested ${movies.length} items (${movieCount} movies, ${movies.length - movieCount} series)`);

    await enrich(movies, previous, cache);
    return { id, displayName, envelope, movies, previous, ok: true };
  } catch (err) {
    console.error(`  ✗ ${id} failed: ${err.message}`);
    if (previous?.raw) {
      console.log(`  reusing previously-published ${id}.json (${(previous.raw.movies ?? []).length} titles)`);
    } else {
      console.log(`  no previous ${id} feed to fall back on — skipping`);
    }
    return { id, displayName, previous, ok: false, reuse: previous?.raw ?? null };
  }
}

/** Phase 2: hash + assemble one airline's feed, after `matchId`s are assigned. A
 * failed airline reuses its previously-published feed (no version change). */
function finalizeAirline(built) {
  const { id, displayName, envelope, movies, previous, ok, reuse } = built;
  if (!ok) return { feed: reuse, changed: false, ok: false };
  const version = createHash("sha256").update(stableStringify({ ...envelope, movies })).digest("hex").slice(0, 16);
  const changed = !previous || previous.version !== version;
  const generatedAt = changed ? new Date().toISOString() : (previous?.generatedAt ?? new Date().toISOString());
  const month = new Date().toLocaleString("en-US", { month: "long", year: "numeric" });
  console.log(`  ${id}: version ${version}, changed=${changed}, ${movies.length} titles`);
  return { feed: { id, displayName, version, generatedAt, month, ...envelope, movies }, changed, ok: true };
}

async function main() {
  const only = (process.env.SOURCES || "").split(",").map((s) => s.trim()).filter(Boolean);
  const adapters = only.length ? SOURCES.filter((s) => only.includes(s.id)) : SOURCES;
  if (adapters.length === 0) throw new Error(`no matching sources for SOURCES=${process.env.SOURCES}`);

  await mkdir("dist", { recursive: true });
  const cache = new Map();

  // Phase 1: harvest + enrich every airline.
  const built = [];
  for (const adapter of adapters) built.push(await harvestAirline(adapter, cache));

  // Cross-airline identity: assign a stable matchId to the airlines we rebuilt,
  // using every airline's resolved IMDb ids (including reused feeds) as the pool —
  // so a title one airline matched lends its id to another that couldn't.
  const rebuilt = built.filter((b) => b.ok).flatMap((b) => b.movies);
  const pool = [
    ...rebuilt,
    ...built.filter((b) => !b.ok && b.reuse).flatMap((b) => b.reuse.movies ?? []),
  ];
  assignMatchIds(rebuilt, pool);

  // Phase 2: hash + write each feed.
  const manifest = [];
  const failures = [];
  let anyChanged = false;
  let unitedFeed = null;
  for (const b of built) {
    const { feed, changed, ok } = finalizeAirline(b);
    if (!ok) failures.push(b.id);
    if (!feed) continue; // nothing to write (failed with no prior feed)
    anyChanged = anyChanged || changed;
    await writeFile(`dist/${b.id}.json`, JSON.stringify(feed, null, 2));
    manifest.push({
      id: b.id, displayName: b.displayName, file: `${b.id}.json`,
      version: feed.version, generatedAt: feed.generatedAt, month: feed.month,
      count: (feed.movies ?? []).length, ok,
    });
    if (b.id === "united") unitedFeed = feed;
  }

  const index = { generatedAt: new Date().toISOString(), airlines: manifest };
  await writeFile("dist/index.json", JSON.stringify(index, null, 2));

  // Back-compat: the existing app fetches catalog.json — keep it mirroring United.
  if (unitedFeed) await writeFile("dist/catalog.json", JSON.stringify(unitedFeed, null, 2));

  console.log(`\nwrote ${manifest.length} feed(s); changed=${anyChanged}; failures=[${failures.join(", ")}]`);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `changed=${anyChanged}\n`);
  }
  if (failures.length === adapters.length) {
    throw new Error(`all sources failed: ${failures.join(", ")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
