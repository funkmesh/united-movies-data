// The ordered registry of airline source adapters. To add a carrier, implement an
// adapter exporting `{ id, displayName, harvest() }` and list it here.

import united from "./united.mjs";
import american from "./american.mjs";
import delta from "./delta.mjs";

export default [united, american, delta];
