import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Search, WifiOff } from "lucide-react";
import OfficerLayout from "./officerLayout";
import ConfirmDialog from "../admin/confirmDialog";
import {
  completeReferral,
  subscribeToReferrals,
  updateReferral,
} from "../../src/firebaseData";
import {
  compareDateKeys,
  formatDateLabel,
  getDateKey,
} from "../../src/referralDates";
import Pagination from "../shared/Pagination";
import FormsFolderBar from "./formsFolderBar";
import { useFormsFolder } from "./formsFolder";
import { ActiveReferralCard, SkippedReferralRow } from "./referralViews";
import {
  clearReferralActions,
  referralName,
  useSessionDoneCount,
} from "./referralFlow";
import { useLhimsRun } from "../../src/lhims/useLhimsRun";
import LhimsRunBar from "../../src/lhims/LhimsRunBar";

const PAGE_SIZE = 25;

// Signature URLs already requested this session, so the offline prefetch
// below doesn't re-fetch every signature after each change.
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

// Oldest form date first, so the officer works through one admission date
// at a time. Array.prototype.sort is stable, so referrals sharing a date
// keep the order Firestore returned them in (same as before).
function sortByDate(referrals) {
  return [...referrals].sort((a, b) =>
    compareDateKeys(getDateKey(a), getDateKey(b)),
  );
}

function doneDescription(referral) {
  if (!referral) return "";
  return `Confirm that ${referralName(referral)}'s form (LHIMS ID ${referral.patientId ?? "unknown"}) has been attached in LHIMS. The referral will be permanently removed from the system and can't be undone.`;
}

function skipDescription(referral) {
  if (!referral) return "";
  return `${referralName(referral)} will move to the Skipped Referrals tab and the next patient will appear. You can still attach the form in LHIMS and mark it done from that tab later.`;
}

function SyncBanner({ offline, unsynced }) {
  const pending = `${unsynced} change${unsynced === 1 ? "" : "s"}`;
  return (
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
            <span className="font-medium">You're offline.</span> You can keep
            working — completed and skipped referrals are saved on this device
            and will sync automatically when the connection returns.
            {unsynced > 0 && ` ${pending} waiting to sync.`}
          </>
        ) : (
          <>Syncing {pending}…</>
        )}
      </div>
    </div>
  );
}

