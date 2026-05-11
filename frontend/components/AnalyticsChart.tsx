"use client";

import React, { useMemo } from "react";
import {
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
} from "recharts";

export interface DailyChartSeries {
  key: string;
  label: string;
}

/** Row for Recharts: date + label + one numeric field per daily_chart_series.key */
export interface DailySeriesPoint {
  date: string;
  label: string;
  [metricKey: string]: string | number;
}

interface TooltipPayloadEntry {
  name?: string;
  value?: number;
  color?: string;
}

interface SalesTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string;
}

function SalesTooltip({ active, payload, label }: SalesTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="glass-card px-4 py-3 text-xs !border-[#384868]">
      <p className="text-gray-400 mb-2 font-medium">{label}</p>
      {payload.map((entry, idx) => (
        <div key={idx} className="flex items-center gap-2 mb-1">
          <div
            className="w-2 h-2 rounded-full"
            style={{ background: entry.color }}
          />
          <span className="text-gray-300">
            {entry.name}:{" "}
            <span className="text-white font-semibold">
              {typeof entry.value === "number"
                ? entry.value.toLocaleString(undefined, {
                    maximumFractionDigits: 2,
                  })
                : entry.value}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

const SERIES_COLORS = ["#22d3ee", "#a855f7", "#34d399", "#fbbf24", "#f472b6"];

export default function AnalyticsChart({
  dailySales,
  dailySeries,
  loading,
  errorMessage,
  datasetSubtitle,
}: {
  dailySales: DailySeriesPoint[];
  dailySeries: DailyChartSeries[];
  loading: boolean;
  errorMessage: string | null;
  datasetSubtitle?: string | null;
}) {
  const empty = !loading && (!dailySales?.length || !dailySeries?.length);
  const subtitle = loading
    ? "Loading dataset metrics…"
    : errorMessage
      ? errorMessage
      : datasetSubtitle
        ? `Daily aggregates from ${datasetSubtitle} (first date column, up to 10 days)`
        : "Daily aggregates when a date-like column is detected";

  const chartBlock = (msg: string, height = 260) => (
    <div
      className="flex items-center justify-center text-[11px] text-gray-500 border border-dashed border-[#1c2333] rounded-lg"
      style={{ height }}
    >
      {msg}
    </div>
  );

  const lines = useMemo(
    () =>
      (dailySeries ?? []).map((s, i) => ({
        ...s,
        color: SERIES_COLORS[i % SERIES_COLORS.length],
      })),
    [dailySeries]
  );

  return (
    <div className="glass-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <h3 className="text-sm font-semibold text-white">
            Daily trends (detected date column)
          </h3>
          <p className="text-[11px] text-gray-500 mt-0.5">{subtitle}</p>
        </div>
        {lines.length > 0 ? (
          <div className="flex flex-wrap gap-4 text-[10px]">
            {lines.map((s) => (
              <div key={s.key} className="flex items-center gap-1.5">
                <div
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ background: s.color }}
                />
                <span className="text-gray-400">{s.label}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {loading ? (
        chartBlock("Loading chart…")
      ) : errorMessage || empty ? (
        chartBlock(
          errorMessage ||
            "No daily time-series — need a parseable date column and numeric columns."
        )
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={dailySales}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1c2333" />
            <XAxis dataKey="label" stroke="#384868" tick={{ fontSize: 11 }} />
            <YAxis stroke="#384868" tick={{ fontSize: 11 }} />
            <Tooltip content={<SalesTooltip />} />
            {lines.map((s) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                strokeWidth={2}
                dot={{ r: 3, fill: s.color, strokeWidth: 0 }}
                activeDot={{ r: 5, fill: s.color }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
