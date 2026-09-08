import { useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { doc, getDoc } from "firebase/firestore";
import DoctorLayout from "./doctorLayout";
import DoctorPending from "./doctorPending";
import DoctorProfile from "./doctorProfile";
import { auth, db } from "../../src/firebase";

// Drop-in root for the Doctor role.
export default function DoctorApp({
  doctorName,
  onSignOut,
  signatureDataUrl = null,
}) {
  const [activePage, setActivePage] = useState("pending");
  const [toast, setToast] = useState(null);
  const [doctorId, setDoctorId] = useState(null);
  const [profile, setProfile] = useState(null);

  useEffect(() => {
    if (!auth || !db) return undefined;
    return auth.onAuthStateChanged(async (user) => {
      setDoctorId(user?.uid ?? null);
      if (!user) {
        setProfile(null);
        return;
      }
      const snapshot = await getDoc(doc(db, "users", user.uid));
      setProfile(snapshot.exists() ? snapshot.data() : null);
    });
  }, []);

  const handleSigned = (count) => {
    setToast(
      `${count} referral${count === 1 ? "" : "s"} signed and sent to assignment queue`,
    );
    setTimeout(() => setToast(null), 3000);
  };

  return (
    <DoctorLayout
      activePage={activePage}
      onNavigate={setActivePage}
      doctorName={doctorName}
      onSignOut={onSignOut}
    >
      {activePage === "pending" && (
        <DoctorPending
          doctorId={doctorId}
          doctorName={doctorName}
          signatureUrl={signatureDataUrl ?? profile?.signaturePngUrl}
          onGoToProfile={() => setActivePage("profile")}
          onSigned={handleSigned}
        />
      )}

      {activePage === "profile" && (
        <DoctorProfile
          existingSignatureUrl={signatureDataUrl ?? profile?.signaturePngUrl}
        />
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-md bg-slate-900 px-4 py-2.5 text-sm text-white shadow-lg">
          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          {toast}
        </div>
      )}
    </DoctorLayout>
  );
}
