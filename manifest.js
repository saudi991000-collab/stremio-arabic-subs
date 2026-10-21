import { VERSION } from "./version.js";

export const manifest = {
  id: "org.arabic.elitesubs.v3",
  version: VERSION,
  name: "⭐ ترجمة النخبة",
  description: "حتى 25 ترجمة عربية بشرية مُتحقَّق منها من مصادر متعددة، مرتبة حسب العمل والحلقة وإصدار الفيديو، مع مزامنة توقيت آمنة ودعم SRT وVTT وASS وSSA.",
  logo: "https://raw.githubusercontent.com/Stremio/stremio-addon-sdk/master/assets/stremio-logo.png",
  resources: [{ name: "subtitles", types: ["movie", "series"] }],
  types: ["movie", "series"],
  catalogs: [],
  behaviorHints: { configurable: false }
};
