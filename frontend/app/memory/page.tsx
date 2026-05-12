"use client";

import React, { useEffect, useMemo, useState } from "react";
import axios from "axios";
import {
  Loader2,
  Database,
  Search,
  Mic,
  FileSpreadsheet,
  Copy,
  Check,
  Trash2,
  Trash,
} from "lucide-react";
import { usePipeline, type MemoryItem } from "@/components/PipelineProvider";
import { API_BASE } from "@/lib/api";

function formatTimeAgo(raw: string | number | null | undefined): string {
  if (raw == null || raw === "") return "";
  const sec = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(sec) || sec <= 0) return "";
  const thenMs = sec < 1e12 ? sec * 1000 : sec;
  const diff = Date.now() - thenMs;
  if (diff < 10_000) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}

function detectMemoryModality(item: MemoryItem): "audio" | "tabular" {
  const sf = String(item.metadata?.source_file ?? "").toLowerCase();
  if (/\.(wav|mp3)$/.test(sf)) return "audio";
  const blob = `${item.code}${JSON.stringify(item.metadata ?? {})}`;
  if (
    blob.includes('"modality": "audio"') ||
    blob.includes("'modality': 'audio'") ||
    blob.includes('"modality":"audio"')
  ) {
    return "audio";
  }
  return "tabular";
}

