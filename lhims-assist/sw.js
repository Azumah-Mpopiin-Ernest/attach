importScripts("config.js");
const C = LA_CONFIG;

const TERMINAL = new Set([
  "VERIFIED",
  "NEEDS_ATTENTION",
  "MISMATCH",
  "UNVERIFIED",
  "LOGGED_OUT",
  "EXTENSION_ERROR",
]);
const REPORTABLE = new Set([
  "SEARCHING",
  "MATCHED",
  "ON_ATTACHMENT_PAGE",
  "FILE_ATTACHED",
  "NOTE_FILLED",
  "TYPE_SET",
  "READY_FOR_SAVE",
  ...TERMINAL,
]);
const NO_BREAKER = new Set(["NO_MATCH", "MULTIPLE_MATCHES", "TAB_CLOSED"]);
const PATCH_KEYS = [
  "reason",
  "scheduleId",
  "searchClicked",
  "baseline",
  "warn",
  "fieldsOk",
];
const DEFAULT_BREAKER = { fails: 0, tripped: false };

const toRegex = (p) =>
  new RegExp(
    "^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
  );
const LHIMS_RE = C.LHIMS_URL_PATTERNS.map(toRegex);
const fromLhims = (s) =>
  s.id === chrome.runtime.id &&
  s.tab &&
  LHIMS_RE.some((r) => r.test(s.url || ""));
const fromApp = (s) => {
  try {
    return (
      s.id === chrome.runtime.id &&
      s.tab &&
      C.APP_ORIGINS.includes(new URL(s.url).origin)
    );
  } catch {
    return false;
  }
};

const store = chrome.storage.session;
const read = async (k, d = null) => (await store.get(k))[k] ?? d;
let chain = Promise.resolve();
const locked = (fn) => {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
};

const shapeOf = (fileName) =>
  fileName
    .replace(/\.[^.]+$/, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0] + "•".repeat(Math.max(0, w.length - 1)))
    .join(" ");

const publicState = (job, breaker) =>
  !job
    ? { stage: "IDLE", breaker }
    : {
        referralId: job.referralId,
        stage: job.stage,
        reason: job.reason || null,
        warn: job.warn || null,
        verified: job.stage === "VERIFIED",
        patientId: job.patientId,
        shape: job.shape,
        claimedTabId: job.claimedTabId ?? null,
        breaker,
      };
const ownerJob = (j) => ({
  jobId: j.jobId,
  stage: j.stage,
  patientId: j.patientId,
  expectedFileName: j.expectedFileName,
  size: j.size,
  scheduleId: j.scheduleId ?? null,
  searchClicked: !!j.searchClicked,
  baseline: j.baseline ?? null,
  fieldsOk: j.fieldsOk ?? null,
});

async function broadcast(job, appTabId = job?.appTabId) {
  const state = publicState(job, await read("breaker", DEFAULT_BREAKER));
  if (appTabId != null)
    chrome.tabs
      .sendMessage(appTabId, { channel: "TO_APP", type: "STATE", state })
      .catch(() => {});
  const tabs = await read("tabs", []);
  const alive = [];
  await Promise.all(
    tabs.map(async (id) => {
      try {
        await chrome.tabs.sendMessage(id, {
          channel: "TO_LHIMS",
          type: "STATE",
          state,
        });
        alive.push(id);
      } catch {
        /* gone or loading */
      }
    }),
  );
  if (alive.length !== tabs.length) await store.set({ tabs: alive });
}

async function arm(job) {
  // No watchdog while waiting for the officer (claim, review/Save).
  if (job.stage === "JOB_RECEIVED" || job.stage === "READY_FOR_SAVE")
    return chrome.alarms.clear("wd");
  return chrome.alarms.create("wd", {
    delayInMinutes:
      job.stage === "SAVE_CLICKED" ? C.VERIFY_TIMEOUT_MIN : C.STAGE_TIMEOUT_MIN,
  });
}

