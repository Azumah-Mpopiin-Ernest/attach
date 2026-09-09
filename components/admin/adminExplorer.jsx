import { useEffect, useMemo, useState } from "react";
import { Search, X, FileText, PenTool, CheckCircle2 } from "lucide-react";
import StatusChip from "./statusChip";
import ConfirmDialog from "./confirmDialog";
import {
  getCollection,
  getReferrals,
  updateDocuments,
  updateReferral,
} from "../../src/firebaseData";
import Pagination from "../shared/Pagination";

const PAGE_SIZE = 25;
const NOTICE_DURATION_MS = 4000;

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "AWAITING_SIGN", label: "Awaiting signature" },
  { value: "READY_TO_ASSIGN", label: "Ready to assign" },
  { value: "ASSIGNED", label: "Assigned" },
  { value: "DONE", label: "Done" },
];

const ACTION_LABELS = {
  unlock: {
    title: (name) => `Unlock ${name}?`,
    description: (referral) =>
      `This will return the record to Ready to assign. ${referral.assignedTo} will lose their claim.`,
    confirmLabel: "Force unlock",
    successText: (referral) => `${referral.name} is back in Ready to assign.`,
  },
  reassign: {
    title: (name) => `Reassign ${name}?`,
    description: () =>
      "This returns the record to Ready to assign so you can hand it to a different officer.",
    confirmLabel: "Continue",
    successText: (referral) =>
      `${referral.name} is ready to assign to a different officer.`,
  },
  revert: {
    title: (name) => `Revert ${name}'s status?`,
    description: () =>
      "This moves the referral back to Ready to assign. If it was already uploaded to LHIMS, this may create a duplicate entry there — confirm with the officer first.",
    confirmLabel: "Revert status",
    successText: (referral) => `${referral.name}'s status was reverted.`,
  },
};

