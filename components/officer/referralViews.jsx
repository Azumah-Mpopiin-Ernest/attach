import { useEffect, useRef, useState } from "react";
import { Check, CheckCircle2, Copy, Download, SkipForward } from "lucide-react";
import { formatDateLabel, getDateKey } from "../../src/referralDates";
import {
  referralFormFileName,
  renderReferralFormJpegBlob,
} from "../../src/referralForm";
import { referralName, useReferralActions } from "./referralFlow";

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

// DRAG TEST. A plain dragged <img> gives LHIMS no real file, so this drags a
// file chip that declares itself a downloadable JPEG with an explicit name
// (the "DownloadURL" drag type, supported by Chrome and Edge). On Windows the
// browser turns that into a real file when the drop target asks for it.
// Nothing here unlocks Mark Done; Download Form is still required.
//
// Rendered once per referral (the latest referral is read from a ref) so a
// Firestore snapshot arriving mid-drag can't replace or revoke the file being
// dragged. Signatures are required, exactly as for the download.
function FormPreview({ referral }) {
  const referralRef = useRef(referral);
  const imageRef = useRef(null);
  const [preview, setPreview] = useState({
    url: null,
    fileName: "",
    error: "",
  });
  const [dragResult, setDragResult] = useState(null);

  useEffect(() => {
    referralRef.current = referral;
  });

  useEffect(() => {
    let active = true;
    let objectUrl = null;
    renderReferralFormJpegBlob(referralRef.current)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setPreview({
          url: objectUrl,
          fileName: referralFormFileName(referralRef.current),
          error: "",
        });
      })
      .catch((previewError) => {
        if (active) {
          setPreview({ url: null, fileName: "", error: previewError.message });
        }
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [referral.id]);

  const handleDragStart = (event) => {
    const { dataTransfer } = event;
    dataTransfer.effectAllowed = "copy";
    dataTransfer.setData(
      "DownloadURL",
      `image/jpeg:${preview.fileName}:${preview.url}`,
    );
    if (imageRef.current) dataTransfer.setDragImage(imageRef.current, 24, 24);
    setDragResult(null);
  };

  const handleDragEnd = (event) => {
    // "none" means nothing accepted the drop.
    setDragResult(
      event.dataTransfer.dropEffect === "none" ? "rejected" : "accepted",
    );
  };

  let content;
  if (preview.url) {
    content = (
      <div
        draggable
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        className="inline-flex max-w-full cursor-grab items-center gap-3 rounded-md border border-slate-300 bg-white p-2 shadow-sm active:cursor-grabbing"
      >
        <img
          ref={imageRef}
          src={preview.url}
          alt=""
          draggable={false}
          className="h-24 w-auto rounded border border-slate-200"
        />
        <span className="break-all pr-2 text-sm font-medium text-slate-700">
          {preview.fileName}
        </span>
      </div>
    );
  } else if (preview.error) {
    content = (
      <p role="alert" className="text-sm text-rose-600">
        Couldn't prepare the form: {preview.error}
      </p>
    );
  } else {
    content = (
      <div
        role="status"
        aria-label="Preparing form"
        className="h-24 w-48 animate-pulse rounded bg-slate-100"
      />
    );
  }

  return (
    <div className="mt-4 rounded-md border border-dashed border-slate-300 px-4 py-3">
      <p className="text-sm font-medium text-slate-700">
        Drag test: drag this file into LHIMS
      </p>
      <p className="mt-0.5 text-sm text-slate-500">
        Download Form is still required to unlock Mark Done.
      </p>
      <div className="mt-3">{content}</div>
      {dragResult && (
        <p className="mt-2 text-xs text-slate-500">
          {dragResult === "accepted"
            ? "The browser reports that the drop was accepted."
            : "The browser reports that nothing accepted the drop."}
        </p>
      )}
    </div>
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

/**
 * The single referral the officer is working on. Mount with
 * `key={referral.id}` so the safeguards are per patient.
 */
export function ActiveReferralCard({
  referral,
  onRequestDone,
  onRequestSkip,
  onError,
}) {
  const flow = useReferralActions(referral, onError);
  const { actions, downloading, unlocked, secondsLeft, copyId, download } =
    flow;

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

        <AttachmentNote onError={onError} />

        <div className="mt-6 flex flex-wrap gap-3">
          <CopyIdButton size="lg" done={actions.idCopied} onClick={copyId} />
          <DownloadFormButton
            size="lg"
            done={actions.fileDownloaded}
            downloading={downloading}
            onClick={download}
          />
        </div>

        <p className="mt-3 text-sm text-slate-500">
          After Download Form, drag the file from your browser's downloads list
          straight into LHIMS.
        </p>

        <FormPreview referral={referral} />

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-5">
          <SkipButton
            unlocked={unlocked}
            secondsLeft={secondsLeft}
            onClick={() => onRequestSkip(referral)}
          />
          <MarkDoneButton
            size="lg"
            unlocked={unlocked}
            secondsLeft={secondsLeft}
            onClick={() => onRequestDone(referral)}
          />
        </div>

        <p className="mt-3 text-sm text-slate-500">{unlockHint(flow)}</p>
      </div>
    </article>
  );
}

/**
 * One row of the Skipped tab. Same safeguards as the active card: Mark Done
 * stays locked until this referral's ID is copied, its form downloaded, and
 * the 10 second countdown has run out.
 */
export function SkippedReferralRow({ referral, onRequestDone, onError }) {
  const { actions, downloading, unlocked, secondsLeft, copyId, download } =
    useReferralActions(referral, onError);

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
