// Delta Air Lines — delta.com's "Delta Studio" entertainment pages, server-rendered.
// Delta publishes a curated monthly highlight of its onboard catalog (a subset of the
// ~300 seatback titles) spread across several sibling pages, each exposing only a
// title + poster per entry (the rest is backfilled from OMDb):
//
//   current-movies  → this month's movie grid ("New on Delta" + "Popular on Delta")
//   delta-studio    → the hub's themed movie collections (a distinct set of titles)
//   tv              → TV series (plus a few YouTube-creator/podcast entries that OMDb
//                     simply won't match — they publish unenriched, like any other miss)
//   kids            → family titles; mixes movies and series, so its titles harvest as
//                     kind-uncertain and the OMDb record's type settles each one
//
// The kids page repeats titles from the other pages; mergeDeltaPages dedupes with the
// kind-certain pages taking priority. live-tv (channel logos) and current-tunes (audio
// playlists) are deliberately skipped — neither lists movies/series.

import { extractDeltaEntries, mergeDeltaPages } from "../lib.mjs";

const BASE = "https://www.delta.com/us/en/onboard/inflight-entertainment/";
const PAGES = [
  { page: "current-movies", kind: "movie" },
  { page: "delta-studio", kind: "movie" },
  { page: "tv", kind: "series" },
  { page: "kids", kind: "unknown" },
];
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  id: "delta",
  displayName: "Delta Air Lines",
  async harvest() {
    // Any page failing fails the whole harvest: the build then reuses the previously
    // published feed, which beats silently publishing a catalog missing a page.
    const pages = [];
    for (const { page, kind } of PAGES) {
      const resp = await fetch(BASE + page, { headers: { "User-Agent": UA } });
      if (!resp.ok) throw new Error(`delta fetch failed: ${page} ${resp.status}`);
      pages.push({ kind, entries: extractDeltaEntries(await resp.text()) });
      await sleep(150);
    }
    return mergeDeltaPages(pages);
  },
};
