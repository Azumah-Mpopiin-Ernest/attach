import { useState } from "react";
import {
  KeyRound,
  User,
  Mail,
  Lock,
  Loader2,
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
} from "lucide-react";

// Two-step "Create Account" flow per the UX spec (Section 4):
//   1. Registration Key — validated before the rest of the form unlocks.
//      Role is silently derived from the key; no role dropdown ever shown.
//   2. Full Name / Email / Password — only enabled once the key checks out.
//
// This component doesn't know about Firebase/Firestore directly. Wire it
// up from wherever your auth logic lives:
//
//   <SignUp
//     onValidateKey={async (key) => {
//       // look up registrationKeys/{key} in Firestore
//       // return { valid: true, role: "doctor", keyId: <the doc's own id> }
//       // or     { valid: false, reason: "This key isn't valid. Check with your admin." }
//       // IMPORTANT: keyId must be the exact document ID (e.g. snapshot.id),
//       // not a re-trimmed/re-cased copy of the user's typed input — the
//       // security rules do a get() on registrationKeys/{registrationKeyId}
//       // and a mismatched id resolves to a nonexistent doc, which throws
//       // inside the rule and surfaces as "missing or insufficient permissions".
//     }}
//     onCreateAccount={async ({ registrationKeyId, fullName, email, password, role }) => {
//       // createUserWithEmailAndPassword, write users/{uid} with { role, fullName, ... },
//       // mark the key as used. Return/resolve on success, throw Error(message) on failure.
//     }}
//     onSignUpSuccess={(role) => {
//       // e.g. setRole(role) in the parent, which then renders
//       // <DoctorApp /> or <AdminApp /> per Section 2 of the spec.
//     }}
//     onSwitchToSignIn={() => setMode("signin")}
//   />
//
// Role -> landing page mapping (Section 2 of the spec). Officers use the
// Chrome extension, not this web app, so this form only ever produces a
// "doctor" or "admin" account — there's no officer branch to route to.
//   doctor  -> /doctor/pending  (DoctorApp)
//   admin   -> /admin/dashboard (AdminApp)
const ROLE_LABEL = {
  doctor: "Doctor",
  admin: "Admin",
  officer: "Officer",
};

