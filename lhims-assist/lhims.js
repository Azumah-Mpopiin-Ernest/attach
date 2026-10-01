(() => {
  "use strict";
  if (window.__laLoaded) return;
  window.__laLoaded = true;

  const C = LA_CONFIG,
    S = C.SELECTORS,
    A = C.AUTO,
    Badge = LA_Badge;
  const dbg = (...a) => C.DEBUG && console.debug("[LHIMS-Assist]", ...a);
  const TERMINAL = new Set([
    "VERIFIED",
    "NEEDS_ATTENTION",
    "MISMATCH",
    "UNVERIFIED",
    "LOGGED_OUT",
    "EXTENSION_ERROR",
  ]);
  const PRE_SAVE = [
    "MATCHED",
    "ON_ATTACHMENT_PAGE",
    "FILE_ATTACHED",
    "NOTE_FILLED",
    "TYPE_SET",
    "READY_FOR_SAVE",
  ];
  const START_ERRORS = {
    APP_NOT_CONNECTED:
      "Open the referral app in this browser first (same profile), then try again.",
    ALREADY_RUNNING: "An auto run is already active.",
  };

  let myTabId = null,
    state = { stage: "IDLE" },
    running = false,
    aborted = false,
    verifying = false,
    armedFor = null,
    activeJob = null;

  class Problem extends Error {
    constructor(stage, reason) {
      super(reason);
      this.stage = stage;
      this.reason = reason;
    }
  }

  // ---------- helpers ----------
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toUpperCase();
  const visible = (el) =>
    !!el &&
    el.getClientRects().length > 0 &&
    getComputedStyle(el).visibility !== "hidden";
  const all = (sel, root = document) => [...root.querySelectorAll(sel)];
  const vis = (sel, root) => all(sel, root).filter(visible);
  const one = (key, sel, root) => {
    const m = vis(sel, root);
    dbg("selector", key, "matched", m.length);
    if (m.length !== 1)
      throw new Problem("NEEDS_ATTENTION", `SELECTOR_${key}_${m.length}`);
    return m[0];
  };
  const guard = () => {
    if (aborted) throw new Error("ABORTED");
  };
  const fire = (el, type) =>
    el.dispatchEvent(new Event(type, { bubbles: true }));
  const setNative = (el, value) => {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    fire(el, "input");
    fire(el, "change");
  };
  const waitFor = (check) =>
    new Promise((resolve) => {
      const v = check();
      if (v) return resolve(v);
      const mo = new MutationObserver(() => {
        const r = check();
        if (r) {
          mo.disconnect();
          resolve(r);
        }
      });
      mo.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    });
  const quietFor = (root, ms) =>
    new Promise((resolve) => {
      let t = setTimeout(done, ms);
      const mo = new MutationObserver(() => {
        clearTimeout(t);
        t = setTimeout(done, ms);
      });
      mo.observe(root, { subtree: true, childList: true, attributes: true });
      function done() {
        mo.disconnect();
        resolve();
      }
    });
  const loaded = () =>
    new Promise((r) =>
      document.readyState === "complete"
        ? r()
        : addEventListener("load", r, { once: true }),
    );
  const b64ToBytes = (b64) => {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  };

  const pageKind = () => {
    const p = location.pathname;
    return p.endsWith(C.PAGES.list)
      ? "LIST"
      : p.endsWith(C.PAGES.update)
        ? "UPDATE"
        : p.endsWith(C.PAGES.view)
          ? "VIEW"
          : p.endsWith(C.PAGES.filter)
            ? "FILTER"
            : "OTHER";
  };
  const listDate = () =>
    new URL(location.href).searchParams.get("dScheduleDate");
  const isLoggedOut = () =>
    !document.querySelector(S.session.loggedIn) &&
    vis(S.login.password).length > 0;
  const listReady = () =>
    !!document.querySelector(S.list.patientSelect) &&
    !!document.querySelector(S.list.grid) &&
    !isLoggedOut();
  const saveKey = (job) => `__la_save_${job.jobId}`;
  const baseKey = (job) => `__la_base_${job.jobId}`;
  const ctx = () => ({
    page: pageKind(),
    role:
      state.claimedTabId == null
        ? state.stage === "JOB_RECEIVED"
          ? "candidate"
          : "none"
        : state.claimedTabId === myTabId
          ? "owner"
          : "other",
  });

  // ---------- dialogs (auto mode only) ----------
  const root = document.documentElement;
  const setAuto = (on) => {
    // dialogs.js (page world) reads these two attributes
    if (on) {
      root.dataset.laAllow = JSON.stringify(A.CONFIRMS);
      root.dataset.laAuto = "1";
    } else delete root.dataset.laAuto;
  };
  document.addEventListener("la-dialog", (e) => {
    let d;
    try {
      d = JSON.parse(e.detail);
    } catch {
      return;
    }
    dbg("dialog", d.kind, d.accepted ? "ACCEPTED" : "REFUSED", d.message);
    if (d.accepted || !activeJob?.auto) return;
    handleError(
      new Problem(
        state.stage === "SAVE_CLICKED" ? "UNVERIFIED" : "NEEDS_ATTENTION",
        "UNEXPECTED_DIALOG",
      ),
    );
  });

  // ---------- messaging ----------
  const sw = async (msg) => {
    try {
      return await chrome.runtime.sendMessage({ channel: "LHIMS", ...msg });
    } catch {
      throw new Problem("EXTENSION_ERROR", "SW_UNREACHABLE");
    }
  };
  async function progress(stage, patch = {}) {
    guard();
    const r = await sw({ type: "PROGRESS", stage, patch });
    if (!r?.ok) throw new Problem("EXTENSION_ERROR", r?.error || "REJECTED");
    state = r.state;
    Badge.render(state, ctx());
    return r.job;
  }

  // ---------- row colour (green / red = skip, yellow = preferred) ----------
  const parseRgb = (s) => {
    const m = (s || "").match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b, a = 1] = m[1]
      .split(/[ ,/]+/)
      .filter(Boolean)
      .map(Number);
    return { r, g, b, a };
  };
  const inRanges = (h, ranges) => ranges.some(([lo, hi]) => h >= lo && h < hi);
  function classifyColor(c) {
    if (!c) return "other";
    const r = c.r / 255,
      g = c.g / 255,
      b = c.b / 255;
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b),
      d = max - min;
    if (d < C.ROW_COLOR.minChroma) return "other";
    let h =
      max === r
        ? ((g - b) / d) % 6
        : max === g
          ? (b - r) / d + 2
          : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    if (inRanges(h, C.ROW_COLOR.red)) return "red";
    if (inRanges(h, C.ROW_COLOR.yellow)) return "yellow";
    if (inRanges(h, C.ROW_COLOR.green)) return "green";
    return "other";
  }
  function rowColor(block) {
    for (let n = block; n; n = n.parentElement) {
      const c = parseRgb(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.05) {
        const k = classifyColor(c);
        if (k !== "other") return k;
      }
      if (n.tagName === "TR") break;
    }
    return "other";
  }

  // ---------- name comparison (order and middle names tolerated) ----------
  const tokens = (s) =>
    norm(String(s).replace(/[<>:"/\\|?*.,'’-]/g, " "))
      .split(" ")
      .filter(Boolean);
  function namesAgree(a, b) {
    const X = tokens(a),
      Y = tokens(b);
    if (!X.length || !Y.length) return false;
    const [small, big] = X.length <= Y.length ? [X, Y] : [Y, X];
    if (small.length < 2 && X.length !== Y.length) return false;
    return small.every((t) => big.includes(t));
  }

  // ---------- steps 1-3: search, pick the right visit, open attachment page ----------
  async function doSearch(job) {
    await progress("SEARCHING");
    const sel = document.querySelector(S.list.patientSelect);
    if (!sel) throw new Problem("NEEDS_ATTENTION", "SELECTOR_patientSelect_0");
    const want = norm(job.patientId);
    const opts = [...sel.options].filter((o) => {
      const m = o.text.match(/\(([^()]+)\)\s*$/);
      return m && norm(m[1]) === want;
    });
    if (opts.length === 0) throw new Problem("NEEDS_ATTENTION", "NO_MATCH");
    setNative(sel, opts[0].value);
    if (sel.value !== opts[0].value)
      throw new Problem("NEEDS_ATTENTION", "SELECT_NOT_SET");
    const btn = one("searchButton", S.list.searchButton);
    await progress("SEARCHING", { searchClicked: true });
    btn.click();
    return evaluateResults(job);
  }

  async function evaluateResults(job) {
    const grid = document.querySelector(S.list.grid);
    if (!grid) throw new Problem("NEEDS_ATTENTION", "SELECTOR_grid_0");
    const want = norm(job.patientId);
    await new Promise((r) => setTimeout(r, 300));
    await quietFor(grid, C.SETTLE_MS);
    guard();

    const found = vis(S.list.patientLink, grid).filter(
      (a) => norm(a.dataset.patientNo) === want,
    );
    if (found.length === 0) throw new Problem("NEEDS_ATTENTION", "NO_MATCH");
    const rows = found
      .map((a) => {
        const block = a.closest(S.list.rowBlock);
        return { block, color: block ? rowColor(block) : "other" };
      })
      .filter((r) => r.block);
    if (rows.length === 0)
      throw new Problem("NEEDS_ATTENTION", "SELECTOR_rowBlock_0");
    rows.forEach((r, i) =>
      dbg(
        "row",
        i,
        r.color,
        r.block.className,
        getComputedStyle(r.block).backgroundColor,
      ),
    );

    let pick,
      how = "";
    if (rows.length === 1) pick = rows[0];
    else {
      const open = rows.filter((r) => r.color !== "red" && r.color !== "green");
      pick = open.find((r) => r.color === "yellow") || open[0];
      if (!pick) throw new Problem("NEEDS_ATTENTION", "NO_USABLE_ROW");
      how = `${rows.length} visits found; used the ${pick.color === "yellow" ? "yellow" : "first"} one`;
    }

    const icon = one("updateIcon", S.list.updateIcon, pick.block);
    const sid = (icon.getAttribute("onclick") || "").match(
      /fUpdateSchedule\(\s*(\d+)/,
    )?.[1];
    if (!sid) throw new Problem("NEEDS_ATTENTION", "SCHEDULE_ID_UNREADABLE");
    await progress("MATCHED", {
      scheduleId: sid,
      ...(how ? { warn: how } : {}),
    });
    icon.click(); // same-tab navigation; in auto mode the update confirmation is accepted by dialogs.js
  }

  // ---------- steps 4-9: attachment page ----------
  const readback = () => {
    const f = vis(S.update.fileInput)[0],
      n = vis(S.update.note)[0],
      t = vis(S.update.type)[0];
    const ok =
      !!f &&
      !!n &&
      !!t &&
      f.files.length === 1 &&
      n.value === C.NOTE_TEXT &&
      t.selectedOptions[0]?.text.trim() === C.ATTACHMENT_TYPE_TEXT;
    return { ok, f, n, t };
  };
  const hrefsIn = (doc) =>
    [...doc.querySelectorAll(S.verify.downloadLink)].map(
      (a) => a.getAttribute("href") || "",
    );

  async function captureBaseline(job) {
    try {
      const u = new URL(C.PAGES.view, location.href);
      u.searchParams.set("iScheduleID", String(job.scheduleId));
      const res = await fetch(u.href, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!res.ok) return null;
      const doc = new DOMParser().parseFromString(
        await res.text(),
        "text/html",
      );
      if (!doc.querySelector(S.session.loggedIn)) return null;
      const hrefs = hrefsIn(doc);
      try {
        sessionStorage.setItem(baseKey(job), JSON.stringify(hrefs));
      } catch {
        /* ignore */
      }
      dbg("baseline links", hrefs.length);
      return hrefs.length;
    } catch {
      return null;
    }
  }

  async function doAttach(job) {
    try {
      sessionStorage.removeItem(saveKey(job));
    } catch {
      /* ignore */
    }
    await loaded();
    if (
      new URL(location.href).searchParams.get("iScheduleID") !==
      String(job.scheduleId)
    )
      throw new Problem("MISMATCH", "SCHEDULE_ID_MISMATCH");
    const hid = document.querySelector(S.update.scheduleIdHidden);
    if (hid && hid.value !== String(job.scheduleId))
      throw new Problem("MISMATCH", "SCHEDULE_ID_MISMATCH_FORM");

    let warn = null;
    const nameMode = job.auto ? "strict" : C.NAME_CHECK;
    if (nameMode !== "off") {
      const named = all(S.update.patientName).filter((e) =>
        e.textContent.trim(),
      );
      const el = named.find(visible) || named[0]; // the name is in the DOM even when its tab is not shown
      dbg("name element", named.length, !!el && visible(el));
      const wantName = job.expectedFileName.replace(/\.[^.]+$/, "");
      if (!el) {
        if (nameMode === "strict")
          throw new Problem("NEEDS_ATTENTION", "NAME_NOT_VERIFIABLE");
        warn = "name not verifiable";
      } else if (!namesAgree(el.textContent, wantName)) {
        if (nameMode === "strict")
          throw new Problem("MISMATCH", "NAME_MISMATCH");
        warn = "name differs from referral";
      }
    }
    await progress("ON_ATTACHMENT_PAGE", warn ? { warn } : {});

    await waitFor(
      () =>
        vis(S.update.fileInput).length &&
        vis(S.update.note).length &&
        vis(S.update.type).length,
    );
    guard();
    // The update page lists the visit's saved attachments: an existing "Internal Referral Form" means this may already be done.
    if (
      job.auto &&
      A.STOP_IF_NOTE_PRESENT &&
      norm(document.body.innerText).includes(norm(C.NOTE_TEXT))
    )
      throw new Problem("NEEDS_ATTENTION", "ALREADY_ATTACHED");
    const f = one("fileInput", S.update.fileInput),
      n = one("note", S.update.note),
      t = one("type", S.update.type);
    if (f.files.length)
      throw new Problem("NEEDS_ATTENTION", "FILE_INPUT_NOT_EMPTY");

    const blob = await sw({ type: "GET_BLOB" });
    if (!blob?.ok)
      throw new Problem("EXTENSION_ERROR", blob?.error || "NO_BLOB");
    const bytes = b64ToBytes(blob.b64);
    if (bytes.length !== blob.size)
      throw new Problem("EXTENSION_ERROR", "SIZE_MISMATCH");
    const dt = new DataTransfer();
    dt.items.add(
      new File([bytes], job.expectedFileName, {
        type: blob.mimeType,
        lastModified: Date.now(),
      }),
    );
    f.files = dt.files;
    fire(f, "input");
    fire(f, "change");
    if (
      f.files.length !== 1 ||
      f.files[0].name !== job.expectedFileName ||
      f.files[0].size !== blob.size
    )
      throw new Problem("NEEDS_ATTENTION", "FILE_NOT_ATTACHED");
    await progress("FILE_ATTACHED");

    setNative(n, C.NOTE_TEXT);
    if (n.value !== C.NOTE_TEXT)
      throw new Problem("NEEDS_ATTENTION", "NOTE_NOT_SET");
    await progress("NOTE_FILLED");

    const opt = [...t.options].filter(
      (o) => o.text.trim() === C.ATTACHMENT_TYPE_TEXT,
    );
    if (opt.length !== 1)
      throw new Problem("NEEDS_ATTENTION", `TYPE_OPTION_${opt.length}`);
    setNative(t, opt[0].value);
    if (t.selectedOptions[0]?.text.trim() !== C.ATTACHMENT_TYPE_TEXT)
      throw new Problem("NEEDS_ATTENTION", "TYPE_NOT_SET");
    await progress("TYPE_SET");

    if (!readback().ok)
      throw new Problem("NEEDS_ATTENTION", "FINAL_READBACK_FAILED");
    const baseline = await captureBaseline(job);
    guard();
    if (job.auto && baseline == null)
      throw new Problem("NEEDS_ATTENTION", "NO_BASELINE"); // never save what cannot be verified
    await progress("READY_FOR_SAVE", {
      baseline,
      ...(baseline == null ? { warn: "Save cannot be auto-verified" } : {}),
    });
    if (job.auto) return autoSave(job);
    armSave(job); // manual mode: STOP. The officer clicks Save.
  }

  // ---------- step 10: Save (auto or by the officer), then verification on the redirected view page ----------
  async function autoSave(job) {
    if (!readback().ok)
      throw new Problem("NEEDS_ATTENTION", "FINAL_READBACK_FAILED");
    const btn = one("saveButton", S.update.saveButton);
    try {
      sessionStorage.setItem(saveKey(job), String(Date.now()));
    } catch {
      /* ignore */
    }
    const r = await sw({ type: "SAVE_CLICKED", fieldsOk: true }); // persisted first: a reload after the click is still understood
    if (!r?.ok) throw new Error("ABORTED"); // job cancelled or stopped before Save: do not click
    state = r.state;
    Badge.render(state, ctx());
    guard();
    dbg("auto save: clicking Save");
    btn.click(); // the "Do You Really Want To Save ?" confirmation is accepted by dialogs.js
  }

  async function fetchSize(href) {
    try {
      const res = await fetch(href, {
        credentials: "same-origin",
        cache: "no-store",
      });
      return res.ok ? (await res.arrayBuffer()).byteLength : null;
    } catch {
      return null;
    }
  }

  function armSave(job) {
    if (armedFor === job.jobId) return;
    armedFor = job.jobId;
    document.addEventListener(
      "click",
      (e) => {
        const b =
          e.target instanceof Element && e.target.closest(S.update.saveButton);
        if (
          !b ||
          !["READY_FOR_SAVE", "SAVE_CLICKED", "UNVERIFIED"].includes(
            state.stage,
          )
        )
          return;
        try {
          sessionStorage.setItem(saveKey(job), String(Date.now()));
        } catch {
          /* ignore */
        }
        const fieldsOk = readback().ok;
        sw({ type: "SAVE_CLICKED", fieldsOk })
          .then((r) => {
            if (r?.ok) {
              state = r.state;
              aborted = false;
              Badge.render(state, ctx());
            }
          })
          .catch(() => {});
      },
      true,
    );
  }

  async function verifyAfterSave(job) {
    if (verifying) return;
    verifying = true;
    try {
      await loaded();
      if (job.fieldsOk === false)
        throw new Problem("UNVERIFIED", "FIELDS_CHANGED");
      if (
        new URL(location.href).searchParams.get("iScheduleID") !==
        String(job.scheduleId)
      )
        throw new Problem("UNVERIFIED", "WRONG_SCHEDULE_AFTER_SAVE");
      if (job.baseline == null) throw new Problem("UNVERIFIED", "NO_BASELINE");

      const links = all(S.verify.downloadLink);
      const delta = links.length - job.baseline;
      dbg("links before/after/delta", job.baseline, links.length, delta);
      if (delta <= 0) throw new Problem("UNVERIFIED", "NO_NEW_ATTACHMENT");
      if (C.LINKS_PER_ATTACHMENT && delta !== C.LINKS_PER_ATTACHMENT)
        throw new Problem("UNVERIFIED", "UNEXPECTED_COUNT");

      let known = [];
      try {
        known = JSON.parse(sessionStorage.getItem(baseKey(job)) || "[]");
      } catch {
        /* ignore */
      }
      const fresh = links.filter(
        (a) => !known.includes(a.getAttribute("href") || ""),
      );
      const target = (fresh.length ? fresh : links).at(-1);
      dbg(
        "href shape",
        (target.getAttribute("href") || "").replace(/\d/g, "9"),
      );

      let warn = null;
      const mode = job.auto ? "strict" : C.VERIFY_BYTES;
      if (mode !== "off") {
        const size = await fetchSize(target.href);
        dbg("stored size", size, "sent size", job.size);
        if (size == null) {
          if (mode === "strict")
            throw new Problem("UNVERIFIED", "CONTENT_NOT_CHECKED");
          warn = "content not checked";
        } else if (size !== job.size) {
          if (mode === "strict")
            throw new Problem("UNVERIFIED", "BYTES_DIFFER");
          warn = "stored size differs from sent file";
        }
      }
      guard();
      await progress("VERIFIED", warn ? { warn } : {});
      try {
        sessionStorage.removeItem(saveKey(job));
        sessionStorage.removeItem(baseKey(job));
      } catch {
        /* ignore */
      }
    } catch (e) {
      await handleError(e);
    } finally {
      verifying = false;
    }
  }

  // ---------- routing ----------
  async function route(job) {
    if (isLoggedOut()) throw new Problem("LOGGED_OUT", "LOGIN_PAGE");
    const st = job.stage,
      page = pageKind();
    if (page === "LIST") {
      if (st === "TAB_CLAIMED" || (st === "SEARCHING" && !job.searchClicked))
        return doSearch(job);
      if (st === "SEARCHING") return evaluateResults(job);
      if (st === "SAVE_CLICKED")
        throw new Problem("UNVERIFIED", "NAVIGATED_AWAY_AFTER_SAVE");
      throw new Problem("NEEDS_ATTENTION", "UNEXPECTED_PAGE");
    }
    if (page === "UPDATE") {
      if (st === "SAVE_CLICKED") {
        if (!job.auto) armSave(job);
        return;
      } // still on the form: wait (the watchdog times it out)
      if (PRE_SAVE.includes(st)) return doAttach(job); // a reload resets the form, so redo from scratch
      throw new Problem("NEEDS_ATTENTION", "UNEXPECTED_PAGE");
    }
    if (page === "VIEW") {
      if (st === "SAVE_CLICKED") return verifyAfterSave(job);
      if (st === "READY_FOR_SAVE" && sessionStorage.getItem(saveKey(job))) {
        const r = await sw({ type: "SAVE_CLICKED", fieldsOk: null });
        if (r?.ok) {
          state = r.state;
          return verifyAfterSave(r.job);
        }
      }
      throw new Problem("NEEDS_ATTENTION", "UNEXPECTED_PAGE");
    }
    throw new Problem("NEEDS_ATTENTION", "LEFT_FLOW");
  }

  async function handleError(e) {
    if (e?.message === "ABORTED") return;
    const p =
      e instanceof Problem ? e : new Problem("EXTENSION_ERROR", "UNEXPECTED");
    dbg("problem", p.stage, p.reason, e);
    try {
      await sw({
        type: "PROGRESS",
        stage: p.stage,
        patch: { reason: p.reason },
      });
    } catch {
      /* SW gone */
    }
    state = { ...state, stage: p.stage, reason: p.reason };
    Badge.render(state, ctx());
  }

  async function resume(job) {
    if (running) return;
    running = true;
    activeJob = job;
    if (job.auto) setAuto(true);
    try {
      await route(job);
    } catch (e) {
      await handleError(e);
    } finally {
      running = false;
    }
  }

  // ---------- boot ----------
  async function adoptJob() {
    // called after a page load or an AUTO_GO message
    const r = await sw({
      type: "HELLO",
      page: pageKind(),
      date: listDate(),
      ready: false,
    });
    if (!r?.ok) return;
    myTabId = r.tabId;
    state = r.state;
    aborted = TERMINAL.has(state.stage);
    Badge.render(state, ctx());
    if (r.job && !TERMINAL.has(state.stage)) resume(r.job);
  }

  chrome.runtime.onMessage.addListener((m, sender) => {
    if (sender.id !== chrome.runtime.id || m?.channel !== "TO_LHIMS") return;
    if (m.type === "AUTO_GO") {
      adoptJob().catch(handleError);
      return;
    }
    if (m.type !== "STATE") return;
    state = m.state;
    aborted = TERMINAL.has(state.stage) || state.stage === "IDLE";
    const mine = state.claimedTabId != null && state.claimedTabId === myTabId;
    if (!mine || aborted) setAuto(false);
    Badge.render(state, ctx());
  });

  async function onAction(id) {
    try {
      if (id === "claim") {
        const r = await sw({ type: "CLAIM", page: pageKind() });
        if (!r?.ok)
          return Badge.flash(
            r?.error === "NOT_A_PATIENT_LIST_TAB"
              ? "Not a patient-list tab."
              : "Cannot claim: " + (r?.error || "unknown"),
          );
        state = r.state;
        aborted = false;
        Badge.render(state, ctx());
        resume(r.job);
      } else if (id === "start") {
        const r = await sw({ type: "RUN_REQUEST" });
        Badge.flash(
          r?.ok
            ? "Starting… the app is preparing the first referral."
            : START_ERRORS[r?.error] ||
                "Could not start: " + (r?.error || "unknown"),
        );
      } else if (id === "stop") {
        await sw({ type: "RUN_STOP" });
      }
    } catch {
      Badge.flash("The extension could not be reached.");
    }
  }

  (async function boot() {
    Badge.mount({ onAction });
    try {
      const kind = pageKind();
      if (kind === "LIST") await loaded();
      const r = await sw({
        type: "HELLO",
        page: kind,
        date: listDate(),
        ready: kind === "LIST" && listReady(),
      });
      if (!r?.ok) return;
      myTabId = r.tabId;
      state = r.state;
      aborted = TERMINAL.has(state.stage);
      Badge.render(state, ctx());
      if (r.job && !TERMINAL.has(state.stage)) resume(r.job);
    } catch (e) {
      handleError(e);
    }
  })();
})();
