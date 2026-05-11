import type { Node, Edge } from "reactflow";
import type { NodeStatus } from "@/components/PipelineNode";

export const STAGES = ["discovery", "transform", "healing", "orchestrator"] as const;

export type PipelineRunStatus =
  | "idle"
  | "running"
  | "paused"
  | "completed"
  | "failed";

export interface PipelineUIState {
  status: PipelineRunStatus;
  current_stage: string;
  thread_id: string | null;
  message: string;
  stages_completed: string[];
  generated_code: string;
  healing_iterations: number;
}

export const DEFAULT_PIPELINE_UI: PipelineUIState = {
  status: "idle",
  current_stage: "",
  thread_id: null,
  message: "Pipeline ready. Start from the Pipeline page after uploading a CSV.",
  stages_completed: [],
  generated_code: "",
  healing_iterations: 0,
};

export function uiStatusFromBackend(
  raw: unknown
): PipelineRunStatus | null {
  if (raw === "paused_for_approval") return "paused";
  if (raw === "completed") return "completed";
  if (raw === "running") return "running";
  if (raw === "failed") return "failed";
  if (raw === "idle") return "idle";
  return null;
}

export function mergePollIntoPipelineState(
  raw: Record<string, unknown>,
  prev: PipelineUIState
): PipelineUIState {
  const status = uiStatusFromBackend(raw.status) ?? prev.status;
  const healingRaw = raw.healing_iterations;
  const healing_iterations =
    typeof healingRaw === "number"
      ? healingRaw
      : typeof healingRaw === "string"
        ? parseInt(healingRaw, 10) || prev.healing_iterations
        : prev.healing_iterations;

  return {
    ...prev,
    status,
    current_stage:
      typeof raw.current_stage === "string"
        ? raw.current_stage
        : prev.current_stage,
    thread_id:
      typeof raw.thread_id === "string" ? raw.thread_id : prev.thread_id,
    message: typeof raw.message === "string" ? raw.message : prev.message,
    stages_completed: Array.isArray(raw.stages_completed)
      ? (raw.stages_completed as string[])
      : prev.stages_completed,
    generated_code:
      typeof raw.generated_code === "string"
        ? raw.generated_code
        : prev.generated_code,
    healing_iterations,
  };
}

export function getNodeStatus(
  stage: string,
  pipelineState: PipelineUIState
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

export function buildNodes(pipelineState: PipelineUIState): Node[] {
  const descriptions: Record<string, string> = {
    discovery: "ydata-profiling discovery (≤6 KB JSON)",
    transform: "Gemini 2.5 Flash + HITL gate",
    healing: "Reject routing & corrective loop (max 3)",
    orchestrator: "ChromaDB RLHF persistence",
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

/** LangGraph v3 topology: healing may loop back to transform on reject. */
export function buildEdges(pipelineState: PipelineUIState): Edge[] {
  const forward: Edge[] = [
    {
      id: "discovery-transform",
      source: "discovery",
      target: "transform",
      animated:
        pipelineState.stages_completed.includes("discovery") ||
        pipelineState.current_stage === "discovery",
      style: {
        stroke: pipelineState.stages_completed.includes("discovery")
          ? "#34d399"
          : "#384868",
        strokeWidth: 2,
      },
    },
    {
      id: "transform-healing",
      source: "transform",
      target: "healing",
      animated:
        pipelineState.stages_completed.includes("transform") ||
        pipelineState.current_stage === "transform",
      style: {
        stroke: pipelineState.stages_completed.includes("transform")
          ? "#34d399"
          : "#384868",
        strokeWidth: 2,
      },
    },
    {
      id: "healing-orchestrator",
      source: "healing",
      target: "orchestrator",
      animated:
        pipelineState.stages_completed.includes("healing") ||
        pipelineState.current_stage === "healing",
      style: {
        stroke: pipelineState.stages_completed.includes("healing")
          ? "#34d399"
          : "#384868",
        strokeWidth: 2,
      },
    },
  ];

  const loopActive =
    pipelineState.status === "paused" &&
    (pipelineState.healing_iterations > 0 ||
      pipelineState.message.toLowerCase().includes("re-generat"));

  const healLoop: Edge = {
    id: "healing-transform-loop",
    source: "healing",
    target: "transform",
    animated: loopActive,
    style: {
      stroke: loopActive ? "#fbbf24" : "#475569",
      strokeWidth: 2,
      strokeDasharray: "6 4",
    },
  };

  return [...forward, healLoop];
}
