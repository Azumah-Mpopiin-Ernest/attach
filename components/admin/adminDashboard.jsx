import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
} from "recharts";
import { useEffect, useMemo, useState } from "react";
import StatTile from "./stattile";
import { getDocument, getReferrals } from "../../src/firebaseData";

// onNavigateToExplorer: (statusFilter) => void — used so stat tiles deep-link
// into the Explorer page pre-filtered, per the UX spec.
export default function AdminDashboard({ onNavigateToExplorer }) {
  const [referrals, setReferrals] = useState([]);
  const [completedCount, setCompletedCount] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([getReferrals(), getDocument("metrics", "summary")])
      .then(([items, metrics]) => {
        if (!active) return;
        setReferrals(items);
        setCompletedCount(metrics?.completedCount ?? 0);
      })
      .catch((snapshotError) => {
        if (active) setError(snapshotError.message);
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

  const dailyData = useMemo(() => groupByDay(referrals), [referrals]);
  const completedData = [{ officer: "Completed", count: stats.done }];

  return (
    <div>
      <h1 className="text-xl font-semibold text-slate-900">Dashboard</h1>
      <p className="mt-1 text-sm text-slate-500">
        System overview for this month.
      </p>
      {error && <p className="mt-4 text-sm text-rose-600">{error}</p>}

      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          value={stats.total.toLocaleString()}
          label="Total this month"
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
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-5">
        <div className="rounded-md border border-slate-200 bg-white p-5 lg:col-span-3">
          <h2 className="text-sm font-medium text-slate-700">
            Referrals per day
          </h2>
          <p className="text-xs text-slate-400">Last 30 days</p>
          <div className="mt-4 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={dailyData}>
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
                />
                <Tooltip
                  contentStyle={{
                    fontSize: 12,
                    borderRadius: 6,
                    borderColor: "#E5E7EB",
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="count"
                  stroke="#2F6F62"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-md border border-slate-200 bg-white p-5 lg:col-span-2">
          <h2 className="text-sm font-medium text-slate-700">
            Completed forms
          </h2>
          <p className="text-xs text-slate-400">
            Tracked without storing completed forms
          </p>
          <div className="mt-4 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={completedData}
                layout="vertical"
                margin={{ left: 8 }}
              >
                <CartesianGrid stroke="#E5E7EB" horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fontSize: 11, fill: "#94A3B8" }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  type="category"
                  dataKey="officer"
                  tick={{ fontSize: 11, fill: "#475569" }}
                  axisLine={false}
                  tickLine={false}
                  width={64}
                />
                <Tooltip
                  contentStyle={{
                    fontSize: 12,
                    borderRadius: 6,
                    borderColor: "#E5E7EB",
                  }}
                />
                <Bar dataKey="count" fill="#2F6F62" radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}

function groupByDay(referrals) {
  const counts = new Map();
  referrals.forEach((referral) => {
    const date = toDate(referral.createdAt ?? referral.referralDate);
    if (!date) return;
    const day = date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    counts.set(day, (counts.get(day) ?? 0) + 1);
  });
  return [...counts].map(([day, count]) => ({ day, count }));
}

function toDate(value) {
  if (!value) return null;
  const date = value.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
