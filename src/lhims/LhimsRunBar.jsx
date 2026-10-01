import { Square } from "lucide-react";

const STOP_TEXT = {
  DONE: "Finished: there are no referrals left in your queue.",
  OFFICER_STOP: "Stopped.",
  NO_READY_TAB:
    "No LHIMS list tab became ready. Check that the tabs open the patient list, then start again.",
  APP_CLOSED: "The app tab was closed, so the run stopped.",
  MISMATCH:
    "Stopped: the wrong patient was detected. Nothing was saved for it. Acknowledge, then check this referral.",
  UNVERIFIED:
    "Stopped: the save could not be confirmed. Check this patient's attachments in LHIMS before doing anything.",
  ALREADY_ATTACHED:
    "Stopped: this visit already shows the referral note. Check LHIMS, then use Mark Done or Skip on the card.",
  LOGGED_OUT: "Stopped: LHIMS is logged out. Log in and start again.",
  UNEXPECTED_DIALOG:
    "Stopped: LHIMS showed a message the extension did not expect. Look at the LHIMS page.",
  FORM_RENDER_FAILED:
    "Stopped: the form could not be prepared (signatures may not be saved on this device).",
  NAME_MISMATCH:
    "Stopped: the patient name in LHIMS does not match the referral. Check this referral.",
};

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

  let tone = "border-slate-200 bg-slate-50 text-slate-700";
  if (active) tone = "border-sky-200 bg-sky-50 text-sky-900";
  else if (stopped && !["DONE", "OFFICER_STOP"].includes(run.stopReason))
    tone = "border-rose-200 bg-rose-50 text-rose-900";

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
                ? "Stopping after the current patient… "
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
