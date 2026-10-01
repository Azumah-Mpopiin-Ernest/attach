importScripts("config.js");
const C = LA_CONFIG,
  A = C.AUTO;

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
const HARD_STOP = new Set(A.HARD_STOPS);
const BENIGN = new Set(A.BENIGN);
const NO_BREAKER = new Set([
  "NO_MATCH",
  "MULTIPLE_MATCHES",
  "TAB_CLOSED",
  "NO_USABLE_ROW",
  "ALREADY_ATTACHED",
]);
const PATCH_KEYS = [
  "reason",
  "scheduleId",
  "searchClicked",
  "baseline",
  "warn",
  "fieldsOk",
];
const DEFAULT_BREAKER = { fails: 0, tripped: false };
const DATE_RE = /^\d{2}-\d{2}-\d{4}$/;
const ACTIVE = (r) =>
  !!r && (r.status === "RUNNING" || r.status === "STOPPING");

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

const listUrl = (run, date) =>
  new URL(
    `${C.PAGES.list}?${C.LIST_URL_QUERY.replace("{DATE}", encodeURIComponent(date))}`,
    run.base,
  ).href;

const shapeOf = (fileName) =>
  fileName
    .replace(/\.[^.]+$/, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0] + "•".repeat(Math.max(0, w.length - 1)))
    .join(" ");

// ---------- state shown to the app and the badges ----------
const publicRun = (r) =>
  r
    ? {
        status: r.status,
        date: r.date,
        done: r.done,
        skipped: r.skipped,
        stopReason: r.stopReason || null,
      }
    : null;
const poolStats = (p) => {
  const v = Object.values(p || {});
  return { total: v.length, ready: v.filter((x) => x.ready).length };
};
const publicState = (job, breaker, run, pool) => ({
  ...(job
    ? {
        referralId: job.referralId,
        stage: job.stage,
        reason: job.reason || null,
        warn: job.warn || null,
        verified: job.stage === "VERIFIED",
        patientId: job.patientId,
        shape: job.shape,
        claimedTabId: job.claimedTabId ?? null,
        auto: !!job.auto,
      }
    : { stage: "IDLE" }),
  breaker,
  run: publicRun(run),
  pool: poolStats(pool),
});
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
  auto: !!j.auto,
  date: j.date ?? null,
});
const snapshot = async (job) =>
  publicState(
    job,
    await read("breaker", DEFAULT_BREAKER),
    await read("run"),
    await read("pool", {}),
  );

