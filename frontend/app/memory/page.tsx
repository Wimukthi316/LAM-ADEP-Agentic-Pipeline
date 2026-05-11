"use client";

import React, { useEffect } from "react";
import { Loader2, Database } from "lucide-react";
import { usePipeline } from "@/components/PipelineProvider";

export default function MemoryPage() {
  const { memoryItems, memoryLoading, refreshMemory } = usePipeline();

  useEffect(() => {
    void refreshMemory();
  }, [refreshMemory]);

  return (
    <main className="p-6 max-w-[1200px] mx-auto w-full">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Database size={20} className="text-purple-400" />
            Approved RAG scripts
          </h2>
          <p className="text-[11px] text-gray-500 mt-1">
            Documents from Chroma collection{" "}
            <code className="text-gray-400">approved_transforms</code> via{" "}
            <code className="text-gray-400">GET /memory</code>.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refreshMemory()}
          className="text-xs font-medium px-3 py-2 rounded-xl border border-[#1c2333] text-gray-300 hover:bg-[#1c2333]/50"
        >
          Refresh
        </button>
      </div>

      {memoryLoading ? (
        <div className="flex items-center justify-center py-20 text-gray-500 gap-2">
          <Loader2 className="animate-spin" size={20} />
          Loading memory…
        </div>
      ) : memoryItems.length === 0 ? (
        <div className="glass-card p-10 text-center text-sm text-gray-500">
          No approved scripts yet. Complete a pipeline with approval to store
          code in ChromaDB.
        </div>
      ) : (
        <ul className="space-y-4">
          {memoryItems.map((item, idx) => (
            <li key={idx} className="glass-card p-4 border border-[#1c2333]">
              <div className="text-[10px] text-gray-500 mb-2 font-mono">
                #{idx + 1}
                {item.metadata?.timestamp != null
                  ? ` · ts ${item.metadata.timestamp}`
                  : null}
              </div>
              <pre className="text-[11px] text-gray-300 whitespace-pre-wrap overflow-x-auto max-h-[260px] overflow-y-auto rounded-lg bg-[#0a0d14] p-3 border border-[#1e2a3d]">
                {item.code || "(empty)"}
              </pre>
              {item.metadata && (
                <details className="mt-2 text-[10px] text-gray-500">
                  <summary className="cursor-pointer text-gray-400">
                    Metadata
                  </summary>
                  <pre className="mt-1 p-2 rounded bg-[#0a0d14] overflow-x-auto">
                    {JSON.stringify(item.metadata, null, 2)}
                  </pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
