import { useEffect, useMemo, useState } from "react";
import { Search, X, FileText, PenTool } from "lucide-react";
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

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "AWAITING_SIGN", label: "Awaiting signature" },
  { value: "READY_TO_ASSIGN", label: "Ready to assign" },
  { value: "ASSIGNED", label: "Assigned" },
  { value: "DONE", label: "Done" },
];

// initialStatusFilter lets the Dashboard deep-link in with a status
// pre-selected (see AdminDashboard's onNavigateToExplorer).
export default function AdminExplorer({ initialStatusFilter = "" }) {
  const [statusFilter, setStatusFilter] = useState(initialStatusFilter);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const [pendingAction, setPendingAction] = useState(null); // { type, referral }
  const [referrals, setReferrals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedIds, setSelectedIds] = useState([]);
  const [officers, setOfficers] = useState([]);
  const [assigning, setAssigning] = useState(false);
  const [page, setPage] = useState(1);

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
        setError(snapshotError.message);
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
        if (active) setError(snapshotError.message);
      });
    return () => {
      active = false;
    };
  }, []);

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
    setError("");
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
    } catch (assignmentError) {
      setError(assignmentError.message);
    } finally {
      setAssigning(false);
      event.target.value = "";
    }
  };

  const confirmAction = () => {
    if (!pendingAction) return;
    const { referral, type } = pendingAction;
    const nextStatus = type === "unlock" ? "READY_TO_ASSIGN" : "AWAITING_SIGN";
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
      })
      .catch((writeError) => setError(writeError.message));
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-slate-900">Explorer</h1>
      </div>

      {error && <p className="mt-4 text-sm text-rose-600">{error}</p>}

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
                value={officer.fullName ?? officer.name ?? officer.displayName}
              >
                {officer.fullName ??
                  officer.name ??
                  officer.displayName ??
                  officer.id}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-5 overflow-x-auto rounded-md border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
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
                        .every((referral) => selectedIds.includes(referral.id))
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
              <th className="px-5 py-3 font-medium">Patient</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 font-medium">Officer</th>
              <th className="px-5 py-3 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody>
            {loading &&
              Array.from({ length: 5 }, (_, index) => (
                <tr
                  key={`loading-${index}`}
                  className="border-b border-slate-100"
                >
                  <td colSpan={5} className="px-5 py-4">
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
                  <td className="px-5 py-3">
                    <div className="font-medium text-slate-800">
                      {r.name ?? r.patientName}
                    </div>
                    <div className="font-mono text-xs text-slate-400">
                      {r.patientId}
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <StatusChip status={r.status} officerName={r.officer} />
                  </td>
                  <td className="px-5 py-3 text-slate-600">
                    {r.officer ?? r.assignedOfficerName ?? "—"}
                  </td>
                  <td className="px-5 py-3 text-slate-400">
                    {formatDate(r.updatedAt)}
                  </td>
                </tr>
              ))}
            {!loading && filtered.length === 0 && (
              <tr>
                <td
                  colSpan={5}
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
                officerName={selected.officer}
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
                    disabled={selected.status !== "IN_PROGRESS"}
                    onClick={() =>
                      setPendingAction({ type: "unlock", referral: selected })
                    }
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Force unlock
                  </button>
                  <button
                    type="button"
                    disabled={selected.status !== "IN_PROGRESS"}
                    onClick={() =>
                      setPendingAction({ type: "reassign", referral: selected })
                    }
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Reassign
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setPendingAction({ type: "revert", referral: selected })
                    }
                    className="rounded-md border border-rose-200 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50"
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
          pendingAction?.type === "unlock"
            ? `Unlock ${pendingAction?.referral.name}?`
            : pendingAction?.type === "reassign"
              ? `Reassign ${pendingAction?.referral.name}?`
              : `Revert ${pendingAction?.referral.name}'s status?`
        }
        description={
          pendingAction?.type === "unlock"
            ? `This will return the record to Ready to Attach. ${pendingAction?.referral.officer} will lose their claim.`
            : pendingAction?.type === "reassign"
              ? "You'll choose a different officer to take over this claim."
              : "This moves the referral back one step. If it was already uploaded to LHIMS, this may create a duplicate entry there — confirm with the officer first."
        }
        confirmLabel={
          pendingAction?.type === "unlock"
            ? "Force unlock"
            : pendingAction?.type === "reassign"
              ? "Continue"
              : "Revert status"
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
