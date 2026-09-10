// Groups referrals by the date printed on the physical form — the
// "Date of Admission" column from the Excel intake, stored on each
// referral as `referral.referralDate` (see adminIntake.jsx's
// parseSpreadsheet). This is deliberately NOT today's date, and NOT
// when the record was created/assigned — it's the date IT staff
// already use to sort forms before opening that day's patient list
// in LHIMS, so grouping by it here mirrors that existing workflow.

export function getReferralDate(referral) {
  const raw =
    referral?.referralDate ?? referral?.dateOfAdmission ?? referral?.date;
  return coerceToDate(raw);
}

function coerceToDate(raw) {
  if (raw === null || raw === undefined || raw === "") return null;

  // A real Firestore Timestamp instance.
  if (typeof raw.toDate === "function") {
    const date = raw.toDate();
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // A Timestamp that's been through JSON serialization (e.g. round-tripped
  // through the offline IndexedDB cache) loses its .toDate() method but
  // keeps its raw shape: { seconds, nanoseconds } or { _seconds, _nanoseconds }.
  // `new Date(thatObject)` silently yields an Invalid Date rather than
  // throwing, which is what was previously dumping real-dated referrals
  // into the "No date on file" bucket — check for this shape explicitly
  // before falling through to the generic Date constructor below.
  if (typeof raw === "object") {
    const seconds = raw.seconds ?? raw._seconds;
    if (typeof seconds === "number") {
      const date = new Date(seconds * 1000);
      return Number.isNaN(date.getTime()) ? null : date;
    }
  }

  // An Excel date serial number, in case a cell wasn't recognized as a
  // real date type during import (so cellDates parsing didn't apply).
  // Excel's day-zero is Dec 30, 1899.
  if (typeof raw === "number") {
    const excelEpoch = Date.UTC(1899, 11, 30);
    const date = new Date(excelEpoch + raw * 86400000);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // The intake spreadsheet's "Date of Admission" column comes through as
  // a "DD-MM-YYYY" string (e.g. "18-06-2026") when the Excel cell wasn't
  // a real date type. JS's native Date constructor doesn't reliably parse
  // dash-separated dates unless they're already "YYYY-MM-DD" — it was
  // silently returning Invalid Date for every one of these, which is what
  // dumped correctly-dated referrals into "No date on file". Parse this
  // shape explicitly before falling through to the generic constructor.
  if (typeof raw === "string") {
    const ddMmYyyy = raw.trim().match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    if (ddMmYyyy) {
      const [, day, month, year] = ddMmYyyy;
      const date = new Date(Number(year), Number(month) - 1, Number(day));
      return Number.isNaN(date.getTime()) ? null : date;
    }
  }

  const date = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Stable "YYYY-MM-DD" grouping key, in local time (not UTC) so a form
// dated the evening of the 5th doesn't get grouped under the 4th or 6th
// depending on the browser's timezone offset.
export function getDateKey(referral) {
  const date = getReferralDate(referral);
  if (!date) return "unknown";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatDateLabel(key) {
  if (key === "unknown") return "No date on file";
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// Ascending comparator for the "YYYY-MM-DD" keys above, with the
// no-date bucket always sorted last since there's nothing to sequence
// it against.
export function compareDateKeys(a, b) {
  if (a === "unknown") return 1;
  if (b === "unknown") return -1;
  return a.localeCompare(b);
}
