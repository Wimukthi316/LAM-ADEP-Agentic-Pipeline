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
  BarChart,
  Bar,
  Area,
  AreaChart,
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

export type AnalyticsChartMode = "tabular" | "audio";

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

function BarTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { value?: number; payload?: { word?: string } }[];
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload;
  const w = p?.word ?? "";
  const v = payload[0]?.value;
  return (
    <div className="glass-card px-3 py-2 text-xs !border-[#384868]">
      <span className="text-purple-300 font-medium">{w}</span>
      <span className="text-gray-500"> · </span>
      <span className="text-white font-semibold">{v}</span>
    </div>
  );
}

const SERIES_COLORS = ["#22d3ee", "#a855f7", "#34d399", "#fbbf24", "#f472b6"];

function tokenizeForFrequency(text: string): Map<string, number> {
  const m = new Map<string, number>();
  const parts = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  for (const w of parts) {
    if (w.length < 2) continue;
    m.set(w, (m.get(w) ?? 0) + 1);
  }
  return m;
}

export function buildWordFrequency(
  transcript: string,
  limit = 14
): { word: string; count: number }[] {
  const m = tokenizeForFrequency(transcript);
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }));
}

/** Stylized pseudo-waveform derived from transcript (deterministic, futuristic look). */
export function buildSimulatedWaveform(
  transcript: string,
  points = 56
): { t: number; amp: number }[] {
  const seed = transcript.length + (transcript.charCodeAt(0) ?? 0);
  const out: { t: number; amp: number }[] = [];
  for (let i = 0; i < points; i++) {
    const phase = i * 0.42;
    const c = transcript.charCodeAt(i % Math.max(transcript.length, 1)) ?? 32;
    const jitter = ((c * (i + 3) + seed) % 97) / 97 - 0.5;
    const envelope = 0.25 + 0.75 * Math.sin((i / points) * Math.PI);
    const amp =
      (Math.sin(phase) * 0.55 + Math.sin(phase * 2.3) * 0.25 + jitter * 0.35) *
      envelope;
    out.push({ t: i, amp: Math.max(-1, Math.min(1, amp)) });
  }
  return out;
}

export default function AnalyticsChart({
  mode,
  dailySales,
  dailySeries,
  loading,
  errorMessage,
  datasetSubtitle,
  audioTranscript = "",
}: {
  mode: AnalyticsChartMode;
  dailySales: DailySeriesPoint[];
  dailySeries: DailyChartSeries[];
  loading: boolean;
  errorMessage: string | null;
  datasetSubtitle?: string | null;
  /** Whisper transcript for audio charts */
  audioTranscript?: string;
}) {
  const transcript = (audioTranscript || "").trim();
  const wordFreq = useMemo(
    () => buildWordFrequency(transcript, 14),
    [transcript]
  );
  const wave = useMemo(
    () => buildSimulatedWaveform(transcript || " "),
    [transcript]
  );

  const tabularEmpty =
    mode === "tabular" &&
    !loading &&
    (!dailySales?.length || !dailySeries?.length);
  const audioEmpty =
    mode === "audio" && !loading && !transcript && wordFreq.length === 0;

  const subtitle = loading
    ? "Loading dataset metrics…"
    : errorMessage
      ? errorMessage
      : mode === "audio"
        ? datasetSubtitle
          ? `Voice intelligence · ${datasetSubtitle}`
          : "Transcript-driven charts (Whisper output)"
        : datasetSubtitle
          ? `Daily aggregates from ${datasetSubtitle} (first date column, up to 10 days)`
          : "Daily aggregates when a date-like column is detected";

  const chartBlock = (msg: string, height = 260) => (
    <div
      className="flex items-center justify-center text-[11px] text-gray-500 border border-dashed border-[#1c2333] rounded-xl bg-[#0a0d14]/40"
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

  if (mode === "audio") {
    return (
      <div className="space-y-6">
        <div className="glass-card p-6 border border-[#1c2333]/80">
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-amber-400 shadow-[0_0_12px_rgba(251,191,36,0.6)]" />
              Simulated voice waveform
            </h3>
            <p className="text-[11px] text-gray-500 mt-0.5">{subtitle}</p>
          </div>
          {loading ? (
            chartBlock("Loading audio visuals…")
          ) : audioEmpty ? (
            chartBlock(
              "No transcript yet — run an audio pipeline to populate Whisper output."
            )
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={wave}>
                <defs>
                  <linearGradient id="waveFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.55} />
                    <stop offset="100%" stopColor="#a855f7" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1c2333" />
                <XAxis dataKey="t" hide />
                <YAxis domain={[-1, 1]} stroke="#384868" tick={{ fontSize: 10 }} />
                <Tooltip
                  content={({ active, payload }) =>
                    active && payload?.[0] ? (
                      <div className="glass-card px-3 py-2 text-[10px] text-cyan-200/90">
                        Energy · sample {(payload[0].payload as { t: number }).t}
                      </div>
                    ) : null
                  }
                />
                <Area
                  type="monotone"
                  dataKey="amp"
                  stroke="#22d3ee"
                  strokeWidth={2}
                  fill="url(#waveFill)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="glass-card p-6 border border-[#1c2333]/80">
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-purple-400 shadow-[0_0_12px_rgba(168,85,247,0.5)]" />
              Top spoken tokens
            </h3>
            <p className="text-[11px] text-gray-500 mt-0.5">
              Frequency of alphanumeric words in the transcript (preview).
            </p>
          </div>
          {loading ? (
            chartBlock("Loading word chart…", 240)
          ) : wordFreq.length === 0 ? (
            chartBlock("No token counts — transcript is empty or too short.", 240)
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={wordFreq} layout="vertical" margin={{ left: 8, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1c2333" horizontal={false} />
                <XAxis type="number" stroke="#384868" tick={{ fontSize: 10 }} />
                <YAxis
                  type="category"
                  dataKey="word"
                  width={88}
                  stroke="#384868"
                  tick={{ fontSize: 10 }}
                />
                <Tooltip content={<BarTooltip />} />
                <Bar
                  dataKey="count"
                  name="Count"
                  fill="#a855f7"
                  radius={[0, 8, 8, 0]}
                  maxBarSize={22}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    );
  }

  /* ── Tabular: existing line chart ─────────────────────────────────── */
  const empty = tabularEmpty;
  return (
    <div className="glass-card p-6 border border-[#1c2333]/80">
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
