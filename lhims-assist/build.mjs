import fs from "node:fs";
import vm from "node:vm";

const sandbox = {};
vm.runInNewContext(fs.readFileSync("config.js", "utf8"), sandbox);
const C = sandbox.LA_CONFIG;

if ([...C.LHIMS_URL_PATTERNS, ...C.APP_ORIGINS].some((s) => s.includes("<"))) {
  console.error("Fill the placeholders in config.js first.");
  process.exit(1);
}
const appMatches = C.APP_ORIGINS.map((o) => {
  const u = new URL(o);
  return `${u.protocol}//${u.hostname}/*`;
});

const manifest = {
  manifest_version: 3,
  name: "LHIMS Referral Assist",
  version: "0.7.0",
  description:
    "Assists and automates attaching referral forms in LHIMS. Local only.",
  minimum_chrome_version: "120",
  permissions: ["storage", "alarms"],
  background: { service_worker: "sw.js" },
  content_scripts: [
    {
      matches: appMatches,
      js: ["config.js", "relay.js"],
      run_at: "document_idle",
    },
    // Runs inside the page itself so it can answer the page's confirm() dialogs.
    {
      matches: C.LHIMS_URL_PATTERNS,
      js: ["dialogs.js"],
      run_at: "document_start",
      world: "MAIN",
      all_frames: false,
    },
    {
      matches: C.LHIMS_URL_PATTERNS,
      js: ["config.js", "badge.js", "lhims.js"],
      // as soon as the page's HTML is parsed: the work pages (attachment,
      // confirmation) never wait for LHIMS's images (see domReady in lhims.js)
      run_at: "document_end",
      all_frames: false,
    },
  ],
  // key: "<paste public key so the extension ID stays stable for force-install>",
};
fs.writeFileSync("manifest.json", JSON.stringify(manifest, null, 2));
console.log("manifest.json written");
