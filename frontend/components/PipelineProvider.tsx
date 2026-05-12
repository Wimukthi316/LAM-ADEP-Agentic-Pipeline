"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import axios from "axios";
import ToastContainer, { useToast } from "@/components/Toast";
import type {
  DailyChartSeries,
  DailySeriesPoint,
} from "@/components/AnalyticsChart";
import { API_BASE } from "@/lib/api";
import {
  DEFAULT_PIPELINE_UI,
  inferPipelineKindFromState,
  mergePollIntoPipelineState,
  orderedStagesForRun,
  parseMultimodalFromGraphState,
  type PipelineUIState,
} from "@/lib/pipelineDag";

function apiErrorDetail(data: unknown): string {
  if (!data || typeof data !== "object") return "Request failed.";
  const d = data as Record<string, unknown>;
  const detail = d.detail;
  if (typeof detail === "string") return detail;
  if (detail != null) return JSON.stringify(detail);
  if (typeof d.error === "string") return d.error;
  if (typeof d.message === "string") return d.message;
  return "Request failed.";
}

export interface MemoryItem {
  code: string;
  metadata: Record<string, string | number | boolean | null> | null;
}

interface PipelineContextValue {
  pipeline: PipelineUIState;
  editedCode: string;
  setEditedCode: React.Dispatch<React.SetStateAction<string>>;
  /** Basename for analytics/download UI (from uploaded path or pending file). */
  csvFilename: string | null;
  pendingDatasetFile: File | null;
  setPendingDatasetFile: (f: File | null) => void;
  /** Absolute path from POST /upload (`file_path`) after last successful upload-on-start. */
  inputCsvPath: string | null;
  setInputCsvPath: (p: string | null) => void;
  startPhase: "idle" | "uploading" | "starting";
  loading: boolean;
  approving: boolean;
  rejecting: boolean;
  downloading: boolean;
  analyticsLoading: boolean;
  analyticsError: string | null;
  analyticsSnapshot: {
    metrics: { label: string; value: number }[];
    daily_sales: DailySeriesPoint[];
    daily_series: DailyChartSeries[];
    dataset_file: string | null;
  } | null;
  memoryItems: MemoryItem[];
  memoryLoading: boolean;
  refreshAnalytics: () => Promise<void>;
  refreshMemory: () => Promise<void>;
  startPipeline: () => Promise<void>;
  approvePipeline: () => Promise<void>;
  rejectPipeline: (feedback: string) => Promise<void>;
  reset: () => void;
  downloadCleanedCsv: () => Promise<void>;
  addToast: ReturnType<typeof useToast>["addToast"];
}

const PipelineContext = createContext<PipelineContextValue | null>(null);

export function usePipeline(): PipelineContextValue {
  const ctx = useContext(PipelineContext);
  if (!ctx)
    throw new Error("usePipeline must be used within PipelineProvider");
  return ctx;
}

function apiResponseToPipelineUI(
  data: Record<string, unknown>,
  paused: boolean
): Partial<PipelineUIState> {
  const st =
    data.state && typeof data.state === "object"
      ? (data.state as Record<string, unknown>)
      : {};
  const fromState =
    typeof st.generated_code === "string" ? st.generated_code : "";
  const fromTop =
    typeof data.generated_code === "string"
      ? (data.generated_code as string)
      : "";
  const generated =
    fromState.trim() !== ""
      ? fromState
      : fromTop;
  const hit = st.healing_iterations;
  const healing_iterations =
    typeof hit === "number"
      ? hit
      : typeof hit === "string"
        ? parseInt(hit, 10) || 0
        : 0;

  const kind = inferPipelineKindFromState(st);
  const defaultEntry =
    kind === "audio" ? "audio_preprocessing" : "discovery";

  const mm = parseMultimodalFromGraphState(st);

  if (paused) {
    const stagesFromState = Array.isArray(st.stages_completed)
      ? (st.stages_completed as string[])
      : [defaultEntry];
    return {
      status: "paused",
      current_stage: "transform",
      thread_id:
        typeof data.thread_id === "string" ? data.thread_id : null,
      message:
        typeof data.message === "string"
          ? data.message
          : "Paused for human review.",
      stages_completed: stagesFromState.length ? stagesFromState : [defaultEntry],
      generated_code: generated,
      healing_iterations,
      pipeline_kind: kind,
      ...mm,
    };
  }

  const fullDone =
    Array.isArray(st.stages_completed) && st.stages_completed.length > 0
      ? (st.stages_completed as string[])
      : orderedStagesForRun(kind);

  return {
    status: "completed",
    current_stage: "orchestrator",
    thread_id:
      typeof data.thread_id === "string" ? data.thread_id : null,
    message:
      typeof data.message === "string"
        ? data.message
        : "Pipeline complete.",
    stages_completed: fullDone,
    generated_code: generated,
    healing_iterations,
    pipeline_kind: kind,
    ...mm,
  };
}

