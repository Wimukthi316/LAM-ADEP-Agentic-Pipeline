"use client";

import React, { useState, useCallback, useEffect, useMemo } from "react";
import ReactFlow, {
  Background,
  type Node,
  type Edge,
  type NodeTypes,
} from "reactflow";
import axios from "axios";
import {
  Play,
  Loader2,
  CheckCircle2,
  XCircle,
  ShieldCheck,
  Activity,
  Zap,
  Clock,
  TrendingDown,
  Brain,
  Radio,
} from "lucide-react";
import PipelineNode, { type NodeStatus } from "@/components/PipelineNode";
import AnalyticsChart from "@/components/AnalyticsChart";
import ToastContainer, { useToast } from "@/components/Toast";

const API_BASE = "http://localhost:8000";

// ── Node types registration ──
const nodeTypes: NodeTypes = {
  pipeline: PipelineNode,
};

// ── Pipeline stage definitions ──
const STAGES = ["discovery", "transform", "healing", "orchestrator"] as const;

interface PipelineState {
  status: "idle" | "running" | "paused" | "completed" | "failed";
  current_stage: string;
  thread_id: string | null;
  message: string;
  stages_completed: string[];
}

const DEFAULT_STATE: PipelineState = {
  status: "idle",
  current_stage: "",
  thread_id: null,
  message: "Pipeline ready. Press Start to begin.",
  stages_completed: [],
};

// ── Derive node status from pipeline state ──
function getNodeStatus(
  stage: string,
  pipelineState: PipelineState
): NodeStatus {
  const { status, current_stage, stages_completed } = pipelineState;

  if (status === "idle") return "idle";
  if (stages_completed.includes(stage)) return "completed";
  if (status === "failed" && current_stage === stage) return "failed";
  if (status === "paused" && current_stage === stage) return "paused";
  if (
    (status === "running" || status === "paused") &&
    current_stage === stage &&
    !stages_completed.includes(stage)
  )
    return status === "paused" ? "paused" : "running";
  if (status === "completed") return "completed";

  return "idle";
}

// ── Build React Flow nodes ──
function buildNodes(pipelineState: PipelineState): Node[] {
  const descriptions: Record<string, string> = {
    discovery: "Schema & anomaly detection",
    transform: "Adaptive transformations",
    healing: "Self-healing data repair",
    orchestrator: "LAM orchestration layer",
  };

  const icons: Record<string, string> = {
    discovery: "search",
    transform: "shuffle",
    healing: "heartpulse",
    orchestrator: "brain",
  };

  return STAGES.map((stage, i) => ({
    id: stage,
    type: "pipeline",
    position: { x: i * 260, y: 60 },
    data: {
      label:
        stage === "orchestrator"
          ? "Orchestrator"
          : stage.charAt(0).toUpperCase() + stage.slice(1),
      icon: icons[stage],
      status: getNodeStatus(stage, pipelineState),
      description: descriptions[stage],
    },
    draggable: false,
  }));
}

// ── Build React Flow edges ──
function buildEdges(pipelineState: PipelineState): Edge[] {
  const pairs: [string, string][] = [
    ["discovery", "transform"],
    ["transform", "healing"],
    ["healing", "orchestrator"],
  ];

  return pairs.map(([source, target]) => {
    const sourceCompleted =
      pipelineState.stages_completed.includes(source);

    return {
      id: `${source}-${target}`,
      source,
      target,
      animated: sourceCompleted || pipelineState.current_stage === source,
      style: {
        stroke: sourceCompleted ? "#34d399" : "#384868",
        strokeWidth: 2,
      },
    };
  });
}

