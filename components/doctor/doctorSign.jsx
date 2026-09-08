import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Loader2, PenTool } from "lucide-react";
import { subscribeToReferral, updateReferral } from "../../src/firebaseData";

// hasSignature: pass this in from the doctor's profile doc. When false,
// this screen shows a setup prompt instead of the sign flow — never a
// dead-end error (per UX spec 5.2).
export default function DoctorSign({
  referralId,
  hasSignature = true,
  signatureDataUrl,
  doctorId,
  onBack,
  onSigned,
  onGoToProfile,
}) {
  const [stage, setStage] = useState("review"); // "review" | "generating" | "done"
  const [referral, setReferral] = useState(null);
  const [subscribeError, setSubscribeError] = useState("");
  const [signError, setSignError] = useState("");

  // Guards against re-running the write when the Firestore listener pushes
  // a fresh `referral` object mid-write (which it will, since our own write
  // triggers a new snapshot) — without this, the effect below re-fires on
  // the new object reference and submits a duplicate sign.
  const signAttemptRef = useRef(null);

  useEffect(() => {
    return subscribeToReferral(referralId, setReferral, (snapshotError) =>
      setSubscribeError(snapshotError.message),
    );
  }, [referralId]);

  useEffect(() => {
    if (stage !== "generating") return;
    if (!referral || !doctorId) return;
    if (signAttemptRef.current === referral.id) return;
    signAttemptRef.current = referral.id;

    let cancelled = false;
    updateReferral(referral.id, {
      status: "READY_TO_ASSIGN",
      signedByDoctorId: doctorId,
      signedAt: new Date(),
      statusHistory: [
        ...(referral.statusHistory ?? []),
        {
          status: "READY_TO_ASSIGN",
          text: "Signed by doctor",
          at: new Date().toISOString(),
        },
      ],
    })
      .then(() => {
        if (!cancelled) setStage("done");
      })
      .catch((writeError) => {
        if (!cancelled) {
          setSignError(writeError.message);
          setStage("review");
          signAttemptRef.current = null;
        }
      });
    return () => {
      cancelled = true;
    };
  }, [doctorId, referral, stage]);

  useEffect(() => {
    if (stage !== "done") return;
    const timer = setTimeout(
      () => onSigned?.(referral.name ?? referral.patientName),
      700,
    );
    return () => clearTimeout(timer);
  }, [stage, onSigned, referral.name, referral.patientName]);

  // Only a failure to load the referral itself is fatal enough to blank
  // the screen. A failed sign attempt is recoverable and stays inline
  // (below), so the doctor never loses the patient details/preview mid-flow.
  if (subscribeError) {
    return <p className="text-sm text-rose-600">{subscribeError}</p>;
  }

  if (!referral) {
    return <p className="text-sm text-slate-500">Loading referral...</p>;
  }

  if (!hasSignature) {
    return (
      <div className="mx-auto max-w-md rounded-md border border-slate-200 bg-white p-8 text-center">
        <PenTool className="mx-auto h-8 w-8 text-slate-400" />
        <h2 className="mt-3 text-base font-semibold text-slate-900">
          Set up your signature first
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          You'll only need to do this once.
        </p>
        <button
          type="button"
          onClick={onGoToProfile}
          className="mt-5 rounded-md bg-[#2F6F62] px-4 py-2 text-sm font-medium text-white hover:bg-[#265a50]"
        >
          Go to Profile
        </button>
      </div>
    );
  }

  const isGenerating = stage === "generating";

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        disabled={isGenerating}
        className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <ArrowLeft className="h-4 w-4" /> Back
      </button>

      <div className="mt-4 grid gap-6 lg:grid-cols-2">
        {/* Patient details */}
        <div className="rounded-md border border-slate-200 bg-white p-6">
          <h2 className="text-sm font-medium uppercase tracking-wide text-slate-400">
            Patient details
          </h2>
          <dl className="mt-3 space-y-3 text-sm">
            <div>
              <dt className="text-slate-400">Name</dt>
              <dd className="font-medium text-slate-800">
                {referral.name ?? referral.patientName}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Patient ID</dt>
              <dd className="font-mono text-slate-700">{referral.patientId}</dd>
            </div>
            <div>
              <dt className="text-slate-400">NHIS</dt>
              <dd className="font-mono text-slate-700">{referral.nhis}</dd>
            </div>
            <div>
              <dt className="text-slate-400">Referral date</dt>
              <dd className="text-slate-700">
                {formatDate(referral.referralDate)}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Reason</dt>
              <dd className="text-slate-700">
                {referral.reason ?? referral.referralReason}
              </dd>
            </div>
          </dl>
        </div>

        {/* Live preview, sized proportionally to 150mm x 100mm landscape */}
        <div className="flex flex-col items-center">
          <h2 className="mb-3 self-start text-sm font-medium uppercase tracking-wide text-slate-400">
            Preview
          </h2>
          <div
            className="flex w-full flex-col justify-between rounded-md border border-slate-300 bg-white p-4 shadow-sm"
            style={{ aspectRatio: "150 / 100" }}
          >
            <div>
              <p className="text-[11px] font-semibold text-slate-800">
                REFERRAL — {referral.patientId}
              </p>
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] text-slate-600">
                <span>Name: {referral.name ?? referral.patientName}</span>
                <span>NHIS: {referral.nhis}</span>
                <span>Date: {formatDate(referral.referralDate)}</span>
              </div>
              <p className="mt-2 text-[9px] leading-snug text-slate-500">
                {referral.reason ?? referral.referralReason}
              </p>
            </div>
            <div className="flex items-end justify-between">
              <span className="text-[9px] text-slate-400">
                Signed electronically
              </span>
              {signatureDataUrl ? (
                <img
                  src={signatureDataUrl}
                  alt="Doctor signature"
                  className="h-8"
                  style={{
                    // Match the ink treatment applied on the downloaded
                    // form (bolded, slightly tilted) so what's previewed
                    // here is what actually gets downloaded, not a flatter
                    // stand-in.
                    transform: "rotate(-1.5deg)",
                    filter: "contrast(1.35) saturate(0.9) brightness(0.92)",
                  }}
                />
              ) : (
                <span className="font-signature text-lg italic text-slate-700">
                  A. Owusu
                </span>
              )}
            </div>
          </div>
          <p className="mt-2 text-xs text-slate-400">
            150mm × 100mm, landscape
          </p>
        </div>
      </div>

      {signError && (
        <p className="mt-4 text-right text-sm text-rose-600">{signError}</p>
      )}

      <div className="mt-6 flex justify-end">
        {stage === "review" && (
          <button
            type="button"
            onClick={() => setStage("generating")}
            className="rounded-md bg-[#2F6F62] px-6 py-2.5 text-sm font-semibold text-white hover:bg-[#265a50]"
          >
            {signError ? "Try again" : "Approve & Sign"}
          </button>
        )}
        {stage === "generating" && (
          <span className="flex items-center gap-2 rounded-md bg-slate-100 px-6 py-2.5 text-sm font-medium text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Generating…
          </span>
        )}
        {stage === "done" && (
          <span className="rounded-md bg-emerald-50 px-6 py-2.5 text-sm font-medium text-emerald-700">
            Signed and sent to attach queue
          </span>
        )}
      </div>
    </div>
  );
}

function formatDate(value) {
  if (!value) return "—";
  const date = value.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}