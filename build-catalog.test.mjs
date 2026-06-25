import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapItem, mapOMDb, parseAwards, mapWikidataAwards, prettyGenre,
  cleanTitle, parseYear, yearWithin, pickSearchMatch,
  extractAmericanRecords, mapAmericanRecord, americanSystems, americanSystemsLegend,
  parseFlightNumber, flightCapabilities, flightSystemIds, filterCatalogForFlight,
  decodeEntities, extractDeltaEntries, mapDeltaEntry,
  omdbDescriptive, backfill, enrichKey, itemKey, bareKey, indexPrevious, lookupPrevious,
} from "./lib.mjs";

test("cleanTitle strips a trailing (YYYY)", () => {
  assert.equal(cleanTitle("The Running Man (2025)"), "The Running Man");
  assert.equal(cleanTitle("Phantom Thread"), "Phantom Thread");
  assert.equal(cleanTitle("Blade Runner 2049"), "Blade Runner 2049"); // year is part of the title
});

test("parseYear pulls a 4-digit year, even from a range", () => {
  assert.equal(parseYear("2017"), 2017);
  assert.equal(parseYear("2018–2020"), 2018);
  assert.equal(parseYear("N/A"), null);
});

test("yearWithin tolerates small release-year disagreements", () => {
  assert.equal(yearWithin("2018", 2017), true);   // Phantom Thread
  assert.equal(yearWithin("1977", 2025), false);  // wrong film
  assert.equal(yearWithin("2018", null), true);   // no wanted year -> lenient
  assert.equal(yearWithin("N/A", 2017), true);    // unknown OMDb year -> lenient
});

test("pickSearchMatch chooses the year-closest candidate", () => {
  // Mirrors the real "Star Wars: A New Hope" search result set.
  const results = [
    { Title: "Star Wars: Episode IV - A New Hope", Year: "1977", imdbID: "tt0076759" },
    { Title: "Star Wars: ... Deleted Scenes", Year: "2011", imdbID: "tt8933914" },
    { Title: "A Live Staged Reading ...", Year: "2025", imdbID: "tt36328088" },
  ];
  assert.equal(pickSearchMatch(results, 1977), "tt0076759");
  assert.equal(pickSearchMatch(results, 2025), "tt36328088");
  assert.equal(pickSearchMatch(results, 1990), null);     // nothing within tolerance
  assert.equal(pickSearchMatch([], 1977), null);
});

test("mapItem maps a geemedia movie item onto the app shape", () => {
  const item = {
    template: "movie",
    id: "1",
    title: "The Moment",
    year: 2026,
    duration_minute: 103,
    director_list: "Aidan Zamiri",
    cast_list: "Charli XCX, Alexander Skarsgard, Isaac Cole Powell",
    movie_language: ["eng", "fra"],
    long_description: "A rising pop star navigates fame.",
    attributes: [
      { name: "Comedy", type: "genre" },
      { name: "ActionAdventure", type: "genre" },
      { name: "R", type: "classification" },
    ],
    poster_image: { microportal_mobile: { "860x1272": ["https://cdn/x.jpg"] } },
  };
  const m = mapItem(item);
  assert.equal(m.kind, "movie");
  assert.equal(m.title, "The Moment");
  assert.equal(m.year, 2026);
  assert.equal(m.runtimeMinutes, 103);
  assert.equal(m.seasonNumber, null);
  assert.equal(m.episodeCount, null);
  assert.equal(m.director, "Aidan Zamiri");
  assert.deepEqual(m.cast, ["Charli XCX", "Alexander Skarsgard", "Isaac Cole Powell"]);
  assert.deepEqual(m.genres, ["Comedy", "Action & Adventure"]);
  assert.equal(m.maturityRating, "R");
  assert.equal(m.language, "English");
  assert.equal(m.posterURL, "https://cdn/x.jpg");
});

