// Pure, testable helpers for the catalog build pipeline.
// Kept side-effect-free so `node --test` can cover the mapping logic that's
// easy to get wrong (the network/puppeteer orchestration lives in build-catalog.mjs).

// --- geemedia content item -> app Movie shape -------------------------------

// Airline feeds label some genres as one run-together word ("ConcertsLiveEvents"),
// which is what a client would otherwise render on a filter chip. Keyed by
// `genreKey` so a compound is recognised however the source spells it — run
// together, spaced, or already pretty.
const PRETTY_GENRE = {
  actionadventure: "Action & Adventure",
  scififantasy: "Sci-Fi & Fantasy",
  concertsliveevents: "Concerts & Live Events",
  foodtravel: "Food & Travel",
};

const LANGUAGE_NAMES = {
  eng: "English", spa: "Spanish", fra: "French", deu: "German", ita: "Italian",
  ptb: "Portuguese", por: "Portuguese", jpn: "Japanese", kor: "Korean",
  zho: "Chinese", cmn: "Chinese", hin: "Hindi", ara: "Arabic", rus: "Russian",
  nld: "Dutch",
};

/** Canonical lookup key for a genre: case- and separator-insensitive, so
 * "ConcertsLiveEvents", "Concerts Live Events" and the already-pretty
 * "Concerts & Live Events" all agree. That also makes `prettyGenre` idempotent
 * over its own output, which matters because previously-published genres flow
 * back through the pipeline via `backfill`. */
const genreKey = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Split a CamelCase run into words: "FoodTravel" -> "Food Travel",
 * "TVShows" -> "TV Shows". Leaves hyphenated OMDb genres ("Sci-Fi",
 * "Reality-TV") and already-spaced names alone. */
