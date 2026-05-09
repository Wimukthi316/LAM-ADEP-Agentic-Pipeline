"use client";

import React, { useCallback, useState } from "react";
import { Upload, Loader2 } from "lucide-react";
import { usePipeline } from "@/components/PipelineProvider";

export default function DatasetUpload() {
  const { uploadDataset, uploadBusy, csvFilename } = usePipeline();
  const [drag, setDrag] = useState(false);

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDrag(false);
      const f = e.dataTransfer.files?.[0];
      if (!f) return;
      if (!f.name.toLowerCase().endsWith(".csv")) {
        return;
      }
      await uploadDataset(f);
    },
    [uploadDataset]
  );

  const onPick = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      e.target.value = "";
      if (!f) return;
      await uploadDataset(f);
    },
    [uploadDataset]
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
        disabled={uploadBusy}
      />
      <div className="pointer-events-none flex flex-col items-center gap-2">
        {uploadBusy ? (
          <Loader2 className="text-cyan-400 animate-spin" size={28} />
        ) : (
          <Upload className="text-gray-500" size={28} />
        )}
        <p className="text-sm font-medium text-gray-300">
          Drop a CSV here or click to upload
        </p>
        <p className="text-[11px] text-gray-500 max-w-sm">
          Files are stored under <code className="text-gray-400">backend/data/</code>.
          {csvFilename ? (
            <span className="block mt-1 text-cyan-400/90">
              Active: {csvFilename}
            </span>
          ) : (
            <span className="block mt-1">No file selected yet.</span>
          )}
        </p>
      </div>
    </div>
  );
}
