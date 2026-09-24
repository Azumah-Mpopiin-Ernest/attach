import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Search,
} from "lucide-react";
import {
  subscribeToReferrals,
  updateReferralsTransaction,
} from "../../src/firebaseData";

const PAGE_SIZE = 25;
const MAX_BATCH = 100;
// Firestore caps a transaction at 10 MiB. Signature data URLs are copied onto
// every referral, so large inline signatures shrink the chunk size.
const TRANSACTION_BYTE_BUDGET = 6_000_000;
const MAX_INLINE_SIGNATURE_CHARS = 700_000; // a Firestore document is 1 MiB max

export default function DoctorPending({
  doctorId,
  doctorName,
  signatureUrl,
  onGoToProfile,
  onSigned,
}) {
  const [query, setQuery] = useState("");
  const [referrals, setReferrals] = useState([]);
  const [loadError, setLoadError] = useState("");
  const [message, setMessage] = useState(null); // { type: "error" | "warning", text }
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState([]);
  const [signingIds, setSigningIds] = useState([]);
  const [signatureSide, setSignatureSide] = useState("from");
  const [queueTab, setQueueTab] = useState("unsigned");

  const isSigning = signingIds.length > 0;

  useEffect(() => {
    return subscribeToReferrals(
      { status: "AWAITING_SIGN" },
      (items) => {
        setReferrals(items);
        setLoading(false);
      },
      (snapshotError) => {
        setLoadError(snapshotError.message);
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

  const filtered = useMemo(() => {
    const needle = query.toLowerCase();
    return eligibleReferrals[queueTab]
      .slice()
      .sort((a, b) =>
        String(a.referralDate ?? "").localeCompare(
          String(b.referralDate ?? ""),
        ),
      )
      .filter((referral) =>
        `${referral.name} ${referral.patientId} ${referral.nhis}`
          .toLowerCase()
          .includes(needle),
      );
  }, [eligibleReferrals, query, queueTab]);

  // Only ever act on what the doctor can see: when the tab or search changes,
  // or another doctor signs something, drop selections that are no longer
  // in the visible list so nothing hidden gets signed.
  useEffect(() => {
    const visible = new Set(filtered.map((item) => item.id));
    setSelectedIds((current) => {
      const next = current.filter((id) => visible.has(id));
      return next.length === current.length ? current : next;
    });
  }, [filtered]);

  useEffect(() => {
    setPage(1);
  }, [queueTab, query]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const paginated = filtered.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedItems = useMemo(
    () => filtered.filter((item) => selectedSet.has(item.id)),
    [filtered, selectedSet],
  );
  const pageSelected =
    paginated.length > 0 && paginated.every((item) => selectedSet.has(item.id));
  const firstBatchCount = Math.min(MAX_BATCH, filtered.length);

  const limitMessage = {
    type: "warning",
    text: `You can sign up to ${MAX_BATCH} referrals at a time.`,
  };

  const toggleSelected = (id) => {
    if (selectedSet.has(id)) {
      setSelectedIds(selectedIds.filter((item) => item !== id));
      return;
    }
    if (selectedIds.length >= MAX_BATCH) {
      setMessage(limitMessage);
      return;
    }
    setMessage(null);
    setSelectedIds([...selectedIds, id]);
  };

  const togglePage = () => {
    if (pageSelected) {
      const pageIds = new Set(paginated.map((item) => item.id));
      setSelectedIds(selectedIds.filter((id) => !pageIds.has(id)));
      return;
    }
    const merged = [
      ...new Set([...selectedIds, ...paginated.map((item) => item.id)]),
    ];
    setMessage(merged.length > MAX_BATCH ? limitMessage : null);
    setSelectedIds(merged.slice(0, MAX_BATCH));
  };

  const selectFirstBatch = () => {
    setMessage(null);
    setSelectedIds(filtered.slice(0, MAX_BATCH).map((item) => item.id));
  };

  const sideLabel =
    queueTab === "needsOtherSignature"
      ? "the missing signer"
      : signatureSide === "from"
        ? "Referred From doctor"
        : "Referred To doctor";

  const approveAndSign = async (items) => {
    if (isSigning) return;
    if (!items.length) {
      setMessage({
        type: "error",
        text: "Select at least one referral before approving and signing.",
      });
      return;
    }
    if (!doctorId || !doctorName) {
      setMessage({
        type: "error",
        text: "Your doctor account is still loading. Please try again shortly.",
      });
      return;
    }
    if (!signatureUrl) {
      setMessage({
        type: "error",
        text: "You have not uploaded a signature yet. Upload it from your Profile before signing referrals.",
      });
      return;
    }
    if (signatureUrl.length > MAX_INLINE_SIGNATURE_CHARS) {
      setMessage({
        type: "error",
        text: "Your signature image is too large to attach to referrals. Upload a smaller image from your Profile.",
      });
      return;
    }
    if (
      items.length > 1 &&
      !window.confirm(
        `Sign ${items.length} referrals as ${sideLabel}? This can't be undone.`,
      )
    ) {
      return;
    }

    const ids = items.map((item) => item.id);
    const chunkSize = Math.max(
      1,
      Math.min(
        MAX_BATCH,
        Math.floor(TRANSACTION_BYTE_BUDGET / (signatureUrl.length + 2_000)),
      ),
    );

    setSigningIds(ids);
    setMessage(null);

    const reportSkipped = (skipped) => {
      if (!skipped.length) return;
      const reasons = [...new Set(skipped.map((item) => item.reason))];
      setMessage({
        type: "warning",
        text: `${skipped.length} referral${skipped.length === 1 ? " was" : "s were"} skipped and left unsigned. ${reasons.join(" ")}`,
      });
    };

    try {
      const { applied, skipped } = await updateReferralsTransaction(
        ids,
        (fresh) =>
          buildSignChanges(fresh, {
            doctorId,
            doctorName,
            signatureUrl,
            side:
              queueTab === "needsOtherSignature"
                ? missingSide(fresh)
                : signatureSide,
          }),
        { chunkSize },
      );
      // The live subscription removes signed referrals from the queue.
      const signedIds = new Set(applied.map((item) => item.id));
      setSelectedIds((current) => current.filter((id) => !signedIds.has(id)));
      if (applied.length) onSigned?.(applied.length);
      reportSkipped(skipped);
    } catch (writeError) {
      const done = writeError.applied ?? [];
      if (done.length) {
        const signedIds = new Set(done.map((item) => item.id));
        setSelectedIds((current) => current.filter((id) => !signedIds.has(id)));
        onSigned?.(done.length);
      }
      setMessage({
        type: "error",
        text: done.length
          ? `${done.length} referral${done.length === 1 ? " was" : "s were"} signed before an error stopped the rest: ${writeError.message} Try again to sign the remainder.`
          : `Nothing was signed: ${writeError.message}`,
      });
    } finally {
      setSigningIds([]);
    }
  };

  // One click: sign the oldest MAX_BATCH referrals in the current tab/search.
  const signFirstBatch = () => approveAndSign(filtered.slice(0, MAX_BATCH));

  return (
    <div>
      {/* Sticky controls: everything a doctor needs stays in view while they
          scroll through a page of rows, so selecting, paging and signing never
          requires scrolling back up or down. */}
      <div className="sticky top-0 z-10 rounded-lg border border-slate-200 bg-white px-5 py-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <h1 className="text-xl font-semibold text-slate-900">
            Pending Signatures
          </h1>
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by name or NHIS"
              className="w-full rounded-md border border-slate-300 py-2 pl-9 pr-3 text-sm focus:border-[#2F6F62] focus:outline-none"
            />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <span
              id="sign-as-label"
              className="text-sm font-medium text-slate-600"
            >
              Sign as
            </span>
            <div
              role="radiogroup"
              aria-labelledby="sign-as-label"
              className="inline-flex rounded-md border border-slate-300 p-0.5"
            >
              {[
                ["from", "Referred From"],
                ["to", "Referred To"],
              ].map(([value, label]) => {
                const active = signatureSide === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={queueTab === "needsOtherSignature" || isSigning}
                    onClick={() => setSignatureSide(value)}
                    className={`rounded px-4 py-1.5 text-sm font-medium disabled:cursor-not-allowed ${
                      active
                        ? "bg-[#2F6F62] text-white disabled:opacity-60"
                        : "text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {queueTab === "needsOtherSignature" && (
              <span className="text-xs text-slate-400">
                Matched to the missing signature
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {selectedIds.length > 0 ? (
              <button
                type="button"
                onClick={() => setSelectedIds([])}
                disabled={isSigning}
                className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Clear selection
              </button>
            ) : (
              <button
                type="button"
                onClick={selectFirstBatch}
                disabled={isSigning || filtered.length === 0}
                className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Select first {firstBatchCount}
              </button>
            )}
            <button
              type="button"
              disabled={!selectedItems.length || isSigning}
              onClick={() => approveAndSign(selectedItems)}
              className="inline-flex items-center gap-1.5 rounded-md bg-[#2F6F62] px-4 py-2 text-sm font-medium text-white hover:bg-[#265a50] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSigning ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              {isSigning
                ? `Signing ${signingIds.length}...`
                : `Approve & Sign${selectedItems.length ? ` (${selectedItems.length})` : ""}`}
            </button>
            {selectedIds.length === 0 && filtered.length > 1 && (
              <button
                type="button"
                onClick={signFirstBatch}
                disabled={isSigning}
                className="inline-flex items-center gap-1.5 rounded-md border border-[#2F6F62] px-4 py-2 text-sm font-medium text-[#2F6F62] hover:bg-[#2F6F62]/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Sign first {firstBatchCount}
              </button>
            )}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b border-slate-200">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setQueueTab("unsigned")}
              disabled={isSigning}
              className={`border-b-2 px-3 py-2.5 text-sm font-medium ${queueTab === "unsigned" ? "border-[#2F6F62] text-[#2F6F62]" : "border-transparent text-slate-500"}`}
            >
              Unsigned forms ({eligibleReferrals.unsigned.length})
            </button>
            <button
              type="button"
              onClick={() => setQueueTab("needsOtherSignature")}
              disabled={isSigning}
              className={`border-b-2 px-3 py-2.5 text-sm font-medium ${queueTab === "needsOtherSignature" ? "border-[#2F6F62] text-[#2F6F62]" : "border-transparent text-slate-500"}`}
            >
              Awaiting your signature (
              {eligibleReferrals.needsOtherSignature.length})
            </button>
          </div>
          {!loading && !loadError && filtered.length > 0 && (
            <div className="flex items-center gap-4 pb-2">
              {selectedIds.length > 0 && (
                <span className="text-sm text-slate-500">
                  {selectedIds.length}/{MAX_BATCH} selected
                </span>
              )}
              <CompactPager
                page={currentPage}
                pageCount={pageCount}
                pageSize={PAGE_SIZE}
                total={filtered.length}
                onPageChange={setPage}
              />
            </div>
          )}
        </div>

        {message && (
          <div
            className={`mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3 text-sm ${
              message.type === "error"
                ? "border-rose-200 bg-rose-50 text-rose-700"
                : "border-amber-200 bg-amber-50 text-amber-800"
            }`}
            role={message.type === "error" ? "alert" : "status"}
          >
            <span>{message.text}</span>
            <button
              type="button"
              onClick={() => setMessage(null)}
              className="rounded-md border border-current px-2.5 py-1 text-xs font-medium"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>

      {loadError && (
        <div
          className="mt-4 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
          role="alert"
        >
          {loadError}
        </div>
      )}
      {!signatureUrl && !loading && !loadError && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
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
      {loading && !loadError && (
        <div className="mt-16 flex items-center justify-center gap-2 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading pending
          signatures...
        </div>
      )}
      {!loading &&
        !loadError &&
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
          <div className="mt-4 overflow-x-auto rounded-md border border-slate-200 bg-white">
            <table className="min-w-[720px] w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                  <th className="w-10 px-5 py-3 font-medium">
                    <input
                      type="checkbox"
                      aria-label="Select all referrals on this page"
                      checked={pageSelected}
                      disabled={isSigning}
                      onChange={togglePage}
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
                        checked={selectedSet.has(referral.id)}
                        disabled={isSigning}
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
                        disabled={isSigning}
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
          </div>
        ))}
    </div>
  );
}

function CompactPager({ page, pageCount, pageSize, total, onPageChange }) {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const buttonClass =
    "rounded-md border border-slate-300 p-1.5 text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <nav
      className="flex items-center gap-2 text-sm text-slate-600"
      aria-label="Pagination"
    >
      <span className="hidden text-slate-400 sm:inline">
        {from}–{to} of {total}
      </span>
      <button
        type="button"
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
        aria-label="Previous page"
        className={buttonClass}
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <span className="whitespace-nowrap">
        Page {page} of {pageCount}
      </span>
      <button
        type="button"
        onClick={() => onPageChange(page + 1)}
        disabled={page >= pageCount}
        aria-label="Next page"
        className={buttonClass}
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </nav>
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

// Pure and synchronous. Runs inside the Firestore transaction against the
// referral's current server state, and throws to skip a referral that can no
// longer be signed (someone else got there first, or it already moved on).
function buildSignChanges(
  referral,
  { doctorId, doctorName, signatureUrl, side },
) {
  if (referral.status !== "AWAITING_SIGN") {
    throw new Error("Some referrals were already processed by someone else.");
  }

  const isFrom = side === "from";
  const otherDoctorId = isFrom
    ? referral.referredToDoctorId
    : referral.referredFromDoctorId;
  const existingDoctorId = isFrom
    ? referral.referredFromDoctorId
    : referral.referredToDoctorId;

  if (existingDoctorId) {
    throw new Error(
      `The Referred ${isFrom ? "From" : "To"} signature was already completed by another doctor.`,
    );
  }
  if (otherDoctorId === doctorId) {
    throw new Error(
      "One doctor cannot sign both Referred From and Referred To.",
    );
  }

  const now = new Date();
  const slotChanges = isFrom
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
  const status = complete ? "READY_TO_ASSIGN" : "AWAITING_SIGN";

  return {
    ...slotChanges,
    status,
    statusHistory: [
      ...(referral.statusHistory ?? []),
      {
        status,
        text: `${doctorName} signed as Referred ${isFrom ? "From" : "To"}`,
        at: now.toISOString(),
      },
    ],
  };
}