async function broadcast(job) {
  const state = await snapshot(job);
  const appTab = await read("appTab");
  if (appTab != null)
    chrome.tabs
      .sendMessage(appTab, { channel: "TO_APP", type: "STATE", state })
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

// ---------- per-job watchdog ----------
async function arm(job) {
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
  if (job.auto) return; // auto runs use the consecutive-problem limit (afterTerminal) instead of the breaker
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
  if (TERMINAL.has(job.stage) && !force) return null;
  const clean = cleanPatch(patch);
  const next = { ...job, ...clean, stage, updatedAt: Date.now() };
  if (!("reason" in clean)) next.reason = null;
  await store.set({ job: next });
  if (TERMINAL.has(stage)) {
    await onTerminal(next);
    await afterTerminal(next);
  } else await arm(next);
  await broadcast(next);
  return next;
}

async function clearJob() {
  await store.remove(["job", "blob"]);
  await chrome.alarms.clear("wd");
  await broadcast(null);
}

// ---------- auto-run: tab pool ----------
async function poolFill() {
  const run = await read("run");
  if (run?.status !== "RUNNING") return;
  const job = await read("job");
  const inUse = job && !TERMINAL.has(job.stage) ? job.claimedTabId : null;
  const old = await read("pool", {});
  const pool = {};
  for (const [id, p] of Object.entries(old)) {
    try {
      await chrome.tabs.get(Number(id));
    } catch {
      continue;
    } // tab is gone
    if (Number(id) !== inUse && p.date !== run.date) {
      pool[id] = { date: run.date, ready: false };
      chrome.tabs
        .update(Number(id), { url: listUrl(run, run.date) })
        .catch(() => {});
    } else pool[id] = p;
  }
  while (Object.keys(pool).length < A.POOL_SIZE) {
    const url = listUrl(run, run.date);
    let t;
    try {
      t = await chrome.tabs.create({
        url,
        active: false,
        windowId: run.windowId,
      });
    } catch {
      try {
        t = await chrome.tabs.create({ url, active: false });
      } catch {
        break;
      }
    }
    chrome.tabs.update(t.id, { autoDiscardable: false }).catch(() => {}); // keep Memory Saver away from warm tabs
    pool[t.id] = { date: run.date, ready: false };
  }
  await store.set({ pool });
}

async function assign() {
  // hand a waiting auto job to a ready tab
  const job = await read("job"),
    run = await read("run"),
    pool = await read("pool", {});
  if (
    run?.status !== "RUNNING" ||
    !job ||
    !job.auto ||
    job.stage !== "JOB_RECEIVED" ||
    job.claimedTabId != null
  )
    return;
  const entry = Object.entries(pool).find(
    ([, p]) => p.ready && !p.busy && p.date === job.date,
  );
  if (!entry) return;
  const tabId = Number(entry[0]);
  pool[tabId] = { ...entry[1], ready: false, busy: true };
  await store.set({ pool, job: { ...job, claimedTabId: tabId } });
  await transition(job.jobId, "TAB_CLAIMED");
  if (A.ACTIVATE_TAB)
    chrome.tabs.update(tabId, { active: true }).catch(() => {});
  chrome.tabs
    .sendMessage(tabId, { channel: "TO_LHIMS", type: "AUTO_GO" })
    .catch(() => {});
}

async function recycle(tabId, run) {
  // used tab goes back to the list URL and becomes a warm tab again
  if (tabId == null) return;
  const pool = await read("pool", {});
  if (!pool[tabId]) return;
  pool[tabId] = { date: run.date, ready: false };
  await store.set({ pool });
  chrome.tabs.update(tabId, { url: listUrl(run, run.date) }).catch(() => {});
}

// A referral that ends without VERIFIED is skipped by the app (with the reason); the run carries on.
// Only HARD_STOPS, or too many real problems in a row, stop the run.
async function afterTerminal(job) {
  const run = await read("run");
  if (!job.auto || !ACTIVE(run)) return;
  if (HARD_STOP.has(job.stage)) return finishRun(job.reason || job.stage, true); // referral stays in the queue
  const verified = job.stage === "VERIFIED";
  const benign = BENIGN.has(job.reason);
  const next = {
    ...run,
    done: run.done + (verified ? 1 : 0),
    skipped: run.skipped + (verified ? 0 : 1),
    problems: verified
      ? 0
      : benign
        ? run.problems || 0
        : (run.problems || 0) + 1,
  };
  await store.set({ run: next });
  if (next.problems >= A.MAX_CONSECUTIVE_PROBLEMS)
    return finishRun("TOO_MANY_PROBLEMS", true);
  if (run.status === "STOPPING")
    return finishRun(run.stopReason || "OFFICER_STOP", false);
  await recycle(job.claimedTabId, next);
}

async function finishRun(reason, keepPool) {
  const run = await read("run");
  if (!run) return;
  await chrome.alarms.clear("runwd");
  let pool = await read("pool", {});
  if (!keepPool && A.CLOSE_POOL_ON_STOP) {
    for (const id of Object.keys(pool))
      chrome.tabs.remove(Number(id)).catch(() => {});
    pool = {};
  }
  await store.set({
    pool,
    run: { ...run, status: "STOPPED", stopReason: reason },
  });
  await broadcast(await read("job"));
}

async function stopRun(reason, keepPool = false) {
  const run = await read("run");
  if (!ACTIVE(run)) return;
  const job = await read("job");
  if (job?.auto && job.stage === "SAVE_CLICKED") {
    // past the point of no return: finish verifying this one
    await store.set({
      run: { ...run, status: "STOPPING", stopReason: reason },
    });
    return broadcast(job);
  }
  if (job?.auto && !TERMINAL.has(job.stage)) await clearJob(); // cancel before Save: nothing is written
  return finishRun(reason, keepPool);
}

// ---------- jobs from the app ----------
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

function validate(p, auto) {
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
  if (auto && !DATE_RE.test(p.date || "")) return "BAD_DATE";
  return null;
}

async function submit(p, job, breaker) {
  if (breaker.tripped) return { ok: false, error: "BREAKER_TRIPPED" };
  const run = await read("run");
  if (run?.status === "STOPPING") return { ok: false, error: "RUN_STOPPING" };
  const auto = run?.status === "RUNNING";
  const bad = validate(p, auto);
  if (bad) return { ok: false, error: bad };
  if (
    job &&
    job.referralId === p.referralId &&
    (!TERMINAL.has(job.stage) || !p.retry)
  )
    return { ok: true, state: await snapshot(job) };
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
    auto,
    date: auto ? p.date : null,
    claimedTabId: null,
    stage: "JOB_RECEIVED",
    reason: null,
    updatedAt: Date.now(),
  };
  await store.set({
    job: next,
    blob: { b64: p.bytesB64, mimeType: p.mimeType },
  });
  await chrome.alarms.clear("wd");
  if (auto && run.date !== p.date) {
    await store.set({ run: { ...run, date: p.date } });
    await poolFill();
  }
  await broadcast(next);
  if (auto) await assign();
  return { ok: true, state: await snapshot(await read("job")) };
}

