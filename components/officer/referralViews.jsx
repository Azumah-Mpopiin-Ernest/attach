import { useEffect, useState } from "react";
import { Check, CheckCircle2, Copy, Download, SkipForward } from "lucide-react";
import { formatDateLabel, getDateKey } from "../../src/referralDates";
import { referralName, useReferralActions } from "./referralFlow";
import { useLhimsAutomation } from "../../src/lhims/useLhimsAutomation";
import { readSkipNote } from "../../src/lhims/skipNotes";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-md border font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 disabled:cursor-not-allowed";
const SIZE_CLASSES = {
  sm: "px-3 py-1.5 text-xs",
  lg: "px-4 py-2.5 text-sm",
};
const ICON_CLASSES = { sm: "h-3.5 w-3.5", lg: "h-4 w-4" };
const LOCKED_CLASSES = "border-transparent bg-slate-200 text-slate-400";
const LOCKED_TITLE =
  "Copy the ID, download the form and try the upload in LHIMS first";

function withCountdown(label, secondsLeft) {
  return secondsLeft > 0 ? `${label} (${secondsLeft}s)` : label;
}

function CopyIdButton({ done, size, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${BUTTON_BASE} ${SIZE_CLASSES[size]} ${
        done
          ? "border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
          : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
      }`}
    >
      {done ? (
        <Check className={ICON_CLASSES[size]} />
      ) : (
        <Copy className={ICON_CLASSES[size]} />
      )}
      {done ? "ID copied" : "Copy ID"}
    </button>
  );
}

function DownloadFormButton({ done, downloading, size, onClick }) {
  let label = "Download Form";
  if (downloading) label = "Preparing…";
  else if (done) label = "Download again";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={downloading}
      className={`${BUTTON_BASE} ${SIZE_CLASSES[size]} border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-60`}
    >
      <Download className={ICON_CLASSES[size]} />
      {label}
    </button>
  );
}

function MarkDoneButton({ unlocked, secondsLeft, size, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!unlocked}
      title={unlocked ? undefined : LOCKED_TITLE}
      className={`${BUTTON_BASE} ${SIZE_CLASSES[size]} ${
        unlocked
          ? "border-transparent bg-[#2F6F62] text-white hover:bg-[#265a50] focus-visible:outline-[#2F6F62]"
          : LOCKED_CLASSES
      }`}
    >
      <CheckCircle2 className={ICON_CLASSES[size]} />
      {withCountdown("Mark Done", secondsLeft)}
    </button>
  );
}

function SkipButton({ unlocked, secondsLeft, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!unlocked}
      title={unlocked ? undefined : LOCKED_TITLE}
      className={`${BUTTON_BASE} ${SIZE_CLASSES.lg} ${
        unlocked
          ? "border-yellow-500 bg-yellow-300 text-yellow-950 hover:bg-yellow-200 focus-visible:outline-yellow-600"
          : LOCKED_CLASSES
      }`}
    >
      <SkipForward className={ICON_CLASSES.lg} />
      {withCountdown("Skip / Put on Hold", secondsLeft)}
    </button>
  );
}

function DownloadedBadge() {
  return (
    <span
      role="status"
      className="inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white"
    >
      <CheckCircle2 className="h-3.5 w-3.5" />
      Downloaded
    </span>
  );
}

// Officers paste this into the attachment notes field when attaching the
// form in LHIMS. Copying it replaces the clipboard, so the patient ID
// should be pasted into LHIMS first.
const ATTACHMENT_NOTE = "Internal Referral Form";

function AttachmentNote({ onError }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copyNote = async () => {
    onError("");
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error(
          "Copying isn't available in this browser. Open the app over HTTPS and try again.",
        );
      }
      await navigator.clipboard.writeText(ATTACHMENT_NOTE);
      setCopied(true);
    } catch (copyError) {
      onError(copyError.message);
    }
  };

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed border-slate-300 px-4 py-3">
      <div>
        <p className="text-sm text-slate-500">Attachment note for LHIMS</p>
        <p className="mt-0.5 select-all text-base font-semibold text-slate-900">
          {ATTACHMENT_NOTE}
        </p>
      </div>
      <button
        type="button"
        onClick={copyNote}
        className={`${BUTTON_BASE} ${SIZE_CLASSES.sm} ${
          copied
            ? "border-emerald-300 bg-emerald-50 text-emerald-800"
            : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
        }`}
      >
        {copied ? (
          <Check className={ICON_CLASSES.sm} />
        ) : (
          <Copy className={ICON_CLASSES.sm} />
        )}
        {copied ? "Note copied" : "Copy note"}
      </button>
    </div>
  );
}

function unlockHint({ actions, ready, secondsLeft }) {
  if (!ready) {
    const steps = [];
    if (!actions.idCopied) steps.push("copy the ID");
    if (!actions.fileDownloaded) steps.push("download the form");
    return `Still to do before Mark Done or Skip: ${steps.join(" and ")}.`;
  }
  if (secondsLeft > 0) {
    return `Now try attaching the form in LHIMS. Mark Done and Skip unlock in ${secondsLeft}s.`;
  }
  return "Attached it in LHIMS? Mark Done. Couldn't attach it because of a problem with the patient's folder? Skip.";
}

// ---------------------------------------------------------------------------
// LHIMS Assist (browser extension) panel
// ---------------------------------------------------------------------------

const STAGE_TEXT = {
  IDLE: "Waiting for the extension…",
  JOB_RECEIVED:
    "Ready. In LHIMS, open the patient-list tab you want to use and press “Use this tab for the current referral”, or start the auto run from the Filter Selection page.",
  TAB_CLAIMED: "Starting in LHIMS…",
  SEARCHING: "Searching for the patient in LHIMS…",
  MATCHED: "Patient found. Opening the attachment page…",
  ON_ATTACHMENT_PAGE: "Checking the visit…",
  FILE_ATTACHED: "File attached. Filling the note…",
  NOTE_FILLED: "Note filled. Setting the type…",
  TYPE_SET: "Final check…",
  READY_FOR_SAVE: "Check the LHIMS page, then click Save there.",
  SAVE_CLICKED: "Save clicked. Confirming…",
  VERIFIED: "Verified in LHIMS. You can mark this done.",
  MISMATCH:
    "The visit that opened did not match the one chosen from the list. Nothing was saved.",
  UNVERIFIED:
    "The save couldn't be confirmed. Check the attachment in LHIMS before marking done.",
  LOGGED_OUT: "LHIMS is logged out. Log in, then retry.",
  EXTENSION_ERROR: "The extension hit an error. Continue manually.",
};

// Wording that differs while the auto run is driving this referral.
const AUTO_TEXT = {
  READY_FOR_SAVE: "Saving in LHIMS…",
  VERIFIED: "Verified in LHIMS. Marking it done…",
  JOB_RECEIVED: "Waiting for a ready LHIMS tab…",
};

const REASON_TEXT = {
  NO_MATCH:
    "No exact match for this patient in the open patient list. Skip this referral.",
  MULTIPLE_MATCHES: "More than one match for this patient. Skip this referral.",
  NO_USABLE_ROW:
    "Every matching visit is green or red. Skip this referral or handle it manually.",
  TIMEOUT: "LHIMS took too long. Finish manually, retry, or skip.",
  TAB_CLOSED: "The LHIMS tab was closed. Retry.",
  ALREADY_ATTACHED:
    "This visit already shows the referral note. Check LHIMS: if it is the right file, confirm below, otherwise skip.",
  UNEXPECTED_DIALOG:
    "LHIMS showed a message the extension did not expect. Look at the LHIMS page.",
  NO_BASELINE:
    "The save could not be made verifiable, so nothing was saved. Check this referral.",
  FORM_RENDER_FAILED:
    "The form couldn't be prepared (signatures may not be saved on this device). Use Download Form below.",
  BREAKER_TRIPPED:
    "Assist is paused after repeated problems. Acknowledge to resume.",
};

const REASON_SUFFIX_STAGES = new Set([
  "MISMATCH",
  "UNVERIFIED",
  "EXTENSION_ERROR",
]);

function lhimsText({ stage, problem, reason, runActive, auto }) {
  if (runActive && stage === "JOB_RECEIVED") return AUTO_TEXT.JOB_RECEIVED;
  if (problem?.code && REASON_TEXT[problem.code])
    return REASON_TEXT[problem.code];
  if (stage === "NEEDS_ATTENTION") return `Could not continue (${reason}).`;
  if (auto && AUTO_TEXT[stage]) return AUTO_TEXT[stage];
  const base = STAGE_TEXT[stage] ?? stage;
  return REASON_SUFFIX_STAGES.has(stage) && reason
    ? `${base} (${reason})`
    : base;
}

const PANEL_BUTTON = `${BUTTON_BASE} ${SIZE_CLASSES.sm} border-slate-300 bg-white text-slate-700 hover:bg-slate-50`;

function LhimsAssistPanel({ lhims }) {
  const {
    stage,
    problem,
    reason,
    warn,
    breakerTripped,
    manuallyConfirmed,
    auto,
    runActive,
  } = lhims;
  const bad =
    Boolean(problem) || stage === "MISMATCH" || stage === "UNVERIFIED";
  let tone = "border-sky-200 bg-sky-50 text-sky-900";
  if (stage === "VERIFIED")
    tone = "border-emerald-200 bg-emerald-50 text-emerald-900";
  else if (bad) tone = "border-rose-200 bg-rose-50 text-rose-900";

  const canRetry =
    ["NEEDS_ATTENTION", "LOGGED_OUT", "EXTENSION_ERROR"].includes(stage) &&
    !breakerTripped &&
    !auto &&
    !runActive;
  const canConfirm =
    (stage === "UNVERIFIED" || reason === "ALREADY_ATTACHED") &&
    !manuallyConfirmed;

  return (
    <div
      role="status"
      className={`mt-5 rounded-md border px-4 py-3 text-sm ${tone}`}
    >
      <p className="font-medium">LHIMS Assist</p>
      <p className="mt-0.5">{lhimsText(lhims)}</p>
      {warn && <p className="mt-1 text-xs">Note: {warn}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {breakerTripped && (
          <button
            type="button"
            onClick={lhims.ackBreaker}
            className={PANEL_BUTTON}
          >
            Acknowledge and resume
          </button>
        )}
        {canRetry && (
          <button
            type="button"
            onClick={lhims.startJob}
            className={PANEL_BUTTON}
          >
            Retry
          </button>
        )}
        {canConfirm && (
          <button
            type="button"
            onClick={() =>
              window.confirm(
                "Have you confirmed in LHIMS that the file is attached to the right patient?",
              ) && lhims.confirmManually()
            }
            className={PANEL_BUTTON}
          >
            I checked LHIMS
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The single referral the officer is working on. Mount with
 * `key={referral.id}` so the safeguards are per patient.
 */
export function ActiveReferralCard({
  referral,
  formsFolder,
  onRequestDone,
  onRequestSkip,
  onError,
}) {
  const flow = useReferralActions(referral, onError, formsFolder);
  const lhims = useLhimsAutomation(referral);
  const { actions, downloading, unlocked, secondsLeft, copyId, download } =
    flow;

  const viaExtension = lhims.extensionPresent;
  // While the auto run is active the run itself marks done / skips, so the
  // manual buttons stay off. Otherwise: with the extension, Mark Done needs
  // VERIFIED (or the officer's manual confirmation); without it, the
  // existing copy + download + countdown guard applies.
  const canMarkDone = viaExtension
    ? !lhims.runActive && (lhims.verified || lhims.manuallyConfirmed)
    : unlocked;
  // Skip keeps the countdown guard, and is also allowed on NEEDS_ATTENTION.
  const canSkip =
    !lhims.runActive && (unlocked || lhims.stage === "NEEDS_ATTENTION");

  let hint = unlockHint(flow);
  if (viaExtension) {
    if (lhims.runActive)
      hint =
        "Auto attach is running. Press Stop in the bar above to take over manually.";
    else if (lhims.verified) hint = "Verified in LHIMS. Mark Done.";
    else
      hint =
        "Mark Done unlocks once LHIMS Assist verifies the attachment. Can't attach it? Skip.";
  }

  return (
    <article
      aria-label={`Referral for ${referralName(referral)}`}
      className="rounded-lg border border-slate-200 bg-white shadow-sm"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-6 py-3">
        <p className="text-sm text-slate-500">
          Referral date{" "}
          <span className="font-semibold text-slate-800">
            {formatDateLabel(getDateKey(referral))}
          </span>
        </p>
        {actions.fileDownloaded && <DownloadedBadge />}
      </header>

      <div className="px-6 py-6">
        <h2 className="break-words text-2xl font-semibold leading-tight text-slate-900">
          {referralName(referral, "Unnamed patient")}
        </h2>

        <dl className="mt-5 grid gap-3 sm:grid-cols-2">
          <div className="rounded-md bg-slate-50 px-4 py-3">
            <dt className="text-sm text-slate-500">LHIMS patient ID</dt>
            <dd className="mt-1 break-all font-mono text-xl font-semibold text-slate-900">
              {referral.patientId ?? "—"}
            </dd>
          </div>
          <div className="rounded-md bg-slate-50 px-4 py-3">
            <dt className="text-sm text-slate-500">NHIS number</dt>
            <dd className="mt-1 break-all font-mono text-xl font-semibold text-slate-900">
              {referral.nhis ?? "—"}
            </dd>
          </div>
        </dl>

        {viaExtension && <LhimsAssistPanel lhims={lhims} />}

        {!viaExtension && <AttachmentNote onError={onError} />}

        <div className="mt-6">
          {viaExtension && (
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
              Manual fallback
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            <CopyIdButton size="lg" done={actions.idCopied} onClick={copyId} />
            <DownloadFormButton
              size="lg"
              done={actions.fileDownloaded}
              downloading={downloading}
              onClick={download}
            />
          </div>
        </div>

        {(!viaExtension || actions.fileDownloaded) && (
          <p className="mt-3 text-sm text-slate-500">
            {formsFolder.hasFolder
              ? `After Download Form, the form is in your "${formsFolder.folderName}" folder. In LHIMS, click Attach and pick the only file there, or drag it in from that folder.`
              : "After Download Form, drag the file from your browser's downloads list straight into LHIMS."}
          </p>
        )}

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-5">
          <SkipButton
            unlocked={canSkip}
            secondsLeft={canSkip ? 0 : secondsLeft}
            onClick={() => onRequestSkip(referral)}
          />
          <MarkDoneButton
            size="lg"
            unlocked={canMarkDone}
            secondsLeft={viaExtension ? 0 : secondsLeft}
            onClick={() => onRequestDone(referral)}
          />
        </div>

        <p className="mt-3 text-sm text-slate-500">{hint}</p>
      </div>
    </article>
  );
}

/**
 * One row of the Skipped tab. Same safeguards as the active card: Mark Done
 * stays locked until this referral's ID is copied, its form downloaded, and
 * the 10 second countdown has run out. When the auto run skipped the
 * referral, the reason is shown so the officer can review it.
 */
export function SkippedReferralRow({
  referral,
  formsFolder,
  onRequestDone,
  onError,
}) {
  const { actions, downloading, unlocked, secondsLeft, copyId, download } =
    useReferralActions(referral, onError, formsFolder);
  const reviewNote = readSkipNote(referral.id);

  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-slate-100 px-5 py-4 last:border-0">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="break-words font-medium text-slate-800">
            {referralName(referral, "Unnamed patient")}
          </span>
          {actions.fileDownloaded && <DownloadedBadge />}
        </div>
        <p className="mt-0.5 break-all font-mono text-xs text-slate-500">
          ID {referral.patientId ?? "—"}, NHIS {referral.nhis ?? "—"}, dated{" "}
          {formatDateLabel(getDateKey(referral))}
        </p>
        {reviewNote && (
          <p className="mt-1.5 max-w-xl rounded border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">
            <span className="font-semibold">Why it was skipped:</span>{" "}
            {reviewNote}
          </p>
        )}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <CopyIdButton size="sm" done={actions.idCopied} onClick={copyId} />
        <DownloadFormButton
          size="sm"
          done={actions.fileDownloaded}
          downloading={downloading}
          onClick={download}
        />
        <MarkDoneButton
          size="sm"
          unlocked={unlocked}
          secondsLeft={secondsLeft}
          onClick={() => onRequestDone(referral)}
        />
      </div>
    </li>
  );
}
