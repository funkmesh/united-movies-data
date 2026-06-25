// The ordered registry of airline source adapters. To add a carrier, implement an
// adapter exporting `{ id, displayName, harvest() }` and list it here.

import united from "./united.mjs";
import american from "./american.mjs";
import delta from "./delta.mjs";

// Order matters for the shared OMDb daily quota: enrich the small catalogs (United,
// Delta) before the large one (American), so a quota crunch degrades American (which is
// already only partially rated) rather than starving a small catalog of all enrichment.
export default [united, delta, american];
