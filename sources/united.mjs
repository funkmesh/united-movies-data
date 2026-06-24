// United Airlines — unitedprivatescreening.com, a geemedia Angular SPA.

import { harvestGeemedia } from "./_geemedia.mjs";

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

export default {
  id: "united",
  displayName: "United Airlines",
  harvest() {
    return harvestGeemedia({
      sectionURLs: [
        "https://www.unitedprivatescreening.com/movies",
        "https://www.unitedprivatescreening.com/tv",
      ],
      apiPattern: /api\/v3\/content\/items/,
      userAgent: UA,
    });
  },
};
