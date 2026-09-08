import { useRef, useState } from "react";
import SignatureCanvas from "./signatureCanvas";
import ConfirmDialog from "./confirmDialog";
import { auth } from "../../src/firebase";
import { updateDocument } from "../../src/firebaseData";

// existingSignatureUrl: pass the doctor's users/{uid}.signaturePngUrl if
// one already exists. When present, this screen shows it pre-loaded with
// "Redraw" instead of "Save" — reinforcing this is a replace action.
export default function DoctorProfile({ existingSignatureUrl = null }) {
  const canvasRef = useRef(null);
  const [mode, setMode] = useState(existingSignatureUrl ? "view" : "draw"); // "view" | "draw"
  const [pendingRedraw, setPendingRedraw] = useState(false);
  const [savedUrl, setSavedUrl] = useState(existingSignatureUrl);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const startRedraw = () => setPendingRedraw(true);

  const confirmRedraw = () => {
    setPendingRedraw(false);
    setError("");
    setMode("draw");
  };

  const handleSave = async () => {
    if (saving) return;
    if (canvasRef.current?.isEmpty()) {
      setError("Draw your signature before saving.");
      return;
    }
    if (!auth?.currentUser) {
      setError("You must be signed in to save a signature.");
      return;
    }
    const dataUrl = canvasRef.current.toTransparentPNG();
    setSaving(true);
    setError("");
    try {
      // Keep the small signature directly on the user's profile. The final
      // referral JPEG is generated locally by the Officer and is never stored.
      await updateDocument("users", auth.currentUser.uid, {
        signaturePngUrl: dataUrl,
      });
      setSavedUrl(dataUrl);
      setMode("view");
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2500);
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  };

  const handleClear = () => {
    if (saving) return;
    canvasRef.current?.clear();
    setError("");
  };

  return (
    <div className="max-w-xl">
      <h1 className="text-xl font-semibold text-slate-900">Your Signature</h1>
      <p className="mt-1 text-sm text-slate-500">
        This is applied automatically whenever you approve and sign a referral.
      </p>
      {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}

      <div className="mt-6 rounded-md border border-slate-200 bg-white p-6">
        {mode === "view" && savedUrl && (
          <>
            <div className="flex h-[180px] items-center justify-center rounded-md border border-dashed border-slate-300 bg-white">
              <img
                src={savedUrl}
                alt="Your saved signature"
                className="max-h-24"
              />
            </div>
            {justSaved && (
              <p className="mt-3 text-sm font-medium text-emerald-700">
                Signature saved
              </p>
            )}
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={startRedraw}
                className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
              >
                Redraw
              </button>
            </div>
          </>
        )}

        {mode === "draw" && (
          <>
            <SignatureCanvas ref={canvasRef} />
            <p className="mt-2 text-xs text-slate-400">
              Sign as you would on paper — vary your speed naturally, it helps
              the signature look right on the printed form.
            </p>
            <div className="mt-4 flex justify-end gap-3">
              <button
                type="button"
                onClick={handleClear}
                disabled={saving}
                className="rounded-md px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="rounded-md bg-[#2F6F62] px-4 py-2 text-sm font-medium text-white hover:bg-[#265a50] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? "Saving..." : "Save Signature"}
              </button>
            </div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={pendingRedraw}
        title="Replace your signature?"
        description="Referrals you've already signed keep their original signature — this only affects new ones going forward."
        confirmLabel="Continue"
        onConfirm={confirmRedraw}
        onCancel={() => setPendingRedraw(false)}
      />
    </div>
  );
}
