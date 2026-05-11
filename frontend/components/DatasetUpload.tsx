"use client";

import React, { useCallback, useMemo, useState } from "react";
import { Upload, FileSpreadsheet, AudioWaveform } from "lucide-react";
import { usePipeline } from "@/components/PipelineProvider";

const ACCEPT_EXT = /\.(csv|wav|mp3)$/i;

function isAllowedFile(f: File): boolean {
  return ACCEPT_EXT.test(f.name);
}

function fileKind(name: string): "csv" | "audio" | "unknown" {
  const n = name.toLowerCase();
  if (n.endsWith(".csv")) return "csv";
  if (n.endsWith(".wav") || n.endsWith(".mp3")) return "audio";
  return "unknown";
}

export default function DatasetUpload() {
  const {
    pendingDatasetFile,
    setPendingDatasetFile,
    inputCsvPath,
    setInputCsvPath,
    loading,
  } = usePipeline();
  const [drag, setDrag] = useState(false);

  const displayName =
    pendingDatasetFile?.name ??
    (inputCsvPath
      ? inputCsvPath.replace(/\\/g, "/").split("/").filter(Boolean).pop()
      : null);

  const selectedKind = useMemo(() => {
    if (pendingDatasetFile) return fileKind(pendingDatasetFile.name);
    if (inputCsvPath) return fileKind(inputCsvPath);
    return null;
  }, [pendingDatasetFile, inputCsvPath]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDrag(false);
      const f = e.dataTransfer.files?.[0];
      if (!f || !isAllowedFile(f)) return;
      setInputCsvPath(null);
      setPendingDatasetFile(f);
    },
    [setPendingDatasetFile, setInputCsvPath]
  );

  const onPick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      e.target.value = "";
      if (!f || !isAllowedFile(f)) return;
      setInputCsvPath(null);
      setPendingDatasetFile(f);
    },
    [setPendingDatasetFile, setInputCsvPath]
  );

  return (
    <div
      className={`group relative overflow-hidden rounded-2xl border-2 border-dashed px-5 py-10 text-center transition-all duration-300 cursor-pointer
        ${
          drag
            ? "border-cyan-400/70 bg-gradient-to-br from-cyan-500/15 via-purple-500/10 to-amber-500/10 shadow-[0_0_40px_-8px_rgba(34,211,238,0.35)] scale-[1.01]"
            : "border-[#2a3548] bg-gradient-to-b from-[#0c1018] to-[#06080f] hover:border-amber-500/35 hover:shadow-[0_0_32px_-12px_rgba(251,191,36,0.25)]"
        }`}
      onDragEnter={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => setDrag(false)}
      onDrop={onDrop}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.07] bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-cyan-400 via-transparent to-transparent"
        aria-hidden
      />
      <input
        type="file"
        accept=".csv,.wav,.mp3,audio/wav,audio/mpeg,audio/mp3,text/csv"
        className="absolute inset-0 z-10 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
        onChange={onPick}
        disabled={loading}
      />
      <div className="pointer-events-none relative z-0 flex flex-col items-center gap-3">
        {displayName ? (
          <div className="flex items-center justify-center gap-3">
            {selectedKind === "audio" ? (
              <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 shadow-inner">
                <AudioWaveform className="text-amber-300" size={32} strokeWidth={1.75} />
              </div>
            ) : (
              <div className="rounded-2xl border border-cyan-500/30 bg-cyan-500/10 p-3 shadow-inner">
                <FileSpreadsheet className="text-cyan-300" size={32} strokeWidth={1.75} />
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center gap-4">
            <div className="rounded-2xl border border-cyan-500/25 bg-cyan-500/5 p-3">
              <FileSpreadsheet className="text-cyan-400/90" size={28} />
            </div>
            <span className="text-lg font-light text-gray-600 select-none">+</span>
            <div className="rounded-2xl border border-amber-500/25 bg-amber-500/5 p-3">
              <AudioWaveform className="text-amber-400/90" size={28} />
            </div>
            <span className="sr-only">CSV or audio</span>
          </div>
        )}
        {!displayName ? (
          <Upload className="text-gray-600 -mt-1" size={22} aria-hidden />
        ) : null}
        <div>
          <p className="text-sm font-semibold text-gray-100 tracking-tight">
            Upload tabular data or audio
          </p>
          <p className="text-[11px] text-gray-500 mt-1 max-w-md mx-auto leading-relaxed">
            <span className="text-cyan-400/90">CSV</span> for discovery + transforms ·{" "}
            <span className="text-amber-400/90">WAV / MP3</span> for MFCC + Whisper path. Upload runs when you
            click <span className="text-gray-400 font-medium">Start pipeline</span> →{" "}
            <code className="text-gray-500">backend/temp_data/</code>
          </p>
        </div>
        {displayName ? (
          <p className="text-[12px] text-cyan-200/90 mt-1 font-medium glass-card px-3 py-1.5 rounded-lg border border-[#1c2333]">
            Selected: {displayName}
          </p>
        ) : (
          <p className="text-[11px] text-gray-600 mt-1">Drop a file here or click anywhere in the zone.</p>
        )}
      </div>
    </div>
  );
}
