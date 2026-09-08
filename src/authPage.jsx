import { useEffect, useState } from "react";
import {
  createUserWithEmailAndPassword,
  browserLocalPersistence,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import SignIn from "./signIn";
import SignUp from "./signUp";
import DoctorApp from "../components/doctor/doctorApp";
import AdminApp from "../components/admin/adminApp";
import OfficerApp from "../components/officer/officerApp";
import { auth, db } from "./firebase";

const ROLE_PATHS = {
  doctor: "/doctor",
  admin: "/admin",
  officer: "/officer",
};

function normalizeRole(role) {
  const normalized = String(role ?? "").toLowerCase();
  return ["doctor", "admin", "officer"].includes(normalized)
    ? normalized
    : null;
}

function authErrorMessage(error) {
  if (error?.code === "auth/invalid-credential")
    return "Incorrect email or password.";
  if (error?.code === "auth/email-already-in-use")
    return "An account already exists for this email.";
  if (error?.code === "auth/weak-password")
    return "Choose a stronger password.";
  return error?.message ?? "Authentication failed. Please try again.";
}

function pathForRole(role) {
  return ROLE_PATHS[normalizeRole(role)] ?? null;
}

export default function AuthPage({ requiredRole = null }) {
  const [mode, setMode] = useState("signin");
  const [session, setSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(Boolean(auth && db));
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!auth || !db) {
      return undefined;
    }

    let unsubscribe;
    setPersistence(auth, browserLocalPersistence)
      .then(() => {
        unsubscribe = onAuthStateChanged(auth, async (user) => {
          if (!user) {
            setSession(null);
            setAuthLoading(false);
            return;
          }

          try {
            const profileSnapshot = await getDoc(doc(db, "users", user.uid));
            const profile = profileSnapshot.exists()
              ? profileSnapshot.data()
              : null;
            const role = normalizeRole(profile?.role);

            if (!profile || !role || profile.active === false) {
              await signOut(auth);
              setSession(null);
            } else {
              setSession({
                role,
                name:
                  profile.fullName ?? profile.name ?? user.displayName ?? "",
              });
            }
          } catch {
            // Keep Firebase Auth signed in. A temporary Firestore failure must
            // not turn a page refresh into an unexpected sign-out.
            setSession(null);
          } finally {
            setAuthLoading(false);
          }
        });
      })
      .catch(() => setAuthLoading(false));

    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    if (authLoading || !session) return;
    const targetPath = pathForRole(session.role);
    if (!targetPath) return;
    if (requiredRole && session.role !== requiredRole) {
      navigate(targetPath, { replace: true });
    } else if (location.pathname === "/" || location.pathname === "/auth") {
      navigate(targetPath, { replace: true });
    }
  }, [authLoading, location.pathname, navigate, requiredRole, session]);

  const handleSignIn = async ({ email, password }) => {
    if (!auth || !db) throw new Error("Firebase is not configured.");
    try {
      const credential = await signInWithEmailAndPassword(
        auth,
        email,
        password,
      );
      const profileSnapshot = await getDoc(
        doc(db, "users", credential.user.uid),
      );
      const profile = profileSnapshot.exists() ? profileSnapshot.data() : null;
      const role = normalizeRole(profile?.role);

      if (!profile || !role) {
        await signOut(auth);
        throw new Error(
          "Your account profile is incomplete. Contact an administrator.",
        );
      }
      if (profile.active === false) {
        await signOut(auth);
        throw new Error("This account is inactive. Contact an administrator.");
      }

      return {
        role,
        name:
          profile.fullName ?? profile.name ?? credential.user.displayName ?? "",
      };
    } catch (error) {
      throw new Error(authErrorMessage(error));
    }
  };

  const handleValidateKey = async (key) => {
    if (!db) throw new Error("Firebase is not configured.");
    const normalizedKey = key.trim().toUpperCase();
    const snapshot = await getDocs(
      query(
        collection(db, "registrationKeys"),
        where("code", "==", normalizedKey),
        where("used", "==", false),
        where("revoked", "==", false),
        limit(1),
      ),
    );
    const keyDocument = snapshot.docs[0];
    const keyData = keyDocument?.data();
    const role = normalizeRole(keyData?.role);

    if (!keyDocument || keyData.used || keyData.revoked || !role) {
      return {
        valid: false,
        reason: "This key is invalid, revoked, used, or unsupported.",
      };
    }
    return { valid: true, role };
  };

  const handleCreateAccount = async ({
    registrationKey,
    fullName,
    email,
    password,
    role,
  }) => {
    if (!auth || !db) throw new Error("Firebase is not configured.");
    const normalizedKey = registrationKey.trim().toUpperCase();
    const requestedRole = normalizeRole(role);
    if (!requestedRole)
      throw new Error("This registration key has an unsupported role.");

    let credential;
    try {
      credential = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(credential.user, { displayName: fullName });

      const keySnapshot = await getDocs(
        query(
          collection(db, "registrationKeys"),
          where("code", "==", normalizedKey),
          where("used", "==", false),
          where("revoked", "==", false),
          limit(1),
        ),
      );
      const keyDocument = keySnapshot.docs[0];
      if (!keyDocument) throw new Error("This registration key is invalid.");

      await runTransaction(db, async (transaction) => {
        const currentKey = (await transaction.get(keyDocument.ref)).data();
        const keyRole = normalizeRole(currentKey?.role);
        if (
          currentKey?.used ||
          currentKey?.revoked ||
          !keyRole ||
          keyRole !== requestedRole
        ) {
          throw new Error("This registration key is no longer available.");
        }

        transaction.set(doc(db, "users", credential.user.uid), {
          fullName: fullName.trim(),
          email: email.trim().toLowerCase(),
          role: keyRole,
          registrationKeyId: keyDocument.id,
          active: true,
          createdAt: serverTimestamp(),
        });
        transaction.update(keyDocument.ref, {
          used: true,
          usedByUid: credential.user.uid,
          usedByName: fullName.trim(),
          usedAt: serverTimestamp(),
        });
      });

      return { role: requestedRole, name: fullName.trim() };
    } catch (error) {
      if (credential?.user) await credential.user.delete().catch(() => {});
      throw new Error(authErrorMessage(error));
    }
  };

  const handleSignOut = () => {
    signOut(auth).finally(() => {
      setSession(null);
      setMode("signin");
      navigate("/", { replace: true });
    });
  };

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
        Loading...
      </div>
    );
  }

  if (
    session?.role === "doctor" &&
    (!requiredRole || requiredRole === "doctor")
  ) {
    return <DoctorApp doctorName={session.name} onSignOut={handleSignOut} />;
  }
  if (
    session?.role === "admin" &&
    (!requiredRole || requiredRole === "admin")
  ) {
    return <AdminApp adminName={session.name} onSignOut={handleSignOut} />;
  }
  if (
    session?.role === "officer" &&
    (!requiredRole || requiredRole === "officer")
  ) {
    return <OfficerApp officerName={session.name} onSignOut={handleSignOut} />;
  }

  if (requiredRole) {
    return <Navigate to="/" replace />;
  }

  return mode === "signin" ? (
    <SignIn
      onSignIn={handleSignIn}
      onSignInSuccess={(result) => {
        setSession(result);
        const targetPath = pathForRole(result?.role);
        if (targetPath) navigate(targetPath, { replace: true });
      }}
      onSwitchToSignUp={() => setMode("signup")}
    />
  ) : (
    <SignUp
      onValidateKey={handleValidateKey}
      onCreateAccount={handleCreateAccount}
      onSignUpSuccess={() => {
        signOut(auth).finally(() => {
          setSession(null);
          setMode("signin");
          navigate("/", { replace: true });
        });
      }}
      onSwitchToSignIn={() => setMode("signin")}
    />
  );
}
