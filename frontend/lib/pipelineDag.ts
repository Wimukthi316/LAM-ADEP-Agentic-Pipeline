import type { Node, Edge } from "reactflow";
import type { NodeStatus } from "@/components/PipelineNode";

/** All node ids that may appear in the React Flow DAG (tabular uses discovery; audio uses audio_preprocessing). */
export const STAGES = [
  "discovery",
  "audio_preprocessing",
  "transform",
  "healing",
  "orchestrator",
] as const;

export type PipelineKind = "tabular" | "audio";

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
  /** Which entry branch the UI + DAG reflect (CSV discovery vs audio preprocessing). */
  pipeline_kind: PipelineKind;
}

export const DEFAULT_PIPELINE_UI: PipelineUIState = {
  status: "idle",
  current_stage: "",
  thread_id: null,
  message:
    "Pipeline ready. Upload tabular data (CSV) or audio (WAV/MP3), then start from the Pipeline page.",
  stages_completed: [],
  generated_code: "",
  healing_iterations: 0,
  pipeline_kind: "tabular",
};

/** Ordered stages for the execution log / status chips for the active modality. */
export function orderedStagesForRun(kind: PipelineKind): string[] {
  if (kind === "audio") {
    return ["audio_preprocessing", "transform", "healing", "orchestrator"];
  }
  return ["discovery", "transform", "healing", "orchestrator"];
}

export function inferPipelineKindFromState(st: Record<string, unknown>): PipelineKind {
  const ap = st.audio_path;
  if (typeof ap === "string" && ap.trim()) {
    return "audio";
  }
  const rawInput = st.input_data;
  if (typeof rawInput === "string" && rawInput.trim()) {
    try {
      const j = JSON.parse(rawInput) as { modality?: string };
      if (j?.modality === "audio") return "audio";
    } catch {
      /* ignore */
    }
  }
  return "tabular";
}

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

  const nextStages = Array.isArray(raw.stages_completed)
    ? (raw.stages_completed as string[])
    : prev.stages_completed;
  let nextKind: PipelineKind = prev.pipeline_kind;
  if (nextStages.includes("audio_preprocessing")) nextKind = "audio";
  else if (nextStages.includes("discovery")) nextKind = "tabular";
  if (typeof raw.pipeline_kind === "string" && raw.pipeline_kind === "audio") {
    nextKind = "audio";
  }

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
    stages_completed: nextStages,
    generated_code:
      typeof raw.generated_code === "string"
        ? raw.generated_code
        : prev.generated_code,
    healing_iterations,
    pipeline_kind: nextKind,
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
  const kind = pipelineState.pipeline_kind;
  const chain = orderedStagesForRun(kind);

  const descriptions: Record<string, string> = {
    discovery: "ydata-profiling → compact JSON (tabular)",
    audio_preprocessing: "MFCC + neuro-symbolic classifier + Whisper",
    transform: "Gemini 2.5 Flash + HITL gate",
    healing: "Reject routing & corrective loop (max 3)",
    orchestrator: "ChromaDB RLHF persistence",
  };

  const icons: Record<string, string> = {
    discovery: "search",
    audio_preprocessing: "audio",
    transform: "shuffle",
    healing: "heartpulse",
    orchestrator: "brain",
  };

  /** ML / local models: amber; Gemini: purple; healing: cyan routing; memory: amber. */
  const nodeTheme: Record<string, "ml" | "gemini" | "routing" | "memory"> = {
    discovery: "ml",
    audio_preprocessing: "ml",
    transform: "gemini",
    healing: "routing",
    orchestrator: "memory",
  };

  const labels: Record<string, string> = {
    discovery: "Discovery",
    audio_preprocessing: "Audio prep",
    transform: "Transform",
    healing: "Healing",
    orchestrator: "Orchestrator",
  };

  return chain.map((stage, i) => ({
    id: stage,
    type: "pipeline",
    position: { x: i * 260, y: 60 },
    data: {
      label: labels[stage] ?? stage,
      icon: icons[stage] ?? "brain",
      nodeTheme: nodeTheme[stage] ?? "ml",
      status: getNodeStatus(stage, pipelineState),
      description: descriptions[stage] ?? "",
    },
    draggable: false,
  }));
}

/** LangGraph topology: entry → transform → healing → orchestrator; healing may loop to transform. */
export function buildEdges(pipelineState: PipelineUIState): Edge[] {
  const kind = pipelineState.pipeline_kind;
  const entry = kind === "audio" ? "audio_preprocessing" : "discovery";
  const entryDone = pipelineState.stages_completed.includes(entry);
  const entryActive = pipelineState.current_stage === entry;

  const forward: Edge[] = [
    {
      id: `${entry}-transform`,
      source: entry,
      target: "transform",
      animated: entryDone || entryActive,
      style: {
        stroke: entryDone ? "#34d399" : "#384868",
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