export default function SignUp({
  onValidateKey,
  onCreateAccount,
  onSignUpSuccess,
  onSwitchToSignIn,
}) {
  const [step, setStep] = useState("key"); // "key" | "details"
  const [registrationKey, setRegistrationKey] = useState("");
  const [registrationKeyId, setRegistrationKeyId] = useState(null);
  const [role, setRole] = useState(null);

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [checkingKey, setCheckingKey] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [keyError, setKeyError] = useState(null);
  const [formError, setFormError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);

  const handleCheckKey = async (e) => {
    e.preventDefault();
    if (!registrationKey.trim() || checkingKey) return;

    setCheckingKey(true);
    setKeyError(null);

    try {
      const result = await onValidateKey(registrationKey.trim());
      if (result?.valid) {
        setRole(result.role);
        // Store the canonical doc id returned by the validator, not the
        // raw typed string — this is what gets written to the new user
        // doc, and it must exactly match registrationKeys/{id}.
        setRegistrationKeyId(result.keyId);
        setStep("details");
      } else {
        setKeyError(
          result?.reason ?? "This key isn't valid. Check with your admin.",
        );
      }
    } catch {
      setKeyError("This key isn't valid. Check with your admin.");
    } finally {
      setCheckingKey(false);
    }
  };

  const handleChangeKey = () => {
    setStep("key");
    setRegistrationKeyId(null);
    setFormError(null);
  };

  const handleCreateAccount = async (e) => {
    e.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setFormError(null);

    try {
      await onCreateAccount({
        registrationKeyId,
        fullName: fullName.trim(),
        email: email.trim(),
        password,
        role,
      });
      setSuccessMessage(
        "Account created successfully. Redirecting to sign in...",
      );
      setTimeout(() => onSignUpSuccess(role), 1200);
    } catch (err) {
      setFormError(
        err?.message ?? "Couldn't create your account. Please try again.",
      );
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900">Create Account</h1>
        <p className="mt-1 text-sm text-slate-500">
          {step === "key"
            ? "Enter the registration key given to you by your admin."
            : `Setting up your ${ROLE_LABEL[role] ?? ""} account.`}
        </p>

        {successMessage && (
          <div
            className="mt-6 flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"
            role="status"
          >
            <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none" />
            <span>{successMessage}</span>
          </div>
        )}

        {!successMessage && step === "key" && (
          <form onSubmit={handleCheckKey} className="mt-6 space-y-4">
            <div>
              <label
                htmlFor="registrationKey"
                className="mb-1.5 block text-sm font-medium text-slate-700"
              >
                Registration Key
              </label>
              <div className="relative">
                <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  id="registrationKey"
                  type="text"
                  autoFocus
                  value={registrationKey}
                  onChange={(e) => {
                    setRegistrationKey(e.target.value);
                    setKeyError(null);
                  }}
                  placeholder="e.g. RB-4KD9-XQ2P"
                  className={`w-full rounded-md border py-2 pl-9 pr-3 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:ring-2 focus:ring-slate-900/10 ${
                    keyError
                      ? "border-red-300 focus:border-red-400"
                      : "border-slate-300 focus:border-slate-400"
                  }`}
                />
              </div>
              {keyError ? (
                <p className="mt-1.5 flex items-start gap-1.5 text-sm text-red-600">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {keyError}
                </p>
              ) : (
                <p className="mt-1.5 text-xs text-slate-400">
                  Given to you by your admin.
                </p>
              )}
            </div>

            <button
              type="submit"
              disabled={!registrationKey.trim() || checkingKey}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-slate-900 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {checkingKey ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Checking key…
                </>
              ) : (
                "Continue"
              )}
            </button>
          </form>
        )}

        {!successMessage && step === "details" && (
          <form onSubmit={handleCreateAccount} className="mt-6 space-y-4">
            <div className="flex items-center justify-between rounded-md bg-slate-50 px-3 py-2 text-sm">
              <span className="flex items-center gap-1.5 text-slate-600">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                {ROLE_LABEL[role] ?? "Account"} — key verified
              </span>
              <button
                type="button"
                onClick={handleChangeKey}
                className="text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline"
              >
                Change
              </button>
            </div>

            <div>
              <label
                htmlFor="fullName"
                className="mb-1.5 block text-sm font-medium text-slate-700"
              >
                Full Name
              </label>
              <div className="relative">
                <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  id="fullName"
                  type="text"
                  autoFocus
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="w-full rounded-md border border-slate-300 py-2 pl-9 pr-3 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-900/10"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="email"
                className="mb-1.5 block text-sm font-medium text-slate-700"
              >
                Email
              </label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-md border border-slate-300 py-2 pl-9 pr-3 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-900/10"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="password"
                className="mb-1.5 block text-sm font-medium text-slate-700"
              >
                Password
              </label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  id="password"
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-md border border-slate-300 py-2 pl-9 pr-3 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-900/10"
                />
              </div>
            </div>

            {formError && (
              <p className="flex items-start gap-1.5 text-sm text-red-600">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {formError}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-slate-900 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Creating account…
                </>
              ) : (
                "Create Account"
              )}
            </button>

            <button
              type="button"
              onClick={handleChangeKey}
              className="flex w-full items-center justify-center gap-1.5 text-xs font-medium text-slate-400 hover:text-slate-600"
            >
              <ArrowLeft className="h-3 w-3" />
              Back
            </button>
          </form>
        )}

        <p className="mt-6 text-center text-sm text-slate-500">
          Already have an account?{" "}
          <button
            type="button"
            onClick={onSwitchToSignIn}
            className="font-medium text-slate-900 underline-offset-2 hover:underline"
          >
            Sign in
          </button>
        </p>
      </div>
    </div>
  );
}