test("mapItem maps a tv_series with season/episode and no year/runtime", () => {
  const item = {
    template: "tv_series",
    id: "2",
    title: "A Knight of the Seven Kingdoms",
    season_number: 1,
    child_id_count: 6,
    duration_minute: 50, // ignored for series
    year: 2025,          // ignored for series
    director_list: "Owen Harris",
    cast_list: "Daniel Ings, Peter Claffey",
    audio_language: ["eng"],
    long_description: "From the world of Westeros.",
    attributes: [
      { name: "Drama", type: "genre" },
      { name: "TVMA", type: "classification" },
    ],
    poster_image: { microportal_mobile: { "860x1272": ["https://cdn/s.jpg"] } },
  };
  const m = mapItem(item);
  assert.equal(m.kind, "series");
  assert.equal(m.title, "A Knight of the Seven Kingdoms");
  assert.equal(m.seasonNumber, 1);
  assert.equal(m.episodeCount, 6);
  assert.equal(m.year, null, "series carry no single year");
  assert.equal(m.runtimeMinutes, null, "series carry no single runtime");
  assert.deepEqual(m.genres, ["Drama"]);
  assert.equal(m.maturityRating, "TVMA");
  assert.equal(m.language, "English");
  assert.equal(m.director, "Owen Harris");
});

test("mapItem drops sections, tv_show umbrellas, and empty titles", () => {
  assert.equal(mapItem({ template: "section", title: "Home" }), null);
  assert.equal(mapItem({ template: "tv_show", title: "South Park" }), null);
  assert.equal(mapItem({ template: "movie", title: "  " }), null);
});

test("prettyGenre normalizes concatenated genre names", () => {
  assert.equal(prettyGenre("SciFiFantasy"), "Sci-Fi & Fantasy");
  assert.equal(prettyGenre("Drama"), "Drama");
});

test("mapOMDb extracts IMDb/RT/Metacritic and awards", () => {
  const omdb = {
    Response: "True",
    imdbRating: "8.5",
    Metascore: "67",
    imdbID: "tt0172495",
    Awards: "Won 5 Oscars. 61 wins & 105 nominations total",
    Ratings: [
      { Source: "Internet Movie Database", Value: "8.5/10" },
      { Source: "Rotten Tomatoes", Value: "80%" },
      { Source: "Metacritic", Value: "67/100" },
    ],
  };
  const e = mapOMDb(omdb);
  assert.equal(e.imdbRating, 8.5);
  assert.equal(e.rating, 8.5);
  assert.equal(e.rottenTomatoes, 80);
  assert.equal(e.metascore, 67);
  assert.equal(e.imdbID, "tt0172495");
  assert.equal(e.oscarWins, 5);
  assert.equal(e.awardWins, 61);
  assert.match(e.awardsSummary, /Won 5 Oscars/);
});

test("mapOMDb tolerates N/A and a not-found response", () => {
  assert.equal(mapOMDb({ Response: "False", Error: "Movie not found!" }), null);
  const e = mapOMDb({ Response: "True", imdbRating: "N/A", Metascore: "N/A", Awards: "N/A", Ratings: [] });
  assert.equal(e.imdbRating, null);
  assert.equal(e.rottenTomatoes, null);
  assert.equal(e.awardsSummary, null);
});

test("parseAwards pulls oscar + total win counts", () => {
  assert.deepEqual(parseAwards("Won 2 Oscars. 134 wins & 89 nominations total"),
    { awardsSummary: "Won 2 Oscars. 134 wins & 89 nominations total", oscarWins: 2, awardWins: 134 });
  assert.deepEqual(parseAwards("Nominated for 3 BAFTA"),
    { awardsSummary: "Nominated for 3 BAFTA", oscarWins: null, awardWins: null });
});

// --- American (entertainment.aa.com flight payload) -------------------------

// Build a page whose flight payload wraps one real movie record inside a larger object,
// the way American's App Router output does — the wrapper must be dropped.
function americanPage(rec) {
  const payload = JSON.stringify({ page: 1, data: { movies: [rec] } });
  const chunk = JSON.stringify(payload).slice(1, -1); // escape as a JS string body
  return `<script>self.__next_f.push([1,"${chunk}"])</script>`;
}

