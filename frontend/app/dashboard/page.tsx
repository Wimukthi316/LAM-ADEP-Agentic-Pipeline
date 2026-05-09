"use client";

import React from "react";
import { Activity, Database, DollarSign, Wallet } from "lucide-react";
import AnalyticsChart from "@/components/AnalyticsChart";
import { usePipeline } from "@/components/PipelineProvider";

function formatUsd(n: number | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(n);
}

function formatInt(n: number | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toLocaleString();
}

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
        <p className="text-lg font-bold text-white">{value}</p>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { analyticsLoading, analyticsError, analyticsSnapshot, csvFilename } =
    usePipeline();

  const datasetLabel =
    analyticsSnapshot?.dataset_file ?? csvFilename ?? undefined;

  return (
    <main className="p-6 max-w-[1600px] mx-auto w-full">
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-white">Analytics</h2>
        <p className="text-[11px] text-gray-500 mt-1">
          Metrics from the active CSV on the API (no fixed filename).
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard
          icon={<Database size={18} />}
          label="Records"
          value={
            analyticsLoading ? "…" : formatInt(analyticsSnapshot?.row_count)
          }
          color="text-amber-400"
        />
        <StatCard
          icon={<DollarSign size={18} />}
          label="Avg unit price"
          value={
            analyticsLoading
              ? "…"
              : formatUsd(analyticsSnapshot?.avg_unit_price)
          }
          color="text-cyan-400"
        />
        <StatCard
          icon={<Wallet size={18} />}
          label="Sum gross income"
          value={
            analyticsLoading
              ? "…"
              : formatUsd(analyticsSnapshot?.sum_gross_income)
          }
          color="text-emerald-400"
        />
        <StatCard
          icon={<Activity size={18} />}
          label="Total sales"
          value={
            analyticsLoading
              ? "…"
              : formatUsd(analyticsSnapshot?.sum_total_sales)
          }
          color="text-purple-400"
        />
      </div>

      <AnalyticsChart
        dailySales={analyticsSnapshot?.daily_sales ?? []}
        loading={analyticsLoading}
        errorMessage={analyticsError}
        datasetSubtitle={datasetLabel}
      />
    </main>
  );
}