// initialStatusFilter lets the Dashboard deep-link in with a status
// pre-selected (see AdminDashboard's onNavigateToExplorer).
export default function AdminExplorer({ initialStatusFilter = "" }) {
  const [statusFilter, setStatusFilter] = useState(initialStatusFilter);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const [pendingAction, setPendingAction] = useState(null); // { type, referral }
  const [referrals, setReferrals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null); // { type: 'success' | 'error', text }
  const [selectedIds, setSelectedIds] = useState([]);
  const [officers, setOfficers] = useState([]);
  const [assigning, setAssigning] = useState(false);
  const [page, setPage] = useState(1);

  // Bulk assignment only ever applies to READY_TO_ASSIGN records, so the
  // whole selection UI (checkboxes, the "N selected" bar, the assign
  // dropdown) is scoped to that filter. Selecting rows on any other filter
  // can't lead anywhere, which was the source of the "why won't this work"
  // confusion.
  const assignmentModeActive = statusFilter === "READY_TO_ASSIGN";

  useEffect(() => {
    let active = true;
    getReferrals()
      .then((items) => {
        if (!active) return;
        setReferrals(items);
        setLoading(false);
      })
      .catch((snapshotError) => {
        if (!active) return;
        showNotice("error", snapshotError.message);
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    getCollection("users")
      .then((users) => {
        if (!active) return;
        setOfficers(
          users.filter(
            (user) =>
              String(user.role).toLowerCase() === "officer" &&
              user.active !== false,
          ),
        );
      })
      .catch((snapshotError) => {
        if (active) showNotice("error", snapshotError.message);
      });
    return () => {
      active = false;
    };
  }, []);

  // Clear any stale selection when leaving Ready to assign, so switching
  // filters back and forth never leaves a hidden selection behind.
  useEffect(() => {
    if (!assignmentModeActive) setSelectedIds([]);
  }, [assignmentModeActive]);

  useEffect(() => {
    if (!notice) return undefined;
    const timeout = setTimeout(() => setNotice(null), NOTICE_DURATION_MS);
    return () => clearTimeout(timeout);
  }, [notice]);

  const showNotice = (type, text) => setNotice({ type, text });

  const filtered = useMemo(() => {
    return referrals.filter((r) => {
      if (statusFilter && r.status !== statusFilter) return false;
      if (
        query &&
        !`${r.name} ${r.patientId} ${r.nhis}`
          .toLowerCase()
          .includes(query.toLowerCase())
      )
        return false;
      return true;
    });
  }, [referrals, statusFilter, query]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const paginated = filtered.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );

  const columnCount = assignmentModeActive ? 3 : 2;

  const closeDrawer = () => setSelected(null);

  const toggleSelected = (id) => {
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
  };

  const assignSelected = async (event) => {
    const assignedTo = event.target.value;
    if (!assignedTo || !selectedIds.length) return;
    setAssigning(true);
    try {
      const currentReferrals = await getReferrals({ force: true });
      const selectedReferrals = currentReferrals.filter((referral) =>
        selectedIds.includes(referral.id),
      );
      const assignableReferrals =
        selectedReferrals.filter(isAssignableReferral);
      if (assignableReferrals.length !== selectedIds.length) {
        setReferrals(currentReferrals);
        setSelectedIds(assignableReferrals.map((referral) => referral.id));
        throw new Error(
          "Only referrals signed by both doctors can be assigned.",
        );
      }

      await updateDocuments(
        "referrals",
        assignableReferrals.map((referral) => referral.id),
        {
          status: "ASSIGNED",
          assignedTo,
          assignedAt: new Date(),
        },
      );
      setReferrals(await getReferrals({ force: true }));
      setSelectedIds([]);
      showNotice(
        "success",
        assignableReferrals.length === 1
          ? `${assignableReferrals[0].name} was assigned to ${assignedTo}.`
          : `${assignableReferrals.length} referrals were assigned to ${assignedTo}.`,
      );
    } catch (assignmentError) {
      showNotice("error", assignmentError.message);
    } finally {
      setAssigning(false);
      event.target.value = "";
    }
  };

  const confirmAction = () => {
    if (!pendingAction) return;
    const { referral, type } = pendingAction;
    const labels = ACTION_LABELS[type];
    // Unlock, reassign, and revert all hand the record back to the
    // assignable pool. Sending it further back to AWAITING_SIGN while the
    // doctor-id fields are still populated is what used to orphan a
    // fully-signed referral, since nothing in the doctor-signing flow would
    // ever route it back out.
    const nextStatus = "READY_TO_ASSIGN";
    updateReferral(referral.id, {
      status: nextStatus,
      ...(type === "unlock" ? { assignedOfficerId: null, lockedAt: null } : {}),
      statusHistory: [
        ...(referral.statusHistory ?? referral.history ?? []),
        {
          status: nextStatus,
          text: `Manual ${type} by Admin`,
          manual: true,
          at: new Date().toISOString(),
        },
      ],
    })
      .then(async () => {
        setReferrals(await getReferrals({ force: true }));
        setPendingAction(null);
        setSelected(null);
        showNotice("success", labels.successText(referral));
      })
      .catch((writeError) => showNotice("error", writeError.message));
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-slate-900">Explorer</h1>
      </div>

      {notice && (
        <div
          className={`mt-4 flex items-center gap-2 rounded-md px-3 py-2 text-sm ${
            notice.type === "success"
              ? "bg-emerald-50 text-emerald-700"
              : "bg-rose-50 text-rose-600"
          }`}
        >
          {notice.type === "success" && (
            <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
          )}
          <span>{notice.text}</span>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 focus:border-[#2F6F62] focus:outline-none"
        >
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>

        <div className="relative w-full sm:w-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, patient ID, or NHIS"
            className="w-full rounded-md border border-slate-300 py-1.5 pl-8 pr-3 text-sm focus:border-[#2F6F62] focus:outline-none sm:w-72"
          />
        </div>

        {assignmentModeActive && (
          <label className="flex w-full flex-wrap items-center gap-2 text-sm text-slate-600 sm:ml-auto sm:w-auto sm:flex-nowrap">
            <span>{selectedIds.length} selected</span>
            <select
              disabled={
                !selectedIds.length ||
                assigning ||
                selectedIds.some(
                  (id) =>
                    !isAssignableReferral(
                      referrals.find((referral) => referral.id === id),
                    ),
                )
              }
              defaultValue=""
              onChange={assignSelected}
              className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-1.5 disabled:opacity-50 sm:flex-none"
            >
              <option value="">Assign selected to...</option>
              {officers.map((officer) => (
                <option
                  key={officer.id}
                  value={
                    officer.fullName ?? officer.name ?? officer.displayName
                  }
                >
                  {officer.fullName ??
                    officer.name ??
                    officer.displayName ??
                    officer.id}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="mt-5 overflow-x-auto rounded-md border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
              {assignmentModeActive && (
                <th className="w-10 px-5 py-3 font-medium">
                  <input
                    type="checkbox"
                    aria-label="Select all visible referrals"
                    checked={
                      paginated.some(isAssignableReferral) &&
                      paginated
                        .filter(isAssignableReferral)
                        .every((referral) => selectedIds.includes(referral.id))
                    }
                    onChange={() =>
                      setSelectedIds(
                        paginated
                          .filter(isAssignableReferral)
                          .every((referral) =>
                            selectedIds.includes(referral.id),
                          )
                          ? []
                          : [
                              ...new Set([
                                ...selectedIds,
                                ...paginated
                                  .filter(isAssignableReferral)
                                  .map((referral) => referral.id),
                              ]),
                            ],
                      )
                    }
                  />
                </th>
              )}
              <th className="px-5 py-3 font-medium">Patient</th>
              <th className="px-5 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {loading &&
              Array.from({ length: 5 }, (_, index) => (
                <tr
                  key={`loading-${index}`}
                  className="border-b border-slate-100"
                >
                  <td colSpan={columnCount} className="px-5 py-4">
                    <div className="h-4 w-full animate-pulse rounded bg-slate-100" />
                  </td>
                </tr>
              ))}
            {!loading &&
              paginated.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setSelected(r)}
                  className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
                >
                  {assignmentModeActive && (
                    <td className="px-5 py-3">
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.name ?? r.patientName ?? r.patientId}`}
                        disabled={!isAssignableReferral(r)}
                        checked={selectedIds.includes(r.id)}
                        onChange={() => toggleSelected(r.id)}
                        onClick={(event) => event.stopPropagation()}
                      />
                    </td>
                  )}
                  <td className="px-5 py-3">
                    <div className="font-medium text-slate-800">
                      {r.name ?? r.patientName}
                    </div>
                    <div className="font-mono text-xs text-slate-400">
                      {r.patientId}
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <StatusChip status={r.status} officerName={r.assignedTo} />
                  </td>
                </tr>
              ))}
            {!loading && filtered.length === 0 && (
              <tr>
                <td
                  colSpan={columnCount}
                  className="px-5 py-10 text-center text-slate-400"
                >
                  No referrals match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <Pagination
          page={currentPage}
          pageCount={pageCount}
          onPageChange={setPage}
          total={filtered.length}
        />
      </div>

      {/* Detail drawer */}
      {selected && (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/30">
          <div className="flex h-full w-full max-w-md flex-col bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  {selected.name}
                </h2>
                <p className="font-mono text-xs text-slate-400">
                  {selected.patientId}
                </p>
              </div>
              <button
                type="button"
                onClick={closeDrawer}
                className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              <StatusChip
                status={selected.status}
                officerName={selected.assignedTo}
              />

              <div className="mt-5 flex gap-2">
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                >
                  <FileText className="h-3.5 w-3.5" /> View PDF
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                >
                  <PenTool className="h-3.5 w-3.5" /> View signature
                </button>
              </div>

              <div className="mt-6">
                <h3 className="text-xs font-medium uppercase tracking-wide text-slate-400">
                  Override actions
                </h3>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={selected.status !== "ASSIGNED"}
                    onClick={() =>
                      setPendingAction({ type: "unlock", referral: selected })
                    }
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Force unlock
                  </button>
                  <button
                    type="button"
                    disabled={selected.status !== "ASSIGNED"}
                    onClick={() =>
                      setPendingAction({ type: "reassign", referral: selected })
                    }
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Reassign
                  </button>
                  <button
                    type="button"
                    disabled={selected.status !== "ASSIGNED"}
                    onClick={() =>
                      setPendingAction({ type: "revert", referral: selected })
                    }
                    className="rounded-md border border-rose-200 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Revert status
                  </button>
                </div>
              </div>

              <div className="mt-6">
                <h3 className="text-xs font-medium uppercase tracking-wide text-slate-400">
                  History
                </h3>
                <ul className="mt-2 space-y-3">
                  {(selected.statusHistory ?? selected.history ?? []).map(
                    (h, i) => (
                      <li key={i} className="text-sm">
                        <div className="flex items-center gap-2">
                          <span className="text-slate-400">
                            {h.time ?? formatDate(h.at)}
                          </span>
                          {h.manual && (
                            <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-200">
                              Manual
                            </span>
                          )}
                        </div>
                        <p className="text-slate-700">{h.text}</p>
                      </li>
                    ),
                  )}
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(pendingAction)}
        title={
          pendingAction &&
          ACTION_LABELS[pendingAction.type].title(pendingAction.referral.name)
        }
        description={
          pendingAction &&
          ACTION_LABELS[pendingAction.type].description(pendingAction.referral)
        }
        confirmLabel={
          pendingAction && ACTION_LABELS[pendingAction.type].confirmLabel
        }
        tone={pendingAction?.type === "revert" ? "danger" : "default"}
        onConfirm={confirmAction}
        onCancel={() => setPendingAction(null)}
      />
    </div>
  );
}

function formatDate(value) {
  if (!value) return "—";
  const date = value.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function isAssignableReferral(referral) {
  return Boolean(
    referral?.status === "READY_TO_ASSIGN" &&
    referral.referredFromDoctorId &&
    referral.referredToDoctorId &&
    referral.referredFromDoctorId !== referral.referredToDoctorId,
  );
}
