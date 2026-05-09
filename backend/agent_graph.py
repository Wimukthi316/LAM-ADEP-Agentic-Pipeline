"""
LAM-ADEP Agentic Data Engineering Pipeline — LangGraph Workflow
===============================================================
Metadata-First Architecture with Gemini 1.5 Flash and Sandboxed Execution.

Architecture
------------
- LLM         : Google Gemini 1.5 Flash (via google.generativeai)
- Vector DB   : ChromaDB persistent           (RLHF knowledge store)
- Metadata    : Custom lightweight pandas profiler (no ydata-profiling)
- Sandbox     : multiprocessing exec() — handled in FastAPI /approve endpoint

Nodes
-----
1. discovery_node    — Read CSV, build compact JSON metadata, store in state.
2. transform_node    — Send metadata JSON to Gemini Flash, extract Python code.
   ** HITL INTERRUPT immediately AFTER this node **
3. healing_node      — Lightweight pass: verifies code is non-empty.
4. orchestrator_node — If approved, persist code to ChromaDB for RLHF.
                       Code execution is handled externally by the /approve endpoint.

Checkpointing is handled by MemorySaver (in-memory, thread-safe).
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import TypedDict

import pandas as pd
from dotenv import load_dotenv
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, StateGraph
from langgraph.types import interrupt

# ---------------------------------------------------------------------------
# Environment & Logging
# ---------------------------------------------------------------------------
# Explicit dotenv load with the backend directory as base path so the key is
# always resolved correctly regardless of the CWD when uvicorn starts.
_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
_ENV_PATH = os.path.join(_BACKEND_DIR, ".env")
load_dotenv(dotenv_path=_ENV_PATH, override=True)

logger = logging.getLogger("lam_adep.graph")

# Absolute paths — always correct regardless of CWD
_DATA_DIR    = os.path.join(_BACKEND_DIR, "data")
CSV_PATH     = os.path.join(_DATA_DIR, "supermarket_sales.csv")
CLEANED_PATH = os.path.join(_DATA_DIR, "cleaned_sales.csv")

# ---------------------------------------------------------------------------
# Lazy Gemini Client Initialization
# ---------------------------------------------------------------------------
_gemini_model = None

TRANSFORM_CODE_FALLBACK = (
    "# Fallback: Gemini did not return valid code.\n"
    "# Please check your GEMINI_API_KEY and retry.\n"
    "import pandas as pd\n\n"
    f"df = pd.read_csv(r'{CSV_PATH}').head(200)\n"
    f"df.to_csv(r'{CLEANED_PATH}', index=False)\n"
    "print('Fallback: raw data saved as cleaned_sales.csv')\n"
)


def _get_gemini():
    """Lazy-init the Gemini 1.5 Flash generative model.

    Reads GEMINI_API_KEY from the environment (already loaded by load_dotenv
    above).  Raises RuntimeError with a clear message if the key is missing.
    """
    global _gemini_model
    if _gemini_model is None:
        import google.generativeai as genai  # type: ignore

        api_key = os.environ.get("GEMINI_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError(
                "GEMINI_API_KEY is not set. "
                f"Add it to {_ENV_PATH} and restart the server."
            )
        genai.configure(api_key=api_key)
        _gemini_model = genai.GenerativeModel("gemini-1.5-flash")
        logger.info("Gemini 1.5 Flash client initialised.")
    return _gemini_model


# ---------------------------------------------------------------------------
# Lightweight Pandas Metadata Extractor
# ---------------------------------------------------------------------------

def _build_metadata_json(df: pd.DataFrame) -> str:
    """Return a compact JSON string describing the DataFrame schema.

    Fields per column:
      - dtype      : pandas dtype string
      - null_count : number of missing values
      - null_pct   : percentage missing (2 d.p.)
      - unique     : number of unique values
      - sample     : first 3 non-null values as strings

    For numeric columns, also adds:
      - min / max / mean / std  (all rounded to 4 d.p.)

    The total output is intentionally small (<4 KB for a typical 200-row CSV)
    so it fits comfortably within Gemini's context window without wasting tokens.
    """
    n_rows, n_cols = df.shape
    columns_meta: list[dict] = []

    for col in df.columns:
        series = df[col]
        null_count = int(series.isna().sum())
        unique_count = int(series.nunique(dropna=True))
        sample = [str(v) for v in series.dropna().head(3).tolist()]

        col_info: dict = {
            "name":       col,
            "dtype":      str(series.dtype),
            "null_count": null_count,
            "null_pct":   round(null_count / n_rows * 100, 2) if n_rows else 0,
            "unique":     unique_count,
            "sample":     sample,
        }

        # Numeric summary
        if pd.api.types.is_numeric_dtype(series):
            col_info["min"]  = round(float(series.min(skipna=True)), 4) if not series.dropna().empty else None
            col_info["max"]  = round(float(series.max(skipna=True)), 4) if not series.dropna().empty else None
            col_info["mean"] = round(float(series.mean(skipna=True)), 4) if not series.dropna().empty else None
            col_info["std"]  = round(float(series.std(skipna=True)), 4) if not series.dropna().empty else None

        columns_meta.append(col_info)

    metadata = {
        "file": os.path.basename(CSV_PATH),
        "rows": n_rows,
        "cols": n_cols,
        "columns": columns_meta,
    }
    return json.dumps(metadata, indent=2)


# ---------------------------------------------------------------------------
# Graph State Schema
# ---------------------------------------------------------------------------

class PipelineState(TypedDict):
    """Typed dictionary that travels through every node."""

    input_data:     str   # Compact JSON metadata from Discovery
    status:         str   # Human-readable status tag
    generated_code: str   # Cleaning code from Transform (LLM output)
    edited_code:    str   # User-edited version of the code (from Monaco HITL)
    human_feedback: str   # Feedback received at the HITL gate


# ---------------------------------------------------------------------------
# Node 1 — Discovery Agent
# ---------------------------------------------------------------------------

def discovery_node(state: PipelineState) -> PipelineState:
    """Read the CSV, build a compact JSON metadata document, and store it.

    Does NOT call any LLM — keeps tokens for the Transform node only.
    Falls back gracefully if the CSV cannot be read.
    """
    logger.info("[Discovery] Reading CSV and building metadata …")

    metadata_json = ""
    try:
        df = pd.read_csv(CSV_PATH).head(200)
        metadata_json = _build_metadata_json(df)
        logger.info(
            "[Discovery] Metadata JSON built (%d chars, %d columns)",
            len(metadata_json), len(df.columns),
        )
    except Exception as exc:
        logger.error("[Discovery] Failed to read CSV: %s", exc, exc_info=True)
        metadata_json = json.dumps({
            "error": str(exc),
            "file": os.path.basename(CSV_PATH),
            "message": "Could not read or profile the source CSV.",
        })

    return {
        **state,
        "input_data":     metadata_json,
        "status":         "Discovery Complete",
        "generated_code": "",
        "edited_code":    "",
        "human_feedback": "",
    }


# ---------------------------------------------------------------------------
# Node 2 — Transform Agent (Gemini 1.5 Flash)
# ---------------------------------------------------------------------------

def transform_node(state: PipelineState) -> PipelineState:
    """Send the metadata JSON to Gemini 1.5 Flash and extract cleaning code.

    Uses absolute path constants so the generated script always writes to the
    correct location regardless of where it is executed.
    """
    logger.info("[Transform] Generating cleaning code via Gemini 1.5 Flash …")

    metadata_json = state.get("input_data", "{}")
    generated_code = TRANSFORM_CODE_FALLBACK

    prompt = (
        "You are an expert Data Engineer. Below is a JSON metadata profile of a "
        "supermarket sales CSV dataset (first 200 rows).\n\n"
        f"```json\n{metadata_json}\n```\n\n"
        "Write a complete, self-contained Python script using pandas that:\n"
        f"1. Loads the CSV from the absolute path: {CSV_PATH!r}\n"
        "2. Takes only the first 200 rows.\n"
        "3. Applies at least 3 data cleaning steps appropriate for this dataset "
        "(e.g. parse date columns, coerce numeric types, drop duplicates, "
        "handle nulls, rename columns for consistency).\n"
        f"4. Saves the cleaned DataFrame to: {CLEANED_PATH!r}\n"
        "5. Prints a summary of rows written.\n\n"
        "IMPORTANT: Return ONLY raw Python code. Do NOT wrap it in markdown "
        "fences (``` or ```python). Do not include any explanation text."
    )

    try:
        model = _get_gemini()
        response = model.generate_content(prompt)
        raw = (response.text or "").strip()

        # Strip any markdown fences the model might emit despite instructions
        raw = re.sub(r"^```(?:python)?\s*", "", raw, flags=re.IGNORECASE)
        raw = re.sub(r"\s*```$", "", raw)
        raw = raw.strip()

        if raw:
            generated_code = raw
            logger.info(
                "[Transform] Gemini code generated (%d chars)", len(generated_code)
            )
        else:
            logger.warning("[Transform] Gemini returned empty response — using fallback.")

    except Exception as exc:
        logger.error("[Transform] Gemini error: %s", exc, exc_info=True)
        generated_code = (
            f"# ERROR: Gemini API call failed — {exc}\n"
            + TRANSFORM_CODE_FALLBACK
        )

    updated_state = {
        **state,
        "status":         "Code Generated. Pending Approval",
        "generated_code": generated_code,
        "edited_code":    generated_code,  # pre-fill editor with generated code
    }

    # ── HITL Gate ─────────────────────────────────────────────────────
    human_decision: str = interrupt(
        {
            "message":         "Review the generated transformation code.",
            "generated_code":  generated_code,
            "action_required": "Send Command(resume='Approve') or Command(resume='Reject') to continue.",
        }
    )

    updated_state["human_feedback"] = human_decision
    logger.info("[Transform] Human decision received: %s", human_decision)

    return updated_state


# ---------------------------------------------------------------------------
# Node 3 — Healing Agent (lightweight validation pass)
# ---------------------------------------------------------------------------

def healing_node(state: PipelineState) -> PipelineState:
    """Validate that a non-empty code string exists.

    Full sandbox execution is handled by the FastAPI /approve endpoint using
    a multiprocessing worker, so we only do a lightweight guard here.
    """
    logger.info("[Healing] Running validation pass …")

    code = state.get("edited_code") or state.get("generated_code", "")
    if not code.strip():
        code = TRANSFORM_CODE_FALLBACK
        logger.warning("[Healing] Code was empty — substituting fallback.")

    return {
        **state,
        "generated_code": code,
        "edited_code":    code,
        "status":         "Healing Complete",
    }


# ---------------------------------------------------------------------------
# Node 4 — Orchestrator / RLHF
# ---------------------------------------------------------------------------

def orchestrator_node(state: PipelineState) -> PipelineState:
    """Persist the approved code to ChromaDB for RLHF knowledge storage.

    Code EXECUTION is intentionally NOT done here — it is handled by the
    FastAPI /approve endpoint via the multiprocessing sandbox before this
    node is even reached for ChromaDB writes.
    """
    feedback = state.get("human_feedback", "").strip().lower()
    logger.info("[Orchestrator] Processing with feedback: %s", feedback)

    if feedback == "reject":
        return {
            **state,
            "status": "Pipeline Rejected by Human — awaiting revision",
        }

    # ── Approved → persist to ChromaDB ────────────────────────────────
    try:
        import chromadb  # type: ignore

        chroma_path = os.path.join(_BACKEND_DIR, "chroma_db")
        client = chromadb.PersistentClient(path=chroma_path)
        collection = client.get_or_create_collection(
            name="rlhf_pipeline_knowledge",
            metadata={"description": "Approved pipeline code for RLHF"},
        )

        code = state.get("edited_code") or state.get("generated_code", "")
        collection.add(
            documents=[code],
            ids=[f"pipeline_code_{hash(code) & 0xFFFFFFFF}"],
            metadatas=[{
                "feedback": state.get("human_feedback", ""),
                "status":   "approved",
                "source":   "transform_agent_gemini",
            }],
        )

        doc_count = collection.count()
        csv_ready = os.path.isfile(CLEANED_PATH)
        logger.info(
            "[Orchestrator] Code saved to ChromaDB (docs=%d). cleaned_sales.csv ready=%s",
            doc_count, csv_ready,
        )

        status_msg = (
            f"Pipeline Complete. cleaned_sales.csv {'ready' if csv_ready else 'pending'}. "
            f"Knowledge saved to ChromaDB ({doc_count} docs)."
        )
        return {**state, "status": status_msg}

    except Exception as exc:
        logger.error("[Orchestrator] ChromaDB error: %s", exc, exc_info=True)
        return {
            **state,
            "status": f"Pipeline Complete (ChromaDB error: {exc}).",
        }


# ---------------------------------------------------------------------------
# Graph Construction
# ---------------------------------------------------------------------------

def build_graph() -> StateGraph:
    """Construct and compile the LAM-ADEP pipeline graph.

    Flow: discovery → transform (HITL interrupt) → healing → orchestrator → END
    """
    builder = StateGraph(PipelineState)

    builder.add_node("discovery",   discovery_node)
    builder.add_node("transform",   transform_node)
    builder.add_node("healing",     healing_node)
    builder.add_node("orchestrator", orchestrator_node)

    builder.set_entry_point("discovery")
    builder.add_edge("discovery",    "transform")
    builder.add_edge("transform",    "healing")
    builder.add_edge("healing",      "orchestrator")
    builder.add_edge("orchestrator", END)

    checkpointer = MemorySaver()
    compiled = builder.compile(checkpointer=checkpointer)

    logger.info("Pipeline graph compiled (4 nodes, Gemini 1.5 Flash).")
    return compiled
