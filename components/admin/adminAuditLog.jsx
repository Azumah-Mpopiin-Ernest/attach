import { useEffect, useMemo, useState } from "react";
import { getCollection } from "../../src/firebaseData";
import Pagination from "../shared/Pagination";

const PAGE_SIZE = 25;

export default function AdminAuditLog() {
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState([]);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    let active = true;
    getCollection("auditLog")
      .then((items) => {
        if (active) setEntries(items);
      })
      .catch((snapshotError) => {
        if (active) setError(snapshotError.message);
      });
    return () => {
      active = false;
    };
  }, []);

  const filtered = useMemo(
    () =>
      entries.filter((entry) =>
        entry.text.toLowerCase().includes(query.toLowerCase()),
      ),
    [entries, query],
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
        <h1 className="text-xl font-semibold text-slate-900">Audit Log</h1>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the log"
          className="w-64 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-[#2F6F62] focus:outline-none"
        />
      </div>

      {error && <p className="mt-4 text-sm text-rose-600">{error}</p>}

      <div className="mt-5 overflow-hidden rounded-md border border-slate-200 bg-white">
        <ul>
          {paginated.map((entry, i) => (
            <li
              key={i}
              className="flex items-start gap-3 border-b border-slate-100 px-5 py-3 text-sm last:border-0"
            >
              <span className="w-32 flex-none font-mono text-xs text-slate-400">
                {entry.time ?? formatDate(entry.createdAt)}
              </span>
              <span className="flex-1 text-slate-700">
                {entry.text ?? entry.action}
              </span>
              {entry.manual && (
                <span className="flex-none rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-200">
                  Manual
                </span>
              )}
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="px-5 py-10 text-center text-sm text-slate-400">
              No matching entries.
            </li>
          )}
        </ul>
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
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}
