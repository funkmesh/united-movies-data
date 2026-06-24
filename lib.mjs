// Pure, testable helpers for the catalog build pipeline.
// Kept side-effect-free so `node --test` can cover the mapping logic that's
// easy to get wrong (the network/puppeteer orchestration lives in build-catalog.mjs).

// --- geemedia content item -> app Movie shape -------------------------------

const PRETTY_GENRE = {
  ActionAdventure: "Action & Adventure",
  SciFiFantasy: "Sci-Fi & Fantasy",
};

const LANGUAGE_NAMES = {
  eng: "English", spa: "Spanish", fra: "French", deu: "German", ita: "Italian",
  ptb: "Portuguese", por: "Portuguese", jpn: "Japanese", kor: "Korean",
  zho: "Chinese", cmn: "Chinese", hin: "Hindi", ara: "Arabic", rus: "Russian",
  nld: "Dutch",
};

export function prettyGenre(name) {
  return PRETTY_GENRE[name] ?? name;
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

/** Extract American's movie record objects from a movies page. Balanced-brace scan
 * over the decoded flight buffer, keeping objects that JSON-parse and carry a
 * top-level name + object_id + duration (drops the page-sized wrappers around them). */
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
      if (!obj.includes('"object_id":"') || !obj.includes('"name":"')) continue;
      let d;
      try { d = JSON.parse(obj); } catch { continue; }
      if (typeof d.name === "string" && d.object_id && d.duration != null) out.set(d.object_id, d);
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

/** Parse Delta's current-movies page into [{title, posterURL}]. Delta exposes only a
 * title + poster per entry (the rest is backfilled from OMDb), and renders each twice
 * for responsive layout, so we dedupe by title. */
export function extractDeltaEntries(html, base = "https://www.delta.com") {
  const seen = new Map();
  const re = /<img\s+src="(\/content\/dam\/delta-com\/products\/[^"]*thumbs[^"]+)"\s+title="([^"]+)"/g;
  for (const m of String(html).matchAll(re)) {
    const title = decodeEntities(m[2]).trim();
    if (title && !seen.has(title)) seen.set(title, base + m[1]);
  }
  return [...seen.entries()].map(([title, posterURL]) => ({ title, posterURL }));
}

/** Map a Delta entry to the app's catalog shape (everything but title/poster is null,
 * to be backfilled from OMDb). */
export function mapDeltaEntry(entry) {
  const title = (entry?.title ?? "").trim();
  if (!title) return null;
  return {
    kind: "movie",
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
