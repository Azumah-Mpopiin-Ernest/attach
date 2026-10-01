import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useEffect, useMemo, useState } from "react";
import StatTile from "./stattile";
import {
  getReferrals,
  getImportBatchImportedCount,
  getBatchCompletedCount,
  getDailyCompletionCounts,
  getOfficerPerformance,
  resetBatchIfEmpty,
} from "../../src/firebaseData";

// Dims a per-officer count while it is zero so non-zero numbers stand out.
function countClass(value, activeClass) {
  return value > 0 ? activeClass : "text-slate-300";
}

// onNavigateToExplorer: (statusFilter) => void — used so stat tiles deep-link
// into the Explorer page pre-filtered, per the UX spec.
//
// EVERY number on this page belongs to the current batch. A batch is
// finished when no referrals are left (all signed, assigned, attached and
// marked done). On load we call resetBatchIfEmpty(), which — if referrals
// is empty — wipes all batch metrics (imported, done, daily chart, officer
// performance) before we read them, so a finished batch never lingers.
//
// Referral states an officer can leave a referral in:
//   Done    deleted on completion (only the counters survive), so it is no
//           longer part of "Left".
//   Skipped put on hold by the officer. The document stays in the batch
//           until an officer marks it done, but it is NOT part of "Left".
//   Active  still ASSIGNED to the officer.
export default function AdminDashboard({ onNavigateToExplorer }) {
  const [referrals, setReferrals] = useState([]);
  const [batchImported, setBatchImported] = useState(0);
  const [batchCompleted, setBatchCompleted] = useState(0);
  const [dailyCounts, setDailyCounts] = useState([]);
  const [officerPerf, setOfficerPerf] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    resetBatchIfEmpty()
      .then(() =>
        Promise.all([
          getReferrals(),
          getImportBatchImportedCount(),
          getBatchCompletedCount(),
          getDailyCompletionCounts(7),
          getOfficerPerformance(7),
        ]),
      )
      .then(([items, imported, completed, daily, perf]) => {
        if (!active) return;
        setReferrals(items);
        setBatchImported(imported);
        setBatchCompleted(completed);
        setDailyCounts(daily);
        setOfficerPerf(perf);
      })
      .catch((snapshotError) => {
        if (active) setError(snapshotError.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  // One pass over the referrals. Skipped referrals are counted separately and
  // do not count as "left".
  const stats = useMemo(() => {
    const counts = { left: 0, readyToAssign: 0, assigned: 0, skipped: 0 };
    referrals.forEach((referral) => {
      if (referral.status === "SKIPPED") {
        counts.skipped += 1;
        return;
      }
      counts.left += 1;
      if (referral.status === "READY_TO_ASSIGN") counts.readyToAssign += 1;
      else if (referral.status === "ASSIGNED") counts.assigned += 1;
    });
    return counts;
  }, [referrals]);

  // One row per officer: Active and Skipped come from the referrals they hold
  // right now, Done / Today / Last 7 days from the completion counters. An
  // officer who has been assigned referrals but has not completed any yet
  // has no counters, so the two sources are merged.
  const officerRows = useMemo(() => {
    const rows = new Map();
    const ensure = (officerName) => {
      if (!rows.has(officerName)) {
        rows.set(officerName, {
          officerName,
          active: 0,
          skipped: 0,
          done: 0,
          today: 0,
          week: 0,
        });
      }
      return rows.get(officerName);
    };

    officerPerf.forEach(({ officerName, today, week, total }) => {
      Object.assign(ensure(officerName), { today, week, done: total });
    });
    referrals.forEach((referral) => {
      if (!referral.assignedTo) return;
      if (referral.status === "ASSIGNED")
        ensure(referral.assignedTo).active += 1;
      else if (referral.status === "SKIPPED") {
        ensure(referral.assignedTo).skipped += 1;
      }
    });

    return Array.from(rows.values()).sort(
      (a, b) => b.done - a.done || a.officerName.localeCompare(b.officerName),
    );
  }, [officerPerf, referrals]);

  // dailyCounts is oldest -> newest, today last (see getDailyCompletionCounts
  // in firebaseData.js) — it's the only place a completion's date survives,
  // since completing a referral deletes the referral document itself.
  const completedToday = dailyCounts[dailyCounts.length - 1]?.count ?? 0;
  const completedYesterday = dailyCounts[dailyCounts.length - 2]?.count ?? null;
  const weekData = useMemo(
    () =>
      dailyCounts.map(({ date, count }) => ({
        day: date.toLocaleDateString(undefined, { weekday: "short" }),
        count,
      })),
    [dailyCounts],
  );

  return (
    <div>
      <h1 className="text-xl font-semibold text-slate-900">Dashboard</h1>
      <p className="mt-1 text-sm text-slate-500">
        Progress of the current batch. Everything resets once no referrals are
        left, including skipped ones.
      </p>
      {error && <p className="mt-4 text-sm text-rose-600">{error}</p>}

      <h2 className="mt-6 text-xs font-semibold uppercase tracking-wide text-slate-400">
        Current batch
      </h2>
      <p className="mt-1 text-xs text-slate-400">
        Left excludes skipped and done referrals. Skipped referrals stay in the
        batch until an officer marks them done.
      </p>
      <div className="mt-2 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {loading ? (
          Array.from({ length: 4 }, (_, index) => (
            <div
              key={`batch-tile-skeleton-${index}`}
              className="rounded-md border border-slate-200 bg-white p-4"
            >
              <div className="h-7 w-16 animate-pulse rounded bg-slate-100" />
              <div className="mt-2 h-3 w-24 animate-pulse rounded bg-slate-100" />
            </div>
          ))
        ) : (
          <>
            <StatTile value={batchImported.toLocaleString()} label="Imported" />
            <StatTile value={stats.left.toLocaleString()} label="Left" />
            <StatTile
              value={stats.skipped.toLocaleString()}
              label="Skipped"
              onClick={() => onNavigateToExplorer?.("SKIPPED")}
            />
            <StatTile value={batchCompleted.toLocaleString()} label="Done" />
          </>
        )}
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {loading ? (
          Array.from({ length: 2 }, (_, index) => (
            <div
              key={`status-tile-skeleton-${index}`}
              className="rounded-md border border-slate-200 bg-white p-4"
            >
              <div className="h-7 w-16 animate-pulse rounded bg-slate-100" />
              <div className="mt-2 h-3 w-24 animate-pulse rounded bg-slate-100" />
            </div>
          ))
        ) : (
          <>
            <StatTile
              value={stats.readyToAssign.toLocaleString()}
              label="Ready to assign"
              onClick={() => onNavigateToExplorer?.("READY_TO_ASSIGN")}
            />
            <StatTile
              value={stats.assigned.toLocaleString()}
              label="Assigned"
              onClick={() => onNavigateToExplorer?.("ASSIGNED")}
            />
          </>
        )}
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-5">
        <div className="rounded-md border border-slate-200 bg-white p-5 lg:col-span-2">
          <h2 className="text-sm font-medium text-slate-700">
            Completed today
          </h2>
          <p className="text-xs text-slate-400">
            {new Date().toLocaleDateString(undefined, {
              weekday: "long",
              month: "short",
              day: "numeric",
            })}
          </p>
          <div className="mt-4 flex h-64 flex-col items-center justify-center">
            {loading ? (
              <div className="h-12 w-20 animate-pulse rounded bg-slate-100" />
            ) : (
              <>
                <span className="text-5xl font-semibold text-[#2F6F62]">
                  {completedToday.toLocaleString()}
                </span>
                <span className="mt-2 text-sm text-slate-400">
                  {completedYesterday === null
                    ? "referrals completed"
                    : `vs ${completedYesterday.toLocaleString()} yesterday`}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="rounded-md border border-slate-200 bg-white p-5 lg:col-span-3">
          <h2 className="text-sm font-medium text-slate-700">
            Completed forms
          </h2>
          <p className="text-xs text-slate-400">Last 7 days (this batch)</p>
          <div className="mt-4 h-64">
            {loading ? (
              <div className="h-full w-full animate-pulse rounded bg-slate-100" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={weekData}>
                  <CartesianGrid stroke="#E5E7EB" vertical={false} />
                  <XAxis
                    dataKey="day"
                    tick={{ fontSize: 11, fill: "#94A3B8" }}
                    axisLine={{ stroke: "#E5E7EB" }}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "#94A3B8" }}
                    axisLine={false}
                    tickLine={false}
                    width={30}
                    allowDecimals={false}
                  />
                  <Tooltip
                    contentStyle={{
                      fontSize: 12,
                      borderRadius: 6,
                      borderColor: "#E5E7EB",
                    }}
                  />
                  <Bar dataKey="count" fill="#2F6F62" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      <div className="mt-8 rounded-md border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-medium text-slate-700">
          Officer performance
        </h2>
        <p className="text-xs text-slate-400">
          Active and Skipped are the referrals each officer holds right now.
          Done is their total for the current batch.
        </p>

        <div className="mt-4 overflow-x-auto rounded-md border border-slate-200">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                <th className="px-4 py-2 font-medium">Officer</th>
                <th className="px-4 py-2 text-right font-medium text-sky-700">
                  Active
                </th>
                <th className="px-4 py-2 text-right font-medium text-amber-700">
                  Skipped
                </th>
                <th className="px-4 py-2 text-right font-medium text-[#2F6F62]">
                  Done
                </th>
                <th className="px-4 py-2 text-right font-medium">Done today</th>
                <th className="px-4 py-2 text-right font-medium">
                  Done last 7 days
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 3 }, (_, index) => (
                  <tr key={`officer-skeleton-${index}`}>
                    <td colSpan={6} className="px-4 py-3">
                      <div className="h-4 w-full animate-pulse rounded bg-slate-100" />
                    </td>
                  </tr>
                ))
              ) : officerRows.length ? (
                officerRows.map((officer) => (
                  <tr
                    key={officer.officerName}
                    className="border-b border-slate-100 last:border-0"
                  >
                    <td className="px-4 py-2 font-medium text-slate-800">
                      {officer.officerName}
                    </td>
                    <td
                      className={`px-4 py-2 text-right font-medium ${countClass(officer.active, "text-sky-700")}`}
                    >
                      {officer.active.toLocaleString()}
                    </td>
                    <td
                      className={`px-4 py-2 text-right font-medium ${countClass(officer.skipped, "text-amber-700")}`}
                    >
                      {officer.skipped.toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-right font-semibold text-[#2F6F62]">
                      {officer.done.toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-right text-slate-600">
                      {officer.today.toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-right text-slate-600">
                      {officer.week.toLocaleString()}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-8 text-center text-slate-400"
                  >
                    No officers have been assigned referrals or completed any
                    yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
