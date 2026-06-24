// Delta Air Lines — delta.com "current movies", a server-rendered page. It's a curated
// highlight (a subset of the ~300 onboard titles) exposing only title + poster per
// entry, so the rest of each title's metadata is backfilled from OMDb. Delta's public
// "TV" page is mostly YouTube creators / podcasts (no IMDb entries), so it's skipped.

import { extractDeltaEntries, mapDeltaEntry } from "../lib.mjs";

const URL = "https://www.delta.com/us/en/onboard/inflight-entertainment/current-movies";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

export default {
  id: "delta",
  displayName: "Delta Air Lines",
  async harvest() {
    const resp = await fetch(URL, { headers: { "User-Agent": UA } });
    if (!resp.ok) throw new Error(`delta fetch failed: ${resp.status}`);
    return extractDeltaEntries(await resp.text()).map(mapDeltaEntry).filter(Boolean);
  },
};