function splitCamelCase(s) {
  return s
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

/** Normalise a source's genre name into the label clients display. Known compounds
 * get a hand-written label (with the "&" the source dropped); anything else falls
 * back to splitting the CamelCase run, so a newly-appearing compound still reads as
 * words instead of shipping as one token. */
export function prettyGenre(name) {
  const s = String(name ?? "").trim();
  if (!s) return s;
  return PRETTY_GENRE[genreKey(s)] ?? splitCamelCase(s).replace(/\s+/g, " ").trim();
}

function intOrNull(v) {
  if (v == null) return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

function numOrNull(v) {
  if (v == null || v === "N/A") return null;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function nonEmpty(s) {
  if (typeof s !== "string") return null;
  const t = s.trim();
  return t.length ? t : null;
}

function nameList(v) {
  let parts = [];
  if (Array.isArray(v)) parts = v;
  else if (typeof v === "string") parts = v.split(",");
  return parts.map((s) => String(s).trim()).filter(Boolean);
}

function languageName(v) {
  const code = (Array.isArray(v) ? v[0] : v);
  if (typeof code !== "string") return null;
  const c = code.toLowerCase();
  return LANGUAGE_NAMES[c] ?? c.toUpperCase();
}

function posterURL(item) {
  const fromMap = (map) => {
    if (!map || typeof map !== "object") return null;
    for (const res of Object.values(map)) {
      if (!res || typeof res !== "object") continue;
      for (const urls of Object.values(res)) {
        if (Array.isArray(urls) && urls.length) return urls[0];
      }
    }
    return null;
  };
  const fromImage = (img) => {
    for (const d of img?.displays ?? []) {
      for (const mr of d?.media_resolutions ?? []) {
        for (const a of mr?.assets ?? []) {
          if (a?.url) return a.url;
        }
      }
    }
    return null;
  };
  const direct = fromMap(item.poster_image);
  if (direct) return direct;
  const images = item.images ?? [];
  const preferred =
    images.find((i) => i.class === "poster_image") ??
    images.find((i) => i.class === "thumbnail");
  return preferred ? fromImage(preferred) : null;
}

/** Content templates we index as catalog entries, and the `kind` we tag each with. */
export const ITEM_KINDS = { movie: "movie", tv_series: "series" };

/** Map a geemedia `content/items` entry (movie or tv series) to the app's catalog
 * JSON (or null for templates we don't index — sections, umbrella tv_show, etc.). */
export function mapItem(item) {
  if (!item) return null;
  const kind = ITEM_KINDS[item.template];
  if (!kind) return null;
  const title = (item.title ?? item.name ?? "").trim();
  if (!title) return null;

  const genres = [];
  let maturity = null;
  for (const attr of item.attributes ?? []) {
    const name = attr.name ?? attr.title;
    if (!name) continue;
    if (attr.type === "genre") genres.push(prettyGenre(name));
    else if (attr.type === "classification" && maturity == null) maturity = name;
  }

  const isSeries = kind === "series";
  return {
    kind,
    title,
    // Series have no single year/runtime; they carry season + episode counts instead.
    year: isSeries ? null : intOrNull(item.year),
    runtimeMinutes: isSeries ? null : intOrNull(item.duration_minute),
    seasonNumber: isSeries ? intOrNull(item.season_number) : null,
    episodeCount: isSeries ? intOrNull(item.child_id_count) : null,
    genres,
    maturityRating: maturity,
    synopsis: nonEmpty(item.long_description) ?? nonEmpty(item.synopsis),
    director: nameList(item.director_list)[0] ?? null,
    cast: nameList(item.cast_list),
    language: languageName(isSeries ? item.audio_language : item.movie_language),
    posterURL: posterURL(item),
  };
}

// --- OMDb title matching ----------------------------------------------------

/** Strip a trailing "(YYYY)" some United titles carry, e.g. "The Running Man (2025)". */
export function cleanTitle(title) {
  return String(title ?? "").replace(/\s*\((?:19|20)\d{2}\)\s*$/, "").trim();
}

/** First 4-digit year in an OMDb year string (handles ranges like "2017–2019"). */
export function parseYear(value) {
  const m = String(value ?? "").match(/(?:19|20)\d{2}/);
  return m ? parseInt(m[0], 10) : null;
}

/** True if the OMDb year is within `tol` years of what we wanted (lenient when
 * either side is unknown — United and OMDb often disagree by a year on release). */
export function yearWithin(omdbYear, wantedYear, tol = 2) {
  if (wantedYear == null) return true;
  const y = parseYear(omdbYear);
  if (y == null) return true;
  return Math.abs(y - wantedYear) <= tol;
}

/** Choose the best imdbID from OMDb `s=` search results: the candidate whose year
 * is closest to `wantedYear` (within `tol`). Returns null if none qualify. */
export function pickSearchMatch(results, wantedYear, tol = 2) {
  const items = (results ?? []).filter((r) => r && r.imdbID);
  if (items.length === 0) return null;
  if (wantedYear == null) return items[0].imdbID;
  let best = null;
  let bestDelta = Infinity;
  for (const r of items) {
    const y = parseYear(r.Year);
    if (y == null) continue;
    const delta = Math.abs(y - wantedYear);
    if (delta <= tol && delta < bestDelta) {
      best = r.imdbID;
      bestDelta = delta;
    }
  }
  return best;
}

// --- OMDb response -> rating/award enrichment -------------------------------

/** Parse OMDb's free-text Awards string into a summary + coarse counts. */
export function parseAwards(s) {
  if (!s || s === "N/A") return { awardsSummary: null, oscarWins: null, awardWins: null };
  const oscars = s.match(/Won (\d+) Oscars?/i);
  const wins = s.match(/(\d+) wins?/i);
  return {
    awardsSummary: s,
    oscarWins: oscars ? parseInt(oscars[1], 10) : null,
    awardWins: wins ? parseInt(wins[1], 10) : null,
  };
}

/** Map an OMDb JSON response to the rating fields we keep (or null if not found). */
export function mapOMDb(j) {
  if (!j || j.Response === "False") return null;
  const rt = (j.Ratings ?? []).find((r) => r.Source === "Rotten Tomatoes");
  const imdb = numOrNull(j.imdbRating);
  return {
    imdbRating: imdb,
    rating: imdb, // back-compat: existing UI/sorts read Movie.rating
    rottenTomatoes: rt ? intOrNull(rt.Value) : null, // "80%" -> 80
    metascore: intOrNull(j.Metascore),
    imdbID: j.imdbID && j.imdbID !== "N/A" ? j.imdbID : null,
    ...parseAwards(j.Awards),
  };
}

// --- Wikidata SPARQL rows -> named awards -----------------------------------

/** Map SPARQL result bindings (?awardLabel, ?year) to [{name, category, year}]. */
export function mapWikidataAwards(bindings) {
  const seen = new Set();
  const out = [];
  for (const b of bindings ?? []) {
    const label = b?.awardLabel?.value;
    if (!label) continue;
    const year = b?.year?.value ? parseInt(b.year.value, 10) : null;
    let name = label;
    let category = null;
    const idx = label.indexOf(" for ");
    if (idx > 0) {
      name = label.slice(0, idx);
      category = label.slice(idx + 5);
    }
    const key = `${name}|${category}|${year}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, category, year });
  }
  // Stable order: by year (unknown last) then name, so the published hash is
  // deterministic.
  out.sort((a, b) => (a.year ?? Infinity) - (b.year ?? Infinity) || a.name.localeCompare(b.name));
  return out;
}

// --- American (entertainment.aa.com) flight payload -> records --------------

/** Concatenate the Next.js App Router "flight" chunks the page embeds for itself. */
function decodeFlight(html) {
  let buf = "";
  for (const m of String(html).matchAll(/self\.__next_f\.push\(\[1,"(.*?)"\]\)/gs)) {
    try { buf += JSON.parse(`"${m[1]}"`); } catch {}
  }
  return buf;
}

/** Extract American's content records (films from /en/movies, series from /en/series)
 * from a page's flight payload. Balanced-brace scan keeping objects that JSON-parse and
 * carry a top-level name + poster + content_type — the marker of a real catalog record,
 * which drops the page-sized wrappers and the nested episode/summary objects. */
export function extractAmericanRecords(html) {
  const buf = decodeFlight(html);
  const out = new Map();
  const stack = [];
  let instr = false, esc = false;
  for (let i = 0; i < buf.length; i++) {
    const ch = buf[i];
    if (instr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') instr = false;
      continue;
    }
    if (ch === '"') instr = true;
    else if (ch === "{") stack.push(i);
    else if (ch === "}" && stack.length) {
      const start = stack.pop();
      if (i + 1 - start > 50000) continue; // skip the page-sized wrappers, keep records
      const obj = buf.slice(start, i + 1);
      if (!obj.includes('"name":"') || !obj.includes('"poster":"')) continue;
      let d;
      try { d = JSON.parse(obj); } catch { continue; }
      const id = d.object_id || d.record_id;
      if (typeof d.name === "string" && id && nonEmpty(d.poster) && d.content_type) out.set(id, d);
    }
  }
  return [...out.values()];
}

/** The onboard IFE systems a title is available on, deduped by id, from a record's
 * nested summaries/programming. Each: { id, system, name, oem, seatback, device }.
 * Per-flight availability is a function of which system a given aircraft carries, so
 * tagging titles with their system ids lets the app filter to a specific flight. */
export function americanSystems(rec) {
  const byId = new Map();
  for (const sm of rec?.summaries ?? []) {
    for (const pg of sm?.programming ?? []) {
      for (const s of pg?.systems ?? []) {
        if (s?.id != null && !byId.has(s.id)) {
          byId.set(s.id, {
            id: s.id,
            system: nonEmpty(s.system),
            name: nonEmpty(s.system_name),
            oem: nonEmpty(s.oem_short_name),
            seatback: typeof s.is_seatback === "boolean" ? s.is_seatback : null,
            device: typeof s.is_device === "boolean" ? s.is_device : null,
          });
        }
      }
      // Fallback to the flat id list when the rich objects are absent.
      for (const raw of pg?.systems_fk_oem_systems ?? []) {
        const id = intOrNull(raw);
        if (id != null && !byId.has(id)) byId.set(id, { id, system: null, name: null, oem: null, seatback: null, device: null });
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** Union of every IFE system seen across a set of American records — the legend the
 * feed publishes once so the app can resolve a title's `systemIds` to names/seatback. */
export function americanSystemsLegend(records) {
  const byId = new Map();
  for (const rec of records ?? []) {
    for (const s of americanSystems(rec)) if (!byId.has(s.id)) byId.set(s.id, s);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** Map an American record to the app's catalog shape. American omits release year and
 * cast, so those are backfilled from OMDb; it does provide the IMDb id, which we keep
 * as a hint so enrichment can match by id instead of by title. `systemIds` tags which
 * onboard IFE systems carry the title (see americanSystems / the feed's systems legend). */
export function mapAmericanRecord(rec) {
  if (!rec || typeof rec.name !== "string") return null;
  const title = rec.name.trim();
  if (!title) return null;
  const isSeries = rec.content_type === "TV" || rec.season_number != null;
  return {
    kind: isSeries ? "series" : "movie",
    title,
    year: null,
    runtimeMinutes: isSeries ? null : intOrNull(rec.duration),
    seasonNumber: isSeries ? intOrNull(rec.season_number) : null,
    episodeCount: null,
    genres: nameList(rec.genres).map(prettyGenre),
    maturityRating: nonEmpty(rec.mpaa_rating),
    synopsis: nonEmpty(rec.synopsis),
    director: nameList(rec.director)[0] ?? null,
    cast: nameList(rec.cast_list ?? rec.cast),
    language: nonEmpty(rec.original_language),
    posterURL: nonEmpty(rec.poster),
    imdbID: /^tt\d+$/.test(rec.imdb_id ?? "") ? rec.imdb_id : null,
    systemIds: americanSystems(rec).map((s) => s.id),
  };
}

// --- American flight matching (filter the catalog to a specific flight) -----

/** Pull the integer flight number from user input like "AA100", "aa 100", "100". */
export function parseFlightNumber(input) {
  const digits = String(input ?? "").replace(/\D+/g, "");
  return digits ? parseInt(digits, 10) : null;
}

/** An American flight record's IFE capabilities, from its seatback/wifi flags
 * (seatback "SB"; wi_ent "WE" / wifi "WF" => streaming to your own device). */
export function flightCapabilities(flight) {
  return {
    seatback: !!flight?.seatback,
    streaming: !!(flight?.wi_ent || flight?.wifi),
  };
}

/** The IFE system ids available on a flight: seatback systems if it has seatback screens,
 * device systems if it streams — resolved against the feed's systems legend. Sorted. */
export function flightSystemIds(flight, legend) {
  const caps = flightCapabilities(flight);
  const ids = new Set();
  for (const s of legend ?? []) {
    if (caps.seatback && s.seatback) ids.add(s.id);
    if (caps.streaming && s.device) ids.add(s.id);
  }
  return [...ids].sort((a, b) => a - b);
}

/** Filter American titles to those available on a flight: titles whose systemIds intersect
 * the flight's available systems. When the flight maps to no known system, returns all
 * titles (graceful degrade). Returns { systemIds, movies }. */
export function filterCatalogForFlight(movies, legend, flight) {
  const ids = flightSystemIds(flight, legend);
  if (ids.length === 0) return { systemIds: [], movies: movies ?? [] };
  const set = new Set(ids);
  const out = (movies ?? []).filter((m) => (m.systemIds ?? []).some((id) => set.has(id)));
  return { systemIds: ids, movies: out };
}

// --- Delta (delta.com current-movies) HTML -> entries -----------------------

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Decode the handful of HTML entities Delta's title attributes carry (e.g. "Copa &#39;71"). */
export function decodeEntities(s) {
  return String(s ?? "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code) => {
    if (code[0] === "#") {
      const n = /^#x/i.test(code) ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** Parse one of Delta's entertainment pages into [{title, posterURL}]. Delta exposes
 * only a title + poster per entry (the rest is backfilled from OMDb), and renders each
 * twice for responsive layout, so we dedupe by title.
 *
 * We match each <img> tag as a whole, then pull the poster and title attributes out of
 * it independently — robust to attribute reordering and lazy-load (`data-src`) markup
 * variants across Delta's pages. Poster paths are usually root-relative, but a few
 * entries (e.g. on the TV page) carry an absolute `https://www.delta.com/...` src, so
 * the origin is optional in the match and the output is normalized onto `base`. The
 * `…/delta-com/products/…thumbs…` path constraint filters out non-poster images
 * (logos, placeholders). */
export function extractDeltaEntries(html, base = "https://www.delta.com") {
  const seen = new Map();
  const imgTagRe = /<img\b([^>]+)>/gi;
  const srcRe = /\b(?:data-src|src)="(?:https?:\/\/[^"/]*delta\.com)?(\/content\/dam\/delta-com\/products\/[^"]*thumbs[^"]+)"/i;
  const titleRe = /\btitle="([^"]+)"/i;
  for (const tagMatch of String(html).matchAll(imgTagRe)) {
    const attrs = tagMatch[1];
    const srcMatch = srcRe.exec(attrs);
    if (!srcMatch) continue;
    const titleMatch = titleRe.exec(attrs);
    if (!titleMatch) continue;
    const title = decodeEntities(titleMatch[1]).trim();
    if (title && !seen.has(title)) seen.set(title, base + srcMatch[1]);
  }
  return [...seen.entries()].map(([title, posterURL]) => ({ title, posterURL }));
}

/** Map a Delta entry to the app's catalog shape (everything but title/poster is null,
 * to be backfilled from OMDb). `kind` is "movie", "series", or "unknown" — Delta's
 * kids page mixes both, so its titles are emitted as "unknown": keyed as a movie (so
 * enrichment-reuse keys stay harvest-stable) but flagged `kindUncertain`, which makes
 * the OMDb lookup type-agnostic and lets the resolved record's type set the real kind. */
export function mapDeltaEntry(entry, kind = "movie") {
  const title = (entry?.title ?? "").trim();
  if (!title) return null;
  const uncertain = kind === "unknown";
  return {
    kind: uncertain ? "movie" : kind,
    ...(uncertain ? { kindUncertain: true } : {}),
    title,
    year: null,
    runtimeMinutes: null,
    seasonNumber: null,
    episodeCount: null,
    genres: [],
    maturityRating: null,
    synopsis: null,
    director: null,
    cast: [],
    language: null,
    posterURL: entry.posterURL ?? null,
  };
}

/** Merge the per-page harvests of Delta's entertainment pages into one item list.
 * `pages` is [{ kind, entries }] in priority order: when the same title appears on
 * several pages (the kids page repeats titles from the movies and TV pages), the
 * earliest page wins — so a title listed on a kind-certain page never reaches the
 * kids page's "unknown" classification. */
export function mergeDeltaPages(pages) {
  const seen = new Set();
  const items = [];
  for (const { kind, entries } of pages) {
    for (const entry of entries) {
      const mapped = mapDeltaEntry(entry, kind);
      if (!mapped) continue;
      const key = mapped.title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(mapped);
    }
  }
  return items;
}

// --- OMDb descriptive backfill (for sources that omit metadata) -------------

function firstLanguage(v) {
  return nonEmpty(nameList(v === "N/A" ? "" : v)[0] ?? "");
}

/** Pull the descriptive (non-rating) fields from an OMDb response, so sources that omit
 * them (Delta, American) can be enriched to parity with United. */
export function omdbDescriptive(j) {
  if (!j || j.Response === "False") return {};
  const rt = /(\d+)\s*min/i.exec(j.Runtime ?? "");
  return {
    kind: j.Type === "series" ? "series" : j.Type === "movie" ? "movie" : null,
    year: parseYear(j.Year),
    runtimeMinutes: rt ? parseInt(rt[1], 10) : null,
    genres: nameList(j.Genre === "N/A" ? "" : j.Genre).map(prettyGenre),
    director: nameList(j.Director === "N/A" ? "" : j.Director)[0] ?? null,
    cast: nameList(j.Actors === "N/A" ? "" : j.Actors),
    synopsis: nonEmpty(j.Plot === "N/A" ? "" : j.Plot),
    language: firstLanguage(j.Language),
    maturityRating: nonEmpty(j.Rated === "N/A" ? "" : j.Rated),
  };
}

/** Fill catalog fields the airline source left empty from OMDb's descriptive data.
 * Never overrides a value the source already provided; series keep null year/runtime. */
export function backfill(movie, d) {
  if (!d) return movie;
  const empty = (v) => v == null || v === "" || (Array.isArray(v) && v.length === 0);
  const scalarKeys = movie.kind === "series"
    ? ["director", "synopsis", "language", "maturityRating"]
    : ["year", "runtimeMinutes", "director", "synopsis", "language", "maturityRating"];
  for (const k of scalarKeys) {
    if (empty(movie[k]) && !empty(d[k])) movie[k] = d[k];
  }
  if (empty(movie.genres) && d.genres?.length) movie.genres = d.genres;
  if (empty(movie.cast) && d.cast?.length) movie.cast = d.cast;
  return movie;
}

// --- feed envelope ----------------------------------------------------------

/** A stable key for the incremental enrichment cache (independent of app ids).
 * Includes kind + year/season so series seasons that share a title don't collide. */
export function itemKey(m) {
  return `${m.kind ?? "movie"}|${m.title.toLowerCase().trim()}|${m.year ?? m.seasonNumber ?? ""}`;
}

/** Key for the in-run cross-airline enrichment cache: prefer a source-provided IMDb id
 * (American), else fall back to the per-title key. */
export function enrichKey(m) {
  return m.imdbID ? `i:${m.imdbID}` : itemKey(m);
}

/** A year-independent fallback key (kind + title + season). `itemKey` includes the year,
 * but sources like American/Delta harvest with year=null and only get a year backfilled
 * from OMDb — so the published feed's `itemKey` won't match the next run's harvested one.
 * Matching on this bare key (and on IMDb id) keeps prior-feed reuse working for them. */
export function bareKey(m) {
  return `${m.kind ?? "movie"}|${m.title.toLowerCase().trim()}|${m.seasonNumber ?? ""}`;
}

/** Index a previously-published feed's titles for reuse, by exact key, bare key, and
 * IMDb id (so reuse survives a year being backfilled between runs). */
export function indexPrevious(movies) {
  const byKey = new Map(), byBare = new Map(), byImdb = new Map();
  for (const m of movies ?? []) {
    byKey.set(itemKey(m), m);
    if (!byBare.has(bareKey(m))) byBare.set(bareKey(m), m);
    if (m.imdbID) byImdb.set(m.imdbID, m);
  }
  return { byKey, byBare, byImdb };
}

/** Find a harvested title in the prior-feed index: by source IMDb id (most precise,
 * disambiguates same-title remakes), then exact key, then the year-independent key. */
export function lookupPrevious(idx, movie) {
  if (!idx) return undefined;
  return (movie.imdbID && idx.byImdb.get(movie.imdbID)) ||
    idx.byKey.get(itemKey(movie)) ||
    idx.byBare.get(bareKey(movie)) ||
    // A kind-uncertain title (Delta kids page) is keyed as a movie at harvest time but
    // may have been published as a series once OMDb resolved it — probe that too, so
    // reuse still hits and the title isn't re-fetched every run.
    (movie.kindUncertain ? idx.byBare.get(bareKey({ ...movie, kind: "series" })) : undefined);
}

// --- cross-airline identity (matchId) ---------------------------------------

/** Year-independent, accent/punctuation-folded title slug. Mirrors the app's
 * TitleMatcher.canonical so the same film slugs identically across airlines and
 * matches the app's fallback for feeds published before matchId existed. */
export function slugify(title) {
  let t = String(title ?? "").toLowerCase();
  t = t.normalize("NFKD").replace(/[̀-ͯ]/g, ""); // fold diacritics
  t = t.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ");
  const comma = t.indexOf(", ");
  if (comma !== -1) {
    const head = t.slice(0, comma);
    const tail = t.slice(comma + 2).trim();
    if (["the", "a", "an"].includes(tail)) t = `${tail} ${head}`;
  }
  t = t.replace(/[^a-z0-9]+/g, " ").trim();
  let toks = t.split(/\s+/).filter(Boolean);
  if (toks.length && ["the", "a", "an"].includes(toks[0])) toks = toks.slice(1);
  return toks.join("-");
}

/** Title-only key for cross-airline identity (kind + slug + season), so the same
 * film unifies across airlines despite title-formatting or year-presence differences. */
export function slugKey(m) {
  return `${m.kind ?? "movie"}|${slugify(m.title)}|${m.seasonNumber ?? ""}`;
}

/** Assign a stable cross-airline `matchId` to each movie so the app can share
 * watch state (seen / watchlist / …) for the same film across airlines:
 *   1. its own IMDb id (remake-safe — OMDb disambiguates by year), else
 *   2. the IMDb id another airline resolved for the same title — but only when
 *      that title maps to exactly one IMDb id (ambiguous remakes fall through), else
 *   3. a year-independent title slug.
 * Series append the season so seasons stay distinct. Builds the IMDb map from
 * `pool` (default: the movies themselves) and mutates+returns `movies`. */
export function assignMatchIds(movies, pool = movies) {
  const imdbByTitle = new Map();
  for (const m of pool) {
    if (!m.imdbID) continue;
    const k = slugKey(m);
    (imdbByTitle.get(k) ?? imdbByTitle.set(k, new Set()).get(k)).add(m.imdbID);
  }
  for (const m of movies) {
    let imdb = m.imdbID;
    if (!imdb) {
      const cands = imdbByTitle.get(slugKey(m));
      if (cands && cands.size === 1) imdb = [...cands][0];
    }
    const base = imdb || slugify(m.title);
    m.matchId = m.kind === "series" && m.seasonNumber != null
      ? `${base}-s${m.seasonNumber}`
      : base;
  }
  return movies;
}

// --- Catalog-size sanity checks ---------------------------------------------
//
// A harvest can silently return far fewer titles than it should — a page's markup
// changes, a parser stops matching, a paginated source loses its later pages — while
// still returning enough to clear the "> 0 items" bar. Delta shipped 26 of ~hundreds
// of titles that way (united-movies#21). These checks compare each airline's fresh
// harvest against a floor and against its own last published size, so a collapse (or an
// implausible surge, which usually means a parser is now over-matching) is flagged
// rather than quietly published.

/** Per-airline expectations for the size sanity check. `min` is a conservative floor —
 * a healthy harvest is comfortably above it, so tripping it means something broke, not
 * that the catalog merely churned. Tune these as real catalog sizes drift. */
export const CATALOG_EXPECTATIONS = {
  united: { min: 20 },
  american: { min: 300 },
  delta: { min: 50 },
};

/** Default relative-change thresholds vs. the previously published size. */
export const CATALOG_CHANGE_THRESHOLDS = { shrink: 0.5, grow: 4 };

/** Evaluate one airline's harvested `count` against its floor and its previous size.
 * Returns null when the size looks healthy, or an anomaly describing what's off:
 *   { id, count, previousCount, expectedMin, severity, reason }
 * `severity` is "error" for a below-floor collapse (feed is almost certainly broken)
 * and "warning" for a large relative shift (worth a look, not necessarily broken).
 * A missing/unknown `previousCount` (first run) skips the relative comparison. */
export function evaluateCatalogSize(id, count, previousCount, opts = {}) {
  const expectedMin = opts.min ?? CATALOG_EXPECTATIONS[id]?.min ?? 1;
  const shrink = opts.shrink ?? CATALOG_CHANGE_THRESHOLDS.shrink;
  const grow = opts.grow ?? CATALOG_CHANGE_THRESHOLDS.grow;
  const prev = Number.isFinite(previousCount) && previousCount > 0 ? previousCount : null;
  const base = { id, count, previousCount: prev, expectedMin };

  if (count < expectedMin) {
    return {
      ...base,
      severity: "error",
      reason: `harvested ${count} titles, below the expected minimum of ${expectedMin}`
        + (prev != null ? ` (last published ${prev})` : "")
        + " — the source page or its parser has likely changed",
    };
  }
  if (prev != null && count < prev * shrink) {
    const pct = Math.round((1 - count / prev) * 100);
    return {
      ...base,
      severity: "warning",
      reason: `harvested ${count} titles, down ${pct}% from the last published ${prev}`
        + " — the source may have changed or the parser may be missing entries",
    };
  }
  if (prev != null && count > prev * grow) {
    const factor = (count / prev).toFixed(1);
    return {
      ...base,
      severity: "warning",
      reason: `harvested ${count} titles, ${factor}× the last published ${prev}`
        + " — a large jump can mean the parser is now over-matching (verify the results)",
    };
  }
  return null;
}

/** Run {@link evaluateCatalogSize} across every successfully-harvested airline.
 * `reports` is an array of { id, count, previousCount }. Returns the anomalies. */
export function checkCatalogSizes(reports, opts = {}) {
  return reports
    .map((r) => evaluateCatalogSize(r.id, r.count, r.previousCount, opts[r.id]))
    .filter(Boolean);
}

// ── Posters (TMDB) ──────────────────────────────────────────────────────────
//
// Posters come from TMDB, never from the airline's own media CDN: App Review
// rejected the app under guideline 5.2.1 for showing studio artwork it had no
// permission to hotlink from there. TMDB's API terms allow a free, ad-free app
// to show its images with attribution, and forbid caching anything obtained
// from it for more than 6 months — so each poster lookup carries the date it
// was made and is redone well inside that window.

export const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w342";
export const POSTER_MAX_AGE_DAYS = 90;

/** The poster path from a TMDB `/find/{imdb_id}` response, preferring the result
 * type that matches the title's kind (a series' IMDb id resolves to a TV result). */
export function tmdbPosterPath(find, kind) {
  const movie = find?.movie_results?.[0];
  const tv = find?.tv_results?.[0];
  const ordered = kind === "series" ? [tv, movie] : [movie, tv];
  for (const r of ordered) if (r?.poster_path) return r.poster_path;
  return null;
}

export function tmdbPosterURL(path) {
  return path ? `${TMDB_IMAGE_BASE}${path}` : null;
}

/** YYYY-MM-DD — the granularity `posterCheckedAt` is stored at, so a feed's hash
 * only changes on the day a lookup is actually redone. */
export function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

/** Whether a previously-published title's TMDB lookup can be reused as-is: it must
 * have been a TMDB lookup (it has `posterCheckedAt`, and any URL is TMDB's) and be
 * younger than POSTER_MAX_AGE_DAYS. A miss (null URL) is reusable too, so titles
 * TMDB doesn't know aren't re-queried every run. */
export function reusablePoster(prior, now, maxAgeDays = POSTER_MAX_AGE_DAYS) {
  if (!prior?.posterCheckedAt) return false;
  if (prior.posterURL && !prior.posterURL.startsWith(TMDB_IMAGE_BASE)) return false;
  const checked = Date.parse(prior.posterCheckedAt);
  if (Number.isNaN(checked)) return false;
  return (now.getTime() - checked) / 86_400_000 < maxAgeDays;
}
