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
// Outcomes the app marks done instead of skipping (keep in sync with src/lhims/useLhimsRun.js).
const MARK_DONE = new Set(["ALREADY_ATTACHED", "NO_USABLE_ROW"]);
// Not the referral's fault: the app sends it again (keep in sync with src/lhims/useLhimsRun.js).
const RETRY = new Set(["WRONG_DATE"]);
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

// An auto run works on up to CONCURRENCY referrals at once, each in its own
// pool tab. Manual mode always has at most one job.
const CONCURRENCY = Math.max(1, A.CONCURRENCY ?? 1);
// Auto runs check the stored file's bytes for the first few saves of a run and
// then on a sample; every save still has its new attachment counted.
const VERIFY_BYTES_FIRST = A.VERIFY_BYTES_FIRST ?? 5;
const VERIFY_BYTES_EVERY = A.VERIFY_BYTES_EVERY ?? 10;
// Finished jobs kept so a reloading app still sees their outcome.
const KEEP_FINISHED = 30;

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

// ---------- jobs (stored as { [jobId]: job }) ----------
const blobKey = (jobId) => `blob:${jobId}`;
const WD_PREFIX = "wd:";
const readJobs = () => read("jobs", {});
const isLive = (j) => !TERMINAL.has(j.stage);
const liveAuto = (jobs) =>
  Object.values(jobs).filter((j) => j.auto && isLive(j));
// newest first; `seq` (creation order) breaks ties within the same millisecond
const newestFirst = (list) =>
  [...list].sort(
    (a, b) => b.updatedAt - a.updatedAt || (b.seq || 0) - (a.seq || 0),
  );
const manualJob = (jobs) =>
  newestFirst(Object.values(jobs).filter((j) => !j.auto))[0] || null;
const liveJobOfTab = (jobs, tabId) =>
  Object.values(jobs).find((j) => j.claimedTabId === tabId && isLive(j)) ||
  null;
// What one LHIMS tab shows: the job it is working on, else the manual job.
const jobForTab = (jobs, tabId) =>
  liveJobOfTab(jobs, tabId) || manualJob(jobs);
// What the app shows at the top level (manual cards); auto runs read `jobs`.
const jobForApp = (jobs) =>
  manualJob(jobs) || newestFirst(Object.values(jobs))[0] || null;

async function removeJobs(ids) {
  if (!ids.length) return;
  const jobs = await readJobs();
  for (const id of ids) delete jobs[id];
  await store.set({ jobs });
  await store.remove(ids.map(blobKey));
  await Promise.all(ids.map((id) => chrome.alarms.clear(WD_PREFIX + id)));
}

async function clearAllJobs() {
  await removeJobs(Object.keys(await readJobs()));
}

// Drops the oldest finished jobs beyond KEEP_FINISHED.
function pruneFinished(jobs) {
  const finished = newestFirst(Object.values(jobs).filter((j) => !isLive(j)));
  for (const j of finished.slice(KEEP_FINISHED)) delete jobs[j.jobId];
  return jobs;
}

// ---------- state shown to the app and the badges ----------
const publicRun = (r) =>
  r
    ? {
        status: r.status,
        date: r.date,
        done: r.done,
        skipped: r.skipped,
        stopReason: r.stopReason || null,
        concurrency: CONCURRENCY,
        timed: r.timed || 0,
        // average milliseconds spent in each stage per finished referral
        timing: Object.fromEntries(
          Object.entries(r.timing || {}).map(([k, v]) => [
            k,
            Math.round(v / Math.max(1, r.timed || 0)),
          ]),
        ),
      }
    : null;
