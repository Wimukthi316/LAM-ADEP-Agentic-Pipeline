"use client";

import React from "react";
import {
  Activity,
  Database,
  BarChart3,
  TrendingUp,
  Layers,
} from "lucide-react";
import AnalyticsChart from "@/components/AnalyticsChart";
import { usePipeline } from "@/components/PipelineProvider";

function formatMetricValue(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER) {
    return v.toLocaleString();
  }
  return v.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

const METRIC_ACCENTS: { Icon: typeof Database; color: string }[] = [
  { Icon: Database, color: "text-amber-400" },
  { Icon: BarChart3, color: "text-cyan-400" },
  { Icon: TrendingUp, color: "text-emerald-400" },
  { Icon: Activity, color: "text-purple-400" },
  { Icon: Layers, color: "text-rose-400" },
];

function StatCard({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div className="glass-card p-4 flex items-center gap-4">
      <div
        className={`w-10 h-10 rounded-xl flex items-center justify-center ${color} bg-white/[0.03]`}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] text-gray-500 uppercase tracking-wider font-medium">
          {label}
        </p>
        <p className="text-lg font-bold text-white break-all">{value}</p>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { analyticsLoading, analyticsError, analyticsSnapshot, csvFilename } =
    usePipeline();

  const datasetLabel =
    analyticsSnapshot?.dataset_file ?? csvFilename ?? undefined;

  const metrics = analyticsSnapshot?.metrics ?? [];

  return (
    <main className="p-6 max-w-[1600px] mx-auto w-full">
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-white">Analytics</h2>
        <p className="text-[11px] text-gray-500 mt-1">
          Schema-aware metrics from the active CSV (numeric column means,
          optional daily sums when a date column is detected).
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4 mb-8">
        {analyticsLoading && metrics.length === 0
          ? Array.from({ length: 4 }).map((_, i) => (
              <StatCard
                key={i}
                icon={<Database size={18} />}
                label="…"
                value="…"
                color="text-gray-500"
              />
            ))
          : metrics.map((m, i) => {
              const { Icon, color } =
                METRIC_ACCENTS[i % METRIC_ACCENTS.length];
              return (
                <StatCard
                  key={`${m.label}-${i}`}
                  icon={<Icon size={18} />}
                  label={m.label}
                  value={formatMetricValue(m.value)}
                  color={color}
                />
              );
            })}
      </div>

      <AnalyticsChart
        dailySales={analyticsSnapshot?.daily_sales ?? []}
        dailySeries={analyticsSnapshot?.daily_series ?? []}
        loading={analyticsLoading}
        errorMessage={analyticsError}
        datasetSubtitle={datasetLabel}
      />
    </main>
  );
}