const AA_REC = {
  name: "Avatar: Fire and Ash",
  object_id: "dd91ff4e-9644-4dd0-a2bd-149e7a4cc222",
  director: "James Cameron",
  duration: 197,
  genres: ["Animation", "Action", "Adventure"],
  imdb_id: "tt1757678",
  mpaa_rating: null,
  original_language: "English",
  content_type: "Film",
  season_number: null,
  synopsis: "Return to Pandora for the third chapter.",
  poster: "https://cdn.example/poster.jpg",
};

test("extractAmericanRecords pulls the movie record and drops its wrapper", () => {
  const recs = extractAmericanRecords(americanPage(AA_REC));
  assert.equal(recs.length, 1);
  assert.equal(recs[0].name, "Avatar: Fire and Ash");
  assert.equal(recs[0].imdb_id, "tt1757678");
});

test("extractAmericanRecords dedupes by object_id and ignores junk", () => {
  const html = americanPage(AA_REC) + americanPage(AA_REC) + "<script>self.__next_f.push([1,\"noise\"])</script>";
  assert.equal(extractAmericanRecords(html).length, 1);
});

test("mapAmericanRecord maps a film onto the app shape with an IMDb hint", () => {
  const m = mapAmericanRecord(AA_REC);
  assert.equal(m.kind, "movie");
  assert.equal(m.title, "Avatar: Fire and Ash");
  assert.equal(m.year, null, "American omits release year (backfilled from OMDb)");
  assert.equal(m.runtimeMinutes, 197);
  assert.deepEqual(m.genres, ["Animation", "Action", "Adventure"]);
  assert.equal(m.director, "James Cameron");
  assert.deepEqual(m.cast, [], "American omits cast (backfilled from OMDb)");
  assert.equal(m.language, "English");
  assert.equal(m.imdbID, "tt1757678");
  assert.equal(m.posterURL, "https://cdn.example/poster.jpg");
});

test("mapAmericanRecord treats a season_number record as a series", () => {
  const m = mapAmericanRecord({ ...AA_REC, content_type: "TV", season_number: 2, duration: 45 });
  assert.equal(m.kind, "series");
  assert.equal(m.seasonNumber, 2);
  assert.equal(m.runtimeMinutes, null);
});

// A series record as /en/series publishes it: content_type "TV", no duration, id in
// object_id (poster is the marker the extractor keys on).
const AA_SERIES = {
  name: "Angel City", content_type: "TV", object_id: "42afef1b", record_id: "recdknp",
  duration: null, imdb_id: null, genres: ["Documentary"], director: "Arlene Nelson",
  original_language: "English", synopsis: "A docuseries.", poster: "https://cdn.example/angel.jpg",
};

test("extractAmericanRecords also captures series (TV, no duration)", () => {
  const recs = extractAmericanRecords(americanPage(AA_SERIES));
  assert.equal(recs.length, 1);
  assert.equal(recs[0].content_type, "TV");
});

test("mapAmericanRecord maps a series to kind=series with null runtime", () => {
  const m = mapAmericanRecord(AA_SERIES);
  assert.equal(m.kind, "series");
  assert.equal(m.runtimeMinutes, null);
  assert.equal(m.title, "Angel City");
  assert.deepEqual(m.genres, ["Documentary"]);
});

// A record carrying the nested IFE-system structure American actually publishes.
const AA_REC_SYS = {
  ...AA_REC,
  object_id: "with-systems",
  summaries: [{
    programming: [{
      systems_fk_oem_systems: ["5", "24"],
      systems: [
        { id: 5, system: "Viasat W-IFE", system_name: "W-IFE", oem_short_name: "Viasat", is_seatback: false, is_device: true },
        { id: 24, system: "PAC eX3", system_name: "eX3", oem_short_name: "PAC", is_seatback: true, is_device: false },
        { id: 5, system: "Viasat W-IFE", system_name: "W-IFE", oem_short_name: "Viasat", is_seatback: false, is_device: true }, // dup id
      ],
    }],
  }],
};

test("americanSystems extracts deduped, sorted systems with seatback/device flags", () => {
  const sys = americanSystems(AA_REC_SYS);
  assert.deepEqual(sys.map((s) => s.id), [5, 24]);
  assert.deepEqual(sys[0], { id: 5, system: "Viasat W-IFE", name: "W-IFE", oem: "Viasat", seatback: false, device: true });
  assert.equal(sys[1].seatback, true);
});

