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
// Nothing left to attach: the visit already has the form, or every matching visit is red/green.
// Marked done instead of skipped (keep in sync with MARK_DONE in lhims-assist/sw.js).
const MARK_DONE = new Set(["ALREADY_ATTACHED", "NO_USABLE_ROW"]);
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

// How many upcoming referrals have their form prepared in advance.
const PREBUILD_AHEAD = 2;

/**
 * Drives the extension's auto run from the officer's queue:
 * sends up to `run.concurrency` referrals at once (each worked in its own
 * LHIMS tab), marks each done once LHIMS verified it, and SKIPS (with the
 * reason) any referral that ends in a problem, so one bad referral never
 * holds up the rest. Stops when the queue is empty.
 *
 * Forms are rendered ahead of time, so the next referral is sent the moment
 * a slot frees up.
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
  const [tick, setTick] = useState(0); // re-runs the driver after each send
  const queueRef = useRef(queue);
  const actionsRef = useRef({ markDone, skipReferral });
  const processed = useRef(new Set()); // referral ids with a final outcome
  const submitted = useRef(new Map()); // referral id -> LHIMS date, sent during this run
  const prebuilt = useRef(new Map()); // referral id -> Promise<job>
  const busy = useRef(false);
  const sendFailures = useRef(0); // consecutive failed sends; a few in a row stop the run
  useEffect(() => {
    queueRef.current = queue;
    actionsRef.current = { markDone, skipReferral };
  });

  // Starts rendering a referral's form (once) and returns the pending job.
  const jobFor = useCallback((referral) => {
    let pending = prebuilt.current.get(referral.id);
    if (!pending) {
      pending = buildJob(referral);
      prebuilt.current.set(referral.id, pending);
      pending.catch(() => prebuilt.current.delete(referral.id)); // retried next time
    }
    return pending;
  }, []);

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

  // outcome of each auto job: done on VERIFIED (or nothing left to attach), otherwise skip with the reason
  useEffect(() => {
    for (const job of ext.jobs ?? []) {
      const id = job.referralId;
      if (
        !job.auto ||
        !id ||
        processed.current.has(id) ||
        !TERMINAL.has(job.stage)
      )
        continue;
      const referral = queueRef.current.find((r) => r.id === id);
      if (!referral) continue;
      if (
        job.stage === "VERIFIED" ||
        (job.stage === "NEEDS_ATTENTION" && MARK_DONE.has(job.reason))
      ) {
        processed.current.add(id);
        actionsRef.current.markDone(referral);
      } else if (!HARD_STOPS.has(job.stage)) {
        processed.current.add(id);
        actionsRef.current.skipReferral(
          referral,
          describeProblem(job.stage, job.reason, job.warn),
        );
      }
      prebuilt.current.delete(id);
    }
  }, [ext]);

  // driver: keep up to `concurrency` referrals in flight, or stop when nothing is left
  useEffect(() => {
    const running = ext.run?.status === "RUNNING";
    if (!ext.run || ext.run.status === "STOPPED") {
      // anything sent but not finished goes back to the queue for the next run
      submitted.current.clear();
      prebuilt.current.clear();
    }
    if (!present || !queueLoaded || !running || busy.current) return;

    const stop = (reason) => request("RUN_STOP", { reason }).catch(() => {});
    // a finished job frees its slot even if its referral left the queue meanwhile
    const finished = new Set(
      (ext.jobs ?? [])
        .filter((j) => j.auto && TERMINAL.has(j.stage))
        .map((j) => j.referralId),
    );
    const inFlight = [...submitted.current].filter(
      ([id]) => !processed.current.has(id) && !finished.has(id),
    );
    const waiting = queue.filter(
      (r) => !processed.current.has(r.id) && !submitted.current.has(r.id),
    );
    if (!waiting.length) {
      if (!inFlight.length) stop("DONE");
      return;
    }
    const concurrency = Math.max(1, ext.run.concurrency || 1);
    if (inFlight.length >= concurrency) return;

    const next = waiting[0];
    const date = toLhimsDate(getDateKey(next));
    if (!date) {
      if (!inFlight.length) stop("BAD_DATE");
      return;
    }
    // one admission date at a time: the LHIMS list tabs are opened for a single date
    if (inFlight.some(([, d]) => d !== date)) return;

    busy.current = true;
    submitted.current.set(next.id, date);
    waiting.slice(1, 1 + PREBUILD_AHEAD).forEach((r) => {
      jobFor(r).catch(() => {}); // render ahead; a failure is retried when its turn comes
    });
    let retrigger = true;
    (async () => {
      try {
        let job;
        try {
          job = await jobFor(next);
        } catch {
          submitted.current.delete(next.id);
          await stop("FORM_RENDER_FAILED");
          return;
        }
        prebuilt.current.delete(next.id);
        const res = await request("SUBMIT_JOB", { ...job, date }, 20000);
        sendFailures.current = 0;
        if (res.ok) return;
        submitted.current.delete(next.id);
        if (res.error === "RUN_STOPPING") return;
        if (res.error === "BUSY") {
          retrigger = false; // the extension is full: the next state change frees a slot
          return;
        }
        if (BAD_DATA.has(res.error)) {
          processed.current.add(next.id);
          actionsRef.current.skipReferral(
            next,
            `The patient ID or name is not in a format the extension can use (${res.error}).`,
          );
          return;
        }
        await stop(res.error);
      } catch (error) {
        // Usually the extension was slow to answer. It ignores a resend of a
        // referral it already has, so retry before giving up.
        submitted.current.delete(next.id);
        sendFailures.current += 1;
        if (sendFailures.current >= 3) {
          sendFailures.current = 0;
          await stop(`APP_ERROR: ${error?.message || "unknown"}`.slice(0, 40));
        }
      } finally {
        busy.current = false;
        if (retrigger) setTick((t) => t + 1);
      }
    })();
  }, [present, queueLoaded, ext, queue, tick, jobFor]);

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
