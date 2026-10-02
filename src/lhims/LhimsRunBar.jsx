import { Square } from "lucide-react";

const STOP_TEXT = {
  DONE: "Finished: there are no referrals left in your queue.",
  OFFICER_STOP: "Stopped.",
  NO_READY_TAB:
    "No LHIMS list tab became ready. Check that the tabs open the patient list, then start again.",
  APP_CLOSED: "The app tab was closed, so the run stopped.",
  LOGGED_OUT:
    "Stopped: LHIMS is logged out. Log in and start again. The referral it was on is still in your queue.",
  EXTENSION_ERROR:
    "Stopped: the extension hit an error. The referral it was on is still in your queue.",
  TOO_MANY_PROBLEMS:
    "Stopped: several referrals in a row had problems, so something may be wrong. Check the Skipped Referrals tab, then start again.",
  FORM_RENDER_FAILED:
    "Stopped: the form could not be prepared (signatures may not be saved on this device).",
  BAD_DATE: "Stopped: a referral has a date the extension cannot use.",
};

// Where the time goes, per finished referral (stages reported by the extension).
const STEPS = [
  ["Waiting for a tab", ["JOB_RECEIVED"]],
  ["Finding patient", ["TAB_CLAIMED", "SEARCHING"]],
  ["Opening visit", ["MATCHED"]],
  ["Filling form", ["ON_ATTACHMENT_PAGE", "FILE_ATTACHED", "NOTE_FILLED", "TYPE_SET"]],
  ["Saving", ["READY_FOR_SAVE", "SAVE_CLICKED"]],
];

function timingLine(run) {
  if (!run?.timed || !run.timing) return null;
  const secs = (stages) =>
    stages.reduce((sum, s) => sum + (run.timing[s] || 0), 0) / 1000;
  const total = Object.values(run.timing).reduce((a, b) => a + b, 0) / 1000;
  const parts = STEPS.map(([label, stages]) => `${label} ${secs(stages).toFixed(1)}s`);
  return `Average per referral ${total.toFixed(1)}s: ${parts.join(" · ")}`;
}

export default function LhimsRunBar({ lhims }) {
  const {
    present,
    run,
    pool,
    breakerTripped,
    startError,
    stopRun,
    ackBreaker,
  } = lhims;
  if (!present) return null;
  const active = run && (run.status === "RUNNING" || run.status === "STOPPING");
  const stopped = run?.status === "STOPPED";
  const calm = ["DONE", "OFFICER_STOP"].includes(run?.stopReason);

  let tone = "border-slate-200 bg-slate-50 text-slate-700";
  if (active) tone = "border-sky-200 bg-sky-50 text-sky-900";
  else if (stopped && !calm) tone = "border-rose-200 bg-rose-50 text-rose-900";

  return (
    <section
      aria-label="Auto attach"
      className={`mb-4 rounded-md border px-4 py-3 text-sm ${tone}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">Auto attach</p>
          {active ? (
            <p className="mt-0.5">
              {run.status === "STOPPING"
                ? "Stopping once the referrals being saved are confirmed… "
                : "Running. "}
              Date {run.date} · tabs ready {pool?.ready ?? 0}/{pool?.total ?? 0}{" "}
              · done {run.done} · skipped {run.skipped}
            </p>
          ) : (
            <p className="mt-0.5">
              {stopped
                ? STOP_TEXT[run.stopReason] || `Stopped (${run.stopReason}).`
                : "In LHIMS, open the Filter Selection page and press “Start auto run” on the extension badge."}
            </p>
          )}
          {stopped && run.skipped > 0 && (
            <p className="mt-0.5">
              Done {run.done} · skipped {run.skipped}. Open the Skipped
              Referrals tab to review why.
            </p>
          )}
          {timingLine(run) && (
            <p className="mt-0.5 text-xs opacity-80">{timingLine(run)}</p>
          )}
          {startError && (
            <p role="alert" className="mt-1 text-rose-700">
              {startError}
            </p>
          )}
        </div>
        <div className="flex flex-none flex-wrap gap-2">
          {breakerTripped && (
            <button
              type="button"
              onClick={ackBreaker}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Acknowledge problem
            </button>
          )}
          {active && (
            <button
              type="button"
              onClick={stopRun}
              disabled={run.status === "STOPPING"}
              className="inline-flex items-center gap-1.5 rounded-md border border-rose-300 bg-white px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-60"
            >
              <Square className="h-3.5 w-3.5" />
              Stop
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
