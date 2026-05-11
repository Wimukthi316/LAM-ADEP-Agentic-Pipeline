"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  ShieldCheck,
  Mic,
} from "lucide-react";
import { usePipeline } from "@/components/PipelineProvider";

/** Minimal Web Speech API surface (DOM lib types vary by TS `lib` config). */
type WebSpeechRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: unknown }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionCtor = new () => WebSpeechRecognition;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
});

export default function HitlPage() {
  const {
    pipeline,
    editedCode,
    setEditedCode,
    approving,
    rejecting,
    approvePipeline,
    rejectPipeline,
    downloadCleanedCsv,
    downloading,
    addToast,
  } = usePipeline();

  const [showReject, setShowReject] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [voiceListening, setVoiceListening] = useState(false);
  const recognitionRef = useRef<WebSpeechRecognition | null>(null);

  const isPaused = pipeline.status === "paused";
  const isCompleted = pipeline.status === "completed";
  const isRegenerating =
    rejecting || (pipeline.status === "running" && Boolean(pipeline.thread_id));
  const codeForEditor = editedCode.trim() ? editedCode : pipeline.generated_code;
  /** Paused: always show editor so users can read/edit even before local state syncs. */
  const showMonacoEditor =
    isPaused ||
    ((isCompleted || isRegenerating) && Boolean(codeForEditor.trim()));
  const monacoValue = isPaused
    ? editedCode || pipeline.generated_code || ""
    : codeForEditor;

  const stopRecognitionHardware = useCallback(() => {
    try {
      recognitionRef.current?.stop();
    } catch {
      /* ignore */
    }
    recognitionRef.current = null;
  }, []);

  const stopVoice = useCallback(() => {
    stopRecognitionHardware();
    setVoiceListening(false);
  }, [stopRecognitionHardware]);

  const closeRejectModal = useCallback(() => {
    stopRecognitionHardware();
    setVoiceListening(false);
    setShowReject(false);
  }, [stopRecognitionHardware]);

  const startVoiceFeedback = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      addToast(
        "warning",
        "Voice unavailable",
        "Speech recognition is not supported in this browser (try Chrome / Edge)."
      );
      return;
    }
    stopVoice();
    setShowReject(true);
    let rec: WebSpeechRecognition;
    try {
      rec = new Ctor();
    } catch {
      addToast("error", "Voice", "Could not start speech recognition.");
      return;
    }
    rec.lang = typeof navigator !== "undefined" ? navigator.language : "en-US";
    rec.continuous = false;
    rec.interimResults = true;
    rec.onresult = (event: { resultIndex: number; results: unknown }) => {
      const results = event.results as {
        length: number;
        [i: number]: { [j: number]: { transcript: string } };
      };
      let chunk = "";
      for (let i = event.resultIndex; i < results.length; i++) {
        chunk += results[i]![0]!.transcript;
      }
      chunk = chunk.trim();
      if (!chunk) return;
      setFeedback((prev) => (prev ? `${prev} ${chunk}`.trim() : chunk));
    };
    rec.onerror = () => {
      setVoiceListening(false);
      recognitionRef.current = null;
    };
    rec.onend = () => {
      setVoiceListening(false);
      recognitionRef.current = null;
    };
    recognitionRef.current = rec;
    setVoiceListening(true);
    try {
      rec.start();
    } catch {
      setVoiceListening(false);
      recognitionRef.current = null;
      addToast("error", "Voice", "Could not start the microphone listener.");
    }
  }, [addToast, stopVoice]);

  useEffect(() => () => stopRecognitionHardware(), [stopRecognitionHardware]);

  const submitReject = async () => {
    stopVoice();
    await rejectPipeline(feedback || "Please improve this transformation.");
    setShowReject(false);
    setFeedback("");
  };

  return (
    <main className="p-6 max-w-[1200px] mx-auto w-full flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-white">Human review</h2>
        <p className="text-[11px] text-gray-500 mt-1">
          Edit generated Python in Monaco, then approve (runs in the
          multiprocessing sandbox) or reject with feedback (POST{" "}
          <code className="text-gray-400">/reject</code> healing loop).
        </p>
      </div>

      <div
        className={`glass-card p-5 ${isPaused ? "ring-1 ring-amber-500/30" : ""}`}
      >
        <div className="flex items-center gap-2 mb-4">
          <ShieldCheck
            size={14}
            className={isPaused ? "text-amber-400" : "text-gray-600"}
          />
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
            Adaptive HITL
          </h3>
          {isPaused && !isRegenerating && (
            <span className="ml-auto text-[10px] font-medium text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded-full">
              Action required
            </span>
          )}
        </div>

        {isRegenerating ? (
          <div className="flex items-center gap-2 text-[11px] text-cyan-300/90 mb-4 py-2 px-3 rounded-lg bg-cyan-500/10 border border-cyan-500/20">
            <Loader2 size={14} className="animate-spin shrink-0" />
            <span>
              Gemini is regenerating transformation code from your feedback…
            </span>
          </div>
        ) : null}

        {isPaused && !isRegenerating ? (
          <p className="text-[11px] text-amber-300/80 mb-4 leading-relaxed">
            Reject opens a modal and sends{" "}
            <code className="text-gray-400">feedback_text</code> to POST{" "}
            <code className="text-gray-400">/reject</code> (max 3 iterations).
            Approve runs your edited script in the sandbox, then completes the graph.
          </p>
        ) : null}

        {isCompleted ? (
          <button
            type="button"
            onClick={() => void downloadCleanedCsv()}
            disabled={downloading}
            className="w-full py-3 rounded-xl font-bold text-sm bg-gradient-to-r from-emerald-500 to-teal-500 text-white flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20 mb-4 disabled:opacity-60"
          >
            {downloading ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Preparing…
              </>
            ) : (
              "Download cleaned CSV"
            )}
          </button>
        ) : null}
      </div>

      {showMonacoEditor ? (
        <div className="glass-card p-5 border border-[#1c2333]/60">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
              {isPaused ? "Edit before approve" : "Executed code"}
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              {isPaused && !isRegenerating ? (
                <span className="text-[9px] text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded-full">
                  Editable
                </span>
              ) : null}
              {isRegenerating ? (
                <span className="text-[9px] text-cyan-400 bg-cyan-500/10 px-2 py-0.5 rounded-full">
                  Read-only until ready
                </span>
              ) : null}
            </div>
          </div>
          <div className="mb-2 flex justify-center">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-purple-500/40 bg-purple-500/10 px-3 py-1 text-[10px] font-semibold text-purple-300 shadow-[0_0_18px_-4px_rgba(168,85,247,0.5)] animate-pulse">
              🧠 Neuro-Symbolic Engine Active
            </span>
          </div>
          <div className="rounded-lg border border-[#1e2a3d] bg-[#0d1117] overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 bg-[#161b22] border-b border-[#1e2a3d]">
              <span className="text-[10px] text-gray-500 font-mono">
                transform_output.py
              </span>
            </div>
            <MonacoEditor
              height="420px"
              language="python"
              theme="vs-dark"
              value={monacoValue}
              onChange={(val) => setEditedCode(val ?? "")}
              options={{
                readOnly: isCompleted || isRegenerating,
                minimap: { enabled: false },
                fontSize: 12,
                lineNumbers: "on",
                scrollBeyondLastLine: false,
                wordWrap: "on",
                automaticLayout: true,
                padding: { top: 8, bottom: 8 },
              }}
            />
          </div>
        </div>
      ) : (
        <div className="glass-card p-8 text-center text-[12px] text-gray-500">
          Start the pipeline from the Pipeline page and return here when the run
          pauses for approval.
        </div>
      )}

      <div className="glass-card p-5 border border-[#1c2333]/50">
        <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-3">
          Actions
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void approvePipeline()}
            disabled={!isPaused || approving || isRegenerating}
            className={`flex-1 min-w-[120px] py-2.5 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5
                    ${
                      isPaused && !approving && !isRegenerating
                        ? "bg-gradient-to-r from-emerald-500 to-teal-600 text-white shadow-lg shadow-emerald-500/15"
                        : "bg-[#1c2333] text-gray-600 cursor-not-allowed"
                    }`}
          >
            {approving ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <CheckCircle2 size={13} />
            )}
            Approve
          </button>
          <button
            type="button"
            onClick={() => setShowReject(true)}
            disabled={!isPaused || rejecting || isRegenerating}
            className={`flex-1 min-w-[120px] py-2.5 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5
                    ${
                      isPaused && !rejecting && !isRegenerating
                        ? "bg-gradient-to-r from-rose-500 to-pink-600 text-white shadow-lg shadow-rose-500/15"
                        : "bg-[#1c2333] text-gray-600 cursor-not-allowed"
                    }`}
          >
            <XCircle size={13} />
            Reject
          </button>
          <button
            type="button"
            onClick={() => startVoiceFeedback()}
            disabled={!isPaused || approving || rejecting || isRegenerating}
            title="Speak your rejection feedback (opens feedback panel)"
            className={`shrink-0 min-w-[132px] py-2.5 px-3 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 border transition-all
                    ${
                      isPaused && !approving && !rejecting && !isRegenerating
                        ? voiceListening
                          ? "border-amber-400/60 bg-amber-500/15 text-amber-200 shadow-[0_0_20px_-4px_rgba(251,191,36,0.45)]"
                          : "border-amber-500/35 bg-[#0a0d14] text-amber-200/90 hover:bg-amber-500/10 hover:border-amber-400/50"
                        : "border-[#1c2333] text-gray-600 cursor-not-allowed"
                    }`}
          >
            {voiceListening ? (
              <Loader2 size={13} className="animate-spin text-amber-300" />
            ) : (
              <Mic size={13} className="text-amber-400/90" />
            )}
            Voice feedback
          </button>
        </div>
      </div>

      {showReject && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeRejectModal();
          }}
        >
          <div className="glass-card max-w-lg w-full p-6 border border-[#1c2333]">
            <h3 className="text-sm font-semibold text-white mb-2">
              Rejection feedback
            </h3>
            <p className="text-[11px] text-gray-500 mb-3">
              This text is passed to Gemini as{" "}
              <code className="text-gray-400">rejection_feedback</code>. Healing
              round {Math.min(pipeline.healing_iterations + 1, 3)} of 3.
            </p>
            {voiceListening ? (
              <p className="text-[10px] text-amber-400/90 mb-2 flex items-center gap-1.5">
                <span className="inline-flex h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                Listening… speak clearly; text appears below. Click again from the bar to re-run.
              </p>
            ) : null}
            <textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              rows={5}
              className="w-full rounded-xl bg-[#0a0d14] border border-[#1c2333] text-sm p-3 text-gray-200 focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
              placeholder="e.g. Preserve column X as string, do not drop nulls in Y… (or use Voice feedback)"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                type="button"
                className="px-4 py-2 rounded-xl text-xs text-gray-400 border border-[#1c2333]"
                onClick={() => closeRejectModal()}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={rejecting}
                className="px-4 py-2 rounded-xl text-xs font-semibold bg-rose-600 text-white disabled:opacity-50"
                onClick={() => void submitReject()}
              >
                {rejecting ? "Sending…" : "Submit & regenerate"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
