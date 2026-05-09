"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import axios from "axios";
import ToastContainer, { useToast } from "@/components/Toast";
import type { DailySalesPoint } from "@/components/AnalyticsChart";
import { API_BASE } from "@/lib/api";
import {
  DEFAULT_PIPELINE_UI,
  mergePollIntoPipelineState,
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
  setEditedCode: (v: string) => void;
  csvFilename: string | null;
  setCsvFilename: (v: string | null) => void;
  loading: boolean;
  approving: boolean;
  rejecting: boolean;
  downloading: boolean;
  uploadBusy: boolean;
  analyticsLoading: boolean;
  analyticsError: string | null;
  analyticsSnapshot: {
    row_count: number;
    avg_unit_price: number;
    sum_gross_income: number;
    sum_total_sales: number;
    daily_sales: DailySalesPoint[];
    dataset_file: string | null;
  } | null;
  memoryItems: MemoryItem[];
  memoryLoading: boolean;
  refreshAnalytics: () => Promise<void>;
  refreshMemory: () => Promise<void>;
  uploadDataset: (file: File) => Promise<boolean>;
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
  const generated =
    typeof st.generated_code === "string" ? st.generated_code : "";
  const hit = st.healing_iterations;
  const healing_iterations =
    typeof hit === "number"
      ? hit
      : typeof hit === "string"
        ? parseInt(hit, 10) || 0
        : 0;

  if (paused) {
    return {
      status: "paused",
      current_stage: "transform",
      thread_id:
        typeof data.thread_id === "string" ? data.thread_id : null,
      message:
        typeof data.message === "string"
          ? data.message
          : "Paused for human review.",
      stages_completed: ["discovery"],
      generated_code: generated,
      healing_iterations,
    };
  }

  return {
    status: "completed",
    current_stage: "orchestrator",
    thread_id:
      typeof data.thread_id === "string" ? data.thread_id : null,
    message:
      typeof data.message === "string"
        ? data.message
        : "Pipeline complete.",
    stages_completed: [
      "discovery",
      "transform",
      "healing",
      "orchestrator",
    ],
    generated_code: generated,
    healing_iterations,
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
  return {
    status: "paused",
    current_stage: "transform",
    thread_id: threadId,
    message:
      typeof state.status === "string"
        ? state.status
        : "Paused for human review.",
    stages_completed: ["discovery"],
    generated_code: generated,
    healing_iterations,
  };
}

export function PipelineProvider({ children }: { children: React.ReactNode }) {
  const { toasts, addToast, dismissToast } = useToast();
  const [pipeline, setPipeline] = useState<PipelineUIState>(DEFAULT_PIPELINE_UI);
  const [editedCode, setEditedCode] = useState("");
  const [csvFilename, setCsvFilename] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [analyticsSnapshot, setAnalyticsSnapshot] = useState<{
    row_count: number;
    avg_unit_price: number;
    sum_gross_income: number;
    sum_total_sales: number;
    daily_sales: DailySalesPoint[];
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
    if (isPaused && pipeline.generated_code)
      setEditedCode(pipeline.generated_code);
  }, [isPaused, pipeline.generated_code]);

  useEffect(() => {
    if (!isRunning && !isPaused) return;
    const interval = setInterval(async () => {
      try {
        const res = await axios.get(`${API_BASE}/status`);
        if (res.data && typeof res.data === "object") {
          setPipeline((prev) =>
            mergePollIntoPipelineState(res.data as Record<string, unknown>, prev)
          );
        }
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
      const dailyRaw = Array.isArray(d.daily_sales) ? d.daily_sales : [];
      const daily_sales: DailySalesPoint[] = dailyRaw.map((p) => {
        const x = p as Record<string, unknown>;
        return {
          date: typeof x.date === "string" ? x.date : "",
          label: typeof x.label === "string" ? x.label : "",
          total_sales: Number(x.total_sales) || 0,
          gross_income: Number(x.gross_income) || 0,
        };
      });
      const dsFile = d.dataset_file;
      setAnalyticsSnapshot({
        row_count: Number(d.row_count) || 0,
        avg_unit_price: Number(d.avg_unit_price) || 0,
        sum_gross_income: Number(d.sum_gross_income) || 0,
        sum_total_sales: Number(d.sum_total_sales) || 0,
        daily_sales,
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
    void refreshAnalytics();
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

  const uploadDataset = useCallback(
    async (file: File): Promise<boolean> => {
      setUploadBusy(true);
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await axios.post(`${API_BASE}/upload`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        });
        const d = res.data as Record<string, unknown>;
        if (d.success === false) {
          addToast("error", "Upload", apiErrorDetail(d));
          return false;
        }
        const name = d.csv_filename;
        if (typeof name === "string") setCsvFilename(name);
        const toastMsg =
          typeof d.message === "string"
            ? d.message
            : typeof name === "string"
              ? name
              : "Ready.";
        addToast("success", "Dataset uploaded", toastMsg);
        await refreshAnalytics();
        return true;
      } catch (err: unknown) {
        let msg = "Upload failed — is the API running?";
        if (axios.isAxiosError(err) && err.response?.data)
          msg = apiErrorDetail(err.response.data);
        addToast("error", "Upload", msg);
        return false;
      } finally {
        setUploadBusy(false);
      }
    },
    [addToast, refreshAnalytics]
  );

  const startPipeline = useCallback(async () => {
    setLoading(true);
    try {
      const body: Record<string, unknown> = { input_data: "sample_data" };
      if (csvFilename) body.csv_filename = csvFilename;
      const res = await axios.post(`${API_BASE}/start`, body);
      const data = res.data as Record<string, unknown>;

      if (data.success === false) {
        const msg = apiErrorDetail(data);
        addToast("error", "Start Failed", msg);
        setPipeline((p) => ({ ...p, status: "failed", message: msg }));
        return;
      }

      const pausedFlag = (data.paused as boolean | undefined) !== false;
      const ui = apiResponseToPipelineUI(data, pausedFlag);
      setPipeline((prev) => ({ ...prev, ...ui }));
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
      setLoading(false);
    }
  }, [addToast, csvFilename]);

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
      if (!paused) void refreshAnalytics();
    } catch (err: unknown) {
      let msg = "Backend request failed.";
      if (axios.isAxiosError(err) && err.response?.data)
        msg = apiErrorDetail(err.response.data);
      addToast("error", "Approve Failed", msg);
    } finally {
      setApproving(false);
    }
  }, [addToast, editedCode, pipeline.thread_id, refreshAnalytics]);

  const rejectPipeline = useCallback(
    async (feedback: string) => {
      if (!pipeline.thread_id) {
        addToast("warning", "No Thread", "Start the pipeline first.");
        return;
      }
      setRejecting(true);
      try {
        const res = await axios.post(`${API_BASE}/reject`, {
          thread_id: pipeline.thread_id,
          feedback: feedback.trim(),
        });
        const data = res.data as Record<string, unknown>;
        if (data.success === false) {
          addToast("error", "Reject Failed", apiErrorDetail(data));
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
      } finally {
        setRejecting(false);
      }
    },
    [addToast, pipeline.thread_id]
  );

  const reset = useCallback(() => {
    setPipeline({ ...DEFAULT_PIPELINE_UI });
    setEditedCode("");
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
    () => ({
      pipeline,
      editedCode,
      setEditedCode,
      csvFilename,
      setCsvFilename,
      loading,
      approving,
      rejecting,
      downloading,
      uploadBusy,
      analyticsLoading,
      analyticsError,
      analyticsSnapshot,
      memoryItems,
      memoryLoading,
      refreshAnalytics,
      refreshMemory,
      uploadDataset,
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
      loading,
      approving,
      rejecting,
      downloading,
      uploadBusy,
      analyticsLoading,
      analyticsError,
      analyticsSnapshot,
      memoryItems,
      memoryLoading,
      refreshAnalytics,
      refreshMemory,
      uploadDataset,
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