async function startRun(p, sender, job, breaker, run) {
  if (ACTIVE(run)) return { ok: false, error: "ALREADY_RUNNING" };
  if (breaker.tripped) return { ok: false, error: "BREAKER_TRIPPED" };
  const ps = await read("pendingStart");
  if (!ps || Date.now() - ps.at > 120000)
    return { ok: false, error: "NO_START_REQUEST" };
  if (!DATE_RE.test(p.date || "")) return { ok: false, error: "BAD_DATE" };
  if (job) await clearJob(); // starting is the officer's acknowledgement of any earlier problem
  await store.remove("pendingStart");
  await store.set({
    run: {
      status: "RUNNING",
      base: ps.base,
      windowId: ps.windowId,
      date: p.date,
      done: 0,
      skipped: 0,
      problems: 0,
      stopReason: null,
      startedAt: Date.now(),
    },
    pool: {},
  });
  await chrome.alarms.create("runwd", {
    delayInMinutes: 1,
    periodInMinutes: 1,
  });
  chrome.tabs.update(sender.tab.id, { autoDiscardable: false }).catch(() => {});
  await poolFill();
  await broadcast(null);
  return { ok: true };
}

async function onApp(msg, sender) {
  await store.set({ appTab: sender.tab.id });
  const job = await read("job");
  const breaker = await read("breaker", DEFAULT_BREAKER);
  const run = await read("run");
  const p = msg.payload || {};
  switch (msg.type) {
    case "PING":
      return { pong: true, version: chrome.runtime.getManifest().version };
    case "GET_STATE":
      return snapshot(job);
    case "ACK_BREAKER":
      await store.set({ breaker: { ...DEFAULT_BREAKER } });
      await broadcast(job);
      return { ok: true };
    case "CANCEL_JOB":
      if (job && job.referralId === p.referralId && !(job.auto && ACTIVE(run)))
        await clearJob();
      return { ok: true };
    case "SUBMIT_JOB":
      return submit(p, job, breaker);
    case "RUN_START":
      return startRun(p, sender, job, breaker, run);
    case "RUN_STOP":
      await stopRun(String(p.reason || "OFFICER_STOP").slice(0, 40));
      return { ok: true };
    default:
      return { ok: false, error: "UNKNOWN_TYPE" };
  }
}

