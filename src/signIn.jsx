import { useState } from "react";
import { Mail, Lock, Loader2, AlertCircle } from "lucide-react";

// Mirrors SignUp.jsx: doesn't know about Firebase directly, just calls
// back out to whatever auth logic lives in the parent.
//
//   <SignIn
//     onSignIn={async ({ email, password }) => {
//       // signInWithEmailAndPassword, then read users/{uid}.role
//       // return { role: "doctor" } or { role: "admin" }
//       // throw Error("Incorrect email or password.") on failure
//     }}
//     onSignInSuccess={(role) => setRole(role)}
//     onSwitchToSignUp={() => setMode("signup")}
//   />
//
// Same role -> landing page mapping as SignUp (Section 2 of the spec):
//   doctor -> /doctor/pending  (DoctorApp)
//   admin  -> /admin/dashboard (AdminApp)
export default function SignIn({
  onSignIn,
  onSignInSuccess,
  onSwitchToSignUp,
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setFormError(null);

    try {
      const result = await onSignIn({ email: email.trim(), password });
      onSignInSuccess(result);
    } catch (err) {
      setFormError(err?.message ?? "Incorrect email or password.");
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900">Sign In</h1>
        <p className="mt-1 text-sm text-slate-500">
          Welcome back. Enter your details to continue.
        </p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
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
                autoFocus
                required
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setFormError(null);
                }}
                className="w-full rounded-md border border-slate-300 py-2 pl-9 pr-3 text-sm text-slate-900 outline-none focus:border-[#2F6F62] focus:ring-2 focus:ring-[#2F6F62]/10"
              />
            </div>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label
                htmlFor="password"
                className="block text-sm font-medium text-slate-700"
              >
                Password
              </label>
              {/* TODO: wire to sendPasswordResetEmail flow */}
              <button
                type="button"
                className="text-xs font-medium text-slate-400 hover:text-slate-600"
              >
                Forgot password?
              </button>
            </div>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setFormError(null);
                }}
                className="w-full rounded-md border border-slate-300 py-2 pl-9 pr-3 text-sm text-slate-900 outline-none focus:border-[#2F6F62] focus:ring-2 focus:ring-[#2F6F62]/10"
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
            className="flex w-full items-center justify-center gap-2 rounded-md bg-[#2F6F62] py-2.5 text-sm font-medium text-white transition hover:bg-[#265a50] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Signing in…
              </>
            ) : (
              "Sign In"
            )}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-slate-500">
          Don't have an account?{" "}
          <button
            type="button"
            onClick={onSwitchToSignUp}
            className="font-medium text-[#2F6F62] underline-offset-2 hover:underline"
          >
            Create one
          </button>
        </p>
      </div>
    </div>
  );
}