function pausedStateToPipelineUI(
  state: Record<string, unknown>,
  threadId: string
): Partial<PipelineUIState> {
  const generated =
    typeof state.generated_code === "string" ? state.generated_code : "";
  const hit = state.healing_iterations;
  const healing_iterations =
    typeof hit === "number"
      ? hit
      : typeof hit === "string"
        ? parseInt(hit, 10) || 0
        : 0;
  const kind = inferPipelineKindFromState(state);
  const defaultEntry =
    kind === "audio" ? "audio_preprocessing" : "discovery";
  const stagesFromState = Array.isArray(state.stages_completed)
    ? (state.stages_completed as string[])
    : [defaultEntry];
  return {
    status: "paused",
    current_stage: "transform",
    thread_id: threadId,
    message:
      typeof state.status === "string"
        ? state.status
        : "Paused for human review.",
    stages_completed: stagesFromState.length ? stagesFromState : [defaultEntry],
    generated_code: generated,
    healing_iterations,
    pipeline_kind: kind,
    ...parseMultimodalFromGraphState(state),
  };
}

export function PipelineProvider({ children }: { children: React.ReactNode }) {
  const { toasts, addToast, dismissToast } = useToast();
  const [pipeline, setPipeline] = useState<PipelineUIState>(DEFAULT_PIPELINE_UI);
  const [editedCode, setEditedCode] = useState("");
  const [pendingDatasetFile, setPendingDatasetFile] = useState<File | null>(null);
  const [inputCsvPath, setInputCsvPath] = useState<string | null>(null);
  const [startPhase, setStartPhase] = useState<"idle" | "uploading" | "starting">(
    "idle"
  );
  const [loading, setLoading] = useState(false);
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  /** Prevents /status polling from overwriting optimistic "running" UI during POST /reject. */
  const rejectingInFlightRef = useRef(false);
  const [downloading, setDownloading] = useState(false);

  const csvFilename = useMemo(() => {
    if (inputCsvPath) {
      const norm = inputCsvPath.replace(/\\/g, "/");
      const seg = norm.split("/").filter(Boolean);
      return seg.length ? seg[seg.length - 1]! : null;
    }
    return pendingDatasetFile?.name ?? null;
  }, [inputCsvPath, pendingDatasetFile]);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [analyticsSnapshot, setAnalyticsSnapshot] = useState<{
    metrics: { label: string; value: number }[];
    daily_sales: DailySeriesPoint[];
    daily_series: DailyChartSeries[];
    dataset_file: string | null;
  } | null>(null);
  const [memoryItems, setMemoryItems] = useState<MemoryItem[]>([]);
  const [memoryLoading, setMemoryLoading] = useState(false);

  const isRunning = pipeline.status === "running";
  const isPaused = pipeline.status === "paused";

  useEffect(() => {
    if (pipeline.thread_id) {
      window.localStorage.setItem("lam_adep_thread_id", pipeline.thread_id);
    }
  }, [pipeline.thread_id]);

  useEffect(() => {
    if (!isPaused) return;
    const code = pipeline.generated_code;
    if (typeof code !== "string" || !code.trim()) return;
    queueMicrotask(() => {
      setEditedCode(code);
    });
  }, [isPaused, pipeline.generated_code]);

  useEffect(() => {
    if (!isRunning && !isPaused) return;
    const interval = setInterval(async () => {
      try {
        const res = await axios.get(`${API_BASE}/status`);
        if (!res.data || typeof res.data !== "object") return;

        let raw = res.data as Record<string, unknown>;

        if (raw.status === "paused_for_approval") {
          const topCode =
            typeof raw.generated_code === "string" ? raw.generated_code : "";
          const nested =
            raw.state && typeof raw.state === "object"
              ? (raw.state as Record<string, unknown>).generated_code
              : undefined;
          const nestedCode =
            typeof nested === "string" ? nested : "";
          const hasCode =
            topCode.trim() !== "" || nestedCode.trim() !== "";
          const tid =
            typeof raw.thread_id === "string" && raw.thread_id.trim()
              ? raw.thread_id.trim()
              : window.localStorage.getItem("lam_adep_thread_id");
          if (!hasCode && tid) {
            try {
              const tRes = await axios.get(`${API_BASE}/state/${tid}`);
              const tData = tRes.data as Record<string, unknown>;
              if (
                tData.success !== false &&
                tData.state &&
                typeof tData.state === "object"
              ) {
                const st = tData.state as Record<string, unknown>;
                const gc =
                  typeof st.generated_code === "string"
                    ? st.generated_code
                    : "";
                if (gc.trim()) {
                  raw = { ...raw, generated_code: gc };
                  setEditedCode(gc);
                }
              }
            } catch {
              /* ignore direct state fetch */
            }
          }
        }

        setPipeline((prev) => {
          if (rejectingInFlightRef.current) return prev;
          return mergePollIntoPipelineState(raw, prev);
        });
      } catch {
        /* ignore poll errors */
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [isRunning, isPaused]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await axios.get(`${API_BASE}/status`);
        if (!res.data || typeof res.data !== "object" || cancelled) return;
        const raw = res.data as Record<string, unknown>;
        if (raw.status === "paused_for_approval") {
          setPipeline((prev) => mergePollIntoPipelineState(raw, prev));
          return;
        }
        const cachedThread = window.localStorage.getItem("lam_adep_thread_id");
        if (!cachedThread) return;
        const tRes = await axios.get(`${API_BASE}/state/${cachedThread}`);
        const tData = tRes.data as Record<string, unknown>;
        if (cancelled || tData.success === false || tData.paused !== true) return;
        const rawState =
          tData.state && typeof tData.state === "object"
            ? (tData.state as Record<string, unknown>)
            : {};
        const ui = pausedStateToPipelineUI(rawState, cachedThread);
        setPipeline((prev) => ({ ...prev, ...ui }));
        if (typeof ui.generated_code === "string" && ui.generated_code.trim()) {
          setEditedCode(ui.generated_code);
        }
      } catch {
        /* ignore hydration failure */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshAnalytics = useCallback(async () => {
    setAnalyticsLoading(true);
    try {
      const params =
        csvFilename != null ? { csv_filename: csvFilename } : undefined;
      const res = await axios.get(`${API_BASE}/analytics`, { params });
      const d = res.data as Record<string, unknown>;
      if (d.success === false) {
        setAnalyticsError(
          typeof d.message === "string" ? d.message : "Analytics unavailable."
        );
        setAnalyticsSnapshot(null);
        return;
      }
      setAnalyticsError(null);
      const metricsRaw = Array.isArray(d.metrics) ? d.metrics : [];
      let metrics: { label: string; value: number }[] = metricsRaw.map(
        (m) => {
          const x = m as Record<string, unknown>;
          return {
            label: typeof x.label === "string" ? x.label : "Metric",
            value: typeof x.value === "number" ? x.value : Number(x.value) || 0,
          };
        }
      );
      if (!metrics.length) {
        metrics = [{ label: "Total Rows", value: 0 }];
      }
      const dailyRaw = Array.isArray(d.daily_sales) ? d.daily_sales : [];
      const daily_sales: DailySeriesPoint[] = dailyRaw.map((p) => {
        const x = p as Record<string, unknown>;
        const pt: DailySeriesPoint = {
          date: typeof x.date === "string" ? x.date : "",
          label: typeof x.label === "string" ? x.label : "",
        };
        for (const [k, v] of Object.entries(x)) {
          if (k === "date" || k === "label") continue;
          pt[k] = typeof v === "number" ? v : Number(v) || 0;
        }
        return pt;
      });
      const seriesRaw = Array.isArray(d.daily_series) ? d.daily_series : [];
      const daily_series: DailyChartSeries[] = seriesRaw.map((s) => {
        const x = s as Record<string, unknown>;
        return {
          key: typeof x.key === "string" ? x.key : "",
          label: typeof x.label === "string" ? x.label : "",
        };
      });
      const dsFile = d.dataset_file;
      setAnalyticsSnapshot({
        metrics,
        daily_sales,
        daily_series,
        dataset_file: typeof dsFile === "string" ? dsFile : null,
      });
    } catch {
      setAnalyticsError(
        "Could not load analytics. Is the backend running on port 8000?"
      );
      setAnalyticsSnapshot(null);
    } finally {
      setAnalyticsLoading(false);
    }
  }, [csvFilename]);

  useEffect(() => {
    queueMicrotask(() => {
      void refreshAnalytics();
    });
  }, [refreshAnalytics]);

  const refreshMemory = useCallback(async () => {
    setMemoryLoading(true);
    try {
      const res = await axios.get(`${API_BASE}/memory`);
      const d = res.data as Record<string, unknown>;
      const raw = Array.isArray(d.items) ? d.items : [];
      const items: MemoryItem[] = raw.map((x) => {
        const o = x as Record<string, unknown>;
        return {
          code: typeof o.code === "string" ? o.code : "",
          metadata:
            o.metadata && typeof o.metadata === "object"
              ? (o.metadata as Record<string, string | number | boolean | null>)
              : null,
        };
      });
      setMemoryItems(items);
    } catch {
      addToast("error", "Memory", "Failed to load ChromaDB memory.");
    } finally {
      setMemoryLoading(false);
    }
  }, [addToast]);

  const startPipeline = useCallback(async () => {
    if (!pendingDatasetFile && !inputCsvPath) {
      addToast(
        "warning",
        "No dataset",
        "Choose a CSV, WAV, or MP3 file first, then start (upload runs automatically)."
      );
      return;
    }

    if (
      pendingDatasetFile &&
      !/\.(csv|wav|mp3)$/i.test(pendingDatasetFile.name)
    ) {
      addToast(
        "warning",
        "Unsupported file",
        "Use a .csv, .wav, or .mp3 file."
      );
      return;
    }

    setLoading(true);
    try {
      let path = inputCsvPath;

      if (pendingDatasetFile) {
        setStartPhase("uploading");
        const fd = new FormData();
        fd.append("file", pendingDatasetFile);
        const up = await axios.post(`${API_BASE}/upload`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        });
        const ud = up.data as Record<string, unknown>;
        if (ud.success === false) {
          addToast("error", "Upload failed", apiErrorDetail(ud));
          setPipeline((p) => ({ ...p, status: "failed", message: apiErrorDetail(ud) }));
          return;
        }
        const fp = ud.file_path ?? ud.path;
        if (typeof fp !== "string" || !fp.trim()) {
          addToast("error", "Upload failed", "Missing file_path in upload response.");
          return;
        }
        path = fp.trim();
        setInputCsvPath(path);
        setPendingDatasetFile(null);
        await refreshAnalytics();
      }

      if (!path) {
        addToast("error", "Start Failed", "No file path after upload.");
        return;
      }

      const isAudio = /\.(wav|mp3)$/i.test(path);
      setStartPhase("starting");
      const startBody = isAudio
        ? { input_data: "audio_trigger", audio_path: path }
        : { input_data: "sample_data", input_csv_path: path };
      const res = await axios.post(`${API_BASE}/start`, startBody);
      const data = res.data as Record<string, unknown>;

      if (data.success === false) {
        const msg = apiErrorDetail(data);
        addToast("error", "Start Failed", msg);
        setPipeline((p) => ({ ...p, status: "failed", message: msg }));
        return;
      }

      const pausedFlag = (data.paused as boolean | undefined) !== false;
      const ui = apiResponseToPipelineUI(data, pausedFlag);
      setPipeline((prev) => ({
        ...prev,
        ...ui,
        pipeline_kind: isAudio ? "audio" : "tabular",
      }));
      if (typeof ui.generated_code === "string" && ui.generated_code.trim()) {
        setEditedCode(ui.generated_code);
      }
      addToast(
        "success",
        "Pipeline Started",
        typeof data.message === "string"
          ? data.message
          : "Paused at HITL — review generated code."
      );
    } catch (err: unknown) {
      let msg = "Could not reach the backend. Is it running on port 8000?";
      if (axios.isAxiosError(err) && err.response?.data)
        msg = apiErrorDetail(err.response.data);
      addToast("error", "Start Failed", msg);
      setPipeline((p) => ({ ...p, status: "failed", message: msg }));
    } finally {
      setStartPhase("idle");
      setLoading(false);
    }
  }, [addToast, pendingDatasetFile, inputCsvPath, refreshAnalytics]);

  const approvePipeline = useCallback(async () => {
    if (!pipeline.thread_id) {
      addToast("warning", "No Thread", "Start the pipeline first.");
      return;
    }
    setApproving(true);
    try {
      const res = await axios.post(`${API_BASE}/approve`, {
        thread_id: pipeline.thread_id,
        action: "Approve",
        edited_code: editedCode,
      });
      const data = res.data as Record<string, unknown>;
      if (data.success === false) {
        addToast("error", "Approve Failed", apiErrorDetail(data));
        return;
      }
      const paused = data.paused === true;
      const ui = apiResponseToPipelineUI(data, paused);
      setPipeline((prev) => ({ ...prev, ...ui }));
      if (
        paused &&
        typeof ui.generated_code === "string" &&
        ui.generated_code.trim()
      ) {
        setEditedCode(ui.generated_code);
      }
      addToast(
        paused ? "info" : "success",
        paused ? "Regenerated" : "Approved",
        typeof data.message === "string" ? data.message : "OK"
      );
      if (!paused) {
        void refreshAnalytics();
        void refreshMemory();
      }
    } catch (err: unknown) {
      let msg = "Backend request failed.";
      if (axios.isAxiosError(err) && err.response?.data)
        msg = apiErrorDetail(err.response.data);
      addToast("error", "Approve Failed", msg);
    } finally {
      setApproving(false);
    }
  }, [addToast, editedCode, pipeline.thread_id, refreshAnalytics, refreshMemory]);

  const rejectPipeline = useCallback(
    async (feedback: string) => {
      if (!pipeline.thread_id) {
        addToast("warning", "No Thread", "Start the pipeline first.");
        return;
      }
      const tid = pipeline.thread_id;
      rejectingInFlightRef.current = true;
      setRejecting(true);
      setPipeline((prev) => ({
        ...prev,
        status: "running",
        current_stage: "transform",
        message: "Regenerating code after rejection…",
      }));
      try {
        const res = await axios.post(`${API_BASE}/reject`, {
          thread_id: tid,
          feedback_text: feedback.trim(),
        });
        const data = res.data as Record<string, unknown>;
        if (data.success === false) {
          addToast("error", "Reject Failed", apiErrorDetail(data));
          try {
            const tRes = await axios.get(`${API_BASE}/state/${tid}`);
            const tData = tRes.data as Record<string, unknown>;
            if (
              tData.success !== false &&
              tData.paused === true &&
              tData.state &&
              typeof tData.state === "object"
            ) {
              const ui = pausedStateToPipelineUI(
                tData.state as Record<string, unknown>,
                tid
              );
              setPipeline((prev) => ({ ...prev, ...ui }));
              if (
                typeof ui.generated_code === "string" &&
                ui.generated_code.trim()
              ) {
                setEditedCode(ui.generated_code);
              }
            }
          } catch {
            /* keep optimistic rollback partial */
          }
          return;
        }
        const ui = apiResponseToPipelineUI(data, true);
        setPipeline((prev) => ({ ...prev, ...ui }));
        if (typeof ui.generated_code === "string" && ui.generated_code.trim()) {
          setEditedCode(ui.generated_code);
        }
        addToast(
          "success",
          "Feedback sent",
          typeof data.message === "string"
            ? data.message
            : "New code ready for review."
        );
      } catch (err: unknown) {
        let msg = "Reject request failed.";
        if (axios.isAxiosError(err) && err.response?.data)
          msg = apiErrorDetail(err.response.data);
        addToast("error", "Reject Failed", msg);
        try {
          const tRes = await axios.get(`${API_BASE}/state/${tid}`);
          const tData = tRes.data as Record<string, unknown>;
          if (
            tData.success !== false &&
            tData.paused === true &&
            tData.state &&
            typeof tData.state === "object"
          ) {
            const ui = pausedStateToPipelineUI(
              tData.state as Record<string, unknown>,
              tid
            );
            setPipeline((prev) => ({ ...prev, ...ui }));
            if (
              typeof ui.generated_code === "string" &&
              ui.generated_code.trim()
            ) {
              setEditedCode(ui.generated_code);
            }
          }
        } catch {
          /* ignore */
        }
      } finally {
        rejectingInFlightRef.current = false;
        setRejecting(false);
      }
    },
    [addToast, pipeline.thread_id]
  );

  const reset = useCallback(() => {
    setPipeline({ ...DEFAULT_PIPELINE_UI });
    setEditedCode("");
    setPendingDatasetFile(null);
    setInputCsvPath(null);
    addToast("info", "Reset", "Pipeline UI reset.");
  }, [addToast]);

  const downloadCleanedCsv = useCallback(async () => {
    setDownloading(true);
    try {
      const q =
        csvFilename != null
          ? `?csv_filename=${encodeURIComponent(csvFilename)}`
          : "";
      const res = await fetch(`${API_BASE}/download${q}`, { method: "GET" });
      const ct = res.headers.get("content-type") || "";

      if (ct.includes("application/json")) {
        const data = (await res.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        addToast(
          "error",
          "Download not available",
          typeof data.message === "string"
            ? data.message
            : "Cleaned file is not ready yet."
        );
        return;
      }

      if (!res.ok) {
        addToast("error", "Download failed", `HTTP ${res.status}`);
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const fname =
        csvFilename != null
          ? `cleaned_${csvFilename.replace(/\.csv$/i, "")}.csv`
          : "cleaned_output.csv";
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      addToast("success", "Download", fname);
    } catch {
      addToast("error", "Download failed", "Network error.");
    } finally {
      setDownloading(false);
    }
  }, [addToast, csvFilename]);

  const value = useMemo(
    (): PipelineContextValue => ({
      pipeline,
      editedCode,
      setEditedCode,
      csvFilename,
      pendingDatasetFile,
      setPendingDatasetFile,
      inputCsvPath,
      setInputCsvPath,
      startPhase,
      loading,
      approving,
      rejecting,
      downloading,
      analyticsLoading,
      analyticsError,
      analyticsSnapshot,
      memoryItems,
      memoryLoading,
      refreshAnalytics,
      refreshMemory,
      startPipeline,
      approvePipeline,
      rejectPipeline,
      reset,
      downloadCleanedCsv,
      addToast,
    }),
    [
      pipeline,
      editedCode,
      csvFilename,
      pendingDatasetFile,
      inputCsvPath,
      setInputCsvPath,
      startPhase,
      loading,
      approving,
      rejecting,
      downloading,
      analyticsLoading,
      analyticsError,
      analyticsSnapshot,
      memoryItems,
      memoryLoading,
      refreshAnalytics,
      refreshMemory,
      startPipeline,
      approvePipeline,
      rejectPipeline,
      reset,
      downloadCleanedCsv,
      addToast,
    ]
  );

  return (
    <PipelineContext.Provider value={value}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </PipelineContext.Provider>
  );
}
