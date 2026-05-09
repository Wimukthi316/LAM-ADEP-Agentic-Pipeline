"use client";

import React, { useCallback, useState } from "react";
import { Upload, FileSpreadsheet } from "lucide-react";
import { usePipeline } from "@/components/PipelineProvider";

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

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDrag(false);
      const f = e.dataTransfer.files?.[0];
      if (!f) return;
      if (!f.name.toLowerCase().endsWith(".csv")) return;
      setInputCsvPath(null);
      setPendingDatasetFile(f);
    },
    [setPendingDatasetFile, setInputCsvPath]
  );

  const onPick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      e.target.value = "";
      if (!f) return;
      setInputCsvPath(null);
      setPendingDatasetFile(f);
    },
    [setPendingDatasetFile, setInputCsvPath]
  );

  return (
    <div
      className={`relative rounded-2xl border-2 border-dashed px-4 py-8 text-center transition-colors cursor-pointer
        ${
          drag
            ? "border-cyan-500/60 bg-cyan-500/5"
            : "border-[#1c2333] bg-[#0a0d14] hover:border-[#384868]"
        }`}
      onDragEnter={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => setDrag(false)}
      onDrop={onDrop}
    >
      <input
        type="file"
        accept=".csv,text/csv"
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        onChange={onPick}
        disabled={loading}
      />
      <div className="pointer-events-none flex flex-col items-center gap-2">
        {displayName ? (
          <FileSpreadsheet className="text-cyan-400/90" size={28} />
        ) : (
          <Upload className="text-gray-500" size={28} />
        )}
        <p className="text-sm font-medium text-gray-300">
          Drop a CSV here or click to select
        </p>
        <p className="text-[11px] text-gray-500 max-w-md">
          The file is uploaded when you click{" "}
          <span className="text-gray-400">Start pipeline</span> (saved under{" "}
          <code className="text-gray-400">backend/temp_data/</code>).
        </p>
        {displayName ? (
          <p className="text-[12px] text-cyan-400/90 mt-1 font-medium">
            Selected: {displayName}
          </p>
        ) : (
          <p className="text-[11px] text-gray-600 mt-1">No file selected yet.</p>
        )}
      </div>
    </div>
  );
}
