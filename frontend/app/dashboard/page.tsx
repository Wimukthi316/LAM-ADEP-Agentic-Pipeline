"use client";

import React, { useMemo } from "react";
import {
  Activity,
  Database,
  BarChart3,
  TrendingUp,
  Layers,
  Mic,
  Volume2,
  Type,
  Sparkles,
  FileSpreadsheet,
  AudioWaveform,
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
  sublabel,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: string;
  sublabel?: string;
}) {
  return (
    <div className="glass-card p-4 flex items-center gap-4 border border-[#1c2333]/60 hover:border-cyan-500/20 transition-colors">
      <div
        className={`w-10 h-10 rounded-xl flex items-center justify-center ${color} bg-white/[0.04] ring-1 ring-white/[0.06]`}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] text-gray-500 uppercase tracking-wider font-medium">
          {label}
        </p>
        <p className="text-lg font-bold text-white break-all leading-tight">{value}</p>
        {sublabel ? (
          <p className="text-[10px] text-gray-600 mt-1">{sublabel}</p>
        ) : null}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const {
    analyticsLoading,
    analyticsError,
    analyticsSnapshot,
    csvFilename,
    pipeline,
  } = usePipeline();

  const datasetLabel =
    analyticsSnapshot?.dataset_file ?? csvFilename ?? undefined;

  const metrics = analyticsSnapshot?.metrics ?? [];

  const transcript = (pipeline.audio_transcript || "").trim();
  const showAudioSection =
    Boolean(transcript) || pipeline.pipeline_kind === "audio";

  const wordCount = useMemo(() => {
    if (!transcript) return 0;
    return transcript.split(/\s+/).filter(Boolean).length;
  }, [transcript]);

  /** Rough speech seconds (~2.2 words/sec) for UX preview when no true duration exists. */
  const estAudioSeconds = useMemo(() => {
    if (wordCount <= 0) return 0;
    return Math.round((wordCount / 2.2) * 10) / 10;
  }, [wordCount]);

  const modalityLabel =
    (pipeline.audio_classifier_prediction || "").trim() ||
    (pipeline.pipeline_kind === "audio" ? "Audio · neuro-symbolic" : "—");

  const audioBasename = useMemo(() => {
    const p = (pipeline.audio_path || "").replace(/\\/g, "/").split("/").filter(Boolean);
    return p.length ? p[p.length - 1]! : null;
  }, [pipeline.audio_path]);

  const hasDailySeries =
    (analyticsSnapshot?.daily_sales?.length ?? 0) > 0 &&
    (analyticsSnapshot?.daily_series?.length ?? 0) > 0;

  const bannerMode = showAudioSection ? "multimodal" : "tabular";

  return (
    <main className="p-6 max-w-[1600px] mx-auto w-full space-y-8">
      {/* Summary banner */}
      <section
        className={`relative overflow-hidden rounded-2xl border px-6 py-5
          ${
            bannerMode === "multimodal"
              ? "border-amber-500/25 bg-gradient-to-r from-amber-500/10 via-[#0c1018] to-purple-500/10"
              : "border-cyan-500/20 bg-gradient-to-r from-cyan-500/10 via-[#0c1018] to-blue-900/10"
          }`}
      >
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.12] bg-[radial-gradient(ellipse_at_20%_0%,rgba(34,211,238,0.5),transparent_50%),radial-gradient(ellipse_at_80%_100%,rgba(168,85,247,0.35),transparent_45%)]"
          aria-hidden
        />
        <div className="relative flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-xl border border-white/10 bg-black/20 p-2">
              <Sparkles className="text-cyan-300" size={22} />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white tracking-tight">
                Multimodal command center
              </h2>
              <p className="text-[12px] text-gray-400 mt-1 max-w-2xl leading-relaxed">
                {showAudioSection ? (
                  <>
                    <span className="text-amber-200/90 font-medium">Audio</span> layer is
                    active{transcript ? " with a live transcript" : " (awaiting transcript)"}.
                    {hasDailySeries || metrics.length > 0 ? (
                      <>
                        {" "}
                        <span className="text-cyan-200/90 font-medium">Tabular</span> analytics
                        from your CSV are shown below.
                      </>
                    ) : (
                      " Add a CSV run to unlock spreadsheet metrics and daily trends."
                    )}
                  </>
                ) : (
                  <>
                    <span className="text-cyan-200/90 font-medium">CSV-first</span> view — run
                    the pipeline from the Pipeline page. Upload{" "}
                    <span className="text-gray-300">WAV/MP3</span> anytime to unlock the audio
                    lane.
                  </>
                )}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {showAudioSection ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[11px] font-medium text-amber-100">
                <AudioWaveform size={14} />
                Audio insight
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1.5 rounded-full border border-cyan-500/25 bg-cyan-500/5 px-3 py-1 text-[11px] font-medium text-cyan-100/90">
              <FileSpreadsheet size={14} />
              {datasetLabel ?? "No dataset selected"}
            </span>
          </div>
        </div>
      </section>

      {/* Audio metrics */}
      {showAudioSection ? (
        <section>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3 flex items-center gap-2">
            <Mic size={14} className="text-amber-400" />
            Audio analytics
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <StatCard
              icon={<Type size={18} />}
              label="Total words spoken"
              value={wordCount ? formatMetricValue(wordCount) : "—"}
              color="text-cyan-400"
              sublabel="From Whisper transcript in graph state"
            />
            <StatCard
              icon={<Volume2 size={18} />}
              label="Est. speech duration"
              value={estAudioSeconds > 0 ? `~${estAudioSeconds}s` : "—"}
              color="text-amber-400"
              sublabel="Approximate from word count (~2.2 words/sec)"
            />
            <StatCard
              icon={<Mic size={18} />}
              label="Identified modality"
              value={modalityLabel === "—" ? "Audio" : modalityLabel}
              color="text-purple-400"
              sublabel={audioBasename ? `Source: ${audioBasename}` : "Classifier + pipeline kind"}
            />
          </div>
        </section>
      ) : null}

      {/* Tabular metric cards */}
      <section>
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3 flex items-center gap-2">
          <BarChart3 size={14} className="text-cyan-400" />
          Tabular metrics
        </h3>
        <p className="text-[11px] text-gray-500 mb-4">
          Schema-aware metrics from the active CSV (numeric summaries; optional daily sums when a
          date column is detected).
        </p>
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
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
      </section>

      {/* Charts: audio lane then tabular lane */}
      {showAudioSection ? (
        <AnalyticsChart
          mode="audio"
          dailySales={[]}
          dailySeries={[]}
          loading={false}
          errorMessage={null}
          datasetSubtitle={audioBasename ?? datasetLabel}
          audioTranscript={pipeline.audio_transcript || transcript}
        />
      ) : null}

      <AnalyticsChart
        mode="tabular"
        dailySales={analyticsSnapshot?.daily_sales ?? []}
        dailySeries={analyticsSnapshot?.daily_series ?? []}
        loading={analyticsLoading}
        errorMessage={analyticsError}
        datasetSubtitle={datasetLabel}
        audioTranscript=""
      />
    </main>
  );
}
