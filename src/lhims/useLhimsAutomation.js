import { useCallback, useEffect, useRef, useState } from "react";
import {
  renderReferralFormJpegBlob,
  referralFormFileName,
} from "../referralForm"; // adjust path
import { request, subscribe } from "./lhimsBridge";

const PROBLEM_STAGES = new Set([
  "NEEDS_ATTENTION",
  "MISMATCH",
  "UNVERIFIED",
  "LOGGED_OUT",
  "EXTENSION_ERROR",
]);
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

const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1]);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });

const sha256Hex = async (blob) => {
  if (!globalThis.crypto?.subtle) return null; // insecure origin: the extension still checks the length
  const buf = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

export function useLhimsAutomation(referral) {
  const id = referral.id;
  const [extensionPresent, setPresent] = useState(false);
  const [state, setState] = useState({ stage: "IDLE" });
  const [localProblem, setLocalProblem] = useState(null);
  const [breaker, setBreaker] = useState({ fails: 0, tripped: false });
  const [manuallyConfirmed, setManual] = useState(() => readFlag("manual", id));

  const referralRef = useRef(referral);
  const aliveRef = useRef(true);
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
        if (m.state.breaker) setBreaker(m.state.breaker);
        if (m.state.referralId === id) setState(m.state);
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

  const submitJob = useCallback(
    async (retry, isAlive = () => aliveRef.current) => {
      const r = referralRef.current;
      setLocalProblem(null);
      let blob;
      try {
        blob = await renderReferralFormJpegBlob(r);
      } catch {
        setLocalProblem({ code: "FORM_RENDER_FAILED" });
        return;
      }
      const bytesB64 = await blobToBase64(blob);
      const sha256 = await sha256Hex(blob);
      if (!isAlive()) return; // card unmounted while rendering: never send a stale job
      const res = await request(
        "SUBMIT_JOB",
        {
          referralId: r.id,
          patientId: r.patientId,
          expectedFileName: referralFormFileName(r),
          mimeType: "image/jpeg",
          size: blob.size,
          bytesB64,
          sha256,
          retry,
        },
        15000,
      );
      if (!isAlive()) return;
      if (!res.ok) setLocalProblem({ code: res.error });
      else setState(res.state);
    },
    [],
  );

  // 2) job lifecycle: adopt, send, cancel on change/unmount
  useEffect(() => {
    if (!extensionPresent) return undefined;
    let cancelled = false;
    aliveRef.current = true;
    (async () => {
      try {
        const cur = await request("GET_STATE", {});
        if (cancelled) return;
        setBreaker(cur.breaker);
        if (cur.referralId === id && cur.stage !== "IDLE") {
          setState(cur);
          return;
        } // adopt after app reload
        if (readFlag("verified", id) || readFlag("manual", id)) return; // already handled this session
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
      aliveRef.current = false;
      request("CANCEL_JOB", { referralId: id }).catch(() => {}); // clears job + bytes in the extension
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
    breakerTripped: breaker.tripped,
    ackBreaker,
    manuallyConfirmed,
    confirmManually,
  };
}
