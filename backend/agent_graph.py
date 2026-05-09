"""
LAM-ADEP Agentic Data Engineering Pipeline — LangGraph Workflow
===============================================================
Metadata-First Architecture v3 — ydata-profiling + Healing Loop + Dynamic CSV

Architecture
------------
- LLM         : Google Gemini 2.5 Flash (google.generativeai)
- Profiler     : ydata-profiling minimal → surgical JSON extraction (≤6 KB)
                 Fallback: custom pandas profiler if ydata-profiling unavailable
- Vector DB   : ChromaDB persistent (RLHF knowledge store)
- Sandbox     : multiprocessing exec() — handled in FastAPI /approve endpoint

Graph Topology (v3 — with healing back-edge)
---------------------------------------------
  discovery → transform ←─────────────────────┐
                  ↓  (HITL interrupt)          │
              healing ──(reject, iter<3)───────┘
                  ↓  (approve OR max iters)
            orchestrator → END

Checkpointing: MemorySaver (in-memory, thread-safe).
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
_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
_ENV_PATH    = os.path.join(_BACKEND_DIR, ".env")
load_dotenv(dotenv_path=_ENV_PATH, override=True)

logger = logging.getLogger("lam_adep.graph")

# Default paths (used when no dynamic upload is active)
_DATA_DIR    = os.path.join(_BACKEND_DIR, "data")
CSV_PATH     = os.path.join(_DATA_DIR, "supermarket_sales.csv")
CLEANED_PATH = os.path.join(_DATA_DIR, "cleaned_sales.csv")

# Max healing loop iterations before forcing orchestrator
MAX_HEALING_ITERATIONS = 3

# Gemini prompt budget — compact profile JSON only (no raw ProfileReport HTML/JSON)
_MAX_METADATA_BYTES = 6000


def _derive_cleaned_path(csv_path: str) -> str:
    """Derive the output cleaned CSV path from the input CSV path.

    Examples:
      .../data/supermarket_sales.csv  →  .../data/cleaned_supermarket_sales.csv
      .../data/retail_data.csv        →  .../data/cleaned_retail_data.csv
    """
    basename = os.path.basename(csv_path)
    name, ext = os.path.splitext(basename)
    return os.path.join(_DATA_DIR, f"cleaned_{name}{ext}")


# ---------------------------------------------------------------------------
# Lazy Gemini Client
# ---------------------------------------------------------------------------
_gemini_model = None

TRANSFORM_CODE_FALLBACK = (
    "# Fallback: Gemini did not return valid code.\n"
    "# Please check GEMINI_API_KEY and retry.\n"
    "import pandas as pd\n\n"
    "df = pd.read_csv(INPUT_CSV, low_memory=False)\n"
    "df.drop_duplicates(inplace=True)\n"
    "for _col in list(df.select_dtypes(include=['number']).columns):\n"
    "    if not df[_col].isna().any():\n"
    "        continue\n"
    "    _med = df[_col].median()\n"
    "    if pd.notna(_med):\n"
    "        df[_col] = df[_col].fillna(_med)\n"
    "        continue\n"
    "    _mean = df[_col].mean()\n"
    "    if pd.notna(_mean):\n"
    "        df[_col] = df[_col].fillna(_mean)\n"
    "        continue\n"
    "    df.drop(columns=[_col], inplace=True)\n"
    "for _col in df.select_dtypes(include=['object', 'string']).columns:\n"
    "    df[_col] = df[_col].fillna('')\n"
    "df.dropna(how='all', inplace=True)\n"
    "df.to_csv(OUTPUT_CSV, index=False)\n"
    "print(f'Fallback: wrote {len(df)} rows to OUTPUT_CSV')\n"
)


_GEMINI_TRANSFORM_RULES = """CRITICAL RULES YOU MUST FOLLOW:
1. NO SAMPLING: NEVER use `nrows`, `.head()`, or any sampling inside or chained from `pd.read_csv()`. Load the full dataset with `pd.read_csv(INPUT_CSV, low_memory=False)`.
2. GLOBALLY DEFINED PATHS: NEVER assign or redefine `INPUT_CSV` or `OUTPUT_CSV`. They exist in the runtime; use them only as `pd.read_csv(INPUT_CSV)` and `df.to_csv(OUTPUT_CSV, index=False)`. Never hardcode disk paths.
3. DATA HYGIENE & SMART IMPUTATION: Always `df.drop_duplicates(inplace=True)`. NEVER blindly `fillna(0)` on numeric columns. Use per-column median or mean where sensible; if a numeric column cannot be imputed without distorting metrics (e.g. no valid median/mean), drop that column or rows per sound judgment — do not zero-fill by default.
4. OUTPUT FORMAT: Save only with `df.to_csv(OUTPUT_CSV, index=False)`.
5. OUTPUT ONLY CODE: Return ONLY executable Python — no markdown fences, no explanations."""


GEMINI_MODEL = "models/gemini-2.5-flash"


def _get_gemini():
    """Lazy-init Gemini (google.generativeai). Raises RuntimeError if key is missing."""
    global _gemini_model
    if _gemini_model is None:
        import google.generativeai as genai  # type: ignore

        api_key = os.environ.get("GEMINI_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError(
                f"GEMINI_API_KEY is not set. Add it to {_ENV_PATH} and restart."
            )
        genai.configure(api_key=api_key)
        _gemini_model = genai.GenerativeModel(GEMINI_MODEL)
        logger.info("Gemini model initialised: %s", GEMINI_MODEL)
    return _gemini_model


# ---------------------------------------------------------------------------
# Metadata Extractors
# ---------------------------------------------------------------------------

def _cap_metadata_dict_to_str(metadata: dict) -> str:
    """Shrink profile dict to fit ~_MAX_METADATA_BYTES UTF-8 (Gemini token budget)."""

    def byte_len(s: str) -> int:
        return len(s.encode("utf-8"))

    def slim_entry(c: dict) -> dict:
        d = {k: v for k, v in dict(c).items() if v is not None}
        tv = d.get("top_values")
        if isinstance(tv, list):
            d["top_values"] = [str(x)[:48] for x in tv[:3]]
        nm = d.get("name")
        if isinstance(nm, str) and len(nm) > 48:
            d["name"] = nm[:48] + "…"
        return d

    cols = [slim_entry(c) for c in (metadata.get("columns") or [])]
    alerts = list(metadata.get("alerts") or [])

    def payload(cl: list, al: list) -> dict:
        return {
            "profiler": metadata.get("profiler"),
            "file":     metadata.get("file"),
            "rows":     metadata.get("rows"),
            "cols":     metadata.get("cols"),
            "columns":  cl,
            "alerts":   al,
        }

    while True:
        body = payload(cols, alerts)
        raw = json.dumps(body, indent=2)
        if byte_len(raw) <= _MAX_METADATA_BYTES:
            return raw
        if alerts:
            alerts = alerts[:-1]
            continue
        if len(cols) > 1:
            cols = cols[:-1]
            continue
        if cols:
            c0 = dict(cols[0])
            for k in ("p25", "p50", "p75", "std", "mean", "min", "max"):
                c0.pop(k, None)
            cols = [c0]
            raw_c = json.dumps(payload(cols, alerts), separators=(",", ":"))
            if byte_len(raw_c) <= _MAX_METADATA_BYTES:
                return raw_c
        return json.dumps(
            {
                "profiler": metadata.get("profiler"),
                "file":     metadata.get("file"),
                "rows":     metadata.get("rows"),
                "cols":     metadata.get("cols"),
                "note":     "profile_truncated_to_budget",
                "columns":  [],
                "alerts":   [],
            },
            separators=(",", ":"),
        )


def _build_pandas_metadata_json(df: pd.DataFrame, csv_path: str) -> str:
    """Lightweight pandas-only metadata extractor (fallback when ydata-profiling
    is unavailable). Produces a compact JSON string suitable for the Gemini prompt.
    """
    n_rows, n_cols = df.shape
    columns_meta: list[dict] = []

    for col in df.columns:
        s = df[col]
        null_count = int(s.isna().sum())
        n_unique = int(s.nunique(dropna=True))
        entry: dict = {
            "name":      col,
            "dtype":     str(s.dtype),
            "n_missing": null_count,
            "p_missing": round(null_count / n_rows * 100, 2) if n_rows else 0,
            "n_unique":  n_unique,
            "p_unique":  round(n_unique / n_rows * 100, 2) if n_rows else 0,
        }
        if pd.api.types.is_numeric_dtype(s) and not s.dropna().empty:
            entry["min"]  = round(float(s.min(skipna=True)), 4)
            entry["max"]  = round(float(s.max(skipna=True)), 4)
            entry["mean"] = round(float(s.mean(skipna=True)), 4)
            entry["std"]  = round(float(s.std(skipna=True)), 4)
        else:
            try:
                vc = s.dropna().astype(str).value_counts().head(5)
                entry["top_values"] = [str(k) for k in vc.index.tolist()]
            except Exception:
                entry["top_values"] = [str(v) for v in s.dropna().head(5).tolist()]
        columns_meta.append(entry)

    meta = {
        "profiler": "pandas/custom",
        "file":     os.path.basename(csv_path),
        "rows":     n_rows,
        "cols":     n_cols,
        "columns":  columns_meta,
    }
    return _cap_metadata_dict_to_str(meta)


def _build_ydata_metadata_json(df: pd.DataFrame, csv_path: str) -> str:
    """Run ydata-profiling (minimal mode) and surgically extract a token-safe
    JSON summary (≤6 KB for a typical 200-row, 17-column dataset).

    Extracted per-column fields:
      - type, n_missing, p_missing (%), n_unique, p_unique (%)
      - mean, std, min, max, p25, p50, p75  (numeric only)
      - top_values[:5]                      (categorical only)

    Global fields:
      - profiler label, file, rows, cols
      - alerts[:10] (data quality warnings from ydata)

    Falls back to pandas profiler on ImportError or any exception.
    """
    try:
        from ydata_profiling import ProfileReport  # type: ignore

        logger.info("[Discovery] Running ydata-profiling (minimal=True) …")
        profile = ProfileReport(df, minimal=True, progress_bar=False)
        raw: dict = json.loads(profile.to_json())

        variables = raw.get("variables", {})
        alerts_raw = raw.get("alerts", [])

        columns_meta: list[dict] = []
        for col_name, col_stats in variables.items():
            entry: dict = {
                "name":      col_name,
                "type":      str(col_stats.get("type", "unknown")),
                "n_missing": int(col_stats.get("n_missing", 0)),
                "p_missing": round(float(col_stats.get("p_missing", 0)) * 100, 2),
                "n_unique":  int(col_stats.get("n_unique", 0)),
                "p_unique":  round(float(col_stats.get("p_unique", 0)) * 100, 2),
            }
            # Numeric distribution stats
            for stat in ("mean", "std", "min", "max", "p25", "p50", "p75"):
                val = col_stats.get(stat)
                if val is not None:
                    try:
                        entry[stat] = round(float(val), 4)
                    except (TypeError, ValueError):
                        pass
            # Top categorical values (capped at 5)
            vc = col_stats.get("value_counts_without_nan")
            if isinstance(vc, dict):
                entry["top_values"] = [str(k) for k in list(vc.keys())[:5]]
            columns_meta.append(entry)

        # Data quality alerts (capped at 10)
        alerts: list[str] = []
        for alert in alerts_raw[:10]:
            if isinstance(alert, str):
                alerts.append(alert)
            elif isinstance(alert, dict):
                alerts.append(str(alert.get("alert_type", alert)))

        metadata = {
            "profiler": "ydata-profiling/minimal",
            "file":     os.path.basename(csv_path),
            "rows":     df.shape[0],
            "cols":     df.shape[1],
            "alerts":   alerts,
            "columns":  columns_meta,
        }
        out = _cap_metadata_dict_to_str(metadata)
        token_estimate = len(out) // 4
        logger.info(
            "[Discovery] ydata-profiling JSON ready (%d chars, ~%d tokens)",
            len(out), token_estimate,
        )
        return out

    except ImportError:
        logger.warning(
            "[Discovery] ydata-profiling not installed — using pandas fallback."
        )
        return _build_pandas_metadata_json(df, csv_path)

    except Exception as exc:
        logger.error(
            "[Discovery] ydata-profiling failed (%s) — using pandas fallback.", exc
        )
        return _build_pandas_metadata_json(df, csv_path)


# ---------------------------------------------------------------------------
# Graph State Schema
# ---------------------------------------------------------------------------

class PipelineState(TypedDict):
    """Typed state dictionary that travels through every node."""

    active_csv_path:    str   # Absolute path to the CSV being processed
    input_data:         str   # Compact JSON metadata from Discovery
    status:             str   # Human-readable status tag
    generated_code:     str   # Latest LLM-generated cleaning code
    edited_code:        str   # User-edited version (from Monaco Editor)
    human_feedback:     str   # Latest HITL decision: "Approve" | "Reject:<text>"
    rejection_feedback: str   # Extracted text from the last rejection
    healing_iterations: int   # Reject loop counter (capped at MAX_HEALING_ITERATIONS)


# ---------------------------------------------------------------------------
# Node 1 — Discovery Agent
# ---------------------------------------------------------------------------

def discovery_node(state: PipelineState) -> PipelineState:
    """Read the active CSV, run ydata-profiling (minimal), store compact JSON.

    Uses `state["active_csv_path"]` if set (dynamic upload), otherwise falls
    back to the default `CSV_PATH` constant.  Does NOT call any LLM.
    """
    csv_path = state.get("active_csv_path") or CSV_PATH
    logger.info("[Discovery] Profiling CSV: %s", csv_path)

    metadata_json = ""
    try:
        df = pd.read_csv(csv_path).head(200)
        metadata_json = _build_ydata_metadata_json(df, csv_path)
        logger.info("[Discovery] Metadata JSON ready (%d chars)", len(metadata_json))
    except Exception as exc:
        logger.error("[Discovery] Failed to read/profile CSV: %s", exc, exc_info=True)
        metadata_json = json.dumps({
            "error":   str(exc),
            "file":    os.path.basename(csv_path),
            "message": "Could not read or profile the source CSV.",
        })

    return {
        **state,
        "input_data":         metadata_json,
        "status":             "Discovery Complete",
        "generated_code":     "",
        "edited_code":        "",
        "human_feedback":     "",
        "rejection_feedback": "",
        "healing_iterations": 0,
    }


# ---------------------------------------------------------------------------
# Node 2 — Transform Agent (Gemini 2.5 Flash)
# ---------------------------------------------------------------------------

def transform_node(state: PipelineState) -> PipelineState:
    """Send metadata JSON to Gemini and extract Python cleaning code.

    On the first run, sends the standard data-engineering prompt.
    On subsequent runs (after rejection), sends a *corrective* prompt that
    includes the reviewer's textual feedback from the previous rejection.
    """
    csv_path     = state.get("active_csv_path") or CSV_PATH
    cleaned_path = _derive_cleaned_path(csv_path)
    metadata_json       = state.get("input_data", "{}")
    rejection_feedback  = (state.get("rejection_feedback") or "").strip()
    healing_iterations  = state.get("healing_iterations", 0)

    logger.info(
        "[Transform] Generating code via Gemini (iter=%d, corrective=%s)",
        healing_iterations, bool(rejection_feedback),
    )
    logger.info("[Transform] Sandbox paths INPUT_CSV=%s OUTPUT_CSV=%s", csv_path, cleaned_path)

    if rejection_feedback:
        # ── Corrective prompt ──────────────────────────────────────────
        prompt = (
            "You are an expert Data Engineer Python Agent. Write production-ready pandas "
            "code that transforms the dataset according to reviewer feedback and schema hints.\n\n"
            f"{_GEMINI_TRANSFORM_RULES}\n\n"
            f"REJECTION FEEDBACK: \"{rejection_feedback}\"\n\n"
            "Dataset metadata profile (JSON):\n"
            f"```json\n{metadata_json}\n```\n\n"
            "Write a CORRECTED script that applies hygiene first, then directly addresses "
            "the feedback with appropriate transformations for this schema.\n"
            "Print a short summary line with final row count.\n"
        )
    else:
        # ── First-run prompt ───────────────────────────────────────────
        prompt = (
            "You are an expert Data Engineer Python Agent. Write production-ready pandas "
            "code to clean and transform the dataset described below.\n\n"
            f"{_GEMINI_TRANSFORM_RULES}\n\n"
            "Dataset metadata profile (JSON):\n"
            f"```json\n{metadata_json}\n```\n\n"
            "After hygiene, apply at least three meaningful transformations suited to this "
            "schema (e.g. parse dates, coerce numerics, standardize strings, outliers).\n"
            "Print a short summary line with final row count.\n"
        )

    generated_code = TRANSFORM_CODE_FALLBACK
    try:
        model = _get_gemini()
        response = model.generate_content(prompt)
        raw = (response.text or "").strip()

        # Strip any markdown fences the model emits despite instructions
        raw = re.sub(r"^```(?:python)?\s*", "", raw, flags=re.IGNORECASE | re.MULTILINE)
        raw = re.sub(r"\s*```\s*$", "", raw, flags=re.MULTILINE)
        raw = raw.strip()

        if raw:
            generated_code = raw
            logger.info("[Transform] Gemini code generated (%d chars)", len(raw))
        else:
            logger.warning("[Transform] Gemini returned empty — using fallback.")

    except Exception as exc:
        logger.error("[Transform] Gemini error: %s", exc, exc_info=True)
        generated_code = f"# ERROR: Gemini API failed — {exc}\n" + TRANSFORM_CODE_FALLBACK

    updated_state = {
        **state,
        "status":         "Code Generated — Pending Approval",
        "generated_code": generated_code,
        "edited_code":    generated_code,  # pre-fill Monaco Editor
    }

    # ── HITL Gate ──────────────────────────────────────────────────────
    human_decision: str = interrupt({
        "message":          "Review the generated transformation code.",
        "generated_code":   generated_code,
        "healing_iteration": healing_iterations,
        "action_required":  "Resume with 'Approve' or 'Reject:<feedback>' to continue.",
    })

    updated_state["human_feedback"] = human_decision
    logger.info("[Transform] HITL decision: %s", human_decision[:80])
    return updated_state


# ---------------------------------------------------------------------------
# Node 3 — Healing Agent (Router + State Preparer)
# ---------------------------------------------------------------------------

def healing_node(state: PipelineState) -> PipelineState:
    """Route the pipeline based on the HITL decision.

    Approve path: validate code is non-empty, pass through to orchestrator.
    Reject path:  extract feedback text, increment healing_iterations, clear
                  generated_code so transform_node produces a fresh script.
                  _should_loop_back() then routes back to transform_node.
    """
    feedback   = (state.get("human_feedback") or "").strip()
    iterations = state.get("healing_iterations", 0)

    if feedback.lower().startswith("reject"):
        # Extract user's textual feedback from "Reject:<message>"
        parts = feedback.split(":", 1)
        rejection_text = parts[1].strip() if len(parts) > 1 and parts[1].strip() \
            else "The generated code needs improvement — please review and fix issues."

        new_iterations = iterations + 1
        logger.info(
            "[Healing] Rejection iter %d/%d. Feedback: %s",
            new_iterations, MAX_HEALING_ITERATIONS, rejection_text[:80],
        )

        if new_iterations > MAX_HEALING_ITERATIONS:
            # Hard cap — force approval with a warning
            logger.warning(
                "[Healing] Max iterations reached (%d). Forcing orchestrator.",
                MAX_HEALING_ITERATIONS,
            )
            return {
                **state,
                "healing_iterations": new_iterations,
                "status": (
                    f"Max healing attempts ({MAX_HEALING_ITERATIONS}) reached. "
                    "Using last generated code."
                ),
            }

        return {
            **state,
            "rejection_feedback":  rejection_text,
            "healing_iterations":  new_iterations,
            "status":              f"Healing: Re-generating code (attempt {new_iterations}/{MAX_HEALING_ITERATIONS})",
            "generated_code":      "",
            "edited_code":         "",
            "human_feedback":      feedback,  # preserve for _should_loop_back routing
        }

    # ── Approve path ───────────────────────────────────────────────────
    code = (state.get("edited_code") or state.get("generated_code") or "").strip()
    if not code:
        code = TRANSFORM_CODE_FALLBACK
        logger.warning("[Healing] Code was empty — substituting fallback.")

    return {
        **state,
        "generated_code":     code,
        "edited_code":        code,
        "rejection_feedback": "",
        "status":             "Healing Complete",
    }


# ---------------------------------------------------------------------------
# Routing function for conditional edge
# ---------------------------------------------------------------------------

def _should_loop_back(state: PipelineState) -> str:
    """Determine next node after healing_node.

    Returns "transform" to regenerate code (reject path, under iteration cap).
    Returns "orchestrator" for approve path or when iterations are exhausted.
    """
    feedback   = (state.get("human_feedback") or "").strip().lower()
    iterations = state.get("healing_iterations", 0)

    if feedback.startswith("reject") and iterations <= MAX_HEALING_ITERATIONS:
        return "transform"
    return "orchestrator"


# ---------------------------------------------------------------------------
# Node 4 — Orchestrator / RLHF
# ---------------------------------------------------------------------------

def orchestrator_node(state: PipelineState) -> PipelineState:
    """Persist the approved code to ChromaDB for RLHF knowledge storage.

    Code EXECUTION is handled externally by the FastAPI /approve endpoint via
    the multiprocessing sandbox before this node is reached.
    """
    feedback = (state.get("human_feedback") or "").strip().lower()
    logger.info("[Orchestrator] Processing — feedback: %s", feedback[:40])

    if feedback.startswith("reject"):
        # Max iterations hit — record as rejected
        return {
            **state,
            "status": (
                f"Pipeline Rejected after {state.get('healing_iterations', 0)} "
                "healing attempts. Please restart and provide clearer instructions."
            ),
        }

    # ── Approved → persist to ChromaDB ────────────────────────────────
    try:
        import chromadb  # type: ignore

        chroma_path = os.path.join(_BACKEND_DIR, "chroma_db")
        client      = chromadb.PersistentClient(path=chroma_path)
        collection  = client.get_or_create_collection(
            name="rlhf_pipeline_knowledge",
            metadata={"description": "Approved pipeline code for RLHF"},
        )

        code         = (state.get("edited_code") or state.get("generated_code") or "")
        csv_path     = state.get("active_csv_path") or CSV_PATH
        cleaned_path = _derive_cleaned_path(csv_path)
        csv_ready    = os.path.isfile(cleaned_path)

        import time
        collection.add(
            documents=[code],
            ids=[f"pipeline_code_{hash(code) & 0xFFFFFFFF}"],
            metadatas=[{
                "feedback":          state.get("human_feedback", ""),
                "status":            "approved",
                "source":            "transform_agent_gemini_v3",
                "source_file":       os.path.basename(csv_path),
                "healing_iters":     str(state.get("healing_iterations", 0)),
                "timestamp":         str(int(time.time())),
            }],
        )

        doc_count  = collection.count()
        status_msg = (
            f"Pipeline Complete. {os.path.basename(cleaned_path)} "
            f"{'ready ✓' if csv_ready else 'pending ✗'}. "
            f"ChromaDB: {doc_count} approved scripts stored."
        )
        logger.info("[Orchestrator] ChromaDB updated (docs=%d, csv_ready=%s)", doc_count, csv_ready)
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
    """Compile the LAM-ADEP v3 pipeline graph.

    Topology:
      discovery → transform (HITL interrupt)
                      ↓
                  healing ──(reject, iter ≤ MAX)──→ transform
                      ↓    (approve OR iter > MAX)
                orchestrator → END
    """
    builder = StateGraph(PipelineState)

    builder.add_node("discovery",    discovery_node)
    builder.add_node("transform",    transform_node)
    builder.add_node("healing",      healing_node)
    builder.add_node("orchestrator", orchestrator_node)

    builder.set_entry_point("discovery")
    builder.add_edge("discovery",    "transform")
    builder.add_edge("transform",    "healing")

    builder.add_conditional_edges(
        "healing",
        _should_loop_back,
        {"transform": "transform", "orchestrator": "orchestrator"},
    )
    builder.add_edge("orchestrator", END)

    checkpointer = MemorySaver()
    compiled = builder.compile(checkpointer=checkpointer)
    logger.info(
        "Pipeline graph compiled v3 (healing loop, ydata-profiling, dynamic CSV)."
    )
    return compiled
