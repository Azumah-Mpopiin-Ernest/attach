import { useEffect, useState } from "react";

const ACTIONS_KEY_PREFIX = "officer-flow:actions:";
const DONE_COUNT_KEY_PREFIX = "officer-flow:done:";

// After the ID is copied AND the form downloaded, Mark Done and Skip stay
// locked for this long: time to actually attempt the upload in LHIMS.
const UNLOCK_SECONDS = 10;

const NO_ACTIONS = { idCopied: false, fileDownloaded: false, readyAt: null };

// sessionStorage can throw (storage disabled, private mode, quota). The
// workflow must keep working without persistence, so every access is guarded.
function readSession(key) {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key, value) {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // Persistence is best-effort; the in-memory state still works.
  }
}

function removeSession(key) {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}

// Applies `patch` and stamps `readyAt` (when the countdown started) the
// moment both prerequisites are first satisfied. `now` is passed in so this
// stays a pure function.
function withAction(current, patch, now) {
  const next = { ...current, ...patch };
  if (next.idCopied && next.fileDownloaded && next.readyAt === null) {
    next.readyAt = now;
  }
  return next;
}

function readActions(referralId) {
  const raw = readSession(ACTIONS_KEY_PREFIX + referralId);
  if (!raw) return NO_ACTIONS;
  try {
    const saved = JSON.parse(raw);
    return withAction(
      {
        idCopied: saved?.idCopied === true,
        fileDownloaded: saved?.fileDownloaded === true,
        readyAt: typeof saved?.readyAt === "number" ? saved.readyAt : null,
      },
      {},
      Date.now(),
    );
  } catch {
    return NO_ACTIONS;
  }
}

function secondsUntilUnlocked(readyAt, now) {
  if (readyAt === null) return null;
  const remainingMs = readyAt + UNLOCK_SECONDS * 1000 - now;
  // `now` can briefly predate `readyAt`, hence the upper clamp.
  return Math.max(0, Math.min(UNLOCK_SECONDS, Math.ceil(remainingMs / 1000)));
}

// Whole seconds left on the unlock countdown, or null while it hasn't
// started (`readyAt` is null). Based on the wall clock, so it stays correct
// in a throttled background tab and continues across a page refresh.
function useUnlockCountdown(readyAt) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (readyAt === null) return undefined;
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= readyAt + UNLOCK_SECONDS * 1000) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [readyAt]);

  return secondsUntilUnlocked(readyAt, now);
}

/**
 * Forget the copy/download progress for a referral. Call this when it is
 * marked done OR skipped: a skipped referral must start from scratch when
 * it is picked up again, so earlier progress can never unlock Mark Done.
 */
export function clearReferralActions(referralId) {
  removeSession(ACTIONS_KEY_PREFIX + referralId);
}

export function referralName(referral, fallback = "this patient") {
  return referral.name ?? referral.patientName ?? fallback;
}

/**
 * Tracks the safeguards for ONE referral:
 *   1. the LHIMS ID has been copied,
 *   2. the form has been downloaded,
 *   3. a 10 second countdown, started once 1 and 2 are both true, has run
 *      out (`unlocked`). Mark Done and Skip both wait for this.
 *
 * Progress (including when the countdown started) is stored per referral id
 * in sessionStorage, so it survives a page refresh but can never leak from
 * one patient to another. Mount the calling component with
 * `key={referral.id}` so the state is re-read for each referral. A flag is
 * set only after its action actually succeeded.
 *
 * `formsFolder` (see formsFolder.js) decides where the form goes: the
 * officer's forms folder when one is set up, a normal download otherwise.
 *
 * `reportError(message)` receives a user-facing message (or "" to clear).
 */
export function useReferralActions(referral, reportError, formsFolder) {
  const { id, patientId } = referral;
  const [actions, setActions] = useState(() => readActions(id));
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (actions.idCopied || actions.fileDownloaded) {
      writeSession(ACTIONS_KEY_PREFIX + id, JSON.stringify(actions));
    }
  }, [id, actions]);

  const ready = actions.idCopied && actions.fileDownloaded;
  const secondsLeft = useUnlockCountdown(ready ? actions.readyAt : null);

  const copyId = async () => {
    reportError("");
    try {
      if (!patientId) {
        throw new Error("This referral has no LHIMS patient ID to copy.");
      }
      if (!navigator.clipboard?.writeText) {
        throw new Error(
          "Copying isn't available in this browser. Open the app over HTTPS and try again.",
        );
      }
      await navigator.clipboard.writeText(String(patientId));
      const now = Date.now();
      setActions((current) => withAction(current, { idCopied: true }, now));
    } catch (copyError) {
      reportError(copyError.message);
    }
  };

  const download = async () => {
    reportError("");
    setDownloading(true);
    try {
      const { notice } = await formsFolder.deliver(referral);
      const now = Date.now();
      setActions((current) =>
        withAction(current, { fileDownloaded: true }, now),
      );
      // The form was delivered, but not where the officer expects.
      if (notice) reportError(notice);
    } catch (downloadError) {
      reportError(downloadError.message);
    } finally {
      setDownloading(false);
    }
  };

  return {
    actions,
    downloading,
    ready,
    secondsLeft,
    unlocked: ready && secondsLeft === 0,
    copyId,
    download,
  };
}

/**
 * Referrals completed by this officer in this browser tab, kept across
 * refreshes. Returns [count, adjust(delta)].
 */
export function useSessionDoneCount(officerName) {
  const storageKey = DONE_COUNT_KEY_PREFIX + officerName;
  const [count, setCount] = useState(
    () => Number.parseInt(readSession(storageKey) ?? "0", 10) || 0,
  );

  useEffect(() => {
    writeSession(storageKey, String(count));
  }, [storageKey, count]);

  const adjust = (delta) => setCount((current) => Math.max(0, current + delta));

  return [count, adjust];
}
