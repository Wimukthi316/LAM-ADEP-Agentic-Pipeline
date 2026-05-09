"use client";

import React from "react";
import { Brain, Radio } from "lucide-react";
import Sidebar from "@/components/Sidebar";
import { usePipeline } from "@/components/PipelineProvider";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { pipeline, csvFilename } = usePipeline();

  const statusColor =
    pipeline.status === "paused"
      ? "text-amber-400"
      : pipeline.status === "running"
        ? "text-cyan-400"
        : pipeline.status === "completed"
          ? "text-emerald-400"
          : pipeline.status === "failed"
            ? "text-rose-400"
            : "text-gray-500";

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <header className="border-b border-[#1c2333] bg-[#06080f]/80 backdrop-blur-md sticky top-0 z-50">
          <div className="max-w-[1600px] mx-auto px-6 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-500 to-purple-600 flex items-center justify-center">
                <Brain size={16} className="text-white" />
              </div>
              <div>
                <h1 className="text-sm font-bold tracking-tight">
                  <span className="gradient-text">LAM-ADEP</span>
                </h1>
                <p className="text-[10px] text-gray-500 -mt-0.5">
                  Metadata-first agentic data engineering
                  {csvFilename ? (
                    <span className="text-gray-600"> · {csvFilename}</span>
                  ) : null}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 glass-card px-3 py-1.5">
              <Radio
                size={12}
                className={
                  pipeline.status === "running"
                    ? "text-cyan-400 animate-pulse"
                    : pipeline.status === "paused"
                      ? "text-amber-400 animate-pulse"
                      : "text-gray-600"
                }
              />
              <span className={`text-[11px] font-medium ${statusColor}`}>
                {pipeline.status.toUpperCase().replace("_", " ")}
              </span>
              {pipeline.healing_iterations > 0 ? (
                <span className="text-[10px] text-gray-500 border-l border-[#1c2333] pl-2 ml-1">
                  heal {pipeline.healing_iterations}/3
                </span>
              ) : null}
            </div>
          </div>
        </header>
        <div className="flex-1">{children}</div>
      </div>
    </div>
  );
}
