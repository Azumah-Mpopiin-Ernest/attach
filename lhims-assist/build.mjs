import fs from "node:fs";
import vm from "node:vm";

const sandbox = {};
vm.runInNewContext(fs.readFileSync("config.js", "utf8"), sandbox);
const C = sandbox.LA_CONFIG;

if ([...C.LHIMS_URL_PATTERNS, ...C.APP_ORIGINS].some((s) => s.includes("<"))) {
  console.error("Fill the placeholders in config.js first.");
  process.exit(1);
}
// Chrome ignores ports in match patterns; the scripts enforce the exact origin at runtime.
const appMatches = C.APP_ORIGINS.map((o) => {
  const u = new URL(o);
  return `${u.protocol}//${u.hostname}/*`;
});

const manifest = {
  manifest_version: 3,
  name: "LHIMS Referral Assist",
  version: "0.2.0",
  description:
    "Assists attaching referral forms in LHIMS. Local only, never saves for you.",
  minimum_chrome_version: "120",
  permissions: ["storage", "alarms"],
  background: { service_worker: "sw.js" },
  content_scripts: [
    {
      matches: appMatches,
      js: ["config.js", "relay.js"],
      run_at: "document_idle",
    },
    {
      matches: C.LHIMS_URL_PATTERNS,
      js: ["config.js", "badge.js", "lhims.js"],
      run_at: "document_idle",
      all_frames: false,
    },
  ],
  // key: "<paste public key so the extension ID stays stable for force-install>",
};
fs.writeFileSync("manifest.json", JSON.stringify(manifest, null, 2));
console.log("manifest.json written");
