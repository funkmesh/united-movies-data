import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapItem, mapOMDb, parseAwards, mapWikidataAwards, prettyGenre,
  cleanTitle, parseYear, yearWithin, pickSearchMatch,
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
