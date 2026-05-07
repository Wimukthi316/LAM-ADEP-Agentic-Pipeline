"use client";

import React from "react";
import {
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
} from "recharts";

export interface DailySalesPoint {
  date: string;
  label: string;
  total_sales: number;
  gross_income: number;
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

export default function AnalyticsChart({
  dailySales,
  loading,
  errorMessage,
}: {
  dailySales: DailySalesPoint[];
  loading: boolean;
  errorMessage: string | null;
}) {
  const empty = !loading && (!dailySales || dailySales.length === 0);
  const subtitle = loading
    ? "Loading dataset metrics…"
    : errorMessage
      ? errorMessage
      : "Daily totals from supermarket_sales.csv (first 10 days)";

  const chartBlock = (
    msg: string,
    height = 220
  ) => (
    <div
      className="flex items-center justify-center text-[11px] text-gray-500 border border-dashed border-[#1c2333] rounded-lg"
      style={{ height }}
    >
      {msg}
    </div>
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="glass-card p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="text-sm font-semibold text-white">
              Daily sales (Total)
            </h3>
            <p className="text-[11px] text-gray-500 mt-0.5">{subtitle}</p>
          </div>
          <div className="flex gap-4 text-[10px]">
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-cyan-400" />
              <span className="text-gray-400">Sales</span>
            </div>
          </div>

        </div>
        {loading ? (
          chartBlock("Loading chart…")
        ) : errorMessage || empty ? (
          chartBlock(errorMessage || "No daily sales data to display.")
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={dailySales}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1c2333" />
              <XAxis dataKey="label" stroke="#384868" tick={{ fontSize: 11 }} />
              <YAxis stroke="#384868" tick={{ fontSize: 11 }} />
              <Tooltip content={<SalesTooltip />} />
              <Line
                type="monotone"
                dataKey="total_sales"
                name="Total sales"
                stroke="#22d3ee"
                strokeWidth={2}
                dot={{ r: 3, fill: "#22d3ee", strokeWidth: 0 }}
                activeDot={{ r: 5, fill: "#22d3ee" }}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="glass-card p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="text-sm font-semibold text-white">
              Daily gross income
            </h3>
            <p className="text-[11px] text-gray-500 mt-0.5">{subtitle}</p>
          </div>
          <div className="flex gap-4 text-[10px]">
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-purple-400" />
              <span className="text-gray-400">Gross income</span>
            </div>
          </div>

        </div>
        {loading ? (
          chartBlock("Loading chart…")
        ) : errorMessage || empty ? (
          chartBlock(errorMessage || "No gross income series to display.")
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={dailySales}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1c2333" />
              <XAxis dataKey="label" stroke="#384868" tick={{ fontSize: 11 }} />
              <YAxis stroke="#384868" tick={{ fontSize: 11 }} />
              <Tooltip content={<SalesTooltip />} />
              <Line
                type="monotone"
                dataKey="gross_income"
                name="Gross income"
                stroke="#a855f7"
                strokeWidth={2}
                dot={{ r: 3, fill: "#a855f7", strokeWidth: 0 }}
                activeDot={{ r: 5, fill: "#a855f7" }}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