// ── Stat Card ──
function StatCard({
  icon,
  label,
  value,
  trend,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  trend?: string;
  color: string;
}) {
  return (
    <div className="glass-card p-4 flex items-center gap-4">
      <div
        className={`w-10 h-10 rounded-xl flex items-center justify-center ${color} bg-white/[0.03]`}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] text-gray-500 uppercase tracking-wider font-medium">
          {label}
        </p>
        <p className="text-lg font-bold text-white">{value}</p>
      </div>
      {trend && (
        <span className="text-[10px] font-medium text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded-full">
          {trend}
        </span>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════
// ── MAIN DASHBOARD COMPONENT ──
// ═══════════════════════════════════════════════
export default function Dashboard() {
  const [pipelineState, setPipelineState] = useState<PipelineState>(DEFAULT_STATE);
  const [loading, setLoading] = useState(false);
  const [approving, setApproving] = useState(false);
  const { toasts, addToast, dismissToast } = useToast();

  const nodes = useMemo(() => buildNodes(pipelineState), [pipelineState]);
  const edges = useMemo(() => buildEdges(pipelineState), [pipelineState]);

  const isPaused = pipelineState.status === "paused";
  const isRunning = pipelineState.status === "running";
  const isCompleted = pipelineState.status === "completed";
  const isFailed = pipelineState.status === "failed";

  // ── Poll pipeline status ──
  useEffect(() => {
    if (!isRunning && !isPaused) return;

    const interval = setInterval(async () => {
      try {
        const res = await axios.get(`${API_BASE}/status`);
        if (res.data) {
          setPipelineState((prev) => ({
            ...prev,
            ...res.data,
          }));
        }
      } catch {
        // Silently fail — we don't want polling errors to spam the user
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [isRunning, isPaused]);

  // ── Start Pipeline ──
  const handleStart = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.post(`${API_BASE}/start`);
      const data = res.data;

      setPipelineState({
        status: data.status === "paused_for_approval" ? "paused" : "running",
        current_stage: data.current_stage || "discovery",
        thread_id: data.thread_id || null,
        message: data.message || "Pipeline started",
        stages_completed: data.stages_completed || [],
      });

      addToast("success", "Pipeline Started", data.message || "Pipeline execution initiated successfully.");
    } catch (err: unknown) {
      let msg = "Could not reach the backend. Is it running on port 8000?";
      if (axios.isAxiosError(err) && err.response?.data?.detail) {
        msg = err.response.data.detail;
      }
      addToast("error", "Start Failed", msg);
      setPipelineState((prev) => ({
        ...prev,
        status: "failed",
        message: msg,
      }));
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  // ── Approve / Reject ──
  const handleApproval = useCallback(
    async (action: "approve" | "reject") => {
      if (!pipelineState.thread_id) {
        addToast("warning", "No Thread", "No active thread to approve/reject.");
        return;
      }

      setApproving(true);
      try {
        const res = await axios.post(`${API_BASE}/approve`, {
          thread_id: pipelineState.thread_id,
          action,
        });
        const data = res.data;

        setPipelineState((prev) => ({
          ...prev,
          status: data.status === "completed"
            ? "completed"
            : data.status === "paused_for_approval"
              ? "paused"
              : "running",
          current_stage: data.current_stage || prev.current_stage,
          message: data.message || `Action ${action} processed.`,
          stages_completed: data.stages_completed || prev.stages_completed,
        }));

        addToast(
          action === "approve" ? "success" : "warning",
          action === "approve" ? "Approved" : "Rejected",
          data.message || `Transformation ${action}d successfully.`
        );
      } catch (err: unknown) {
        let msg = "Backend request failed. Please try again.";
        if (axios.isAxiosError(err) && err.response?.data?.detail) {
          msg = err.response.data.detail;
        }
        addToast("error", "Action Failed", msg);
      } finally {
        setApproving(false);
      }
    },
    [pipelineState.thread_id, addToast]
  );

  // ── Reset ──
  const handleReset = useCallback(() => {
    setPipelineState(DEFAULT_STATE);
    addToast("info", "Reset", "Dashboard reset to initial state.");
  }, [addToast]);

  // ── Status color ──
  const statusColor = isPaused
    ? "text-amber-400"
    : isRunning
      ? "text-cyan-400"
      : isCompleted
        ? "text-emerald-400"
        : isFailed
          ? "text-rose-400"
          : "text-gray-500";

  return (
    <main className="flex flex-col min-h-screen">
      {/* Toast Container */}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />

      {/* ── HEADER ── */}
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
                AI-Human Command Center
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {/* Live Status */}
            <div className="flex items-center gap-2 glass-card px-3 py-1.5">
              <Radio
                size={12}
                className={`${
                  isRunning
                    ? "text-cyan-400 animate-pulse"
                    : isPaused
                      ? "text-amber-400 animate-pulse"
                      : "text-gray-600"
                }`}
              />
              <span className={`text-[11px] font-medium ${statusColor}`}>
                {pipelineState.status.toUpperCase().replace("_", " ")}
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* ── MAIN CONTENT ── */}
      <div className="flex-1 flex flex-col lg:flex-row max-w-[1600px] mx-auto w-full">
        {/* ── LEFT: DAG + Analytics ── */}
        <div className="flex-1 p-6 flex flex-col gap-6 min-w-0">
          {/* Stat Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              icon={<Clock size={18} />}
              label="Avg MTTR"
              value="4 min"
              trend="↓ 91%"
              color="text-cyan-400"
            />
            <StatCard
              icon={<Zap size={18} />}
              label="Autonomy"
              value="94%"
              trend="↑ 82%"
              color="text-purple-400"
            />
            <StatCard
              icon={<TrendingDown size={18} />}
              label="Incidents"
              value="3"
              trend="↓ 93%"
              color="text-emerald-400"
            />
            <StatCard
              icon={<Activity size={18} />}
              label="Pipelines"
              value="847"
              color="text-amber-400"
            />
          </div>

          {/* DAG Visualization */}
          <div className="glass-card p-1 flex-1 min-h-[280px]">
            <div className="flex items-center justify-between px-5 pt-4 pb-2">
              <div>
                <h2 className="text-sm font-semibold text-white">
                  Pipeline DAG
                </h2>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  LangGraph stateful execution flow
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
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  Done
                </span>
              </div>
            </div>
            <div className="h-[220px]">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                fitView
                fitViewOptions={{ padding: 0.3 }}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                panOnDrag={false}
                zoomOnScroll={false}
                zoomOnPinch={false}
                zoomOnDoubleClick={false}
                preventScrolling={false}
                proOptions={{ hideAttribution: true }}
              >
                <Background color="#1c2333" gap={20} size={1} />
              </ReactFlow>
            </div>
          </div>

          {/* Analytics */}
          <div>
            <div className="mb-4">
              <h2 className="text-sm font-semibold text-white">
                Performance Analytics
              </h2>
              <p className="text-[11px] text-gray-500 mt-0.5">
                LAM adaptive learning metrics
              </p>
            </div>
            <AnalyticsChart />
          </div>
        </div>

        {/* ── RIGHT: HITL COMMAND CENTER SIDEBAR ── */}
        <aside className="w-full lg:w-[340px] border-l border-[#1c2333] p-6 flex flex-col gap-6">
          {/* Pipeline Control */}
          <div className="glass-card p-5">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
              Pipeline Control
            </h3>

            {/* Status Message */}
            <div className="mb-4 p-3 rounded-xl bg-[#0a0d14] border border-[#1c2333]">
              <p className="text-[11px] text-gray-400 leading-relaxed">
                {pipelineState.message}
              </p>
              {pipelineState.thread_id && (
                <p className="text-[10px] text-gray-600 mt-1 font-mono">
                  Thread: {pipelineState.thread_id.slice(0, 12)}...
                </p>
              )}
            </div>

            {/* Start Button */}
            <button
              onClick={handleStart}
              disabled={loading || isRunning}
              className={`
                w-full py-3 rounded-xl font-semibold text-sm
                flex items-center justify-center gap-2
                transition-all duration-200
                ${
                  loading || isRunning
                    ? "bg-[#1c2333] text-gray-500 cursor-not-allowed"
                    : "bg-gradient-to-r from-cyan-500 to-blue-600 text-white hover:from-cyan-400 hover:to-blue-500 hover:shadow-lg hover:shadow-cyan-500/20 active:scale-[0.98]"
                }
              `}
            >
              {loading ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Initializing...
                </>
              ) : isRunning ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Executing...
                </>
              ) : (
                <>
                  <Play size={16} />
                  Start Pipeline
                </>
              )}
            </button>

            {/* Reset */}
            {(isCompleted || isFailed) && (
              <button
                onClick={handleReset}
                className="w-full mt-2 py-2 rounded-xl text-xs font-medium text-gray-400
                  border border-[#1c2333] hover:bg-[#1c2333]/50 transition-colors"
              >
                Reset Dashboard
              </button>
            )}
          </div>

          {/* ── HITL Approval Section ── */}
          <div
            className={`glass-card p-5 transition-all duration-500 ${
              isPaused
                ? "opacity-100 ring-1 ring-amber-500/30"
                : "opacity-40 pointer-events-none"
            }`}
          >
            <div className="flex items-center gap-2 mb-4">
              <ShieldCheck
                size={14}
                className={isPaused ? "text-amber-400" : "text-gray-600"}
              />
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Adaptive HITL
              </h3>
              {isPaused && (
                <span className="ml-auto text-[10px] font-medium text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded-full animate-pulse">
                  ACTION REQUIRED
                </span>
              )}
            </div>

            {isPaused && (
              <div className="mb-4 p-3 rounded-xl bg-amber-500/5 border border-amber-500/20">
                <p className="text-[11px] text-amber-300/80 leading-relaxed">
                  The pipeline has paused for human review. Approve the
                  transformation plan to continue, or reject to halt execution.
                </p>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => handleApproval("approve")}
                disabled={!isPaused || approving}
                className={`
                  flex-1 py-2.5 rounded-xl text-xs font-semibold
                  flex items-center justify-center gap-1.5
                  transition-all duration-200
                  ${
                    isPaused && !approving
                      ? "bg-gradient-to-r from-emerald-500 to-teal-600 text-white hover:from-emerald-400 hover:to-teal-500 hover:shadow-lg hover:shadow-emerald-500/20 active:scale-[0.98]"
                      : "bg-[#1c2333] text-gray-600 cursor-not-allowed"
                  }
                `}
              >
                {approving ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <CheckCircle2 size={13} />
                )}
                Approve
              </button>
              <button
                onClick={() => handleApproval("reject")}
                disabled={!isPaused || approving}
                className={`
                  flex-1 py-2.5 rounded-xl text-xs font-semibold
                  flex items-center justify-center gap-1.5
                  transition-all duration-200
                  ${
                    isPaused && !approving
                      ? "bg-gradient-to-r from-rose-500 to-pink-600 text-white hover:from-rose-400 hover:to-pink-500 hover:shadow-lg hover:shadow-rose-500/20 active:scale-[0.98]"
                      : "bg-[#1c2333] text-gray-600 cursor-not-allowed"
                  }
                `}
              >
                <XCircle size={13} />
                Reject
              </button>
            </div>
          </div>

          {/* ── Pipeline Stages List ── */}
          <div className="glass-card p-5">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
              Execution Log
            </h3>
            <div className="space-y-3">
              {STAGES.map((stage) => {
                const status = getNodeStatus(stage, pipelineState);
                return (
                  <div
                    key={stage}
                    className="flex items-center gap-3 text-xs"
                  >
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
                    {status === "running" && (
                      <span className="ml-auto text-[10px] text-cyan-400 animate-pulse">
                        processing...
                      </span>
                    )}
                    {status === "paused" && (
                      <span className="ml-auto text-[10px] text-amber-400 animate-pulse">
                        awaiting...
                      </span>
                    )}
                    {status === "completed" && (
                      <span className="ml-auto text-[10px] text-emerald-500">
                        ✓ done
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
