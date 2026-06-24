// Reusable harvester for geemedia-backed IFE microsites (United, and any future
// carrier on the same platform). Runs the site's own SPA in headless Chrome and
// collects the `content/items` JSON it fetches for itself.

import puppeteer from "puppeteer";
import { mapItem, ITEM_KINDS } from "../lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {{ sectionURLs: string[], apiPattern: RegExp, userAgent: string }} cfg */
export async function harvestGeemedia({ sectionURLs, apiPattern, userAgent }) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(userAgent);

    const byId = new Map();
    page.on("response", async (resp) => {
      if (!apiPattern.test(resp.url()) || resp.status() !== 200) return;
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

    // Visit each section so all content types are fetched.
    for (const url of sectionURLs) {
      await page.goto(url, { waitUntil: "networkidle2", timeout: 90000 });
      for (let i = 0; i < 10; i++) {
        await page.evaluate(() => window.scrollBy(0, 1400));
        await sleep(700);
      }
      await sleep(2000);
    }

    return [...byId.values()].map(mapItem).filter(Boolean);
  } finally {
    await browser.close();
  }
}