test("americanSystems falls back to the flat id list when rich objects are absent", () => {
  const rec = { summaries: [{ programming: [{ systems_fk_oem_systems: ["6", "38"] }] }] };
  assert.deepEqual(americanSystems(rec).map((s) => s.id), [6, 38]);
  assert.equal(americanSystems({}).length, 0);
});

test("mapAmericanRecord tags the title with its systemIds (for flight matching)", () => {
  assert.deepEqual(mapAmericanRecord(AA_REC_SYS).systemIds, [5, 24]);
  assert.deepEqual(mapAmericanRecord(AA_REC).systemIds, [], "no systems -> empty");
});

test("americanSystemsLegend unions systems across records", () => {
  const legend = americanSystemsLegend([
    AA_REC_SYS,
    { summaries: [{ programming: [{ systems: [{ id: 6, system: "Thales Olympus", system_name: "Olympus", oem_short_name: "Thales", is_seatback: false, is_device: false }] }] }] },
  ]);
  assert.deepEqual(legend.map((s) => s.id), [5, 6, 24]);
  assert.equal(legend.find((s) => s.id === 6).oem, "Thales");
});

// --- American flight matching -----------------------------------------------

const LEGEND = [
  { id: 5, system: "Viasat W-IFE", name: "W-IFE", oem: "Viasat", seatback: false, device: true },
  { id: 20, system: "Intelsat Gogo", name: "Gogo", oem: "Intelsat", seatback: false, device: true },
  { id: 24, system: "PAC eX3", name: "eX3", oem: "PAC", seatback: true, device: false },
  { id: 38, system: "Thales Titan", name: "Titan", oem: "Thales", seatback: true, device: false },
];

test("parseFlightNumber extracts the number from AA100 / 'aa 1' / '100'", () => {
  assert.equal(parseFlightNumber("AA100"), 100);
  assert.equal(parseFlightNumber("aa 1"), 1);
  assert.equal(parseFlightNumber("100"), 100);
  assert.equal(parseFlightNumber(""), null);
  assert.equal(parseFlightNumber(null), null);
});

test("flightCapabilities reads seatback/streaming from the AA flag fields", () => {
  assert.deepEqual(flightCapabilities({ seatback: "SB", wi_ent: "WE" }), { seatback: true, streaming: true });
  assert.deepEqual(flightCapabilities({ seatback: null, wi_ent: "WE", wifi: "WF" }), { seatback: false, streaming: true });
  assert.deepEqual(flightCapabilities({ seatback: "SB", wi_ent: null, wifi: null }), { seatback: true, streaming: false });
});

test("flightSystemIds resolves capabilities to system ids via the legend", () => {
  assert.deepEqual(flightSystemIds({ seatback: null, wi_ent: "WE" }, LEGEND), [5, 20]);        // streaming-only
  assert.deepEqual(flightSystemIds({ seatback: "SB", wi_ent: null, wifi: null }, LEGEND), [24, 38]); // seatback-only
  assert.deepEqual(flightSystemIds({ seatback: "SB", wi_ent: "WE" }, LEGEND), [5, 20, 24, 38]); // both
});

test("filterCatalogForFlight keeps only titles available on the flight's systems", () => {
  const movies = [
    { title: "Seatback Only", systemIds: [24, 38] },
    { title: "Streaming Only", systemIds: [5, 20] },
    { title: "Everywhere", systemIds: [5, 24] },
    { title: "Untagged", systemIds: [] },
  ];
  const streaming = filterCatalogForFlight(movies, LEGEND, { seatback: null, wi_ent: "WE" });
  assert.deepEqual(streaming.systemIds, [5, 20]);
  assert.deepEqual(streaming.movies.map((m) => m.title), ["Streaming Only", "Everywhere"]);

  const seatback = filterCatalogForFlight(movies, LEGEND, { seatback: "SB", wi_ent: null, wifi: null });
  assert.deepEqual(seatback.movies.map((m) => m.title), ["Seatback Only", "Everywhere"]);

  const none = filterCatalogForFlight(movies, LEGEND, {}); // no capability -> all titles
  assert.equal(none.movies.length, movies.length);
});

