"use client";

import React, { useMemo } from "react";
import type { Node, Edge } from "reactflow";
import {
  Play,
  Loader2,
  CheckCircle2,
  XCircle,
  Radio,
} from "lucide-react";
import PipelineFlowGraph from "@/components/PipelineFlowGraph";
import DatasetUpload from "@/components/DatasetUpload";
import { usePipeline } from "@/components/PipelineProvider";
import {
  STAGES,
  buildNodes,
  buildEdges,
  getNodeStatus,
} from "@/lib/pipelineDag";

export default function PipelinePage() {
  const {
    pipeline,
    loading,
    startPipeline,
    reset,
  } = usePipeline();

  const nodes = useMemo(() => buildNodes(pipeline), [pipeline]);
  const edges = useMemo(() => buildEdges(pipeline), [pipeline]);

  const isPaused = pipeline.status === "paused";
  const isRunning = pipeline.status === "running";
  const isCompleted = pipeline.status === "completed";
  const isFailed = pipeline.status === "failed";

  return (
    <main className="p-6 max-w-[1600px] mx-auto w-full flex flex-col gap-8">
      <section>
        <h2 className="text-lg font-semibold text-white">Dataset</h2>
        <p className="text-[11px] text-gray-500 mt-1 mb-4">
          Upload a CSV, then start the LangGraph run. The backend resolves paths
          dynamically—no hardcoded supermarket file.
        </p>
        <DatasetUpload />
      </section>

      <section className="glass-card p-5">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
          Pipeline control
        </h3>
        <div className="mb-4 p-3 rounded-xl bg-[#0a0d14] border border-[#1c2333]">
          <p className="text-[11px] text-gray-400 leading-relaxed">
            {pipeline.message}
          </p>
          {pipeline.thread_id ? (
            <p className="text-[10px] text-gray-600 mt-1 font-mono">
              Thread: {pipeline.thread_id.slice(0, 12)}…
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void startPipeline()}
          disabled={loading || isRunning || isPaused || isCompleted}
          className={`
                w-full max-w-md py-3 rounded-xl font-semibold text-sm
                flex items-center justify-center gap-2 transition-all duration-200
                ${
                  loading || isRunning || isPaused || isCompleted
                    ? "bg-[#1c2333] text-gray-500 cursor-not-allowed"
                    : "bg-gradient-to-r from-cyan-500 to-blue-600 text-white hover:from-cyan-400 hover:to-blue-500 hover:shadow-lg hover:shadow-cyan-500/20 active:scale-[0.98]"
                }
              `}
        >
          {loading ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              Initializing…
            </>
          ) : (
            <>
              <Play size={16} />
              Start pipeline
            </>
          )}
        </button>
        {(isCompleted || isFailed) && (
          <button
            type="button"
            onClick={reset}
            className="mt-2 max-w-md w-full py-2 rounded-xl text-xs font-medium text-gray-400 border border-[#1c2333] hover:bg-[#1c2333]/50 transition-colors"
          >
            Reset UI state
          </button>
        )}
      </section>

      <section className="glass-card p-1 min-h-[300px]">
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <div>
            <h2 className="text-sm font-semibold text-white">Pipeline DAG</h2>
            <p className="text-[11px] text-gray-500 mt-0.5">
              LangGraph v3 — dashed edge: healing → transform on reject (max 3)
            </p>
          </div>
          <div className="flex items-center gap-3 text-[10px] text-gray-500">
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-gray-600" />
              Idle
            </span>
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
              Running
            </span>
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
              Paused
            </span>
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500/80 border border-dashed border-amber-500/80 w-3 h-0.5 p-0 rounded" />
              Heal loop
            </span>
          </div>
        </div>
        <PipelineFlowGraph nodes={nodes as Node[]} edges={edges as Edge[]} />
      </section>

      <section className="glass-card p-5">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
          Execution log
        </h3>
        <div className="space-y-3">
          {STAGES.map((stage) => {
            const status = getNodeStatus(stage, pipeline);
            return (
              <div key={stage} className="flex items-center gap-3 text-xs">
                <div
                  className={`w-6 h-6 rounded-lg flex items-center justify-center text-[10px] font-bold
                      ${
                        status === "completed"
                          ? "bg-emerald-500/20 text-emerald-400"
                          : status === "running"
                            ? "bg-cyan-500/20 text-cyan-400"
                            : status === "paused"
                              ? "bg-amber-500/20 text-amber-400"
                              : status === "failed"
                                ? "bg-rose-500/20 text-rose-400"
                                : "bg-[#1c2333] text-gray-600"
                      }`}
                >
                  {status === "completed" ? (
                    <CheckCircle2 size={12} />
                  ) : status === "running" ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : status === "failed" ? (
                    <XCircle size={12} />
                  ) : (
                    STAGES.indexOf(stage) + 1
                  )}
                </div>
                <span
                  className={
                    status === "completed"
                      ? "text-gray-300"
                      : status === "running" || status === "paused"
                        ? "text-white font-medium"
                        : "text-gray-600"
                  }
                >
                  {stage.charAt(0).toUpperCase() + stage.slice(1)}
                </span>
                {status === "paused" && (
                  <span className="ml-auto text-[10px] text-amber-400 animate-pulse flex items-center gap-1">
                    <Radio size={10} />
                    HITL
                  </span>
                )}
                {status === "completed" && (
                  <span className="ml-auto text-[10px] text-emerald-500">
                    done
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}
