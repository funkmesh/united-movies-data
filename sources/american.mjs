// American Airlines — entertainment.aa.com, a Next.js App Router site. Its movie
// records are embedded in each page's "flight" payload and pages are URL-addressable
// (`?page=N`, ~28 records each), so we can fetch them server-side without a browser.
// (Movies only; the site exposes no public TV section.)

import { extractAmericanRecords, mapAmericanRecord, americanSystemsLegend } from "../lib.mjs";

const BASE = "https://entertainment.aa.com/en/movies";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const MAX_PAGES = 60; // safety cap; the loop stops when a page yields no records
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  id: "american",
  displayName: "American Airlines",
  async harvest() {
    const byId = new Map();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const resp = await fetch(`${BASE}?page=${page}`, { headers: { "User-Agent": UA } });
      if (!resp.ok) break;
      const records = extractAmericanRecords(await resp.text());
      if (records.length === 0) break; // past the last page
      for (const rec of records) if (rec.object_id) byId.set(rec.object_id, rec);
      await sleep(150);
    }
    const records = [...byId.values()];
    const items = records.map(mapAmericanRecord).filter(Boolean);
    // Publish the IFE-system legend once so the app can resolve each title's systemIds
    // (and, given a flight's system, filter the catalog to that flight).
    return { items, envelope: { systems: americanSystemsLegend(records) } };
  },
};
