"use client";

import React, { useState } from "react";
import dynamic from "next/dynamic";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { usePipeline } from "@/components/PipelineProvider";

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
  } = usePipeline();

  const [showReject, setShowReject] = useState(false);
  const [feedback, setFeedback] = useState("");

  const isPaused = pipeline.status === "paused";
  const isCompleted = pipeline.status === "completed";
  const codeForEditor = editedCode.trim() ? editedCode : pipeline.generated_code;

  const submitReject = async () => {
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
          {isPaused && (
            <span className="ml-auto text-[10px] font-medium text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded-full">
              Action required
            </span>
          )}
        </div>

        {isPaused ? (
          <p className="text-[11px] text-amber-300/80 mb-4 leading-relaxed">
            Reject sends structured feedback to Gemini for a corrective
            regeneration (max 3 iterations). Approve executes your edited script
            in the sandbox, then completes the graph.
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

        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => void approvePipeline()}
            disabled={!isPaused || approving}
            className={`flex-1 py-2.5 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5
                    ${
                      isPaused && !approving
                        ? "bg-gradient-to-r from-emerald-500 to-teal-600 text-white"
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
            disabled={!isPaused || rejecting}
            className={`flex-1 py-2.5 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5
                    ${
                      isPaused && !rejecting
                        ? "bg-gradient-to-r from-rose-500 to-pink-600 text-white"
                        : "bg-[#1c2333] text-gray-600 cursor-not-allowed"
                    }`}
          >
            <XCircle size={13} />
            Reject
          </button>
        </div>
      </div>

      {(isPaused || isCompleted) && codeForEditor.trim() ? (
        <div className="glass-card p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
              {isPaused ? "Edit before approve" : "Executed code"}
            </p>
            {isPaused ? (
              <span className="text-[9px] text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded-full">
                Editable
              </span>
            ) : null}
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
              value={codeForEditor}
              onChange={(val) => setEditedCode(val ?? "")}
              options={{
                readOnly: isCompleted,
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

      {showReject && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="glass-card max-w-lg w-full p-6 border border-[#1c2333]">
            <h3 className="text-sm font-semibold text-white mb-2">
              Rejection feedback
            </h3>
            <p className="text-[11px] text-gray-500 mb-3">
              This text is passed to Gemini as{" "}
              <code className="text-gray-400">rejection_feedback</code>. Healing
              round {Math.min(pipeline.healing_iterations + 1, 3)} of 3.
            </p>
            <textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              rows={5}
              className="w-full rounded-xl bg-[#0a0d14] border border-[#1c2333] text-sm p-3 text-gray-200 focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
              placeholder="e.g. Preserve column X as string, do not drop nulls in Y…"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                type="button"
                className="px-4 py-2 rounded-xl text-xs text-gray-400 border border-[#1c2333]"
                onClick={() => setShowReject(false)}
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
