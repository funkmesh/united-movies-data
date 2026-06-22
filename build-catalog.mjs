// Builds the enriched catalog feed the app consumes.
//
// 1. Harvest United's catalog by running the real Angular SPA in headless Chrome
//    and collecting the `content/items` JSON it fetches for itself.
// 2. Enrich each *new* title with OMDb ratings (IMDb / Rotten Tomatoes / Metacritic)
//    + an awards summary, and named awards from Wikidata (matched by IMDb id).
//    Enrichment for titles already present in the previously published feed is reused
//    so we only hit the APIs for genuinely new movies.
// 3. Write dist/catalog.json as `{ version, generatedAt, month, movies }`, where
//    `version` is a content hash excluding `generatedAt`; emit `changed` so the
//    workflow only redeploys (and changes the ETag) when content actually changed.
//
// Env: OMDB_API_KEY (required for enrichment; absent => ratings/awards left null).
//      PAGES_URL (optional; defaults to the production GitHub Pages feed URL).

import puppeteer from "puppeteer";
import { createHash } from "node:crypto";
import { writeFile, mkdir, appendFile } from "node:fs/promises";
import { mapItem, mapOMDb, mapWikidataAwards, itemKey, ITEM_KINDS } from "./lib.mjs";

const SECTION_URLS = [
  "https://www.unitedprivatescreening.com/movies",
  "https://www.unitedprivatescreening.com/tv",
];
const PAGES_URL = process.env.PAGES_URL || "https://funkmesh.github.io/united-movies-data/catalog.json";
const OMDB_KEY = process.env.OMDB_API_KEY || "";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const WIKIDATA_UA = "united-movie-picker/1.0 (catalog enrichment; https://github.com/funkmesh/united-movies)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function harvest() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);

    const byId = new Map();
    page.on("response", async (resp) => {
      if (!/api\/v3\/content\/items/.test(resp.url()) || resp.status() !== 200) return;
      try {
        const json = JSON.parse(await resp.text());
        const walk = (it) => {
          if (!it || typeof it !== "object") return;
          if (ITEM_KINDS[it.template] && it.id) byId.set(it.id, it);
          for (const k of it.child_items ?? it.items ?? []) walk(k);
        };
        for (const it of json.items ?? []) walk(it);
      } catch {}
    });

    // Visit the Movies and TV sections so both content types are fetched.
    for (const url of SECTION_URLS) {
      await page.goto(url, { waitUntil: "networkidle2", timeout: 90000 });
      for (let i = 0; i < 10; i++) {
        await page.evaluate(() => window.scrollBy(0, 1400));
        await sleep(700);
      }
      await sleep(2000);
    }

    const items = [...byId.values()].map(mapItem).filter(Boolean);
    const movieCount = items.filter((m) => m.kind === "movie").length;
    console.log(`harvested ${items.length} items (${movieCount} movies, ${items.length - movieCount} series)`);
    return items;
  } finally {
    await browser.close();
  }
}

async function loadPrevious() {
  try {
    const resp = await fetch(PAGES_URL, { headers: { "User-Agent": WIKIDATA_UA } });
    if (!resp.ok) return null;
    const json = await resp.json();
    const prev = new Map();
    for (const m of json.movies ?? []) prev.set(itemKey(m), m);
    console.log(`loaded ${prev.size} previously-published items for reuse`);
    return { version: json.version, generatedAt: json.generatedAt, movies: prev };
  } catch {
    console.log("no previous feed (first run or unreachable)");
    return null;
  }
}

async function omdb(title, year, kind) {
  if (!OMDB_KEY) return null;
  const type = kind === "series" ? "&type=series" : "";
  const url = `https://www.omdbapi.com/?apikey=${OMDB_KEY}&t=${encodeURIComponent(title)}${year ? `&y=${year}` : ""}${type}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return mapOMDb(await resp.json());
  } catch {
    return null;
  }
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

async function enrich(movies, previous) {
  let fetched = 0;
  for (const movie of movies) {
    const prior = previous?.movies.get(itemKey(movie));
    if (prior && "imdbRating" in prior) {
      // Reuse prior enrichment so we only hit APIs for new titles.
      Object.assign(movie, {
        imdbRating: prior.imdbRating ?? null,
        rating: prior.rating ?? prior.imdbRating ?? null,
        rottenTomatoes: prior.rottenTomatoes ?? null,
        metascore: prior.metascore ?? null,
        imdbID: prior.imdbID ?? null,
        awardsSummary: prior.awardsSummary ?? null,
        oscarWins: prior.oscarWins ?? null,
        awardWins: prior.awardWins ?? null,
        awards: prior.awards ?? [],
      });
      continue;
    }

    const rating = await omdb(movie.title, movie.year, movie.kind);
    fetched++;
    if (rating) {
      Object.assign(movie, rating);
      movie.awards = await wikidataAwards(rating.imdbID);
      await sleep(200); // be polite to Wikidata
    } else {
      Object.assign(movie, {
        imdbRating: null, rating: null, rottenTomatoes: null, metascore: null,
        imdbID: null, awardsSummary: null, oscarWins: null, awardWins: null, awards: [],
      });
    }
    await sleep(120); // be polite to OMDb
  }
  console.log(`enriched ${fetched} new titles via OMDb/Wikidata (${movies.length - fetched} reused)`);
}

function stableStringify(value) {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
      : v
  );
}

async function main() {
  const movies = await harvest();
  if (movies.length === 0) throw new Error("harvest returned 0 movies — aborting (likely blocked or page changed)");
  movies.sort((a, b) => a.title.localeCompare(b.title));

  const previous = await loadPrevious();
  await enrich(movies, previous);

  const version = createHash("sha256").update(stableStringify(movies)).digest("hex").slice(0, 16);
  const changed = !previous || previous.version !== version;
  const generatedAt = changed ? new Date().toISOString() : (previous?.generatedAt ?? new Date().toISOString());
  const month = new Date().toLocaleString("en-US", { month: "long", year: "numeric" });

  const feed = { version, generatedAt, month, movies };
  await mkdir("dist", { recursive: true });
  await writeFile("dist/catalog.json", JSON.stringify(feed, null, 2));
  console.log(`wrote dist/catalog.json — version ${version}, changed=${changed}, ${movies.length} movies`);

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