async function onTerminal(job) {
  await store.remove("blob"); // bytes never outlive the job
  await chrome.alarms.clear("wd");
  const b = await read("breaker", DEFAULT_BREAKER);
  if (job.stage === "VERIFIED") b.fails = 0;
  else if (job.stage === "MISMATCH") b.tripped = true;
  else if (
    ["UNVERIFIED", "EXTENSION_ERROR"].includes(job.stage) ||
    (job.stage === "NEEDS_ATTENTION" && !NO_BREAKER.has(job.reason))
  ) {
    b.fails += 1;
    if (b.fails >= C.BREAKER_MAX_FAILS) b.tripped = true;
  }
  await store.set({ breaker: b });
}

const cleanPatch = (patch) => {
  const out = {};
  for (const k of PATCH_KEYS) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (v === null || typeof v === "boolean" || typeof v === "number")
      out[k] = v;
    else if (typeof v === "string" && v.length <= 100) out[k] = v;
  }
  return out;
};

async function transition(jobId, stage, patch = {}, force = false) {
  const job = await read("job");
  if (!job || job.jobId !== jobId) return null;
  if (TERMINAL.has(job.stage) && !force) return null; // ignore late updates
  const clean = cleanPatch(patch);
  const next = { ...job, ...clean, stage, updatedAt: Date.now() };
  if (!("reason" in clean)) next.reason = null;
  await store.set({ job: next });
  if (TERMINAL.has(stage)) await onTerminal(next);
  else await arm(next);
  await broadcast(next);
  return next;
}

async function clearJob(job) {
  await store.remove(["job", "blob"]);
  await chrome.alarms.clear("wd");
  await broadcast(null, job.appTabId);
}

const decode = (b64) => {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
};
const sha256Hex = async (bytes) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

function validate(p) {
  if (
    typeof p.referralId !== "string" ||
    !p.referralId ||
    p.referralId.length > 128
  )
    return "BAD_REFERRAL";
  if (typeof p.patientId !== "string" || !/^[\w-]{3,40}$/.test(p.patientId))
    return "BAD_PATIENT_ID";
  if (
    typeof p.expectedFileName !== "string" ||
    p.expectedFileName.length > 200 ||
    !/\.jpe?g$/i.test(p.expectedFileName)
  )
    return "BAD_FILE_NAME";
  if (p.mimeType !== "image/jpeg") return "BAD_MIME";
  if (!Number.isInteger(p.size) || p.size <= 0 || p.size > C.MAX_BYTES)
    return "BAD_SIZE";
  if (
    typeof p.bytesB64 !== "string" ||
    p.bytesB64.length > Math.ceil(C.MAX_BYTES * 1.4)
  )
    return "BAD_BYTES";
  return null;
}

async function submit(p, sender, job, breaker) {
  if (breaker.tripped) return { ok: false, error: "BREAKER_TRIPPED" };
  const bad = validate(p);
  if (bad) return { ok: false, error: bad };
  if (
    job &&
    job.referralId === p.referralId &&
    (!TERMINAL.has(job.stage) || !p.retry)
  ) {
    await store.set({ job: { ...job, appTabId: sender.tab.id } }); // idempotent; re-binds app tab after app reload
    return { ok: true, state: publicState(job, breaker) };
  }
  const bytes = decode(p.bytesB64);
  if (bytes.length !== p.size) return { ok: false, error: "SIZE_MISMATCH" };
  if (p.sha256 && (await sha256Hex(bytes)) !== p.sha256)
    return { ok: false, error: "HASH_MISMATCH" };
  const next = {
    jobId: crypto.randomUUID(),
    referralId: p.referralId,
    patientId: p.patientId.trim(),
    expectedFileName: p.expectedFileName,
    mimeType: p.mimeType,
    size: p.size,
    shape: shapeOf(p.expectedFileName),
    appTabId: sender.tab.id,
    claimedTabId: null,
    stage: "JOB_RECEIVED",
    reason: null,
    updatedAt: Date.now(),
  };
  await store.set({
    job: next,
    blob: { b64: p.bytesB64, mimeType: p.mimeType },
  }); // replaces any previous job + bytes
  await chrome.alarms.clear("wd");
  await broadcast(next);
  return { ok: true, state: publicState(next, breaker) };
}