const poolStats = (p) => {
  const v = Object.values(p || {});
  return {
    total: v.length,
    ready: v.filter((x) => x.ready).length,
    // a list tab showing another date than the run needs (see HELLO)
    wrongDate: v.find((x) => x.wrongDate)?.wrongDate || null,
  };
};
const publicJob = (job) => ({
  jobId: job.jobId,
  referralId: job.referralId,
  stage: job.stage,
  reason: job.reason || null,
  warn: job.warn || null,
  verified: job.stage === "VERIFIED",
  patientId: job.patientId,
  shape: job.shape,
  claimedTabId: job.claimedTabId ?? null,
  auto: !!job.auto,
});
const publicState = (job, breaker, run, pool, jobs = null) => ({
  ...(job ? publicJob(job) : { stage: "IDLE" }),
  ...(jobs ? { jobs: newestFirst(Object.values(jobs)).map(publicJob) } : {}),
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
  verifyBytes: j.verifyBytes !== false,
  date: j.date ?? null,
});
const common = async () => ({
  jobs: await readJobs(),
  breaker: await read("breaker", DEFAULT_BREAKER),
  run: await read("run"),
  pool: await read("pool", {}),
});
const appState = async () => {
  const s = await common();
  return publicState(jobForApp(s.jobs), s.breaker, s.run, s.pool, s.jobs);
};
const tabState = async (tabId) => {
  const s = await common();
  return publicState(jobForTab(s.jobs, tabId), s.breaker, s.run, s.pool);
};

async function broadcast() {
  const s = await common();
  const appTab = await read("appTab");
  if (appTab != null)
    chrome.tabs
      .sendMessage(appTab, {
        channel: "TO_APP",
        type: "STATE",
        state: publicState(
          jobForApp(s.jobs),
          s.breaker,
          s.run,
          s.pool,
          s.jobs,
        ),
      })
      .catch(() => {});
  // Fire and forget: never wait for a tab here. A tab busy loading a heavy
  // LHIMS page (or showing a dialog) would otherwise hold up every message,
  // including the other jobs' progress and the app's next SUBMIT_JOB.
  for (const id of await read("tabs", []))
    chrome.tabs
      .sendMessage(id, {
        channel: "TO_LHIMS",
        type: "STATE",
        state: publicState(jobForTab(s.jobs, id), s.breaker, s.run, s.pool),
      })
      .catch(() => dropTab(id)); // gone or navigating; it says HELLO again when loaded
}

function dropTab(id) {
  locked(async () => {
    const tabs = await read("tabs", []);
    if (tabs.includes(id)) await store.set({ tabs: tabs.filter((t) => t !== id) });
  });
}

// ---------- per-job watchdog ----------
async function arm(job) {
  const name = WD_PREFIX + job.jobId;
  if (job.stage === "JOB_RECEIVED" || job.stage === "READY_FOR_SAVE")
    return chrome.alarms.clear(name);
  return chrome.alarms.create(name, {
    delayInMinutes:
      job.stage === "SAVE_CLICKED" ? C.VERIFY_TIMEOUT_MIN : C.STAGE_TIMEOUT_MIN,
  });
}

async function onTerminal(job) {
  await store.remove(blobKey(job.jobId)); // bytes never outlive the job
  await chrome.alarms.clear(WD_PREFIX + job.jobId);
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
  const jobs = await readJobs();
  const job = jobs[jobId];
  if (!job) return null;
  if (TERMINAL.has(job.stage) && !force) return null;
  const clean = cleanPatch(patch);
  const next = { ...job, ...clean, stage, updatedAt: Date.now() };
  if (!("reason" in clean)) next.reason = null;
  // a problem's diagnostic must not inherit an earlier stage's note (e.g. "2 visits found")
  if (TERMINAL.has(stage) && stage !== "VERIFIED" && !("warn" in clean))
    next.warn = null;
  jobs[jobId] = next;
  await store.set({ jobs });
  if (job.auto) await recordTiming(job, next);
  if (TERMINAL.has(stage)) {
    await onTerminal(next);
    await afterTerminal(next);
  } else await arm(next);
  await broadcast();
  return next;
}

