"""
LAM-ADEP Agentic Data Engineering Pipeline — FastAPI Server
============================================================
Production-grade REST API with multiprocessing sandbox execution.

Design decisions
----------------
• GEMINI_API_KEY is loaded from backend/.env via explicit dotenv path so it
  is always resolved correctly regardless of the CWD when uvicorn starts.
• /approve accepts an optional `edited_code` field — if provided (user edited
  code in Monaco), that version is used for sandbox execution instead of the
  LLM-generated original.
• Sandbox execution uses multiprocessing.Process with a 30-second timeout.
  The child process is forcibly killed on timeout or exception.
• compute_analytics() wraps every column access in try/except so a missing
  or malformatted 'Date' / numeric column never crashes the endpoint.
• Global exception handler returns 200 OK with structured error — the
  frontend never sees raw 5xx responses.
"""

from __future__ import annotations

import io
import logging
import multiprocessing
import os
import queue
import traceback
import uuid
from contextlib import asynccontextmanager
from typing import Any, Optional

import pandas as pd
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from langgraph.types import Command
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Bootstrap — load .env from the backend directory explicitly
# ---------------------------------------------------------------------------
_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
_ENV_PATH = os.path.join(_BACKEND_DIR, ".env")
load_dotenv(dotenv_path=_ENV_PATH, override=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
)
logger = logging.getLogger("lam_adep.api")

# Late import so graph module benefits from the dotenv already loaded above
from agent_graph import PipelineState, build_graph, CSV_PATH, CLEANED_PATH  # noqa: E402

# ---------------------------------------------------------------------------
# Multiprocessing Sandbox
# ---------------------------------------------------------------------------

def _sandbox_worker(code: str, csv_path: str, cleaned_path: str, result_queue: multiprocessing.Queue) -> None:
    """Worker that runs in a child process.

    Captures stdout/stderr and any exception, putting a result dict onto the
    queue so the parent can inspect it after join().
    """
    import sys

    captured_stdout = io.StringIO()
    captured_stderr = io.StringIO()

    try:
        exec_globals: dict = {
            "__builtins__": __builtins__,
            "CSV_PATH":     csv_path,
            "CLEANED_PATH": cleaned_path,
        }

        # Rewrite common relative path patterns to absolute paths
        for old, new in [
            ("backend/data/supermarket_sales.csv", csv_path),
            ("backend/data/cleaned_sales.csv",     cleaned_path),
            ("data/supermarket_sales.csv",          csv_path),
            ("data/cleaned_sales.csv",              cleaned_path),
            ("supermarket_sales.csv",               csv_path),
            ("cleaned_sales.csv",                   cleaned_path),
        ]:
            code = code.replace(old, new)

        # Redirect stdout so print() calls are captured
        sys.stdout = captured_stdout
        sys.stderr = captured_stderr

        exec(compile(code, "<sandbox>", "exec"), exec_globals)  # noqa: S102

        sys.stdout = sys.__stdout__
        sys.stderr = sys.__stderr__

        result_queue.put({
            "success": True,
            "stdout":  captured_stdout.getvalue(),
            "stderr":  captured_stderr.getvalue(),
        })
    except Exception as exc:
        sys.stdout = sys.__stdout__
        sys.stderr = sys.__stderr__
        result_queue.put({
            "success":    False,
            "error":      str(exc),
            "traceback":  traceback.format_exc(),
            "stdout":     captured_stdout.getvalue(),
            "stderr":     captured_stderr.getvalue(),
        })


def run_code_in_sandbox(code: str, timeout: int = 30) -> dict[str, Any]:
    """Execute *code* in an isolated child process with a hard timeout.

    Returns a result dict:
      {"success": bool, "stdout": str, "stderr": str, "error"?: str}

    The child process is forcibly terminated if it does not complete within
    *timeout* seconds.
    """
    if not code or not code.strip():
        return {"success": False, "error": "No code provided to sandbox."}

    # multiprocessing requires the 'spawn' start method on Windows to avoid
    # inheriting the parent's open file handles cleanly. We use a Manager
    # queue to pass results safely across process boundaries.
    ctx = multiprocessing.get_context("spawn")
    result_queue: multiprocessing.Queue = ctx.Queue()

    process = ctx.Process(
        target=_sandbox_worker,
        args=(code, CSV_PATH, CLEANED_PATH, result_queue),
        daemon=True,
    )
    process.start()
    process.join(timeout=timeout)

    if process.is_alive():
        process.kill()
        process.join()
        logger.error("[Sandbox] Worker timed out after %ds — process killed.", timeout)
        return {
            "success": False,
            "error":   f"Execution timed out after {timeout} seconds.",
            "stdout":  "",
            "stderr":  "",
        }

    try:
        result = result_queue.get_nowait()
    except queue.Empty:
        result = {
            "success": False,
            "error":   "Worker exited without returning a result (possible crash).",
            "stdout":  "",
            "stderr":  "",
        }

    if result.get("success"):
        logger.info(
            "[Sandbox] Execution succeeded. stdout=%r",
            (result.get("stdout") or "")[:200],
        )
    else:
        logger.error(
            "[Sandbox] Execution failed: %s", result.get("error", "unknown")
        )

    return result