async function onApp(msg, sender) {
  const job = await read("job");
  const breaker = await read("breaker", DEFAULT_BREAKER);
  const p = msg.payload || {};
  switch (msg.type) {
    case "PING":
      return { pong: true, version: chrome.runtime.getManifest().version };
    case "GET_STATE":
      if (job) await store.set({ job: { ...job, appTabId: sender.tab.id } });
      return publicState(job, breaker);
    case "ACK_BREAKER":
      await store.set({ breaker: { ...DEFAULT_BREAKER } });
      await broadcast(job);
      return { ok: true };
    case "CANCEL_JOB":
      if (job && job.referralId === p.referralId) await clearJob(job);
      return { ok: true };
    case "SUBMIT_JOB":
      return submit(p, sender, job, breaker);
    default:
      return { ok: false, error: "UNKNOWN_TYPE" };
  }
}

async function onLhims(msg, sender) {
  const tabId = sender.tab.id;
  const job = await read("job");
  const breaker = await read("breaker", DEFAULT_BREAKER);
  const owner = !!job && job.claimedTabId === tabId;
  const view = (j) => ({
    state: publicState(j, breaker),
    job: j && j.claimedTabId === tabId ? ownerJob(j) : undefined,
  });

  switch (msg.type) {
    case "HELLO": {
      const tabs = new Set(await read("tabs", []));
      tabs.add(tabId);
      await store.set({ tabs: [...tabs] });
      return { ok: true, tabId, ...view(job) };
    }
    case "CLAIM": {
      if (!job || job.stage !== "JOB_RECEIVED" || job.claimedTabId != null)
        return { ok: false, error: "NOT_CLAIMABLE" };
      if (msg.page !== "LIST")
        return { ok: false, error: "NOT_A_PATIENT_LIST_TAB" };
      await store.set({ job: { ...job, claimedTabId: tabId } });
      const next = await transition(job.jobId, "TAB_CLAIMED");
      return next
        ? { ok: true, ...view(next) }
        : { ok: false, error: "IGNORED" };
    }
    case "PROGRESS": {
      if (!owner || !REPORTABLE.has(msg.stage))
        return { ok: false, error: "REJECTED" };
      const next = await transition(job.jobId, msg.stage, msg.patch || {});
      return next
        ? { ok: true, ...view(next) }
        : { ok: false, error: "IGNORED" };
    }
    case "SAVE_CLICKED": {
      if (
        !owner ||
        !["READY_FOR_SAVE", "SAVE_CLICKED", "UNVERIFIED"].includes(job.stage)
      )
        return { ok: false, error: "REJECTED" };
      const next = await transition(
        job.jobId,
        "SAVE_CLICKED",
        { fieldsOk: msg.fieldsOk ?? null },
        true,
      );
      return next
        ? { ok: true, ...view(next) }
        : { ok: false, error: "IGNORED" };
    }
    case "GET_BLOB": {
      if (!owner || TERMINAL.has(job.stage))
        return { ok: false, error: "REJECTED" };
      const blob = await read("blob");
      return blob
        ? { ok: true, b64: blob.b64, mimeType: blob.mimeType, size: job.size }
        : { ok: false, error: "NO_BLOB" };
    }
    default:
      return { ok: false, error: "UNKNOWN_TYPE" };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler =
    msg?.channel === "APP" && fromApp(sender)
      ? onApp
      : msg?.channel === "LHIMS" && fromLhims(sender)
        ? onLhims
        : null;
  if (!handler) return false;
  locked(() => handler(msg, sender)).then(sendResponse, (e) =>
    sendResponse({ ok: false, error: String(e?.message || e) }),
  );
  return true;
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== "wd") return;
  locked(async () => {
    const job = await read("job");
    if (!job || TERMINAL.has(job.stage)) return;
    await transition(
      job.jobId,
      job.stage === "SAVE_CLICKED" ? "UNVERIFIED" : "NEEDS_ATTENTION",
      { reason: "TIMEOUT" },
    );
  });
});

chrome.tabs.onRemoved.addListener((tabId) =>
  locked(async () => {
    await store.set({
      tabs: (await read("tabs", [])).filter((t) => t !== tabId),
    });
    const job = await read("job");
    if (job && job.claimedTabId === tabId && !TERMINAL.has(job.stage))
      await transition(
        job.jobId,
        job.stage === "SAVE_CLICKED" ? "UNVERIFIED" : "NEEDS_ATTENTION",
        { reason: "TAB_CLOSED" },
      );
  }),
);
