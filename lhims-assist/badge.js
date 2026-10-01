globalThis.LA_Badge = (() => {
  const TXT = {
    JOB_RECEIVED: [
      "info",
      "Job ready",
      "Open the patient list tab you want to use, then press the button.",
    ],
    TAB_CLAIMED: ["info", "Starting", "Starting the search…"],
    SEARCHING: ["info", "Searching", "Looking for an exact patient match…"],
    MATCHED: ["info", "Match found", "Opening the attachment page…"],
    ON_ATTACHMENT_PAGE: [
      "info",
      "Checking patient",
      "Verifying this is the right visit…",
    ],
    FILE_ATTACHED: ["info", "File attached", "Filling the note…"],
    NOTE_FILLED: ["info", "Note filled", "Setting the type…"],
    TYPE_SET: ["info", "Type set", "Final check…"],
    READY_FOR_SAVE: [
      "warn",
      "Check the page",
      "Check the page, then click Save.",
    ],
    SAVE_CLICKED: ["info", "Saving", "Waiting to confirm the file saved…"],
    VERIFIED: ["ok", "Verified", "Saved. Go back to the app and mark it done."],
    MISMATCH: ["bad", "Wrong patient", "Wrong patient: stop. Do not save."],
    UNVERIFIED: [
      "bad",
      "Not verified",
      "Could not confirm the save. Check the attachment in LHIMS, then use the app.",
    ],
    LOGGED_OUT: [
      "bad",
      "Logged out",
      "Log in to LHIMS, then restart the job from the app.",
    ],
    EXTENSION_ERROR: ["bad", "Extension error", "Continue manually."],
  };
  const REASONS = {
    NO_MATCH: "No exact match: skip in the app.",
    MULTIPLE_MATCHES: "Several matches: skip in the app.",
    TIMEOUT: "Timed out. Finish manually or skip in the app.",
    TAB_CLOSED: "Tab was closed. Restart from the app.",
  };

  let host, els, handlers;

  function describe(state, ctx) {
    const s = state.stage;
    if (!s || s === "IDLE") return null;
    if (ctx.role === "other")
      return {
        tone: "info",
        title: "Busy",
        line: "Another tab is handling the current referral.",
      };
    if (s === "NEEDS_ATTENTION")
      return {
        tone: "bad",
        title: "Needs attention",
        line:
          REASONS[state.reason] ||
          `Could not continue (${state.reason}). Finish manually or skip in the app.`,
      };
    const [tone, title, line0] = TXT[s] || ["info", s, ""];
    const line =
      line0 + (s === "UNVERIFIED" && state.reason ? ` (${state.reason})` : "");
    if (s === "JOB_RECEIVED" && ctx.role === "candidate" && ctx.page !== "LIST")
      return {
        tone,
        title,
        line: "This is not a patient-list tab. Switch to one.",
      };
    return {
      tone,
      title,
      line,
      claim:
        s === "JOB_RECEIVED" && ctx.role === "candidate" && ctx.page === "LIST",
    };
  }

  function mount(h) {
    handlers = h;
    host = document.createElement("div");
    host.style.cssText =
      "all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;display:none";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        .card{font:13px/1.4 system-ui,sans-serif;width:280px;background:#fff;color:#111;border:2px solid #2563eb;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.25);overflow:hidden}
        .card[data-tone=ok]{border-color:#16a34a}.card[data-tone=bad]{border-color:#dc2626}.card[data-tone=warn]{border-color:#d97706}
        .hd{padding:6px 10px;cursor:move;font-weight:600;background:#2563eb;color:#fff;user-select:none;touch-action:none}
        .card[data-tone=ok] .hd{background:#16a34a}.card[data-tone=bad] .hd{background:#dc2626}.card[data-tone=warn] .hd{background:#d97706}
        .bd{padding:8px 10px}.pt{font-family:ui-monospace,monospace;font-size:12px;color:#444;margin-bottom:4px}
        .wn{color:#92400e;font-size:12px;margin-top:4px}
        button{margin-top:8px;width:100%;padding:7px;border:0;border-radius:6px;background:#16a34a;color:#fff;font-weight:600;cursor:pointer}
      </style>
      <div class="card"><div class="hd"></div><div class="bd"><div class="pt"></div><div class="ln"></div><div class="wn"></div><button hidden>Use this tab for the current referral</button></div></div>`;
    els = {
      card: root.querySelector(".card"),
      hd: root.querySelector(".hd"),
      pt: root.querySelector(".pt"),
      ln: root.querySelector(".ln"),
      wn: root.querySelector(".wn"),
      btn: root.querySelector("button"),
    };
    els.btn.addEventListener("click", () => handlers.onClaim());
    try {
      const pos = JSON.parse(localStorage.getItem("la_badge_pos") || "null");
      if (pos)
        Object.assign(host.style, {
          left: pos.x + "px",
          top: pos.y + "px",
          right: "auto",
          bottom: "auto",
        });
    } catch {
      /* ignore */
    }
    let off = null;
    els.hd.addEventListener("pointerdown", (e) => {
      const r = host.getBoundingClientRect();
      off = { x: e.clientX - r.left, y: e.clientY - r.top };
      els.hd.setPointerCapture(e.pointerId);
    });
    els.hd.addEventListener("pointermove", (e) => {
      if (!off) return;
      Object.assign(host.style, {
        left: Math.max(0, e.clientX - off.x) + "px",
        top: Math.max(0, e.clientY - off.y) + "px",
        right: "auto",
        bottom: "auto",
      });
    });
    els.hd.addEventListener("pointerup", () => {
      if (!off) return;
      off = null;
      const r = host.getBoundingClientRect();
      try {
        localStorage.setItem(
          "la_badge_pos",
          JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }),
        );
      } catch {
        /* ignore */
      }
    });
    document.documentElement.appendChild(host);
  }

  function render(state, ctx) {
    const d = describe(state, ctx);
    if (!d) {
      host.style.display = "none";
      return;
    }
    host.style.display = "block";
    els.card.dataset.tone = d.tone;
    els.hd.textContent = `LHIMS Assist · ${d.title}`;
    els.pt.textContent = state.patientId
      ? `${state.patientId}  ${state.shape || ""}`
      : "";
    els.ln.textContent = d.line;
    els.wn.textContent = state.warn ? `Note: ${state.warn}` : "";
    els.btn.hidden = !d.claim;
  }

  function flash(text) {
    els.ln.textContent = text;
  }
  return { mount, render, flash };
})();