# ---------------------------------------------------------------------------
# Analytics Helper — fully guarded against missing/malformatted columns
# ---------------------------------------------------------------------------

def _data_dir() -> str:
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")


_CLEANED_CSV = os.path.join(_data_dir(), "cleaned_sales.csv")
_SOURCE_CSV  = os.path.join(_data_dir(), "supermarket_sales.csv")


def compute_analytics() -> dict[str, Any]:
    """Load supermarket_sales.csv and return summary stats + daily aggregates.

    Every column access is individually guarded by try/except so a missing
    or badly-formatted 'Date' / numeric column never raises a KeyError or
    crashes the endpoint.
    """
    csv_path = _SOURCE_CSV
    if not os.path.isfile(csv_path):
        return {
            "success": False,
            "error":   "DATASET_MISSING",
            "message": "supermarket_sales.csv was not found under backend/data.",
        }

    try:
        df = pd.read_csv(csv_path)
    except Exception as exc:
        logger.exception("Failed to read supermarket_sales.csv")
        return {"success": False, "error": "READ_FAILED", "message": str(exc)}

    # ── Numeric summaries — each wrapped individually ──────────────────
    row_count = int(len(df))

    try:
        avg_unit_price = float(pd.to_numeric(df["Unit price"], errors="coerce").mean(skipna=True) or 0.0)
    except Exception:
        avg_unit_price = 0.0

    try:
        sum_gross_income = float(pd.to_numeric(df["gross income"], errors="coerce").sum(skipna=True) or 0.0)
    except Exception:
        sum_gross_income = 0.0

    try:
        sum_total_sales = float(pd.to_numeric(df["Total"], errors="coerce").sum(skipna=True) or 0.0)
    except Exception:
        sum_total_sales = 0.0

    # ── Daily time-series — fully optional ────────────────────────────
    daily_sales: list[dict[str, Any]] = []
    try:
        work = df.copy()
        work["_date"]  = pd.to_datetime(work["Date"], errors="coerce") if "Date" in work.columns else pd.NaT
        work["_total"] = pd.to_numeric(work["Total"], errors="coerce") if "Total" in work.columns else 0.0
        work["_gi"]    = pd.to_numeric(work["gross income"], errors="coerce") if "gross income" in work.columns else 0.0
        work["_day"]   = work["_date"].dt.normalize()

        dated = work.dropna(subset=["_date"])
        if not dated.empty:
            daily = (
                dated.groupby("_day", as_index=False)
                .agg(daily_total=("_total", "sum"), daily_gross_income=("_gi", "sum"))
                .rename(columns={"_day": "_date"})
                .sort_values("_date")
                .head(10)
            )
            for _, row in daily.iterrows():
                dt = row["_date"]
                if pd.isna(dt):
                    continue
                ts = pd.Timestamp(dt)
                daily_sales.append({
                    "date":         ts.strftime("%Y-%m-%d"),
                    "label":        ts.strftime("%b %d"),
                    "total_sales":  round(float(row["daily_total"]), 2),
                    "gross_income": round(float(row["daily_gross_income"]), 2),
                })
    except Exception as exc:
        logger.warning("Daily sales aggregation skipped: %s", exc)
        daily_sales = []

    return {
        "success":          True,
        "row_count":        row_count,
        "avg_unit_price":   round(avg_unit_price, 4),
        "sum_gross_income": round(sum_gross_income, 2),
        "sum_total_sales":  round(sum_total_sales, 2),
        "daily_sales":      daily_sales,
    }