// --- Delta (delta.com current-movies HTML) ----------------------------------

test("decodeEntities decodes numeric and named HTML entities", () => {
  assert.equal(decodeEntities("Copa &#39;71"), "Copa '71");
  assert.equal(decodeEntities("Tom &amp; Jerry"), "Tom & Jerry");
  assert.equal(decodeEntities("Caf&#xe9;"), "Café");
});

test("extractDeltaEntries pulls deduped title + absolute poster", () => {
  // Delta renders each poster twice (responsive variants) with the same title attr.
  const html = `
    <img src="/content/dam/delta-com/products/movie-thumbs/june-2026/coco-180x250.jpg" title="Coco" class="md-d-none" alt="Coco Poster"/>
    <img src="/content/dam/delta-com/products/movie-thumbs/june-2026/coco-180x250.jpg" title="Coco" alt="Coco Poster"/>
    <img src="/content/dam/delta-com/products/movie-thumbs/june-2026/copa71-180x250.jpg" title="Copa &#39;71" alt="Copa '71 Poster"/>
    <img src="/content/dam/other/logo.png" title="Not a movie" alt="logo"/>`;
  const entries = extractDeltaEntries(html);
  assert.equal(entries.length, 2, "deduped, and the non-thumbs image is ignored");
  assert.deepEqual(entries[0], { title: "Coco", posterURL: "https://www.delta.com/content/dam/delta-com/products/movie-thumbs/june-2026/coco-180x250.jpg" });
  assert.equal(entries[1].title, "Copa '71");
});

test("mapDeltaEntry leaves everything but title/poster null for OMDb backfill", () => {
  const m = mapDeltaEntry({ title: "Coco", posterURL: "https://x/coco.jpg" });
  assert.equal(m.kind, "movie");
  assert.equal(m.title, "Coco");
  assert.equal(m.posterURL, "https://x/coco.jpg");
  assert.deepEqual(m.genres, []);
  assert.equal(m.director, null);
  assert.equal(m.year, null);
});

// --- OMDb descriptive backfill ----------------------------------------------

const OMDB_FULL = {
  Response: "True",
  Year: "2017",
  Runtime: "130 min",
  Genre: "Drama, Romance",
  Director: "Luca Guadagnino",
  Actors: "Armie Hammer, Timothée Chalamet, Michael Stuhlbarg",
  Plot: "A romance in 1980s Italy.",
  Language: "English, Italian, French",
  Rated: "R",
};

test("omdbDescriptive parses the non-rating fields", () => {
  const d = omdbDescriptive(OMDB_FULL);
  assert.equal(d.year, 2017);
  assert.equal(d.runtimeMinutes, 130);
  assert.deepEqual(d.genres, ["Drama", "Romance"]);
  assert.equal(d.director, "Luca Guadagnino");
  assert.deepEqual(d.cast, ["Armie Hammer", "Timothée Chalamet", "Michael Stuhlbarg"]);
  assert.equal(d.language, "English", "first language only");
  assert.equal(d.maturityRating, "R");
  assert.deepEqual(omdbDescriptive({ Response: "False" }), {});
});

test("backfill fills empty fields but never overrides source-provided ones", () => {
  const sparse = mapDeltaEntry({ title: "Call Me by Your Name", posterURL: "p" });
  backfill(sparse, omdbDescriptive(OMDB_FULL));
  assert.equal(sparse.year, 2017);
  assert.deepEqual(sparse.genres, ["Drama", "Romance"]);
  assert.equal(sparse.director, "Luca Guadagnino");

  const rich = mapAmericanRecord(AA_REC); // already has genres + director
  backfill(rich, omdbDescriptive(OMDB_FULL));
  assert.deepEqual(rich.genres, ["Animation", "Action", "Adventure"], "kept source genres");
  assert.equal(rich.director, "James Cameron", "kept source director");
  assert.deepEqual(rich.cast, ["Armie Hammer", "Timothée Chalamet", "Michael Stuhlbarg"], "backfilled missing cast");
  assert.equal(rich.year, 2017, "backfilled missing year");
});

