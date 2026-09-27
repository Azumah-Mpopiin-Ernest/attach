import { useRef, useState } from "react";
import SignatureCanvas from "./signatureCanvas";
import ConfirmDialog from "./confirmDialog";
import { auth } from "../../src/firebase";
import { updateDocument } from "../../src/firebaseData";

// existingSignatureUrl: pass the doctor's users/{uid}.signaturePngUrl if
// one already exists. When present, this screen shows it pre-loaded with
// "Redraw" instead of "Save" — reinforcing this is a replace action.
//
// existingName: pass the doctor's users/{uid}.fullName if one already
// exists. Falls back to auth.currentUser.displayName, then an empty string.
export default function DoctorProfile({
  existingSignatureUrl = null,
  existingName = null,
}) {
  const canvasRef = useRef(null);
  const [mode, setMode] = useState(existingSignatureUrl ? "view" : "draw"); // "view" | "draw"
  const [pendingRedraw, setPendingRedraw] = useState(false);
  const [savedUrl, setSavedUrl] = useState(existingSignatureUrl);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // --- Name editing state ---
  const [savedName, setSavedName] = useState(
    existingName ?? auth?.currentUser?.displayName ?? "",
  );
  const [nameEditing, setNameEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(savedName);
  const [nameError, setNameError] = useState("");
  const [nameSaving, setNameSaving] = useState(false);
  const [nameJustSaved, setNameJustSaved] = useState(false);

  const startEditName = () => {
    setNameDraft(savedName);
    setNameError("");
    setNameEditing(true);
  };

  const cancelEditName = () => {
    setNameEditing(false);
    setNameError("");
    setNameDraft(savedName);
  };

  const handleSaveName = async () => {
    if (nameSaving) return;
    const trimmed = nameDraft.trim();
    if (!trimmed) {
      setNameError("Name can't be empty.");
      return;
    }
    if (!auth?.currentUser) {
      setNameError("You must be signed in to update your name.");
      return;
    }
    setNameSaving(true);
    setNameError("");
    try {
      // fullName is the same field signup writes, and the one the rest of
      // the app (session name, referredFrom/ToDoctorName on referrals)
      // reads — keep them in sync rather than introducing a second field.
      await updateDocument("users", auth.currentUser.uid, {
        fullName: trimmed,
      });
      setSavedName(trimmed);
      setNameEditing(false);
      setNameJustSaved(true);
      setTimeout(() => setNameJustSaved(false), 2500);
    } catch (saveError) {
      setNameError(saveError.message);
    } finally {
      setNameSaving(false);
    }
  };

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
      <h1 className="text-xl font-semibold text-slate-900">Your Profile</h1>

      {/* --- Name section --- */}
      <div className="mt-6 rounded-md border border-slate-200 bg-white p-6">
        <h2 className="text-sm font-semibold text-slate-900">Name</h2>
        <p className="mt-1 text-sm text-slate-500">
          This is the name used to identify you on the referral forms you sign.
        </p>
        {nameError && <p className="mt-3 text-sm text-rose-600">{nameError}</p>}

        {!nameEditing ? (
          <div className="mt-4 flex items-center justify-between">
            <span className="text-base font-medium text-slate-900">
              {savedName || "No name set"}
            </span>
            <button
              type="button"
              onClick={startEditName}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              Edit
            </button>
          </div>
        ) : (
          <div className="mt-4">
            <input
              type="text"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              disabled={nameSaving}
              autoFocus
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-[#2F6F62] focus:outline-none focus:ring-1 focus:ring-[#2F6F62] disabled:opacity-60"
              placeholder="Dr. Jane Doe"
            />
            <div className="mt-4 flex justify-end gap-3">
              <button
                type="button"
                onClick={cancelEditName}
                disabled={nameSaving}
                className="rounded-md px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveName}
                disabled={nameSaving}
                className="rounded-md bg-[#2F6F62] px-4 py-2 text-sm font-medium text-white hover:bg-[#265a50] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {nameSaving ? "Saving..." : "Save Name"}
              </button>
            </div>
          </div>
        )}
        {nameJustSaved && (
          <p className="mt-3 text-sm font-medium text-emerald-700">
            Name saved
          </p>
        )}
      </div>

      {/* --- Signature section --- */}
      <h2 className="mt-8 text-sm font-semibold text-slate-900">
        Your Signature
      </h2>
      <p className="mt-1 text-sm text-slate-500">
        This is applied automatically whenever you approve and sign a referral.
      </p>
      {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}

      <div className="mt-4 rounded-md border border-slate-200 bg-white p-6">
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
