// Why a referral was skipped by the auto run, kept in this browser so the
// officer can review it in the Skipped Referrals tab.
const KEY = "lhims:skipNotes";
const MAX_NOTES = 500;

const TEXT = {
  NO_MATCH: "Patient not found in the LHIMS list for this date.",
  NO_USABLE_ROW: "Every matching visit in LHIMS was green or red.",
  ALREADY_ATTACHED:
    "This visit already shows an “Internal Referral Form” attachment. Check LHIMS: if it is the right file, mark this done.",
  UNVERIFIED:
    "The save could not be confirmed. It may already be attached: check LHIMS before attaching again.",
  MISMATCH:
    "The visit that opened did not match the one chosen from the list. Nothing was saved.",
  TIMEOUT: "LHIMS took too long to respond.",
  WRONG_DATE: "LHIMS was showing a different date than this referral's.",
  TAB_CLOSED: "The LHIMS tab was closed during the attempt.",
  UNEXPECTED_DIALOG: "LHIMS showed a message the extension did not expect.",
  SELECTOR: "A part of the LHIMS page was not found as expected.",
  FILE_NOT_ATTACHED: "The file could not be attached on the LHIMS page.",
  FINAL_READBACK_FAILED:
    "The file, note or type was not set correctly. Nothing was saved.",
  NO_BASELINE: "The save could not be made verifiable, so nothing was saved.",
  NEEDS_ATTENTION: "The extension could not complete this referral.",
};

// `detail` is the extension's short diagnostic (e.g. "not in dropdown (0 options)").
export function describeProblem(stage, reason, detail = null) {
  let base = null;
  if (stage === "UNVERIFIED")
    base = TEXT.UNVERIFIED; // a save may have happened: always warn
  else if (reason?.startsWith("SELECTOR_")) base = TEXT.SELECTOR;
  else base = TEXT[reason] ?? TEXT[stage] ?? "Problem during auto attach.";
  const code = [reason, detail].filter(Boolean).join(": ");
  return code ? `${base} (${code})` : base;
}

function readAll() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function writeAll(map) {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* best effort */
  }
}

export function saveSkipNote(referralId, text) {
  const map = readAll();
  map[referralId] = { text, at: Date.now() };
  const keys = Object.keys(map);
  if (keys.length > MAX_NOTES) {
    keys
      .sort((a, b) => map[a].at - map[b].at)
      .slice(0, keys.length - MAX_NOTES)
      .forEach((k) => delete map[k]);
  }
  writeAll(map);
}

export function readSkipNote(referralId) {
  return readAll()[referralId]?.text ?? "";
}

export function clearSkipNote(referralId) {
  const map = readAll();
  if (referralId in map) {
    delete map[referralId];
    writeAll(map);
  }
}