// ---------- messages from LHIMS tabs ----------
async function onLhims(msg, sender) {
  const tabId = sender.tab.id;
  const job = await read("job");
  const run = await read("run");
  const owner = !!job && job.claimedTabId === tabId;
  const view = async (j) => ({
    state: await snapshot(j),
    job: j && j.claimedTabId === tabId ? ownerJob(j) : undefined,
  });

  switch (msg.type) {
    case "HELLO": {
      const tabs = new Set(await read("tabs", []));
      tabs.add(tabId);
      await store.set({ tabs: [...tabs] });
      const pool = await read("pool", {});
      const p = pool[tabId];
      if (
        p &&
        !p.busy &&
        msg.page === "LIST" &&
        msg.ready &&
        msg.date === p.date &&
        ACTIVE(run)
      ) {
        pool[tabId] = { ...p, ready: true };
        await store.set({ pool });
        await assign();
      }
      return { ok: true, tabId, ...(await view(await read("job"))) };
    }
    case "CLAIM": {
      if (ACTIVE(run)) return { ok: false, error: "RUN_ACTIVE" };
      if (!job || job.stage !== "JOB_RECEIVED" || job.claimedTabId != null)
        return { ok: false, error: "NOT_CLAIMABLE" };
      if (msg.page !== "LIST")
        return { ok: false, error: "NOT_A_PATIENT_LIST_TAB" };
      await store.set({ job: { ...job, claimedTabId: tabId } });
      const next = await transition(job.jobId, "TAB_CLAIMED");
      return next
        ? { ok: true, ...(await view(next)) }
        : { ok: false, error: "IGNORED" };
    }
    case "PROGRESS": {
      if (!owner || !REPORTABLE.has(msg.stage))
        return { ok: false, error: "REJECTED" };
      const next = await transition(job.jobId, msg.stage, msg.patch || {});
      return next
        ? { ok: true, ...(await view(next)) }
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
        ? { ok: true, ...(await view(next)) }
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
    case "RUN_REQUEST": {
      // the badge on the Filter Selection page asks the app to start
      if (ACTIVE(run)) return { ok: false, error: "ALREADY_RUNNING" };
      const appTab = await read("appTab");
      if (appTab == null) return { ok: false, error: "APP_NOT_CONNECTED" };
      await store.set({
        pendingStart: {
          base: sender.url,
          windowId: sender.tab.windowId,
          at: Date.now(),
        },
      });
      try {
        await chrome.tabs.sendMessage(appTab, {
          channel: "TO_APP",
          type: "RUN_REQUEST",
        });
      } catch {
        return { ok: false, error: "APP_NOT_CONNECTED" };
      }
      return { ok: true };
    }
    case "RUN_STOP":
      await stopRun("OFFICER_STOP");
      return { ok: true };
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
  if (a.name === "wd") {
    locked(async () => {
      const job = await read("job");
      if (!job || TERMINAL.has(job.stage)) return;
      await transition(
        job.jobId,
        job.stage === "SAVE_CLICKED" ? "UNVERIFIED" : "NEEDS_ATTENTION",
        { reason: "TIMEOUT" },
      );
    });
  } else if (a.name === "runwd") {
    locked(async () => {
      const run = await read("run");
      if (run?.status !== "RUNNING") return;
      const job = await read("job");
      const appTab = await read("appTab");
      let appAlive = appTab != null;
      if (appAlive) {
        try {
          await chrome.tabs.get(appTab);
        } catch {
          appAlive = false;
        }
      }
      if (!appAlive && job?.stage !== "SAVE_CLICKED")
        return stopRun("APP_CLOSED", true);
      if (
        job?.auto &&
        job.stage === "JOB_RECEIVED" &&
        Date.now() - job.updatedAt > A.READY_TAB_TIMEOUT_MIN * 60000
      )
        return stopRun("NO_READY_TAB", true);
      await poolFill();
      await assign();
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) =>
  locked(async () => {
    await store.set({
      tabs: (await read("tabs", [])).filter((t) => t !== tabId),
    });
    const pool = await read("pool", {});
    if (pool[tabId]) {
      delete pool[tabId];
      await store.set({ pool });
    }
    const job = await read("job");
    if (job && job.claimedTabId === tabId && !TERMINAL.has(job.stage))
      await transition(
        job.jobId,
        job.stage === "SAVE_CLICKED" ? "UNVERIFIED" : "NEEDS_ATTENTION",
        { reason: "TAB_CLOSED" },
      );
  }),
);
