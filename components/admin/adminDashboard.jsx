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
  getDocument,
  getReferrals,
  getDailyCompletionCounts,
} from "../../src/firebaseData";

// onNavigateToExplorer: (statusFilter) => void — used so stat tiles deep-link
// into the Explorer page pre-filtered, per the UX spec.
export default function AdminDashboard({ onNavigateToExplorer }) {
  const [referrals, setReferrals] = useState([]);
  const [completedCount, setCompletedCount] = useState(0);
  const [dailyCounts, setDailyCounts] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    Promise.all([
      getReferrals(),
      getDocument("metrics", "summary"),
      getDailyCompletionCounts(7),
    ])
      .then(([items, metrics, daily]) => {
        if (!active) return;
        setReferrals(items);
        setCompletedCount(metrics?.completedCount ?? 0);
        setDailyCounts(daily);
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
      total: referrals.length + completedCount,
      awaitingSign: referrals.filter(
        (referral) => referral.status === "READY_TO_ASSIGN",
      ).length,
      inProgress: referrals.filter((referral) => referral.status === "ASSIGNED")
        .length,
      done:
        completedCount +
        referrals.filter((referral) => referral.status === "DONE").length,
    }),
    [completedCount, referrals],
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
      <p className="mt-1 text-sm text-slate-500">System overview.</p>
      {error && <p className="mt-4 text-sm text-rose-600">{error}</p>}

      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {loading ? (
          Array.from({ length: 4 }, (_, index) => (
            <div
              key={`tile-skeleton-${index}`}
              className="rounded-md border border-slate-200 bg-white p-4"
            >
              <div className="h-7 w-16 animate-pulse rounded bg-slate-100" />
              <div className="mt-2 h-3 w-24 animate-pulse rounded bg-slate-100" />
            </div>
          ))
        ) : (
          <>
            <StatTile
              value={stats.total.toLocaleString()}
              label="Total"
              onClick={() => onNavigateToExplorer?.(null)}
            />
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
            <StatTile value={stats.done.toLocaleString()} label="Done" />
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
          <p className="text-xs text-slate-400">Last 7 days</p>
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
    </div>
  );
}
