import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Copy,
  Download,
  RefreshCw,
  Search,
  WifiOff,
} from "lucide-react";
import OfficerLayout from "./officerLayout";
import ConfirmDialog from "../admin/confirmDialog";
import { completeReferral, subscribeToReferrals } from "../../src/firebaseData";
import {
  getDateKey,
  formatDateLabel,
  compareDateKeys,
} from "../../src/referralDates";
import Pagination from "../shared/Pagination";
import { downloadReferralForm } from "../../src/referralForm";

const PAGE_SIZE = 25;

// Signature URLs already requested this session, so the offline prefetch
// below doesn't re-fetch every signature after each Mark Done.
const prefetchedSignatures = new Set();

function useBrowserOnline() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);
  return online;
}

export default function OfficerApp({ officerName, onSignOut }) {
  const [referrals, setReferrals] = useState([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [copiedId, setCopiedId] = useState(null);
  const [page, setPage] = useState(1);
  const [selectedDateKey, setSelectedDateKey] = useState(null);
  const [pendingReferral, setPendingReferral] = useState(null);

  // Completions started but not yet confirmed by the server.
  const [unsynced, setUnsynced] = useState(0);
  const browserOnline = useBrowserOnline();
  const [fromCache, setFromCache] = useState(false);
  const [cacheStale, setCacheStale] = useState(false);

  useEffect(
    () =>
      subscribeToReferrals(
        { assignedTo: officerName, includeMetadata: true },
        (items, meta) => {
          setReferrals(items);
          setFromCache(Boolean(meta?.fromCache));
        },
        (snapshotError) => setError(snapshotError.message),
      ),
    [officerName],
  );

  // navigator.onLine is true on a LAN with no internet, so also treat
  // "Firestore has only been able to answer from cache for 4s" as offline.
  useEffect(() => {
    if (!fromCache) {
      setCacheStale(false);
      return undefined;
    }
    const timer = setTimeout(() => setCacheStale(true), 4000);
    return () => clearTimeout(timer);
  }, [fromCache]);

  const offline = !browserOnline || cacheStale;

  const assignedReferrals = useMemo(
    () => referrals.filter((referral) => referral.status === "ASSIGNED"),
    [referrals],
  );

  // While online, touch each doctor signature image once so the service
  // worker keeps a copy for offline "Download Form".
  useEffect(() => {
    if (offline) return;
    const urls = new Set();
    assignedReferrals.forEach((referral) => {
      [referral.referredFromSignatureUrl, referral.referredToSignatureUrl]
        .filter(Boolean)
        .forEach((url) => urls.add(url));
    });
    urls.forEach((url) => {
      if (prefetchedSignatures.has(url)) return;
      prefetchedSignatures.add(url);
      fetch(url, { mode: "cors" }).catch(() =>
        prefetchedSignatures.delete(url),
      );
    });
  }, [assignedReferrals, offline]);

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
    setError("");
    try {
      await downloadReferralForm(referral);
    } catch (downloadError) {
      setError(downloadError.message);
    }
  };

  // Deliberately not awaited by the UI: the local cache removes the row at
  // once (online or offline) and the write syncs in the background. If the
  // server later rejects it, Firestore rolls it back, the referral
  // reappears, and we show the error here.
  const markDone = (referral) => {
    if (!referral) return;
    const label = referral.name ?? referral.patientName ?? "referral";
    setPendingReferral(null);
    setError("");
    setUnsynced((count) => count + 1);
    completeReferral(referral.id, officerName)
      .catch((writeError) =>
        setError(`Couldn't save ${label}: ${writeError.message}`),
      )
      .finally(() => setUnsynced((count) => Math.max(0, count - 1)));
  };

  return (
    <OfficerLayout officerName={officerName} onSignOut={onSignOut}>
      {(offline || unsynced > 0) && (
        <div
          className={`mb-4 flex items-start gap-2.5 rounded-md border px-4 py-3 text-sm ${
            offline
              ? "border-amber-200 bg-amber-50 text-amber-800"
              : "border-sky-200 bg-sky-50 text-sky-800"
          }`}
        >
          {offline ? (
            <WifiOff className="mt-0.5 h-4 w-4 flex-none" />
          ) : (
            <RefreshCw className="mt-0.5 h-4 w-4 flex-none animate-spin" />
          )}
          <div>
            {offline ? (
              <>
                <span className="font-medium">You're offline.</span> You can
                keep working — completed referrals are saved on this device and
                will sync automatically when the connection returns.
                {unsynced > 0 &&
                  ` ${unsynced} completion${unsynced === 1 ? "" : "s"} waiting to sync.`}
              </>
            ) : (
              <>
                Syncing {unsynced} completed referral
                {unsynced === 1 ? "" : "s"}…
              </>
            )}
          </div>
        </div>
      )}

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
                        onClick={() => setPendingReferral(referral)}
                        className="inline-flex items-center gap-1.5 rounded-md bg-[#2F6F62] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#265a50]"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Mark Done
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

      <ConfirmDialog
        open={Boolean(pendingReferral)}
        title="Mark this referral as done?"
        description={`Confirm that ${pendingReferral?.name ?? pendingReferral?.patientName ?? "this patient"}'s form has been attached in LHIMS. The referral will be permanently removed from the system and can't be undone.`}
        confirmLabel="Yes, mark done"
        onConfirm={() => markDone(pendingReferral)}
        onCancel={() => setPendingReferral(null)}
      />
    </OfficerLayout>
  );
}
