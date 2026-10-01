(() => {
  const APP = "LHIMS_ASSIST_APP",
    EXT = "LHIMS_ASSIST_EXT";
  const ALLOWED = new Set([
    "PING",
    "GET_STATE",
    "SUBMIT_JOB",
    "CANCEL_JOB",
    "ACK_BREAKER",
  ]);
  if (!LA_CONFIG.APP_ORIGINS.includes(location.origin)) return; // exact-origin check (manifest ignores ports)

  const post = (m) =>
    window.postMessage({ source: EXT, ...m }, location.origin);

  window.addEventListener("message", async (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.source !== APP || !ALLOWED.has(d.type)) return;
    try {
      const data = await chrome.runtime.sendMessage({
        channel: "APP",
        type: d.type,
        payload: d.payload,
      });
      post({ type: "RESPONSE", requestId: d.requestId, ok: true, data });
    } catch (err) {
      post({
        type: "RESPONSE",
        requestId: d.requestId,
        ok: false,
        error: String(err?.message || err),
      });
    }
  });

  chrome.runtime.onMessage.addListener((m, sender) => {
    if (sender.id !== chrome.runtime.id) return;
    if (m?.channel === "TO_APP" && m.type === "STATE")
      post({ type: "STATE", state: m.state }); // stage/reason only
  });

  post({ type: "READY" });
})();