# ---------------------------------------------------------------------------
# Application lifespan
# ---------------------------------------------------------------------------
_compiled_graph = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _compiled_graph
    logger.info("Compiling LangGraph pipeline …")
    _compiled_graph = build_graph()
    logger.info("Server ready — Metadata-First / Gemini 1.5 Flash.")
    yield
    logger.info("Shutting down.")


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(
    title="LAM-ADEP Pipeline API",
    version="2.0.0",
    description="Metadata-First Agentic Data Engineering Pipeline — Gemini 1.5 Flash + Sandboxed Execution.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Global Exception Handlers
# ---------------------------------------------------------------------------

@app.exception_handler(RequestValidationError)
async def _validation_exception_handler(request: Request, exc: RequestValidationError):
    logger.warning("Validation error on %s %s: %s", request.method, request.url.path, exc.errors())
    return JSONResponse(
        status_code=200,
        content={"success": False, "error": "Validation Error", "detail": exc.errors()},
    )


@app.exception_handler(Exception)
async def _global_exception_handler(request: Request, exc: Exception):
    logger.error("Unhandled exception on %s %s: %s", request.method, request.url.path, exc, exc_info=True)
    return JSONResponse(
        status_code=200,
        content={
            "success": False,
            "error":   str(exc),
            "detail":  traceback.format_exception_only(type(exc), exc)[-1].strip(),
        },
    )


# ---------------------------------------------------------------------------
# Request / Response Schemas
# ---------------------------------------------------------------------------

class StartRequest(BaseModel):
    input_data: str = Field(
        default="Sample CSV data: id, name, value",
        description="Raw data or description to feed into the pipeline.",
    )


class ApproveRequest(BaseModel):
    thread_id:   str = Field(..., description="Thread ID returned by /start.")
    action:      str = Field(..., description="Human decision — 'Approve' or 'Reject'.")
    edited_code: Optional[str] = Field(
        default=None,
        description="User-edited code from Monaco Editor. If provided and action is Approve, "
                    "this code is executed in the sandbox instead of the LLM-generated original.",
    )


class APIResponse(BaseModel):
    success:    bool = True
    thread_id:  str  = ""
    state:      dict[str, Any] = {}
    message:    str  = ""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _state_to_dict(state: PipelineState | dict) -> dict[str, Any]:
    if hasattr(state, "values"):
        return dict(state.values)
    return dict(state)


def _config_for(thread_id: str) -> dict:
    return {"configurable": {"thread_id": thread_id}}


# ---------------------------------------------------------------------------
# Pipeline Status Store
# ---------------------------------------------------------------------------
_latest_status: dict[str, Any] = {}


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/", tags=["Health"])
async def health_check():
    return {"success": True, "message": "LAM-ADEP Pipeline API v2 (Gemini 1.5 Flash) is running."}


@app.get("/status", tags=["Pipeline"])
async def get_status():
    return _latest_status


@app.get("/download", tags=["Pipeline"])
async def download_cleaned_data():
    if not os.path.isfile(_CLEANED_CSV):
        return JSONResponse(
            status_code=200,
            content={
                "success": False,
                "error":   "FILE_NOT_FOUND",
                "message": "cleaned_sales.csv is not available yet. Approve the pipeline first.",
            },
        )
    try:
        return FileResponse(path=_CLEANED_CSV, filename="cleaned_sales.csv", media_type="text/csv")
    except Exception as exc:
        logger.error("FileResponse for cleaned_sales.csv failed: %s", exc)
        return JSONResponse(
            status_code=200,
            content={"success": False, "error": "SERVE_FAILED", "message": str(exc)},
        )


@app.get("/analytics", tags=["Analytics"])
async def get_analytics():
    """Real summary statistics from supermarket_sales.csv.

    Fully guarded — returns 200 OK even if columns are missing or malformatted.
    """
    result = compute_analytics()
    return JSONResponse(status_code=200, content=result)


@app.post("/start", response_model=APIResponse, tags=["Pipeline"])
async def start_pipeline(body: StartRequest):
    """Kick off the pipeline.

    Runs Discovery → Transform and pauses at the HITL interrupt gate.
    Returns thread_id and the current state (including generated_code).
    """
    thread_id = str(uuid.uuid4())
    config = _config_for(thread_id)

    logger.info("Starting pipeline — thread %s", thread_id)

    initial_state: PipelineState = {
        "input_data":     body.input_data,
        "status":         "Initialized",
        "generated_code": "",
        "edited_code":    "",
        "human_feedback": "",
    }

    _compiled_graph.invoke(initial_state, config=config)
    snapshot = _compiled_graph.get_state(config)
    current_state = _state_to_dict(snapshot)

    logger.info("Pipeline paused at HITL gate — thread %s", thread_id)

    global _latest_status
    _latest_status = {
        "status":          "paused_for_approval",
        "current_stage":   "transform",
        "thread_id":       thread_id,
        "message":         "Pipeline paused at HITL gate. Review generated code in Monaco Editor.",
        "stages_completed": ["discovery"],
        "generated_code":  current_state.get("generated_code", "") or "",
    }

    return APIResponse(
        success=True,
        thread_id=thread_id,
        state=current_state,
        message="Pipeline paused. Review and optionally edit the generated code, then Approve.",
    )


@app.post("/approve", response_model=APIResponse, tags=["Pipeline"])
async def approve_pipeline(body: ApproveRequest):
    """Resume the paused pipeline after human review.

    If `edited_code` is supplied AND `action` is 'Approve':
      1. The sandbox executes the *edited* code first.
      2. If sandbox succeeds, the graph resumes and chromaDB stores the edited code.
      3. If sandbox fails, we fall back to a guaranteed pandas cleaning pass.

    Send `action: "Reject"` to skip execution and record the rejection.
    """
    config = _config_for(body.thread_id)

    snapshot = _compiled_graph.get_state(config)
    if not snapshot or not snapshot.next:
        return APIResponse(
            success=False,
            thread_id=body.thread_id,
            state=_state_to_dict(snapshot) if snapshot else {},
            message="No paused pipeline found for this thread_id.",
        )

    action_lower = body.action.strip().lower()
    logger.info("Resuming pipeline — thread %s, action=%s", body.thread_id, body.action)

    # ── If approving, run the sandbox BEFORE resuming the graph ──────
    sandbox_result: dict[str, Any] = {}
    if action_lower == "approve":
        # Prefer user-edited code over original LLM output
        state_values = _state_to_dict(snapshot)
        code_to_run = (
            body.edited_code.strip()
            if body.edited_code and body.edited_code.strip()
            else state_values.get("generated_code", "")
        )

        logger.info("[Approve] Running sandbox (timeout=30s) …")
        sandbox_result = run_code_in_sandbox(code_to_run, timeout=30)

        if not sandbox_result.get("success"):
            logger.warning(
                "[Approve] Sandbox failed (%s) — running guaranteed fallback.",
                sandbox_result.get("error"),
            )
            # Guaranteed fallback: always produce cleaned_sales.csv
            try:
                df = pd.read_csv(CSV_PATH).head(200)
                if "Date" in df.columns:
                    df["Date"] = pd.to_datetime(df["Date"], errors="coerce")
                for col in df.select_dtypes(include=["object"]).columns:
                    coerced = pd.to_numeric(df[col], errors="coerce")
                    if coerced.notna().mean() > 0.9:
                        df[col] = coerced
                df = df.drop_duplicates()
                df.to_csv(CLEANED_PATH, index=False)
                logger.info("[Approve] Fallback write succeeded — cleaned_sales.csv ready.")
                sandbox_result["fallback"] = "Used guaranteed pandas fallback."
            except Exception as fb_err:
                logger.error("[Approve] Fallback also failed: %s", fb_err)
                sandbox_result["fallback_error"] = str(fb_err)
        else:
            # Verify file was actually written
            if not os.path.isfile(CLEANED_PATH):
                logger.warning("[Approve] Sandbox reported success but cleaned_sales.csv not found — running fallback.")
                try:
                    pd.read_csv(CSV_PATH).head(200).drop_duplicates().to_csv(CLEANED_PATH, index=False)
                except Exception:
                    pass

        # Patch the graph state with the edited code so orchestrator persists it
        if body.edited_code and body.edited_code.strip():
            _compiled_graph.update_state(
                config,
                {"edited_code": body.edited_code.strip(), "generated_code": body.edited_code.strip()},
            )

    # ── Resume the graph ──────────────────────────────────────────────
    _compiled_graph.invoke(Command(resume=body.action), config=config)

    final_snapshot = _compiled_graph.get_state(config)
    final_state = _state_to_dict(final_snapshot)

    logger.info("Pipeline finished — thread %s", body.thread_id)

    csv_ready = os.path.isfile(CLEANED_PATH)
    if action_lower == "approve":
        msg = (
            f"Pipeline completed. cleaned_sales.csv {'ready ✓' if csv_ready else 'unavailable ✗'}. "
            f"Sandbox: {'OK' if sandbox_result.get('success') else 'fallback used'}."
        )
    else:
        msg = "Pipeline completed — code was rejected by human reviewer."

    final_status_text = final_state.get("status", "Pipeline Complete")

    global _latest_status
    _latest_status = {
        "status":           "completed",
        "current_stage":    "orchestrator",
        "thread_id":        body.thread_id,
        "message":          final_status_text,
        "stages_completed": ["discovery", "transform", "healing", "orchestrator"],
        "generated_code":   final_state.get("generated_code", "") or "",
        "sandbox":          sandbox_result,
    }

    return APIResponse(
        success=True,
        thread_id=body.thread_id,
        state=final_state,
        message=msg,
    )


# ---------------------------------------------------------------------------
# Standalone runner
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    # multiprocessing on Windows requires this guard
    multiprocessing.freeze_support()
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=False,   # reload=True conflicts with multiprocessing spawn on Windows
        log_level="info",
    )
