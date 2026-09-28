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

// onNavigateToExplorer: (statusFilter) => void — used so stat tiles deep-link
// into the Explorer page pre-filtered, per the UX spec.
//
// EVERY number on this page belongs to the current batch. A batch is
// finished when no referrals are left (all signed, assigned, attached and
// marked done). On load we call resetBatchIfEmpty(), which — if referrals
// is empty — wipes all batch metrics (imported, done, daily chart, officer
// performance) before we read them, so a finished batch never lingers.
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

  const stats = useMemo(
    () => ({
      left: referrals.length,
      awaitingSign: referrals.filter(
        (referral) => referral.status === "READY_TO_ASSIGN",
      ).length,
      inProgress: referrals.filter((referral) => referral.status === "ASSIGNED")
        .length,
    }),
    [referrals],
  );

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
        left.
      </p>
      {error && <p className="mt-4 text-sm text-rose-600">{error}</p>}

      <h2 className="mt-6 text-xs font-semibold uppercase tracking-wide text-slate-400">
        Current batch
      </h2>
      <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {loading ? (
          Array.from({ length: 3 }, (_, index) => (
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
              value={stats.awaitingSign.toLocaleString()}
              label="Ready to assign"
              onClick={() => onNavigateToExplorer?.("READY_TO_ASSIGN")}
            />
            <StatTile
              value={stats.inProgress.toLocaleString()}
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
          Today, last 7 days, and total for the current batch.
        </p>

        <div className="mt-4 overflow-hidden rounded-md border border-slate-200">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                <th className="px-4 py-2 font-medium">Officer</th>
                <th className="px-4 py-2 text-right font-medium">Today</th>
                <th className="px-4 py-2 text-right font-medium">
                  Last 7 days
                </th>
                <th className="px-4 py-2 text-right font-medium">
                  Batch total
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 3 }, (_, index) => (
                  <tr key={`officer-skeleton-${index}`}>
                    <td colSpan={4} className="px-4 py-3">
                      <div className="h-4 w-full animate-pulse rounded bg-slate-100" />
                    </td>
                  </tr>
                ))
              ) : officerPerf.length ? (
                officerPerf.map((officer) => (
                  <tr
                    key={officer.officerName}
                    className="border-b border-slate-100 last:border-0"
                  >
                    <td className="px-4 py-2 font-medium text-slate-800">
                      {officer.officerName}
                    </td>
                    <td className="px-4 py-2 text-right text-slate-600">
                      {officer.today.toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-right text-slate-600">
                      {officer.week.toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-right font-medium text-slate-800">
                      {officer.total.toLocaleString()}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td
                    colSpan={4}
                    className="px-4 py-8 text-center text-slate-400"
                  >
                    No completions recorded yet.
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