function TabButton({ id, selected, count, onSelect, children }) {
  return (
    <button
      type="button"
      role="tab"
      id={`officer-tab-${id}`}
      aria-selected={selected}
      aria-controls={`officer-panel-${id}`}
      onClick={() => onSelect(id)}
      className={`-mb-px inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
        selected
          ? "border-[#2F6F62] text-[#2F6F62]"
          : "border-transparent text-slate-500 hover:text-slate-700"
      }`}
    >
      {children}
      <span
        className={`rounded-full px-2 py-0.5 text-xs ${
          selected ? "bg-[#2F6F62] text-white" : "bg-slate-100 text-slate-600"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

function StatTile({ label, value }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-xl font-semibold text-slate-900">
        {value.toLocaleString()}
      </dd>
    </div>
  );
}

// Makes the admission date being worked on impossible to miss, because the
// officer must have the matching patient list open in LHIMS.
function WorkingDateBanner({ dateLabel, leftForDate, inQueue, doneCount }) {
  return (
    <section
      aria-label="Date being worked on"
      className="mb-4 rounded-lg border-l-4 border-[#2F6F62] bg-[#2F6F62]/5 px-5 py-4"
    >
      <p className="text-sm font-medium text-[#2F6F62]">Now working on</p>
      <p className="mt-0.5 text-3xl font-semibold tracking-tight text-slate-900">
        {dateLabel}
      </p>
      <p className="mt-2 text-sm text-slate-600">
        Open this date's patient list in LHIMS, then work through the referrals
        one at a time.
      </p>
      <dl className="mt-4 grid grid-cols-3 gap-3">
        <StatTile label="Left for this date" value={leftForDate} />
        <StatTile label="Total in queue" value={inQueue} />
        <StatTile label="Done this session" value={doneCount} />
      </dl>
    </section>
  );
}

export default function OfficerApp({ officerName, onSignOut }) {
  const [assigned, setAssigned] = useState([]);
  const [skipped, setSkipped] = useState([]);
  const [queueLoaded, setQueueLoaded] = useState(false);
  const [tab, setTab] = useState("active");
  const [error, setError] = useState("");
  const [pinnedId, setPinnedId] = useState(null);
  const [pendingDone, setPendingDone] = useState(null);
  const [pendingSkip, setPendingSkip] = useState(null);
  const [skippedQuery, setSkippedQuery] = useState("");
  const [skippedPage, setSkippedPage] = useState(1);
  const [doneCount, adjustDoneCount] = useSessionDoneCount(officerName);
  const formsFolder = useFormsFolder();

  // Changes (completions or skips) started but not yet confirmed by the
  // server.
  const [unsynced, setUnsynced] = useState(0);
  const browserOnline = useBrowserOnline();
  const [fromCache, setFromCache] = useState(false);
  const [cacheStale, setCacheStale] = useState(false);

  useEffect(
    () =>
      subscribeToReferrals(
        { assignedTo: officerName, status: "ASSIGNED", includeMetadata: true },
        (items, meta) => {
          setAssigned(items);
          setFromCache(Boolean(meta?.fromCache));
          // A cold, empty cache answers first; don't mistake that for an
          // empty queue until the server (or real data) has spoken.
          if (!meta?.fromCache || items.length > 0) setQueueLoaded(true);
        },
        (snapshotError) => setError(snapshotError.message),
      ),
    [officerName],
  );

  // Every referral this officer skipped. Together with the query above this
  // splits the officer's referrals by status, so total reads are unchanged.
  useEffect(
    () =>
      subscribeToReferrals(
        { assignedTo: officerName, status: "SKIPPED" },
        setSkipped,
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

  // While online, touch each doctor signature image once so the service
  // worker keeps a copy for offline "Download Form" (active and skipped).
  useEffect(() => {
    if (offline) return;
    const urls = new Set();
    [...assigned, ...skipped].forEach((referral) => {
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
  }, [assigned, skipped, offline]);

  const queue = useMemo(() => sortByDate(assigned), [assigned]);
  const skippedQueue = useMemo(() => sortByDate(skipped), [skipped]);

  // The referral on screen is PINNED by id: a referral that arrives or is
  // reassigned mid-task can't swap the card out from under the officer. It
  // only changes when the pinned referral leaves the queue (done, skipped,
  // or removed elsewhere), falling back to the oldest one waiting. Updating
  // state during render like this is React's supported way to derive state
  // from other state; the guard ends the loop after one extra render.
  const activeReferral =
    queue.find((referral) => referral.id === pinnedId) ?? queue[0] ?? null;
  if (activeReferral && activeReferral.id !== pinnedId) {
    setPinnedId(activeReferral.id);
  }

  const activeDateKey = activeReferral ? getDateKey(activeReferral) : null;
  const leftForDate = useMemo(
    () =>
      queue.filter((referral) => getDateKey(referral) === activeDateKey).length,
    [queue, activeDateKey],
  );

  const visibleSkipped = useMemo(() => {
    const needle = skippedQuery.trim().toLowerCase();
    if (!needle) return skippedQueue;
    return skippedQueue.filter((referral) =>
      `${referralName(referral, "")} ${referral.patientId ?? ""} ${referral.nhis ?? ""}`
        .toLowerCase()
        .includes(needle),
    );
  }, [skippedQueue, skippedQuery]);

  // Clamped rather than reset in an effect: if skipped referrals are
  // completed and the last page empties, we land on the new last page.
  const skippedPageCount = Math.max(
    1,
    Math.ceil(visibleSkipped.length / PAGE_SIZE),
  );
  const currentSkippedPage = Math.min(skippedPage, skippedPageCount);
  const pagedSkipped = visibleSkipped.slice(
    (currentSkippedPage - 1) * PAGE_SIZE,
    currentSkippedPage * PAGE_SIZE,
  );

  // Deliberately not awaited by the UI: the local cache removes the row at
  // once (online or offline) and the write syncs in the background. The
  // security rules only allow this delete while the referral is still
  // assigned to this officer, so a stale second tab is rejected on sync;
  // Firestore then rolls it back, the referral reappears, and we show the
  // error here.
  const markDone = (referral) => {
    if (!referral) return;
    const label = referralName(referral, "referral");
    setPendingDone(null);
    setError("");
    clearReferralActions(referral.id);
    formsFolder.removeForm(referral);
    setUnsynced((count) => count + 1);
    adjustDoneCount(1);
    completeReferral(referral.id, officerName)
      .catch((writeError) => {
        adjustDoneCount(-1);
        setError(`Couldn't save ${label}: ${writeError.message}`);
      })
      .finally(() => setUnsynced((count) => Math.max(0, count - 1)));
  };

  // Same optimistic pattern. Only an ASSIGNED referral owned by this officer
  // may become SKIPPED (enforced by the security rules).
  const skipReferral = (referral) => {
    if (!referral) return;
    const label = referralName(referral, "referral");
    setPendingSkip(null);
    setError("");
    clearReferralActions(referral.id);
    formsFolder.removeForm(referral);
    setUnsynced((count) => count + 1);
    updateReferral(referral.id, { status: "SKIPPED" })
      .catch((writeError) =>
        setError(`Couldn't skip ${label}: ${writeError.message}`),
      )
      .finally(() => setUnsynced((count) => Math.max(0, count - 1)));
  };

  // Drives the extension's auto run: sends the next form, marks each
  // referral done once LHIMS verified it, skips the ones with no match.
  const lhimsRun = useLhimsRun({ queue, queueLoaded, markDone, skipReferral });

  return (
    <OfficerLayout officerName={officerName} onSignOut={onSignOut}>
      <div className="mx-auto w-full max-w-3xl">
        <h1 className="sr-only">Assigned referrals</h1>

        {(offline || unsynced > 0) && (
          <SyncBanner offline={offline} unsynced={unsynced} />
        )}

        <LhimsRunBar lhims={lhimsRun} />

        <FormsFolderBar formsFolder={formsFolder} />

        <div
          role="tablist"
          aria-label="Referral queues"
          className="flex gap-1 border-b border-slate-200"
        >
          <TabButton
            id="active"
            selected={tab === "active"}
            count={queue.length}
            onSelect={setTab}
          >
            Active Queue
          </TabButton>
          <TabButton
            id="skipped"
            selected={tab === "skipped"}
            count={skippedQueue.length}
            onSelect={setTab}
          >
            Skipped Referrals
          </TabButton>
        </div>

        {error && (
          <p role="alert" className="mt-4 text-sm text-rose-600">
            {error}
          </p>
        )}

        {tab === "active" ? (
          <div
            role="tabpanel"
            id="officer-panel-active"
            aria-labelledby="officer-tab-active"
            className="mt-5"
          >
            {activeReferral ? (
              <>
                <WorkingDateBanner
                  dateLabel={formatDateLabel(activeDateKey)}
                  leftForDate={leftForDate}
                  inQueue={queue.length}
                  doneCount={doneCount}
                />
                <ActiveReferralCard
                  key={activeReferral.id}
                  referral={activeReferral}
                  formsFolder={formsFolder}
                  onRequestDone={setPendingDone}
                  onRequestSkip={setPendingSkip}
                  onError={setError}
                />
              </>
            ) : (
              <div className="rounded-md border border-slate-200 bg-white px-5 py-12 text-center text-slate-400">
                {queueLoaded || offline ? (
                  <>
                    No assigned records in your queue.
                    {skippedQueue.length > 0 &&
                      ` ${skippedQueue.length} skipped referral${skippedQueue.length === 1 ? " is" : "s are"} waiting in the Skipped Referrals tab.`}
                  </>
                ) : (
                  "Loading your queue…"
                )}
              </div>
            )}
          </div>
        ) : (
          <div
            role="tabpanel"
            id="officer-panel-skipped"
            aria-labelledby="officer-tab-skipped"
            className="mt-5"
          >
            <div className="flex flex-wrap items-end justify-between gap-4">
              <p className="max-w-md text-sm text-slate-500">
                Referrals you put on hold. Attach each form in LHIMS when it
                works again, then mark it done here.
              </p>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  value={skippedQuery}
                  onChange={(event) => {
                    setSkippedQuery(event.target.value);
                    setSkippedPage(1);
                  }}
                  placeholder="Search patient or ID"
                  aria-label="Search skipped referrals"
                  className="w-full rounded-md border border-slate-300 py-1.5 pl-8 pr-3 text-sm sm:w-64"
                />
              </div>
            </div>

            {skippedQueue.length === 0 ? (
              <div className="mt-5 rounded-md border border-slate-200 bg-white px-5 py-12 text-center text-slate-400">
                No skipped referrals.
              </div>
            ) : (
              <div className="mt-5 rounded-md border border-slate-200 bg-white">
                <ul>
                  {pagedSkipped.map((referral) => (
                    <SkippedReferralRow
                      key={referral.id}
                      referral={referral}
                      formsFolder={formsFolder}
                      onRequestDone={setPendingDone}
                      onError={setError}
                    />
                  ))}
                  {visibleSkipped.length === 0 && (
                    <li className="px-5 py-12 text-center text-slate-400">
                      No skipped referrals match your search.
                    </li>
                  )}
                </ul>
                <Pagination
                  page={currentSkippedPage}
                  pageCount={skippedPageCount}
                  onPageChange={setSkippedPage}
                  total={visibleSkipped.length}
                />
              </div>
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(pendingDone)}
        title="Mark this referral as done?"
        description={doneDescription(pendingDone)}
        confirmLabel="Yes, mark done"
        onConfirm={() => markDone(pendingDone)}
        onCancel={() => setPendingDone(null)}
      />
      <ConfirmDialog
        open={Boolean(pendingSkip)}
        title="Skip this referral?"
        description={skipDescription(pendingSkip)}
        confirmLabel="Yes, skip it"
        tone="warning"
        onConfirm={() => skipReferral(pendingSkip)}
        onCancel={() => setPendingSkip(null)}
      />
    </OfficerLayout>
  );
}
