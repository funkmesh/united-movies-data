// Prototype "American flight mode" proxy.
//
// Resolves a flight number to its aircraft's IFE capability via American's public
// schedule API, then filters our published american.json down to the titles available
// on that flight. Adds permissive CORS so a browser app can call it — American's own
// /api/flight sends no CORS headers, which is the whole reason a proxy is needed.
//
//   GET /flight?number=AA100&date=2026-06-25[&dep=JFK&arv=LHR]
//     -> { flight, date, systemIds, count, total, movies }
//   GET /health -> { ok: true }
//
// The data functions (lookupFlight / flightCatalog) are exported so this can be dropped
// into a serverless function instead of run as a standalone server.
//
// Run: `node flight-mode.mjs`  (or `npm run flight`)
// Env: PORT (default 8787), PAGES_BASE (published feeds base),
//      AMERICAN_FEED (default <PAGES_BASE>/american.json).
//
// Caveat: American's public schedule endpoint returns only a subset of flights per day,
// so some flight numbers won't resolve. Filtering uses the seatback-vs-streaming
// capability model American's own site uses, not a precise per-tail system.

import { createServer } from "node:http";
import { parseFlightNumber, filterCatalogForFlight } from "./lib.mjs";

const PORT = parseInt(process.env.PORT || "8787", 10);
const PAGES_BASE = process.env.PAGES_BASE || "https://funkmesh.github.io/united-movies-data";
const FEED_URL = process.env.AMERICAN_FEED || `${PAGES_BASE}/american.json`;
const SCHEDULE = "https://entertainment.aa.com/api/flight";
const UA = "inflight-movie-picker/1.0";

const todayISO = () => new Date().toISOString().slice(0, 10);

async function fetchJSON(url, headers) {
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`${url} -> ${resp.status}`);
  return resp.json();
}

/** Resolve a flight number (+ date, optional dep/arv) to its American schedule records. */
export async function lookupFlight({ number, date, dep, arv }) {
  const sched = await fetchJSON(`${SCHEDULE}?date=${encodeURIComponent(date)}`, { "User-Agent": UA });
  return (sched?.data ?? []).filter((f) =>
    f.flight_number === number &&
    (!dep || f.dep === String(dep).toUpperCase()) &&
    (!arv || f.arv === String(arv).toUpperCase()));
}

/** Core handler: flight number/date -> the catalog filtered to that flight. */
export async function flightCatalog({ number, date, dep, arv }) {
  const matches = await lookupFlight({ number, date, dep, arv });
  if (matches.length === 0) {
    return {
      error: "flight not found in schedule",
      number, date,
      hint: "American's public schedule API returns only a subset of flights; try a different date or a mainline route, or pass &dep=&arv= to disambiguate.",
    };
  }
  const flight = matches[0];
  const feed = await fetchJSON(FEED_URL, { "User-Agent": UA });
  const { systemIds, movies } = filterCatalogForFlight(feed.movies, feed.systems, flight);
  return {
    flight: {
      number: flight.flight_number, dep: flight.dep, arv: flight.arv, date: flight.date,
      eqp: flight.eqp, seatback: !!flight.seatback, streaming: !!(flight.wi_ent || flight.wifi),
    },
    date,
    systemIds,
    count: movies.length,
    total: (feed.movies ?? []).length,
    movies,
  };
}

function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Cache-Control": "public, max-age=300",
  });
  res.end(JSON.stringify(body));
}

export async function requestHandler(req, res) {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (req.method === "OPTIONS") return send(res, 204, {});
    if (url.pathname === "/health") return send(res, 200, { ok: true });
    if (url.pathname !== "/flight") return send(res, 404, { error: "not found" });

    const number = parseFlightNumber(url.searchParams.get("number"));
    if (number == null) return send(res, 400, { error: "missing/invalid ?number (e.g. AA100)" });
    const date = url.searchParams.get("date") || todayISO();
    const result = await flightCatalog({
      number, date,
      dep: url.searchParams.get("dep"),
      arv: url.searchParams.get("arv"),
    });
    send(res, result.error ? 404 : 200, result);
  } catch (err) {
    send(res, 502, { error: String(err?.message || err) });
  }
}

// Only listen when run directly, so the handlers can be imported/deployed elsewhere.
if (import.meta.url === `file://${process.argv[1]}`) {
  createServer(requestHandler).listen(PORT, () =>
    console.log(`flight-mode proxy: http://localhost:${PORT}/flight?number=AA100`));
}
