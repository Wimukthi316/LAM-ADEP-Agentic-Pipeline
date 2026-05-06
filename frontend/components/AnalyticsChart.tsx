"use client";

import React from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Area,
  AreaChart,
} from "recharts";

const data = [
  { week: "W1", mttr: 48, autonomy: 12, incidents: 42 },
  { week: "W2", mttr: 44, autonomy: 19, incidents: 38 },
  { week: "W3", mttr: 38, autonomy: 27, incidents: 31 },
  { week: "W4", mttr: 31, autonomy: 38, incidents: 26 },
  { week: "W5", mttr: 26, autonomy: 49, incidents: 22 },
  { week: "W6", mttr: 22, autonomy: 58, incidents: 18 },
  { week: "W7", mttr: 18, autonomy: 67, incidents: 14 },
  { week: "W8", mttr: 14, autonomy: 74, incidents: 11 },
  { week: "W9", mttr: 11, autonomy: 81, incidents: 8 },
  { week: "W10", mttr: 8, autonomy: 87, incidents: 6 },
  { week: "W11", mttr: 6, autonomy: 91, incidents: 4 },
  { week: "W12", mttr: 4, autonomy: 94, incidents: 3 },
];

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{
    name: string;
    value: number;
    color: string;
  }>;
  label?: string;
}

function CustomTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload) return null;
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
            {entry.name}: <span className="text-white font-semibold">{entry.value}</span>
            {entry.name === "MTTR" ? " min" : entry.name === "Autonomy" ? "%" : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function AnalyticsChart() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* MTTR & Autonomy Chart */}
      <div className="glass-card p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="text-sm font-semibold text-white">
              MTTR Reduction & Autonomy Score
            </h3>
            <p className="text-[11px] text-gray-500 mt-0.5">
              12-week adaptive learning progression
            </p>
          </div>
          <div className="flex gap-4 text-[10px]">
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-cyan-400" />
              <span className="text-gray-400">MTTR (min)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-purple-400" />
              <span className="text-gray-400">Autonomy %</span>
            </div>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={data}>
            <defs>
              <linearGradient id="gradCyan" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#22d3ee" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="gradPurple" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#a855f7" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#a855f7" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1c2333" />
            <XAxis dataKey="week" stroke="#384868" tick={{ fontSize: 11 }} />
            <YAxis stroke="#384868" tick={{ fontSize: 11 }} />
            <Tooltip content={<CustomTooltip />} />
            <Area
              type="monotone"
              dataKey="mttr"
              stroke="#22d3ee"
              strokeWidth={2}
              fill="url(#gradCyan)"
              name="MTTR"
              dot={{ r: 3, fill: "#22d3ee", strokeWidth: 0 }}
              activeDot={{ r: 5, fill: "#22d3ee" }}
            />
            <Area
              type="monotone"
              dataKey="autonomy"
              stroke="#a855f7"
              strokeWidth={2}
              fill="url(#gradPurple)"
              name="Autonomy"
              dot={{ r: 3, fill: "#a855f7", strokeWidth: 0 }}
              activeDot={{ r: 5, fill: "#a855f7" }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Incident Resolution Chart */}
      <div className="glass-card p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="text-sm font-semibold text-white">
              Self-Healing Incident Trend
            </h3>
            <p className="text-[11px] text-gray-500 mt-0.5">
              Automated resolution rate over time
            </p>
          </div>
          <div className="flex gap-4 text-[10px]">
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-emerald-400" />
              <span className="text-gray-400">Incidents</span>
            </div>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={data}>
            <defs>
              <linearGradient id="gradGreen" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#34d399" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1c2333" />
            <XAxis dataKey="week" stroke="#384868" tick={{ fontSize: 11 }} />
            <YAxis stroke="#384868" tick={{ fontSize: 11 }} />
            <Tooltip content={<CustomTooltip />} />
            <Area
              type="monotone"
              dataKey="incidents"
              stroke="#34d399"
              strokeWidth={2}
              fill="url(#gradGreen)"
              name="Incidents"
              dot={{ r: 3, fill: "#34d399", strokeWidth: 0 }}
              activeDot={{ r: 5, fill: "#34d399" }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
