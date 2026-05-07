"""
LAM-ADEP Agentic Data Engineering Pipeline — FastAPI Server
============================================================
Production-grade REST API that exposes two endpoints:

  POST /start   → kick off the LangGraph pipeline (pauses at HITL gate)
  POST /approve → resume the paused pipeline with human decision

Design decisions
----------------
• Global exception handler catches *everything* and returns 200 OK with a
  structured error payload — the frontend never sees raw 500s.
• CORS is fully open for local dev (origins=["*"]).
• Each /start call generates a fresh UUID thread_id so multiple runs can
  coexist in memory.
"""

from __future__ import annotations

import logging
import traceback
import uuid
from contextlib import asynccontextmanager
from typing import Any

import os

import pandas as pd
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from langgraph.types import Command
from pydantic import BaseModel, Field

from agent_graph import PipelineState, build_graph

# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------
load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
)
logger = logging.getLogger("lam_adep.api")


# ---------------------------------------------------------------------------
# Application lifespan — build graph once at startup
# ---------------------------------------------------------------------------
_compiled_graph = None            # module-level reference


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Compile the LangGraph pipeline once during server startup."""
    global _compiled_graph
    logger.info("Compiling LangGraph pipeline …")
    _compiled_graph = build_graph()
    logger.info("Server ready.")
    yield
    logger.info("Shutting down.")


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(
    title="LAM-ADEP Pipeline API",
    version="0.1.0",
    description="Backend MVP for the LAM-ADEP Agentic Data Engineering Pipeline.",
    lifespan=lifespan,
)

# --- CORS (wide-open for local development) --------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Global Exception Handlers — bulletproof 200-OK error envelopes
# ---------------------------------------------------------------------------

@app.exception_handler(RequestValidationError)
async def _validation_exception_handler(request: Request, exc: RequestValidationError):
    """Catch Pydantic / FastAPI validation errors (422) and return them as
    a clean 200 OK with a structured error payload."""
    logger.warning(
        "Validation error on %s %s: %s",
        request.method,
        request.url.path,
        exc.errors(),
    )
    return JSONResponse(
        status_code=200,
        content={
            "success": False,
            "error": "Validation Error",
            "detail": exc.errors(),
        },
    )


@app.exception_handler(Exception)
async def _global_exception_handler(request: Request, exc: Exception):
    """Catch any unhandled exception and return a clean 200 OK with an
    error payload.  This prevents the frontend from ever seeing a raw 5xx."""
    logger.error(
        "Unhandled exception on %s %s: %s",
        request.method,
        request.url.path,
        exc,
        exc_info=True,
    )
    return JSONResponse(
        status_code=200,
        content={
            "success": False,
            "error": str(exc),
            "detail": traceback.format_exception_only(type(exc), exc)[-1].strip(),
        },
    )


# ---------------------------------------------------------------------------
# Request / Response Schemas
# ---------------------------------------------------------------------------

class StartRequest(BaseModel):
    """Payload for POST /start."""

    input_data: str = Field(
        default="Sample CSV data: id, name, value",
        description="Raw data or description to feed into the pipeline.",
    )


class ApproveRequest(BaseModel):
    """Payload for POST /approve."""

    thread_id: str = Field(
        ...,
        description="Thread ID returned by /start.",
    )
    action: str = Field(
        ...,
        description="Human decision — typically 'Approve' or 'Reject'.",
    )


class APIResponse(BaseModel):
    """Standardised envelope for every API response."""

    success: bool = True
    thread_id: str = ""
    state: dict[str, Any] = {}
    message: str = ""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _state_to_dict(state: PipelineState | dict) -> dict[str, Any]:
    """Normalise graph state into a plain JSON-safe dict."""
    if hasattr(state, "values"):
        # LangGraph StateSnapshot — pull the .values dict
        return dict(state.values)
    return dict(state)


def _config_for(thread_id: str) -> dict:
    """Build a LangGraph config dict for a given thread."""
    return {"configurable": {"thread_id": thread_id}}


def _data_dir() -> str:
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")


_CLEANED_CSV = os.path.join(_data_dir(), "cleaned_sales.csv")
_SOURCE_CSV  = os.path.join(_data_dir(), "supermarket_sales.csv")


def compute_analytics() -> dict[str, Any]:
    """Load supermarket_sales.csv and return summary stats and daily aggregates."""
    csv_path = os.path.join(_data_dir(), "supermarket_sales.csv")
    if not os.path.isfile(csv_path):
        return {
            "success": False,
            "error": "DATASET_MISSING",
            "message": "supermarket_sales.csv was not found under backend/data.",
        }

    required = ["Unit price", "gross income", "Total", "Date"]
    try:
        df = pd.read_csv(csv_path)
    except Exception as exc:
        logger.exception("Failed to read supermarket_sales.csv")
        return {
            "success": False,
            "error": "READ_FAILED",
            "message": str(exc),
        }

    missing = [c for c in required if c not in df.columns]
    if missing:
        return {
            "success": False,
            "error": "SCHEMA_MISMATCH",
            "message": f"Missing expected columns: {missing}",
        }

    try:
        work = df.copy()
        work["Date"] = pd.to_datetime(work["Date"], errors="coerce")
        for col in ("Unit price", "gross income", "Total"):
            work[col] = pd.to_numeric(work[col], errors="coerce")

        row_count = int(len(work))
        avg_unit_price = float(work["Unit price"].mean(skipna=True) or 0.0)
        sum_gross_income = float(work["gross income"].sum(skipna=True) or 0.0)
        sum_total_sales = float(work["Total"].sum(skipna=True) or 0.0)

        dated = work.dropna(subset=["Date"])
        daily = (
            dated.groupby(dated["Date"].dt.normalize(), as_index=False)
            .agg(
                daily_total=("Total", "sum"),
                daily_gross_income=("gross income", "sum"),
            )
            .sort_values("Date")
            .head(10)
        )
        daily_sales: list[dict[str, Any]] = []
        for _, row in daily.iterrows():
            dt = row["Date"]
            if pd.isna(dt):
                continue
            ts = pd.Timestamp(dt)
            daily_sales.append(
                {
                    "date": ts.strftime("%Y-%m-%d"),
                    "label": ts.strftime("%b %d"),
                    "total_sales": round(float(row["daily_total"]), 2),
                    "gross_income": round(float(row["daily_gross_income"]), 2),
                }
            )

        return {
            "success": True,
            "row_count": row_count,
            "avg_unit_price": round(avg_unit_price, 4),
            "sum_gross_income": round(sum_gross_income, 2),
            "sum_total_sales": round(sum_total_sales, 2),
            "daily_sales": daily_sales,
        }
    except Exception as exc:
        logger.exception("Analytics computation failed")
        return {
            "success": False,
            "error": "COMPUTE_FAILED",
            "message": str(exc),
        }


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

_latest_status = {}

@app.get("/status", tags=["Pipeline"])
async def get_status():
    """Return the current state of the pipeline/LangGraph."""
    return _latest_status

@app.get("/", tags=["Health"])
async def health_check():
    """Lightweight liveness probe."""
    return {"success": True, "message": "LAM-ADEP Pipeline API is running."}


@app.get("/download", tags=["Pipeline"])
async def download_cleaned_data():
    """Download cleaned_sales.csv if it exists; otherwise return a JSON error (200 OK)."""
    if not os.path.isfile(_CLEANED_CSV):
        return JSONResponse(
            status_code=200,
            content={
                "success": False,
                "error": "FILE_NOT_FOUND",
                "message": (
                    "cleaned_sales.csv is not available yet. "
                    "Approve the pipeline so the transform step can produce it."
                ),
            },
        )
    try:
        return FileResponse(
            path=_CLEANED_CSV,
            filename="cleaned_sales.csv",
            media_type="text/csv",
        )
    except Exception as exc:
        logger.error("FileResponse for cleaned_sales.csv failed: %s", exc)
        return JSONResponse(
            status_code=200,
            content={"success": False, "error": "SERVE_FAILED", "message": str(exc)},
        )


@app.get("/analytics", tags=["Analytics"])
async def get_analytics():
    """Real summary statistics from supermarket_sales.csv for the dashboard."""
    result = compute_analytics()
    # Always return 200 so the frontend can parse the error cleanly
    return JSONResponse(status_code=200, content=result)


@app.post("/start", response_model=APIResponse, tags=["Pipeline"])
async def start_pipeline(body: StartRequest):
    """Kick off the pipeline.

    The graph runs through **Discovery → Transform** and then pauses at
    the HITL interrupt gate inside the Transform node.  The response
    contains the `thread_id` (needed to resume) and the current state.
    """
    thread_id = str(uuid.uuid4())
    config = _config_for(thread_id)

    logger.info("Starting pipeline — thread %s", thread_id)

    initial_state: PipelineState = {
        "input_data": body.input_data,
        "status": "Initialized",
        "generated_code": "",
        "human_feedback": "",
    }

    # invoke() will run until the interrupt() inside transform_node pauses
    # the graph.  The returned value is the state *at the point of pause*.
    _compiled_graph.invoke(initial_state, config=config)

    # Read the persisted state snapshot (more reliable than the return value
    # when an interrupt is involved).
    snapshot = _compiled_graph.get_state(config)
    current_state = _state_to_dict(snapshot)

    logger.info("Pipeline paused at HITL gate — thread %s", thread_id)

    global _latest_status
    _latest_status = {
        "status": "paused_for_approval",
        "current_stage": "transform",
        "thread_id": thread_id,
        "message": "Pipeline paused at HITL gate. Awaiting human approval of generated code.",
        "stages_completed": ["discovery"],
        "generated_code": current_state.get("generated_code", "") or "",
    }

    return APIResponse(
        success=True,
        thread_id=thread_id,
        state=current_state,
        message="Pipeline paused. Awaiting human approval.",
    )


@app.post("/approve", response_model=APIResponse, tags=["Pipeline"])
async def approve_pipeline(body: ApproveRequest):
    """Resume the paused pipeline after human review.

    Send `action: "Approve"` to let the Healing node run, or
    `action: "Reject"` to record the rejection and still complete
    the graph traversal.
    """
    config = _config_for(body.thread_id)

    # Verify the thread exists and is actually paused
    snapshot = _compiled_graph.get_state(config)
    if not snapshot or not snapshot.next:
        return APIResponse(
            success=False,
            thread_id=body.thread_id,
            state=_state_to_dict(snapshot) if snapshot else {},
            message="No paused pipeline found for this thread_id. "
                    "Either it was already completed or the ID is invalid.",
        )

    logger.info(
        "Resuming pipeline — thread %s, action=%s",
        body.thread_id,
        body.action,
    )

    # Resume the graph; Command(resume=...) feeds the value back into
    # the interrupt() call inside transform_node.
    _compiled_graph.invoke(
        Command(resume=body.action),
        config=config,
    )

    # Fetch the final state
    final_snapshot = _compiled_graph.get_state(config)
    final_state = _state_to_dict(final_snapshot)

    logger.info("Pipeline finished — thread %s", body.thread_id)

    msg = (
        "Pipeline completed successfully."
        if body.action.strip().lower() == "approve"
        else "Pipeline completed — code was rejected by human reviewer."
    )

    # Read the final status from graph state for accurate reporting
    final_status_text = final_state.get("status", "Pipeline Complete")

    global _latest_status
    _latest_status = {
        "status": "completed",
        "current_stage": "orchestrator",
        "thread_id": body.thread_id,
        "message": final_status_text,
        "stages_completed": ["discovery", "transform", "healing", "orchestrator"],
        "generated_code": final_state.get("generated_code", "") or "",
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
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info",
    )
