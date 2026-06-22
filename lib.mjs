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

// --- feed envelope ----------------------------------------------------------

/** A stable key for the incremental enrichment cache (independent of app ids).
 * Includes kind + year/season so series seasons that share a title don't collide. */
export function itemKey(m) {
  return `${m.kind ?? "movie"}|${m.title.toLowerCase().trim()}|${m.year ?? m.seasonNumber ?? ""}`;
}
