import { useCallback, useEffect, useRef, useState } from "react";
import { request, subscribe } from "./lhimsBridge";
import { buildJob } from "./lhimsJob";

const PROBLEM_STAGES = new Set([
  "NEEDS_ATTENTION",
  "MISMATCH",
  "UNVERIFIED",
  "LOGGED_OUT",
  "EXTENSION_ERROR",
]);
const isRunActive = (run) =>
  run?.status === "RUNNING" || run?.status === "STOPPING";
const flagKey = (kind, id) => `lhims:${kind}:${id}`;
const readFlag = (kind, id) => {
  try {
    return sessionStorage.getItem(flagKey(kind, id)) === "1";
  } catch {
    return false;
  }
};
const writeFlag = (kind, id) => {
  try {
    sessionStorage.setItem(flagKey(kind, id), "1");
  } catch {
    /* ignore */
  }
};

// Per-referral view of the extension. Sends a manual (officer-saves) job only while no auto run is active.
export function useLhimsAutomation(referral) {
  const id = referral.id;
  const [extensionPresent, setPresent] = useState(false);
  const [state, setState] = useState({ stage: "IDLE" });
  const [runActive, setRunActive] = useState(false);
  const [localProblem, setLocalProblem] = useState(null);
  const [breaker, setBreaker] = useState({ fails: 0, tripped: false });
  const [manuallyConfirmed, setManual] = useState(() => readFlag("manual", id));

  const referralRef = useRef(referral);
  const runActiveRef = useRef(false);
  useEffect(() => {
    referralRef.current = referral;
  });

  // 1) presence + live state from the extension
  useEffect(() => {
    let alive = true;
    const probe = async () => {
      try {
        const r = await request("PING", {}, 1200);
        if (alive && r?.pong) setPresent(true);
      } catch {
        /* extension absent */
      }
    };
    const off = subscribe((m) => {
      if (!alive) return;
      if (m.type === "READY") probe();
      if (m.type === "STATE") {
        const active = isRunActive(m.state.run);
        runActiveRef.current = active;
        setRunActive(active);
        if (m.state.breaker) setBreaker(m.state.breaker);
        if (m.state.referralId === id) setState(m.state);
        else if (m.state.stage === "IDLE") setState({ stage: "IDLE" });
      }
    });
    probe();
    const timers = [setTimeout(probe, 1000), setTimeout(probe, 2500)];
    return () => {
      alive = false;
      off();
      timers.forEach(clearTimeout);
    };
  }, [id]);

  const submitJob = useCallback(async (retry, isAlive = () => true) => {
    const r = referralRef.current;
    setLocalProblem(null);
    let job;
    try {
      job = await buildJob(r);
    } catch {
      setLocalProblem({ code: "FORM_RENDER_FAILED" });
      return;
    }
    if (!isAlive()) return; // card unmounted while rendering: never send a stale job
    const res = await request("SUBMIT_JOB", { ...job, retry }, 15000);
    if (!isAlive()) return;
    if (!res.ok) setLocalProblem({ code: res.error });
    else setState(res.state);
  }, []);

  // 2) job lifecycle: adopt, send (manual mode only), cancel on change/unmount
  useEffect(() => {
    if (!extensionPresent) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const cur = await request("GET_STATE", {});
        if (cancelled) return;
        setBreaker(cur.breaker);
        const active = isRunActive(cur.run);
        runActiveRef.current = active;
        setRunActive(active);
        if (cur.referralId === id && cur.stage !== "IDLE") {
          setState(cur);
          return;
        } // adopt after app reload / auto run
        if (active) return; // the auto run controller sends the jobs
        if (readFlag("verified", id) || readFlag("manual", id)) return;
        if (cur.breaker?.tripped) {
          setLocalProblem({ code: "BREAKER_TRIPPED" });
          return;
        }
        await submitJob(false, () => !cancelled);
      } catch (e) {
        if (!cancelled)
          setLocalProblem({ code: "BRIDGE_ERROR", detail: e.message });
      }
    })();
    return () => {
      cancelled = true;
      if (!runActiveRef.current)
        request("CANCEL_JOB", { referralId: id }).catch(() => {}); // never cancel an auto job
    };
  }, [extensionPresent, id, submitJob]);

  const startJob = useCallback(() => submitJob(true), [submitJob]);
  const cancelJob = useCallback(async () => {
    await request("CANCEL_JOB", { referralId: id }).catch(() => {});
    setState({ stage: "IDLE" });
  }, [id]);
  const ackBreaker = useCallback(async () => {
    await request("ACK_BREAKER", {});
    setBreaker({ fails: 0, tripped: false });
    setLocalProblem(null);
  }, []);
  const confirmManually = useCallback(() => {
    writeFlag("manual", id);
    setManual(true);
  }, [id]);

  const stage = state.stage;
  useEffect(() => {
    if (stage === "VERIFIED") writeFlag("verified", id);
  }, [stage, id]);
  const verified = stage === "VERIFIED" || readFlag("verified", id);
  const problem =
    localProblem ||
    (PROBLEM_STAGES.has(stage) ? { code: state.reason || stage, stage } : null);

  return {
    stage,
    verified,
    problem,
    extensionPresent,
    startJob,
    cancelJob,
    reason: state.reason || null,
    warn: state.warn || null,
    auto: !!state.auto,
    runActive,
    breakerTripped: breaker.tripped,
    ackBreaker,
    manuallyConfirmed,
    confirmManually,
  };
}