export default function MemoryPage() {
  const { memoryItems, memoryLoading, refreshMemory, addToast } = usePipeline();
  const [query, setQuery] = useState("");
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    void refreshMemory();
  }, [refreshMemory]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return memoryItems;
    return memoryItems.filter((item) => {
      const hay = `${item.code}\n${JSON.stringify(item.metadata ?? {})}`.toLowerCase();
      return hay.includes(q);
    });
  }, [memoryItems, query]);

  const clearMemory = async () => {
    if (
      !confirm(
        "Are you sure you want to clear all approved RAG memories? This action cannot be undone."
      )
    ) {
      return;
    }
    setClearing(true);
    try {
      const res = await axios.delete(`${API_BASE}/memory`);
      const data = res.data as Record<string, unknown>;
      if (data.success === false) {
        addToast(
          "error",
          "Clear failed",
          typeof data.message === "string" ? data.message : "Could not clear memory."
        );
        return;
      }
      addToast(
        "success",
        "Memory cleared",
        typeof data.message === "string" ? data.message : "Chroma collection emptied."
      );
      await refreshMemory();
    } catch {
      addToast("error", "Clear failed", "Network error or backend unavailable.");
    } finally {
      setClearing(false);
    }
  };

  const deleteMemoryItem = async (item: MemoryItem) => {
    if (!item.id) {
      addToast("error", "Delete", "This entry has no Chroma id. Refresh the list.");
      return;
    }
    if (!confirm("Delete this memory item?")) return;
    setDeletingId(item.id);
    try {
      const res = await axios.delete(
        `${API_BASE}/memory/${encodeURIComponent(item.id)}`
      );
      const data = res.data as Record<string, unknown>;
      if (data.success === false) {
        addToast(
          "error",
          "Delete failed",
          typeof data.message === "string" ? data.message : "Could not delete item."
        );
        return;
      }
      addToast(
        "success",
        "Deleted",
        typeof data.message === "string" ? data.message : "Memory item removed."
      );
      await refreshMemory();
    } catch {
      addToast("error", "Delete failed", "Network error or backend unavailable.");
    } finally {
      setDeletingId(null);
    }
  };

  const copyCode = async (code: string, idx: number) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedIdx(idx);
      addToast("success", "Copied", "Snippet copied to clipboard.");
      window.setTimeout(() => setCopiedIdx((c) => (c === idx ? null : c)), 2000);
    } catch {
      addToast("error", "Copy failed", "Clipboard permission denied.");
    }
  };

  return (
    <main className="p-6 max-w-[1200px] mx-auto w-full">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Database size={20} className="text-purple-400" />
            Vector memory
          </h2>
          <p className="text-[11px] text-gray-500 mt-1">
            Chroma collection{" "}
            <code className="text-gray-400">approved_transforms</code> —{" "}
            <code className="text-gray-400">GET /memory</code> ·{" "}
            <code className="text-gray-400">DELETE /memory</code> ·{" "}
            <code className="text-gray-400">DELETE /memory/{"{id}"}</code>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void refreshMemory()}
            disabled={clearing}
            className="text-xs font-medium px-3 py-2 rounded-xl border border-[#1c2333] text-gray-300 hover:bg-[#1c2333]/50 disabled:opacity-50"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => void clearMemory()}
            disabled={clearing || memoryLoading}
            className="text-xs font-medium px-3 py-2 rounded-xl border border-red-500/50 bg-red-500/10 text-red-400 hover:bg-red-500/20 flex items-center gap-1.5 disabled:opacity-50 disabled:pointer-events-none"
          >
            {clearing ? (
              <Loader2 size={14} className="animate-spin shrink-0" />
            ) : (
              <Trash2 size={14} className="shrink-0" />
            )}
            Clear Memory
          </button>
        </div>
      </div>

      <div className="relative mb-6">
        <Search
          className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500"
          size={16}
        />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search code & metadata…"
          className="w-full rounded-xl border border-[#1c2333] bg-[#0a0d14]/90 py-2.5 pl-10 pr-4 text-sm text-gray-200 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-purple-500/40"
        />
      </div>

      {memoryLoading ? (
        <div className="flex items-center justify-center py-20 text-gray-500 gap-2">
          <Loader2 className="animate-spin" size={20} />
          Loading memory…
        </div>
      ) : filtered.length === 0 ? (
        <div className="glass-card p-10 text-center text-sm text-gray-500 border border-[#1c2333]/60">
          {memoryItems.length === 0
            ? "No approved scripts yet. Complete a pipeline with approval to store code in ChromaDB."
            : "No entries match your search."}
        </div>
      ) : (
        <ul className="space-y-5">
          {filtered.map((item, idx) => {
            const modality = detectMemoryModality(item);
            const tsRaw = item.metadata?.timestamp;
            const ago = formatTimeAgo(tsRaw as string | number | null);

            return (
              <li
                key={item.id || `${idx}-${String(item.metadata?.timestamp ?? idx)}`}
                className="glass-card p-0 overflow-hidden border border-[#1c2333]/80 shadow-lg shadow-black/20"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-[#1c2333] bg-[#080a10]/80">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[10px] text-gray-500 font-mono">#{idx + 1}</span>
                    {modality === "audio" ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-purple-500/35 bg-purple-500/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-purple-200">
                        <Mic size={12} className="text-purple-300" />
                        Audio
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/35 bg-emerald-500/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-200">
                        <FileSpreadsheet size={12} className="text-emerald-300" />
                        Tabular
                      </span>
                    )}
                    {ago ? (
                      <span className="text-[10px] text-gray-500">
                        Saved <span className="text-gray-400">{ago}</span>
                        {tsRaw != null ? (
                          <span className="text-gray-600"> · ts {String(tsRaw)}</span>
                        ) : null}
                      </span>
                    ) : null}
                  </div>
                </div>

                <div className="relative group">
                  <div className="absolute right-2 top-2 z-10 flex gap-1">
                    <button
                      type="button"
                      title="Copy code"
                      onClick={() => void copyCode(item.code, idx)}
                      className="rounded-lg border border-[#2a3548] bg-[#0d1117]/95 p-2 text-gray-400 hover:text-white hover:border-cyan-500/40 transition-colors"
                    >
                      {copiedIdx === idx ? (
                        <Check size={14} className="text-emerald-400" />
                      ) : (
                        <Copy size={14} />
                      )}
                    </button>
                    <button
                      type="button"
                      title="Delete this memory"
                      disabled={
                        clearing || !item.id || deletingId === item.id
                      }
                      onClick={() => void deleteMemoryItem(item)}
                      className="rounded-lg border border-transparent bg-[#0d1117]/95 p-2 text-gray-500 hover:text-red-400 hover:bg-red-500/10 hover:border-red-500/30 transition-colors disabled:opacity-40 disabled:pointer-events-none"
                    >
                      {deletingId === item.id ? (
                        <Loader2 size={14} className="animate-spin text-red-400/80" />
                      ) : (
                        <Trash size={14} />
                      )}
                    </button>
                  </div>
                  <pre
                    className="m-0 max-h-[320px] overflow-auto rounded-none border-0 bg-[#050608] px-4 py-4 pr-14 text-[12px] leading-relaxed text-gray-200 font-mono
                    selection:bg-cyan-500/25 border-l-4 border-l-cyan-500/40
                    [scrollbar-width:thin]"
                  >
                    <code>{item.code || "(empty)"}</code>
                  </pre>
                </div>

                {item.metadata && (
                  <details className="border-t border-[#1c2333] bg-[#06080f]/90 px-4 py-2 text-[10px] text-gray-500">
                    <summary className="cursor-pointer text-gray-400 hover:text-gray-300 select-none">
                      Raw metadata
                    </summary>
                    <pre className="mt-2 p-3 rounded-lg bg-[#0a0d14] overflow-x-auto text-[10px] text-gray-500 border border-[#1e2a3d]">
                      {JSON.stringify(item.metadata, null, 2)}
                    </pre>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
