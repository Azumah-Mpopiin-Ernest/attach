import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Copy, Download, Search } from "lucide-react";
import OfficerLayout from "./officerLayout";
import { completeReferral, subscribeToReferrals } from "../../src/firebaseData";
import {
  getDateKey,
  formatDateLabel,
  compareDateKeys,
} from "../../src/referralDates";
import Pagination from "../shared/Pagination";
import { downloadReferralForm } from "../../src/referralForm";

const PAGE_SIZE = 25;

export default function OfficerApp({ officerName, onSignOut }) {
  const [referrals, setReferrals] = useState([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [copiedId, setCopiedId] = useState(null);
  const [savingId, setSavingId] = useState(null);
  const [page, setPage] = useState(1);
  const [selectedDateKey, setSelectedDateKey] = useState(null);

  useEffect(
    () =>
      subscribeToReferrals(
        { assignedTo: officerName },
        setReferrals,
        (snapshotError) => setError(snapshotError.message),
      ),
    [officerName],
  );

  const assignedReferrals = useMemo(
    () => referrals.filter((referral) => referral.status === "ASSIGNED"),
    [referrals],
  );

  // Group the officer's queue by the date on the form (referral.referralDate)
  // so they can pick one admission date, open that date's list in LHIMS,
  // and work straight through it — mirroring how the paper forms used to
  // be sorted before upload.
  const dateGroups = useMemo(() => {
    const counts = new Map();
    assignedReferrals.forEach((referral) => {
      const key = getDateKey(referral);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    return Array.from(counts.entries())
      .sort(([a], [b]) => compareDateKeys(a, b))
      .map(([key, count]) => ({ key, label: formatDateLabel(key), count }));
  }, [assignedReferrals]);

  // The date the officer is actually working, derived synchronously every
  // render rather than via an effect: falls back to the oldest date with
  // work waiting whenever `selectedDateKey` isn't (or is no longer) a
  // valid choice — covers both the very first render, before any click
  // has set a preference, and auto-advancing once the current date's
  // queue empties (e.g. right after the last referral for that date is
  // marked done).
  const effectiveDateKey = dateGroups.some(
    (group) => group.key === selectedDateKey,
  )
    ? selectedDateKey
    : (dateGroups[0]?.key ?? null);

  const visibleReferrals = useMemo(() => {
    const normalizedQuery = query.toLowerCase();
    return assignedReferrals.filter(
      (referral) =>
        getDateKey(referral) === effectiveDateKey &&
        `${referral.name ?? referral.patientName ?? ""} ${referral.patientId ?? ""} ${referral.nhis ?? ""}`
          .toLowerCase()
          .includes(normalizedQuery),
    );
  }, [query, assignedReferrals, effectiveDateKey]);

  const pageCount = Math.max(1, Math.ceil(visibleReferrals.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const paginatedReferrals = visibleReferrals.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );

  // Jumping to a different date, or a search narrowing the visible set,
  // can both leave `page` pointing past the end — reset to page 1 rather
  // than showing a blank table.
  useEffect(() => {
    setPage(1);
  }, [effectiveDateKey, query]);

  const copyPatientId = async (patientId) => {
    await navigator.clipboard?.writeText(patientId);
    setCopiedId(patientId);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const downloadForm = async (referral) => {
    try {
      await downloadReferralForm(referral);
    } catch (downloadError) {
      setError(downloadError.message);
    }
  };

  const markDone = async (referral) => {
    setSavingId(referral.id);
    setError("");
    try {
      await completeReferral(referral.id);
      setReferrals((current) =>
        current.filter((item) => item.id !== referral.id),
      );
    } catch (writeError) {
      setError(writeError.message);
    } finally {
      setSavingId(null);
    }
  };

  return (
    <OfficerLayout officerName={officerName} onSignOut={onSignOut}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">
            Assigned queue
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {effectiveDateKey
              ? `Open ${formatDateLabel(effectiveDateKey)}'s patient list in LHIMS, then work straight through the referrals below.`
              : "Complete the LHIMS save manually, then mark the record done here."}
          </p>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search patient or ID"
            className="w-full rounded-md border border-slate-300 py-1.5 pl-8 pr-3 text-sm sm:w-64"
          />
        </div>
      </div>

      {dateGroups.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {dateGroups.map((group) => {
            const isSelected = group.key === effectiveDateKey;
            return (
              <button
                key={group.key}
                type="button"
                onClick={() => setSelectedDateKey(group.key)}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                  isSelected
                    ? "border-[#2F6F62] bg-[#2F6F62] text-white"
                    : "border-slate-300 text-slate-600 hover:bg-slate-50"
                }`}
              >
                {group.label}
                <span
                  className={`ml-1.5 ${isSelected ? "text-white/80" : "text-slate-400"}`}
                >
                  {group.count}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {error && <p className="mt-4 text-sm text-rose-600">{error}</p>}

      {dateGroups.length === 0 ? (
        <div className="mt-5 rounded-md border border-slate-200 bg-white px-5 py-12 text-center text-slate-400">
          No assigned records in your queue.
        </div>
      ) : (
        <div className="mt-5 overflow-x-auto rounded-md border border-slate-200 bg-white">
          <table className="min-w-[760px] w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                <th className="px-5 py-3 font-medium">Patient</th>
                <th className="px-5 py-3 font-medium">NHIS</th>
                <th className="px-5 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {paginatedReferrals.map((referral) => (
                <tr
                  key={referral.id}
                  className="border-b border-slate-100 last:border-0"
                >
                  <td className="px-5 py-3">
                    <div className="font-medium text-slate-800">
                      {referral.name ?? referral.patientName}
                    </div>
                    <div className="font-mono text-xs text-slate-400">
                      {referral.patientId}
                    </div>
                  </td>
                  <td className="px-5 py-3 font-mono text-slate-600">
                    {referral.nhis ?? "—"}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => copyPatientId(referral.patientId)}
                        className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                      >
                        <Copy className="h-3.5 w-3.5" />
                        {copiedId === referral.patientId ? "Copied" : "Copy ID"}
                      </button>
                      <button
                        type="button"
                        onClick={() => downloadForm(referral)}
                        className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                      >
                        <Download className="h-3.5 w-3.5" />
                        Download Form
                      </button>
                      <button
                        type="button"
                        disabled={savingId === referral.id}
                        onClick={() => markDone(referral)}
                        className="inline-flex items-center gap-1.5 rounded-md bg-[#2F6F62] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#265a50] disabled:opacity-50"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        {savingId === referral.id ? "Saving..." : "Mark Done"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {!visibleReferrals.length && (
                <tr>
                  <td
                    colSpan={3}
                    className="px-5 py-12 text-center text-slate-400"
                  >
                    No referrals for{" "}
                    {effectiveDateKey
                      ? formatDateLabel(effectiveDateKey)
                      : "this date"}{" "}
                    match your search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <Pagination
            page={currentPage}
            pageCount={pageCount}
            onPageChange={setPage}
            total={visibleReferrals.length}
          />
        </div>
      )}
    </OfficerLayout>
  );
}
