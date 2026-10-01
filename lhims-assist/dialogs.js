(() => {
  if (window.__laDialogs) return;
  window.__laDialogs = true;
  const root = document.documentElement;
  const norm = (s) =>
    String(s ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const origConfirm = window.confirm.bind(window);
  const origAlert = window.alert.bind(window);
  const origPrompt = window.prompt.bind(window);
  const auto = () => root.dataset.laAuto === "1"; // set by the extension only while an auto job is active
  const note = (kind, accepted, message) =>
    document.dispatchEvent(
      new CustomEvent("la-dialog", {
        detail: JSON.stringify({
          kind,
          accepted,
          message: String(message ?? "").slice(0, 200),
        }),
      }),
    );

  window.confirm = function (message) {
    if (!auto()) return origConfirm(message);
    let allow = [];
    try {
      allow = JSON.parse(root.dataset.laAllow || "[]");
    } catch {
      /* ignore */
    }
    const ok = allow.includes(norm(message));
    note("confirm", ok, message);
    return ok; // unknown confirms are refused, never accepted
  };
  window.alert = function (message) {
    if (!auto()) return origAlert(message);
    note("alert", false, message); // an alert during auto mode is a problem report
  };
  window.prompt = function (message, def) {
    if (!auto()) return origPrompt(message, def);
    note("prompt", false, message);
    return null;
  };
})();
