import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Loader2, Search } from "lucide-react";
import { subscribeToReferrals, updateReferral } from "../../src/firebaseData";
import Pagination from "../shared/Pagination";

const PAGE_SIZE = 25;

export default function DoctorPending({
  doctorId,
  doctorName,
  signatureUrl,
  onGoToProfile,
  onSigned,
}) {
  const [query, setQuery] = useState("");
  const [referrals, setReferrals] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState([]);
  const [signingIds, setSigningIds] = useState([]);
  const [signatureSide, setSignatureSide] = useState("from");
  const [queueTab, setQueueTab] = useState("unsigned");

  useEffect(() => {
    return subscribeToReferrals(
      { status: "AWAITING_SIGN" },
      (items) => {
        setReferrals(items);
        setLoading(false);
      },
      (snapshotError) => {
        setError(snapshotError.message);
        setLoading(false);
      },
    );
  }, []);

  const eligibleReferrals = useMemo(() => {
    if (!doctorId) return { unsigned: [], needsOtherSignature: [] };
    return referrals.reduce(
      (groups, referral) => {
        const fromSigned = Boolean(referral.referredFromDoctorId);
        const toSigned = Boolean(referral.referredToDoctorId);
        const signedByThisDoctor =
          referral.referredFromDoctorId === doctorId ||
          referral.referredToDoctorId === doctorId;

        if (signedByThisDoctor || (fromSigned && toSigned)) return groups;
        if (!fromSigned && !toSigned) groups.unsigned.push(referral);
        else groups.needsOtherSignature.push(referral);
        return groups;
      },
      { unsigned: [], needsOtherSignature: [] },
    );
  }, [doctorId, referrals]);

  const filtered = useMemo(
    () =>
      eligibleReferrals[queueTab]
        .slice()
        .sort((a, b) =>
          String(a.referralDate ?? "").localeCompare(
            String(b.referralDate ?? ""),
          ),
        )
        .filter((referral) =>
          `${referral.name} ${referral.patientId} ${referral.nhis}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        ),
    [eligibleReferrals, query, queueTab],
  );

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const paginated = filtered.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );
  const pageSelected =
    paginated.length > 0 &&
    paginated.every((item) => selectedIds.includes(item.id));

  const toggleSelected = (id) => {
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
  };

  const approveAndSign = async (items) => {
    if (signingIds.length) return;
    if (!items.length) {
      setError("Select at least one referral before approving and signing.");
      return;
    }
    if (!doctorId || !doctorName) {
      setError(
        "Your doctor account is still loading. Please try again shortly.",
      );
      return;
    }
    if (!signatureUrl) {
      setError(
        "You have not uploaded a signature yet. Upload it from your Profile before signing referrals.",
      );
      return;
    }

    const ids = items.map((item) => item.id);
    setSigningIds(ids);
    setError("");
    try {
      const signedUpdates = await Promise.all(
        items.map((referral) =>
          signReferral(referral, {
            doctorId,
            doctorName,
            signatureUrl,
            side:
              queueTab === "needsOtherSignature"
                ? missingSide(referral)
                : signatureSide,
          }),
        ),
      );
      setReferrals((current) =>
        current.map((referral) => {
          const update = signedUpdates.find((item) => item.id === referral.id);
          return update ? { ...referral, ...update.changes } : referral;
        }),
      );
      setSelectedIds((current) => current.filter((id) => !ids.includes(id)));
      onSigned?.(items.length);
    } catch (writeError) {
      setError(writeError.message);
    } finally {
      setSigningIds([]);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-slate-900">
          Pending Signatures
        </h1>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name or NHIS"
            className="w-full rounded-md border border-slate-300 py-1.5 pl-8 pr-3 text-sm focus:border-[#2F6F62] focus:outline-none sm:w-64"
          />
        </div>
        <button
          type="button"
          disabled={!selectedIds.length || signingIds.length > 0}
          onClick={() =>
            approveAndSign(
              filtered.filter((item) => selectedIds.includes(item.id)),
            )
          }
          className="inline-flex items-center gap-1.5 rounded-md bg-[#2F6F62] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#265a50] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {signingIds.length ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CheckCircle2 className="h-4 w-4" />
          )}
          {signingIds.length
            ? "Signing..."
            : `Approve & Sign${selectedIds.length ? ` (${selectedIds.length})` : ""}`}
        </button>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <span>Sign as</span>
          <select
            value={signatureSide}
            onChange={(event) => setSignatureSide(event.target.value)}
            disabled={queueTab === "needsOtherSignature"}
            className="rounded-md border border-slate-300 px-2 py-1.5"
          >
            <option value="from">Referred From doctor</option>
            <option value="to">Referred To doctor</option>
          </select>
        </label>
      </div>

      <div className="mt-5 flex gap-1 border-b border-slate-200">
        <button
          type="button"
          onClick={() => setQueueTab("unsigned")}
          className={`border-b-2 px-3 py-2 text-sm font-medium ${queueTab === "unsigned" ? "border-[#2F6F62] text-[#2F6F62]" : "border-transparent text-slate-500"}`}
        >
          Unsigned forms ({eligibleReferrals.unsigned.length})
        </button>
        <button
          type="button"
          onClick={() => setQueueTab("needsOtherSignature")}
          className={`border-b-2 px-3 py-2 text-sm font-medium ${queueTab === "needsOtherSignature" ? "border-[#2F6F62] text-[#2F6F62]" : "border-transparent text-slate-500"}`}
        >
          Awaiting your signature (
          {eligibleReferrals.needsOtherSignature.length})
        </button>
      </div>

      {error && (
        <div
          className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
          role="alert"
        >
          <span>{error}</span>
          {!signatureUrl && (
            <button
              type="button"
              onClick={onGoToProfile}
              className="rounded-md bg-rose-700 px-3 py-1.5 font-medium text-white hover:bg-rose-800"
            >
              Go to Profile
            </button>
          )}
        </div>
      )}
      {!signatureUrl && !loading && !error && (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span>
            You must upload your signature before you can approve referrals.
          </span>
          <button
            type="button"
            onClick={onGoToProfile}
            className="rounded-md bg-amber-700 px-3 py-1.5 font-medium text-white hover:bg-amber-800"
          >
            Go to Profile
          </button>
        </div>
      )}
      {loading && !error && (
        <div className="mt-16 flex items-center justify-center gap-2 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading pending
          signatures...
        </div>
      )}
      {!loading &&
        !error &&
        (filtered.length === 0 ? (
          <div className="mt-16 flex flex-col items-center text-center">
            <p className="text-base font-medium text-slate-700">
              You're all caught up
            </p>
            <p className="mt-1 text-sm text-slate-400">
              New referrals appear here after intake.
            </p>
          </div>
        ) : (
          <div className="mt-5 overflow-x-auto rounded-md border border-slate-200 bg-white">
            <table className="min-w-[720px] w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                  <th className="w-10 px-5 py-3 font-medium">
                    <input
                      type="checkbox"
                      aria-label="Select all visible referrals"
                      checked={pageSelected}
                      onChange={() =>
                        setSelectedIds(
                          pageSelected
                            ? selectedIds.filter(
                                (id) =>
                                  !paginated.some((item) => item.id === id),
                              )
                            : [
                                ...new Set([
                                  ...selectedIds,
                                  ...paginated.map((item) => item.id),
                                ]),
                              ],
                        )
                      }
                    />
                  </th>
                  <th className="px-5 py-3 font-medium">Patient</th>
                  <th className="px-5 py-3 font-medium">NHIS</th>
                  <th className="px-5 py-3 font-medium">Date</th>
                  <th className="px-5 py-3 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {paginated.map((referral) => (
                  <tr
                    key={referral.id}
                    className="border-b border-slate-100 last:border-0 hover:bg-slate-50"
                  >
                    <td className="px-5 py-3">
                      <input
                        type="checkbox"
                        aria-label={`Select ${referral.name ?? referral.patientId}`}
                        checked={selectedIds.includes(referral.id)}
                        onChange={() => toggleSelected(referral.id)}
                      />
                    </td>
                    <td className="px-5 py-3">
                      <div className="font-medium text-slate-800">
                        {referral.name}
                      </div>
                      <div className="font-mono text-xs text-slate-400">
                        {referral.patientId}
                      </div>
                    </td>
                    <td className="px-5 py-3 font-mono text-slate-600">
                      {referral.nhis}
                    </td>
                    <td className="px-5 py-3 text-slate-500">
                      {formatReferralDate(referral.referralDate)}
                    </td>
                    <td className="px-5 py-3">
                      <button
                        type="button"
                        disabled={signingIds.length > 0}
                        onClick={() => approveAndSign([referral])}
                        className="inline-flex items-center gap-1.5 rounded-md bg-[#2F6F62] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#265a50] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {signingIds.includes(referral.id) ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <CheckCircle2 className="h-3.5 w-3.5" />
                        )}
                        {signingIds.includes(referral.id)
                          ? "Signing..."
                          : "Approve & Sign"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination
              page={currentPage}
              pageCount={pageCount}
              onPageChange={setPage}
              total={filtered.length}
            />
          </div>
        ))}
    </div>
  );
}

function formatReferralDate(value) {
  const date = toDate(value);
  return date ? date.toLocaleDateString("en-GB") : "—";
}

function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === "number")
    return new Date(Date.UTC(1899, 11, 30) + value * 86400000);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function missingSide(referral) {
  return referral.referredFromDoctorId ? "to" : "from";
}

async function signReferral(
  referral,
  { doctorId, doctorName, signatureUrl, side },
) {
  const isFrom = side === "from";
  const otherDoctorId = isFrom
    ? referral.referredToDoctorId
    : referral.referredFromDoctorId;
  const existingDoctorId = isFrom
    ? referral.referredFromDoctorId
    : referral.referredToDoctorId;
  if (existingDoctorId) {
    throw new Error(
      `The Referred ${isFrom ? "From" : "To"} signature has already been completed by another doctor.`,
    );
  }
  if (otherDoctorId === doctorId)
    throw new Error(
      "One doctor cannot sign both Referred From and Referred To.",
    );

  const now = new Date();
  const changes = isFrom
    ? {
        referredFromDoctorId: doctorId,
        referredFromDoctorName: doctorName,
        referredFromSignatureUrl: signatureUrl,
        referredFromSignedAt: now,
      }
    : {
        referredToDoctorId: doctorId,
        referredToDoctorName: doctorName,
        referredToSignatureUrl: signatureUrl,
        referredToSignedAt: now,
      };
  const fromDoctorId = isFrom ? doctorId : referral.referredFromDoctorId;
  const toDoctorId = isFrom ? referral.referredToDoctorId : doctorId;
  const complete = Boolean(
    fromDoctorId && toDoctorId && fromDoctorId !== toDoctorId,
  );

  const changesToSave = {
    ...changes,
    status: complete ? "READY_TO_ASSIGN" : "AWAITING_SIGN",
    statusHistory: [
      ...(referral.statusHistory ?? []),
      {
        status: complete ? "READY_TO_ASSIGN" : "AWAITING_SIGN",
        text: `${doctorName} signed as Referred ${isFrom ? "From" : "To"}`,
        at: now.toISOString(),
      },
    ],
  };

  return updateReferral(referral.id, changesToSave).then(() => ({
    id: referral.id,
    changes: changesToSave,
  }));
}
