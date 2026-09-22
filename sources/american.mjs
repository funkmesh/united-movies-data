// American Airlines — entertainment.aa.com, a Next.js App Router site. Its content
// records (films from /en/movies, series from /en/series) are embedded in each page's
// "flight" payload and pages are URL-addressable (`?page=N`, ~28 records each).
//
// Those pages used to be fetchable server-side. Since ~2026-09-10 they aren't: the site
// runs Vercel's Attack Challenge Mode, which answers a plain fetch on every path (even
// robots.txt) with HTTP 429 and `x-vercel-mitigated: challenge` — an interstitial that
// only a real browser clears. So we load the site once in headless Chrome, the same way
// United harvests, and then read each page's HTML with a same-origin fetch from inside
// that page, which carries the clearance cookie. One browser, N cheap fetches.
//
// The flight payload itself is unchanged: extraction and mapping are as they were.

import puppeteer from "puppeteer";
import { classifyAmericanPage, mapAmericanRecord, americanSystemsLegend } from "../lib.mjs";

const SECTIONS = [
  "https://entertainment.aa.com/en/movies",
  "https://entertainment.aa.com/en/series",
];
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const MAX_PAGES = 60; // safety cap; each section's loop stops when a page yields no records
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Load the site until the challenge interstitial hands over to the app, leaving the
 * page holding the clearance cookie every later fetch rides on. */
async function clearCheckpoint(page) {
  const resp = await page.goto(SECTIONS[0], { waitUntil: "networkidle2", timeout: 90000 });
  for (let i = 0; i < 15; i++) {
    if (!/security checkpoint/i.test(await page.title())) return;
    await sleep(2000); // the interstitial solves itself, then reloads into the app
  }
  throw new Error(`stuck on Vercel's security checkpoint (HTTP ${resp?.status() ?? "?"}) — it no longer clears in headless Chrome`);
}

/** Fetch a listing page's HTML from inside the cleared page (same origin, same cookies). */
function fetchInPage(page, url) {
  return page.evaluate(async (u) => {
    const r = await fetch(u, { headers: { Accept: "text/html" } });
    return { status: r.status, html: await r.text() };
  }, url);
}

export default {
  id: "american",
  displayName: "American Airlines",
  async harvest() {
    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    });
    try {
      const page = await browser.newPage();
      await page.setUserAgent(UA);
      await clearCheckpoint(page);

      const byId = new Map();
      for (const base of SECTIONS) {
        for (let n = 1; n <= MAX_PAGES; n++) {
          const url = `${base}?page=${n}`;
          const { status, html } = await fetchInPage(page, url);
          const { state, records, detail } = classifyAmericanPage(status, html);
          // Name the failure rather than letting it decay into "harvest returned 0 items":
          // a blocked page is a transport problem, an empty page 1 is a shape change, and
          // an empty page 2+ is simply the end of the section.
          if (state === "blocked") throw new Error(`${url} blocked: ${detail}`);
          if (state === "empty") {
            if (n === 1) throw new Error(`${url} parsed no records: ${detail} — the payload's shape has likely changed`);
            break;
          }
          for (const rec of records) {
            const key = rec.object_id || rec.record_id;
            if (key) byId.set(key, rec);
          }
          await sleep(150);
        }
      }

      const records = [...byId.values()];
      const items = records.map(mapAmericanRecord).filter(Boolean);
      // Publish the IFE-system legend once so the app can resolve each title's systemIds
      // (and, given a flight's system, filter the catalog to that flight).
      return { items, envelope: { systems: americanSystemsLegend(records) } };
    } finally {
      await browser.close();
    }
  },
};
