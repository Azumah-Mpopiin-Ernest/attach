import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import StatusChip from "./statusChip";
import { subscribeToReferrals } from "../../src/firebaseData";
import Pagination from "../shared/Pagination";

const PAGE_SIZE = 25;

export default function DoctorHistory({ doctorId }) {
  const [query, setQuery] = useState("");
  const [referrals, setReferrals] = useState([]);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (!doctorId) return undefined;
    return subscribeToReferrals({ doctorId }, setReferrals, (snapshotError) =>
      setError(snapshotError.message),
    );
  }, [doctorId]);

  const filtered = useMemo(
    () =>
      referrals.filter((r) =>
        `${r.name} ${r.patientId}`.toLowerCase().includes(query.toLowerCase()),
      ),
    [query, referrals],
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const paginated = filtered.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-slate-900">Signed History</h1>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or patient ID"
            className="w-64 rounded-md border border-slate-300 py-1.5 pl-8 pr-3 text-sm focus:border-[#2F6F62] focus:outline-none"
          />
        </div>
      </div>

      {error && <p className="mt-6 text-sm text-rose-600">{error}</p>}
      {!doctorId && (
        <p className="mt-6 text-sm text-slate-500">
          Sign in to view signed history.
        </p>
      )}
      <div className="mt-5 overflow-hidden rounded-md border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
              <th className="px-5 py-3 font-medium">Patient</th>
              <th className="px-5 py-3 font-medium">Signed on</th>
              <th className="px-5 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {paginated.map((r) => (
              <tr
                key={r.id}
                className="border-b border-slate-100 last:border-0"
              >
                <td className="px-5 py-3">
                  <div className="font-medium text-slate-800">
                    {r.name ?? r.patientName}
                  </div>
                  <div className="font-mono text-xs text-slate-400">
                    {r.patientId}
                  </div>
                </td>
                <td className="px-5 py-3 text-slate-500">
                  {formatDate(r.signedAt)}
                </td>
                <td className="px-5 py-3">
                  <StatusChip status={r.status} />
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={3}
                  className="px-5 py-10 text-center text-slate-400"
                >
                  No signed referrals match your search.
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
    </div>
  );
}

function formatDate(value) {
  if (!value) return "—";
  const date = value.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}