// Time spent in the stage just left, summed per run (shown as averages in the app).
async function recordTiming(prev, next) {
  const run = await read("run");
  if (!ACTIVE(run)) return;
  const timing = { ...(run.timing || {}) };
  timing[prev.stage] = (timing[prev.stage] || 0) + (next.updatedAt - prev.updatedAt);
  await store.set({
    run: {
      ...run,
      timing,
      timed: (run.timed || 0) + (TERMINAL.has(next.stage) ? 1 : 0),
    },
  });
}

// ---------- Filter & Lock ----------
// LHIMS shows the session's locked date on every list tab, whatever the
// address says. Before list tabs are (re)opened for a date, one LHIMS tab is
// asked to lock that date (lhims.js lockDate). The run's start tab (Filter
// Selection) is asked first, since it can also click Filter & Lock itself.
function withTimeout(p, ms) {
  let timer;
  return Promise.race([
    p,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("TIMEOUT")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function lockDate(date) {
  const run = await read("run");
  const ids = [
    run?.filterTabId,
    ...(await read("tabs", [])),
    ...Object.keys(await read("pool", {})).map(Number),
  ].filter((id, i, a) => id != null && a.indexOf(id) === i);
  if (run) await store.set({ run: { ...run, lockTriedAt: Date.now() } });
  for (const id of ids) {
    try {
      await store.set({ locking: { tabId: id, until: Date.now() + 15000 } });
      const r = await withTimeout(
        chrome.tabs.sendMessage(id, { channel: "TO_LHIMS", type: "LOCK_DATE", date }),
        10000,
      );
      if (r?.ok) {
        const cur = await read("run");
        if (cur) await store.set({ run: { ...cur, lockedDate: date } });
        return true;
      }
    } catch {
      /* tab gone, loading or not an LHIMS page: try the next one */
    } finally {
      await store.remove("locking");
    }
  }
  return false;
}

// Filter & Lock clicked on the page opens a list tab of its own: close it.
chrome.tabs.onCreated.addListener((tab) =>
  locked(async () => {
    const l = await read("locking");
    if (l && tab.openerTabId === l.tabId && Date.now() < l.until)
      chrome.tabs.remove(tab.id).catch(() => {});
  }),
);

// ---------- auto-run: tab pool ----------
async function poolFill() {
  const run = await read("run");
  if (run?.status !== "RUNNING") return;
  const inUse = new Set(
    liveAuto(await readJobs())
      .map((j) => j.claimedTabId)
      .filter((id) => id != null),
  );
  const old = await read("pool", {});
  const pool = {};
  for (const [id, p] of Object.entries(old)) {
    try {
      await chrome.tabs.get(Number(id));
    } catch {
      continue;
    } // tab is gone
    // reload tabs opened for another date, and tabs whose page showed the
    // wrong date (once LHIMS is switched, a reload picks up the right one)
    if (!inUse.has(Number(id)) && (p.date !== run.date || p.wrongDate)) {
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
  // hand each waiting auto job to its own ready tab
  const run = await read("run");
  if (run?.status !== "RUNNING") return;
  const jobs = await readJobs();
  const pool = await read("pool", {});
  const waiting = Object.values(jobs)
    .filter(
      (j) => j.auto && j.stage === "JOB_RECEIVED" && j.claimedTabId == null,
    )
    .sort((a, b) => a.updatedAt - b.updatedAt);
  const claimed = [];
  for (const job of waiting) {
    const entry = Object.entries(pool).find(
      ([, p]) => p.ready && !p.busy && p.date === job.date,
    );
    if (!entry) continue;
    const tabId = Number(entry[0]);
    pool[tabId] = { ...entry[1], ready: false, busy: true };
    jobs[job.jobId] = { ...job, claimedTabId: tabId };
    claimed.push([job.jobId, tabId]);
  }
  if (!claimed.length) return;
  await store.set({ pool, jobs });
  for (const [jobId, tabId] of claimed) {
    await transition(jobId, "TAB_CLAIMED");
    if (A.ACTIVATE_TAB)
      chrome.tabs.update(tabId, { active: true }).catch(() => {});
    chrome.tabs
      .sendMessage(tabId, { channel: "TO_LHIMS", type: "AUTO_GO" })
      .catch(() => {});
  }
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
  if (HARD_STOP.has(job.stage)) return stopRun(job.reason || job.stage, true); // referral stays in the queue
  if (job.stage === "NEEDS_ATTENTION" && RETRY.has(job.reason)) {
    // nothing happened to this referral: no counts, the app sends it again
    if (run.status === "STOPPING") {
      if (!liveAuto(await readJobs()).length)
        await finishRun(run.stopReason || "OFFICER_STOP", !!run.keepPool);
      return;
    }
    return recycle(job.claimedTabId, run);
  }
  const done =
    job.stage === "VERIFIED" ||
    (job.stage === "NEEDS_ATTENTION" && MARK_DONE.has(job.reason));
  const benign = BENIGN.has(job.reason);
  const next = {
    ...run,
    done: run.done + (done ? 1 : 0),
    skipped: run.skipped + (done ? 0 : 1),
    problems: done
      ? 0
      : benign
        ? run.problems || 0
        : (run.problems || 0) + 1,
  };
  await store.set({ run: next });
  if (next.status === "STOPPING") {
    // finish once the last job past Save has been verified
    if (!liveAuto(await readJobs()).length)
      await finishRun(next.stopReason || "OFFICER_STOP", !!next.keepPool);
    return;
  }
  if (next.problems >= A.MAX_CONSECUTIVE_PROBLEMS)
    return stopRun("TOO_MANY_PROBLEMS", true);
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
  await broadcast();
}

async function stopRun(reason, keepPool = false) {
  const run = await read("run");
  if (!ACTIVE(run)) return;
  const live = liveAuto(await readJobs());
  // cancel everything before Save: nothing is written
  await removeJobs(
    live.filter((j) => j.stage !== "SAVE_CLICKED").map((j) => j.jobId),
  );
  if (live.some((j) => j.stage === "SAVE_CLICKED")) {
    // past the point of no return: finish verifying those first
    await store.set({
      run: {
        ...run,
        status: "STOPPING",
        stopReason: run.status === "STOPPING" ? run.stopReason : reason,
        keepPool: keepPool || !!run.keepPool,
      },
    });
    return broadcast();
  }
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

async function submit(p, breaker) {
  if (breaker.tripped) return { ok: false, error: "BREAKER_TRIPPED" };
  let run = await read("run");
  if (run?.status === "STOPPING") return { ok: false, error: "RUN_STOPPING" };
  const auto = run?.status === "RUNNING";
  const bad = validate(p, auto);
  if (bad) return { ok: false, error: bad };
  let jobs = await readJobs();
  const existing = newestFirst(
    Object.values(jobs).filter((j) => j.referralId === p.referralId),
  )[0];
  if (existing && (isLive(existing) || !p.retry))
    return { ok: true, state: await appState() };
  if (auto && liveAuto(jobs).length >= CONCURRENCY)
    return { ok: false, error: "BUSY" };
  const bytes = decode(p.bytesB64);
  if (bytes.length !== p.size) return { ok: false, error: "SIZE_MISMATCH" };
  if (p.sha256 && (await sha256Hex(bytes)) !== p.sha256)
    return { ok: false, error: "HASH_MISMATCH" };

  if (!auto) {
    // manual mode keeps a single job: a new one replaces the previous one
    await removeJobs(
      Object.values(jobs)
        .filter((j) => !j.auto)
        .map((j) => j.jobId),
    );
    jobs = await readJobs();
  }
  let verifyBytes = true;
  if (auto) {
    const n = run.submitted || 0;
    verifyBytes = n < VERIFY_BYTES_FIRST || n % VERIFY_BYTES_EVERY === 0;
    run = { ...run, submitted: n + 1 };
  }
  const seq = (await read("seq", 0)) + 1;
  await store.set({ seq });
  const next = {
    jobId: crypto.randomUUID(),
    seq,
    referralId: p.referralId,
    patientId: p.patientId.trim(),
    expectedFileName: p.expectedFileName,
    mimeType: p.mimeType,
    size: p.size,
    shape: shapeOf(p.expectedFileName),
    auto,
    verifyBytes,
    date: auto ? p.date : null,
    claimedTabId: null,
    stage: "JOB_RECEIVED",
    reason: null,
    updatedAt: Date.now(),
  };
  jobs[next.jobId] = next;
  await store.set({
    jobs: pruneFinished(jobs),
    [blobKey(next.jobId)]: { b64: p.bytesB64, mimeType: p.mimeType },
  });
  if (auto) {
    const dateChanged = run.date !== p.date;
    await store.set({ run: { ...run, date: p.date } });
    if (dateChanged) {
      await lockDate(p.date); // LHIMS must show the new date before the tabs reopen
      await poolFill();
    }
  }
  await broadcast();
  if (auto) await assign();
  return { ok: true, state: await appState() };
}

async function startRun(p, sender, breaker, run) {
  if (ACTIVE(run)) return { ok: false, error: "ALREADY_RUNNING" };
  if (breaker.tripped) return { ok: false, error: "BREAKER_TRIPPED" };
  const ps = await read("pendingStart");
  if (!ps || Date.now() - ps.at > 120000)
    return { ok: false, error: "NO_START_REQUEST" };
  if (!DATE_RE.test(p.date || "")) return { ok: false, error: "BAD_DATE" };
  await clearAllJobs(); // starting is the officer's acknowledgement of any earlier problem
  await store.remove("pendingStart");
  await store.set({
    run: {
      status: "RUNNING",
      base: ps.base,
      windowId: ps.windowId,
      filterTabId: ps.tabId ?? null,
      date: p.date,
      done: 0,
      skipped: 0,
      problems: 0,
      submitted: 0,
      timing: {},
      timed: 0,
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
  await lockDate(p.date); // the first date too: no manual Filter & Lock needed
  await poolFill();
  await broadcast();
  return { ok: true };
}

async function onApp(msg, sender) {
  await store.set({ appTab: sender.tab.id });
  const breaker = await read("breaker", DEFAULT_BREAKER);
  const run = await read("run");
  const p = msg.payload || {};
  switch (msg.type) {
    case "PING":
      return { pong: true, version: chrome.runtime.getManifest().version };
    case "GET_STATE":
      return appState();
    case "ACK_BREAKER":
      await store.set({ breaker: { ...DEFAULT_BREAKER } });
      await broadcast();
      return { ok: true };
    case "CANCEL_JOB": {
      const autoActive = ACTIVE(run);
      await removeJobs(
        Object.values(await readJobs())
          .filter(
            (j) => j.referralId === p.referralId && !(j.auto && autoActive),
          )
          .map((j) => j.jobId),
      );
      await broadcast();
      return { ok: true };
    }
    case "SUBMIT_JOB":
      return submit(p, breaker);
    case "RUN_START":
      return startRun(p, sender, breaker, run);
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
  const run = await read("run");
  const job = liveJobOfTab(await readJobs(), tabId); // the job this tab owns
  const view = async (j) => ({
    state: await tabState(tabId),
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
        // Ready only if the page really shows the run's date: LHIMS can keep
        // a date locked for the session and ignore the one in the address.
        const wrong = msg.shown && msg.shown !== p.date ? msg.shown : null;
        pool[tabId] = { ...p, ready: !wrong, wrongDate: wrong };
        await store.set({ pool });
        if (wrong) {
          // LHIMS still shows another date: lock the run's date again (at most
          // every 20 s) and reload the tabs that showed the wrong one
          const cur = await read("run");
          if (Date.now() - (cur?.lockTriedAt || 0) > 20000) {
            await lockDate(p.date);
            await poolFill();
          }
        } else await assign();
        if (!wrong && Object.values(pool).some((x) => x.wrongDate))
          await poolFill(); // the date is right now: reload tabs that showed the old one
      }
      return {
        ok: true,
        tabId,
        ...(await view(jobForTab(await readJobs(), tabId))),
      };
    }
    case "CLAIM": {
      if (ACTIVE(run)) return { ok: false, error: "RUN_ACTIVE" };
      const jobs = await readJobs();
      const m = manualJob(jobs);
      if (!m || m.stage !== "JOB_RECEIVED" || m.claimedTabId != null)
        return { ok: false, error: "NOT_CLAIMABLE" };
      if (msg.page !== "LIST")
        return { ok: false, error: "NOT_A_PATIENT_LIST_TAB" };
      jobs[m.jobId] = { ...m, claimedTabId: tabId };
      await store.set({ jobs });
      const next = await transition(m.jobId, "TAB_CLAIMED");
      return next
        ? { ok: true, ...(await view(next)) }
        : { ok: false, error: "IGNORED" };
    }
    case "PROGRESS": {
      if (!job || !REPORTABLE.has(msg.stage))
        return { ok: false, error: "REJECTED" };
      const next = await transition(job.jobId, msg.stage, msg.patch || {});
      return next
        ? { ok: true, ...(await view(next)) }
        : { ok: false, error: "IGNORED" };
    }
    case "SAVE_CLICKED": {
      // UNVERIFIED is terminal, so look past liveJobOfTab for a manual re-save
      const own =
        job ||
        newestFirst(
          Object.values(await readJobs()).filter(
            (j) => j.claimedTabId === tabId && j.stage === "UNVERIFIED",
          ),
        )[0];
      if (
        !own ||
        !["READY_FOR_SAVE", "SAVE_CLICKED", "UNVERIFIED"].includes(own.stage)
      )
        return { ok: false, error: "REJECTED" };
      const next = await transition(
        own.jobId,
        "SAVE_CLICKED",
        { fieldsOk: msg.fieldsOk ?? null },
        true,
      );
      return next
        ? { ok: true, ...(await view(next)) }
        : { ok: false, error: "IGNORED" };
    }
    case "GET_BLOB": {
      if (!job) return { ok: false, error: "REJECTED" };
      const blob = await read(blobKey(job.jobId));
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
          tabId: sender.tab.id,
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
  if (a.name.startsWith(WD_PREFIX)) {
    const jobId = a.name.slice(WD_PREFIX.length);
    locked(async () => {
      const job = (await readJobs())[jobId];
      if (!job || !isLive(job)) return;
      await transition(
        jobId,
        job.stage === "SAVE_CLICKED" ? "UNVERIFIED" : "NEEDS_ATTENTION",
        { reason: "TIMEOUT" },
      );
    });
  } else if (a.name === "runwd") {
    locked(async () => {
      const run = await read("run");
      if (run?.status !== "RUNNING") return;
      const live = liveAuto(await readJobs());
      const appTab = await read("appTab");
      let appAlive = appTab != null;
      if (appAlive) {
        try {
          await chrome.tabs.get(appTab);
        } catch {
          appAlive = false;
        }
      }
      if (!appAlive && !live.some((j) => j.stage === "SAVE_CLICKED"))
        return stopRun("APP_CLOSED", true);
      if (
        live.some(
          (j) =>
            j.stage === "JOB_RECEIVED" &&
            Date.now() - j.updatedAt > A.READY_TAB_TIMEOUT_MIN * 60000,
        )
      ) {
        const pool = await read("pool", {});
        const wrong = Object.values(pool).some((x) => x.wrongDate);
        return stopRun(wrong ? "WRONG_DATE" : "NO_READY_TAB", true);
      }
      const pool = await read("pool", {});
      if (
        Object.values(pool).some((x) => x.wrongDate) &&
        Date.now() - (run.lockTriedAt || 0) > 20000
      )
        await lockDate(run.date); // try the lock again before reloading
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
    const job = liveJobOfTab(await readJobs(), tabId);
    if (job)
      await transition(
        job.jobId,
        job.stage === "SAVE_CLICKED" ? "UNVERIFIED" : "NEEDS_ATTENTION",
        { reason: "TAB_CLOSED" },
      );
  }),
);
