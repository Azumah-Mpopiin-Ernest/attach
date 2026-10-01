import { useCallback, useEffect, useRef, useState } from "react";
import { getDateKey } from "../referralDates";
import { request, subscribe } from "./lhimsBridge";
import { buildJob } from "./lhimsJob";
import { describeProblem } from "./skipNotes";

const TERMINAL = new Set([
  "VERIFIED",
  "NEEDS_ATTENTION",
  "MISMATCH",
  "UNVERIFIED",
  "LOGGED_OUT",
  "EXTENSION_ERROR",
]);
// These stop the whole run and leave the referral in the queue (every following referral would fail the same way).
const HARD_STOPS = new Set(["LOGGED_OUT", "EXTENSION_ERROR"]);
const BAD_DATA = new Set(["BAD_PATIENT_ID", "BAD_FILE_NAME"]); // this referral cannot be automated: skip it, keep going
const START_ERRORS = {
  NO_START_REQUEST:
    'Press "Start auto run" on the extension badge in LHIMS (Filter Selection page).',
  BREAKER_TRIPPED:
    "Assist is paused after a problem. Acknowledge it first, then start again.",
  ALREADY_RUNNING: "An auto run is already active.",
};

// LHIMS wants DD-MM-YYYY. Accepts YYYY-MM-DD or DD-MM-YYYY keys.
function toLhimsDate(key) {
  if (typeof key !== "string") return null;
  let m = key.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = key.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? key : null;
}

/**
 * Drives the extension's auto run from the officer's queue:
 * sends the next referral's form, marks it done once LHIMS verified it, and
 * SKIPS (with the reason) any referral that ends in a problem, so one bad
 * referral never holds up the rest. Stops when the queue is empty.
 *
 * `skipReferral(referral, note)` must store the note for the skipped list.
 */
export function useLhimsRun({ queue, queueLoaded, markDone, skipReferral }) {
  const [present, setPresent] = useState(false);
  const [ext, setExt] = useState({
    stage: "IDLE",
    run: null,
    pool: null,
    breaker: { fails: 0, tripped: false },
  });
  const [startError, setStartError] = useState("");
  const queueRef = useRef(queue);
  const actionsRef = useRef({ markDone, skipReferral });
  const processed = useRef(new Set());
  const busy = useRef(false);
  useEffect(() => {
    queueRef.current = queue;
    actionsRef.current = { markDone, skipReferral };
  });

  const startRun = useCallback(async () => {
    setStartError("");
    const first = queueRef.current[0];
    if (!first) {
      setStartError("There are no referrals in your queue.");
      return;
    }
    const date = toLhimsDate(getDateKey(first));
    if (!date) {
      setStartError(
        "This referral date is in a format the extension cannot use. Send the developer referralDates.js.",
      );
      return;
    }
    try {
      const r = await request("RUN_START", { date });
      if (!r.ok)
        setStartError(START_ERRORS[r.error] || `Could not start (${r.error}).`);
    } catch (e) {
      setStartError(e.message);
    }
  }, []);

  // presence + live state + start requests coming from the badge
  useEffect(() => {
    let alive = true;
    const probe = async () => {
      try {
        const r = await request("PING", {}, 1200);
        if (!alive || !r?.pong) return;
        setPresent(true);
        setExt(await request("GET_STATE", {}));
      } catch {
        /* extension absent */
      }
    };
    const off = subscribe((m) => {
      if (!alive) return;
      if (m.type === "READY") probe();
      else if (m.type === "STATE") setExt(m.state);
      else if (m.type === "RUN_REQUEST") startRun();
    });
    probe();
    const timers = [setTimeout(probe, 1000), setTimeout(probe, 2500)];
    return () => {
      alive = false;
      off();
      timers.forEach(clearTimeout);
    };
  }, [startRun]);

  // outcome of the current auto job: done on VERIFIED, otherwise skip with the reason
  useEffect(() => {
    const id = ext.referralId;
    if (
      !ext.auto ||
      !id ||
      processed.current.has(id) ||
      !TERMINAL.has(ext.stage)
    )
      return;
    const referral = queueRef.current.find((r) => r.id === id);
    if (!referral) return;
    if (ext.stage === "VERIFIED") {
      processed.current.add(id);
      actionsRef.current.markDone(referral);
    } else if (!HARD_STOPS.has(ext.stage)) {
      processed.current.add(id);
      actionsRef.current.skipReferral(
        referral,
        describeProblem(ext.stage, ext.reason),
      );
    }
  }, [ext]);

  // driver: send the next referral, or stop when nothing is left
  useEffect(() => {
    if (
      !present ||
      !queueLoaded ||
      ext.run?.status !== "RUNNING" ||
      busy.current
    )
      return;
    if (ext.referralId && !TERMINAL.has(ext.stage)) return; // a job is in progress
    const next = queue.find((r) => !processed.current.has(r.id));
    const stop = (reason) => request("RUN_STOP", { reason }).catch(() => {});
    if (!next) {
      stop("DONE");
      return;
    }
    busy.current = true;
    (async () => {
      try {
        const date = toLhimsDate(getDateKey(next));
        if (!date) {
          await stop("BAD_DATE");
          return;
        }
        let job;
        try {
          job = await buildJob(next);
        } catch {
          await stop("FORM_RENDER_FAILED");
          return;
        }
        const res = await request("SUBMIT_JOB", { ...job, date }, 20000);
        if (res.ok || res.error === "RUN_STOPPING") return;
        if (BAD_DATA.has(res.error)) {
          processed.current.add(next.id);
          actionsRef.current.skipReferral(
            next,
            `The patient ID or name is not in a format the extension can use (${res.error}).`,
          );
          return;
        }
        await stop(res.error);
      } catch {
        await stop("APP_ERROR");
      } finally {
        busy.current = false;
      }
    })();
  }, [present, queueLoaded, ext, queue]);

  const stopRun = useCallback(
    () => request("RUN_STOP", { reason: "OFFICER_STOP" }).catch(() => {}),
    [],
  );
  const ackBreaker = useCallback(async () => {
    await request("ACK_BREAKER", {}).catch(() => {});
    setStartError("");
  }, []);

  return {
    present,
    run: ext.run,
    pool: ext.pool,
    stage: ext.stage,
    reason: ext.reason || null,
    breakerTripped: !!ext.breaker?.tripped,
    startError,
    stopRun,
    ackBreaker,
  };
}