test("backfill keeps series year/runtime null", () => {
  const series = { kind: "series", title: "X", year: null, runtimeMinutes: null, seasonNumber: 1, genres: [], cast: [], director: null, synopsis: null, language: null, maturityRating: null };
  backfill(series, omdbDescriptive(OMDB_FULL));
  assert.equal(series.year, null);
  assert.equal(series.runtimeMinutes, null);
  assert.equal(series.director, "Luca Guadagnino", "non year/runtime fields still backfill");
});

test("enrichKey prefers a source IMDb id, else the per-title key", () => {
  assert.equal(enrichKey(mapAmericanRecord(AA_REC)), "i:tt1757678");
  const delta = mapDeltaEntry({ title: "Coco", posterURL: "p" });
  assert.equal(enrichKey(delta), itemKey(delta));
});

test("bareKey ignores year but keeps kind/title/season", () => {
  assert.equal(bareKey({ kind: "movie", title: "Coco", year: 2017, seasonNumber: null }), "movie|coco|");
  assert.equal(bareKey({ kind: "movie", title: "Coco", year: null, seasonNumber: null }), "movie|coco|");
  assert.equal(bareKey({ kind: "series", title: "Show", seasonNumber: 2 }), "series|show|2");
});

test("lookupPrevious reuses a title whose year was backfilled between runs", () => {
  // Prior feed: enriched last run, so year was backfilled from OMDb.
  const prior = [
    { kind: "movie", title: "A Single Man", year: 2009, imdbID: "tt1315981", imdbRating: 7.5, seasonNumber: null },
    { kind: "movie", title: "Superman", year: 1978, imdbID: "tt0078346", imdbRating: 7.4, seasonNumber: null },
    { kind: "movie", title: "Superman", year: 2025, imdbID: "tt5950044", imdbRating: 7.0, seasonNumber: null },
  ];
  const idx = indexPrevious(prior);
  // Delta harvests with year=null and no imdbID -> matched via the bare (year-less) key.
  assert.equal(lookupPrevious(idx, { kind: "movie", title: "A Single Man", year: null, seasonNumber: null })?.imdbID, "tt1315981");
  // American harvests with a source imdbID -> disambiguates same-title remakes.
  assert.equal(lookupPrevious(idx, { kind: "movie", title: "Superman", year: null, imdbID: "tt5950044", seasonNumber: null })?.year, 2025);
  assert.equal(lookupPrevious(idx, { kind: "movie", title: "Superman", year: null, imdbID: "tt0078346", seasonNumber: null })?.year, 1978);
  // United harvests with a stable source year -> exact key still works.
  assert.equal(lookupPrevious(idx, { kind: "movie", title: "A Single Man", year: 2009, seasonNumber: null })?.imdbID, "tt1315981");
  // Miss returns undefined.
  assert.equal(lookupPrevious(idx, { kind: "movie", title: "Nope", year: null, seasonNumber: null }), undefined);
});

test("mapWikidataAwards splits 'X for Y' labels and dedupes", () => {
  const bindings = [
    { awardLabel: { value: "Academy Award for Best Picture" }, year: { value: "2001" } },
    { awardLabel: { value: "Academy Award for Best Picture" }, year: { value: "2001" } }, // dup
    { awardLabel: { value: "BAFTA Award for Best Film" }, year: { value: "2000" } },
    { awardLabel: { value: "Saturn Award" } },
  ];
  const awards = mapWikidataAwards(bindings);
  assert.equal(awards.length, 3);
  assert.deepEqual(awards[0], { name: "BAFTA Award", category: "Best Film", year: 2000 });
  assert.deepEqual(
    awards.find((a) => a.category === "Best Picture"),
    { name: "Academy Award", category: "Best Picture", year: 2001 }
  );
  assert.deepEqual(awards.find((a) => a.name === "Saturn Award"), { name: "Saturn Award", category: null, year: null });
});
