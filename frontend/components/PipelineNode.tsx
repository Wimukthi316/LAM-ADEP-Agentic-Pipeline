"use client";

import React from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import {
  Search,
  Shuffle,
  HeartPulse,
  Brain,
  Loader2,
  CheckCircle2,
  XCircle,
  PauseCircle,
  AudioWaveform,
} from "lucide-react";

export type NodeStatus = "idle" | "running" | "completed" | "failed" | "paused";

export type PipelineNodeTheme = "ml" | "gemini" | "routing" | "memory";

interface PipelineNodeData {
  label: string;
  icon: string;
  /** Visual lane: ML (amber), Gemini (purple), routing (cyan), memory (amber). */
  nodeTheme?: PipelineNodeTheme;
  status: NodeStatus;
  description: string;
}

const iconMap: Record<string, React.ReactNode> = {
  search: <Search size={20} />,
  audio: <AudioWaveform size={20} />,
  shuffle: <Shuffle size={20} />,
  heartpulse: <HeartPulse size={20} />,
  brain: <Brain size={20} />,
};

const themeGradient: Record<PipelineNodeTheme, string> = {
  ml: "from-amber-500/25 to-orange-600/15",
  gemini: "from-purple-500/25 to-fuchsia-600/20",
  routing: "from-cyan-500/20 to-teal-600/15",
  memory: "from-amber-500/20 to-yellow-600/15",
};

const themeAccent: Record<PipelineNodeTheme, string> = {
  ml: "text-amber-400",
  gemini: "text-purple-400",
  routing: "text-cyan-400",
  memory: "text-amber-300",
};

/** Legacy fallback when `nodeTheme` is absent (older callers). */
const gradientByIcon: Record<string, string> = {
  search: "from-cyan-500/20 to-blue-600/20",
  audio: "from-amber-500/25 to-orange-600/15",
  shuffle: "from-purple-500/20 to-fuchsia-600/20",
  heartpulse: "from-emerald-500/20 to-teal-600/20",
  brain: "from-amber-500/20 to-orange-600/20",
};

const accentByIcon: Record<string, string> = {
  search: "text-cyan-400",
  audio: "text-amber-400",
  shuffle: "text-purple-400",
  heartpulse: "text-emerald-400",
  brain: "text-amber-400",
};

const statusBadge: Record<NodeStatus, { label: string; icon: React.ReactNode; color: string }> = {
  idle: { label: "Idle", icon: null, color: "text-gray-500" },
  running: {
    label: "Running",
    icon: <Loader2 size={12} className="animate-spin" />,
    color: "text-cyan-400",
  },
  completed: {
    label: "Done",
    icon: <CheckCircle2 size={12} />,
    color: "text-emerald-400",
  },
  failed: {
    label: "Failed",
    icon: <XCircle size={12} />,
    color: "text-rose-400",
  },
  paused: {
    label: "Awaiting",
    icon: <PauseCircle size={12} />,
    color: "text-amber-400",
  },
};

export default function PipelineNode({ data }: NodeProps<PipelineNodeData>) {
  const status = data.status ?? "idle";
  const badge = statusBadge[status];
  const theme = data.nodeTheme;
  const grad = theme
    ? themeGradient[theme]
    : gradientByIcon[data.icon] ?? "from-gray-700/20 to-gray-800/20";
  const acc = theme
    ? themeAccent[theme]
    : accentByIcon[data.icon] ?? "text-gray-400";

  return (
    <>
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-[#384868] !border-[#384868] !w-2 !h-2"
      />

      <div
        className={`
          relative w-[180px] rounded-2xl border border-[#1c2333]
          bg-gradient-to-br ${grad}
          backdrop-blur-md p-4 transition-all duration-300
          node-${status}
        `}
      >
        {/* Icon */}
        <div
          className={`mb-2 flex items-center justify-center w-9 h-9 rounded-xl
            bg-[#0d1117]/80 border border-[#1c2333] ${acc}`}
        >
          {iconMap[data.icon] ?? <Brain size={20} />}
        </div>

        {/* Title */}
        <h3 className="text-sm font-semibold text-white leading-tight mb-0.5">
          {data.label}
        </h3>

        {/* Description */}
        <p className="text-[10px] text-gray-400 leading-tight mb-2">
          {data.description}
        </p>

        {/* Status Badge */}
        <div
          className={`flex items-center gap-1 text-[10px] font-medium ${badge.color}`}
        >
          {badge.icon}
          <span>{badge.label}</span>
        </div>

        {/* Running shimmer overlay */}
        {status === "running" && (
          <div className="absolute inset-0 rounded-2xl shimmer pointer-events-none" />
        )}
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="!bg-[#384868] !border-[#384868] !w-2 !h-2"
      />
    </>
  );
}
