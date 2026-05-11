"""
LAM-ADEP Agentic Data Engineering Pipeline — LangGraph Workflow
===============================================================
Metadata-First Architecture v3 — ydata-profiling + Healing Loop + Dynamic CSV

Architecture
------------
- LLM         : Google Gemini 2.5 Flash (google.generativeai)
- Profiler     : ydata-profiling minimal → surgical JSON extraction (≤6 KB)
                 Fallback: custom pandas profiler if ydata-profiling unavailable
- Vector DB   : ChromaDB persistent (`approved_transforms` policy memory)
- Sandbox     : multiprocessing exec() — handled in FastAPI /approve endpoint

Graph Topology (v3 — multimodal entry + healing back-edge)
-----------------------------------------------------------
  START ──(audio_path valid file?)──→ audio_preprocessing ──┐
    └──────────────────────────────→ discovery ────────────┤
                                                              ↓
                    transform ←──────────────────────────────┘
                          ↓  (HITL interrupt)
                      healing ──(reject, iter<3)──→ transform
                          ↓  (approve OR max iters)
                    orchestrator → END

Checkpointing: SQLite (`checkpoints.db`) via SqliteSaver (persistent per thread_id).

Neuro-symbolic (optional): `backend/models/*.pkl` — data-quality label on discovery metadata;
error-classifier context string built in `healing_node` for the corrective Gemini prompt in `transform_node`.
Multimodal audio: optional `audio_path` → MFCC + `audio_classifier_model.pkl` + lazy Whisper `base` → `audio_transcript` in `input_data` JSON for Gemini.
"""

from __future__ import annotations

import ast
import json
import logging
import math
import os
import re
import sqlite3
import time
import uuid
from typing import TypedDict

try:
    from typing import NotRequired
except ImportError:  # Python < 3.11
    from typing_extensions import NotRequired  # type: ignore[misc]

import joblib
import numpy as np
import pandas as pd
from dotenv import load_dotenv
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

try:
    import librosa
except ImportError:  # pragma: no cover — optional until deps installed
    librosa = None  # type: ignore[assignment,misc]

try:
    import whisper
except ImportError:  # pragma: no cover
    whisper = None  # type: ignore[assignment,misc]

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

# ---------------------------------------------------------------------------
# Neuro-symbolic: local sklearn/joblib models (optional — safe if missing)
# ---------------------------------------------------------------------------
_MODELS_DIR = os.path.join(_BACKEND_DIR, "models")
_DATA_QUALITY_MODEL_PATH = os.path.join(_MODELS_DIR, "data_quality_model.pkl")
_ERROR_CLASSIFIER_MODEL_PATH = os.path.join(_MODELS_DIR, "error_classifier_model.pkl")
_AUDIO_CLASSIFIER_MODEL_PATH = os.path.join(_MODELS_DIR, "audio_classifier_model.pkl")

data_quality_model = None
error_classifier_model = None
audio_classifier_model = None
# Lazy OpenAI Whisper (`base`); set on first successful load (see `_lazy_load_whisper_model`).
whisper_model = None  # type: ignore[assignment]

try:
    if os.path.isfile(_DATA_QUALITY_MODEL_PATH):
        data_quality_model = joblib.load(_DATA_QUALITY_MODEL_PATH)
        logger.info("[NeuroSymbolic] Loaded data_quality_model from %s", _DATA_QUALITY_MODEL_PATH)
    else:
        logger.info(
            "[NeuroSymbolic] data_quality_model.pkl not found at %s — skipping.",
            _DATA_QUALITY_MODEL_PATH,
        )
except Exception as exc:
    data_quality_model = None
    logger.warning(
        "[NeuroSymbolic] Failed to load data_quality_model: %s",
        exc,
        exc_info=True,
    )

try:
    if os.path.isfile(_ERROR_CLASSIFIER_MODEL_PATH):
        error_classifier_model = joblib.load(_ERROR_CLASSIFIER_MODEL_PATH)
        logger.info(
            "[NeuroSymbolic] Loaded error_classifier_model from %s",
            _ERROR_CLASSIFIER_MODEL_PATH,
        )
    else:
        logger.info(
            "[NeuroSymbolic] error_classifier_model.pkl not found at %s — skipping.",
            _ERROR_CLASSIFIER_MODEL_PATH,
        )
except Exception as exc:
    error_classifier_model = None
    logger.warning(
        "[NeuroSymbolic] Failed to load error_classifier_model: %s",
        exc,
        exc_info=True,
    )

try:
    if os.path.isfile(_AUDIO_CLASSIFIER_MODEL_PATH):
        audio_classifier_model = joblib.load(_AUDIO_CLASSIFIER_MODEL_PATH)
        logger.info(
            "[Audio] Loaded audio_classifier_model from %s",
            _AUDIO_CLASSIFIER_MODEL_PATH,
        )
    else:
        logger.info(
            "[Audio] audio_classifier_model.pkl not found at %s — skipping.",
            _AUDIO_CLASSIFIER_MODEL_PATH,
        )
except Exception as exc:
    audio_classifier_model = None
    logger.warning(
        "[Audio] Failed to load audio_classifier_model: %s",
        exc,
        exc_info=True,
    )


def _lazy_load_whisper_model():
    """Load Whisper `base` once; failures leave `whisper_model` as None."""
    global whisper_model
    if whisper_model is not None:
        return whisper_model
    if whisper is None:
        logger.warning("[Audio] `whisper` package not available — install openai-whisper.")
        return None
    try:
        whisper_model = whisper.load_model("base")  # type: ignore[union-attr]
        logger.info("[Audio] Whisper `base` model loaded.")
    except Exception as exc:
        logger.warning("[Audio] Whisper load failed: %s", exc, exc_info=True)
        whisper_model = None
    return whisper_model


# ChromaDB policy memory (persistent RLHF / approved transforms)
_CHROMA_DB_PATH = os.path.join(_BACKEND_DIR, "chroma_db")
_APPROVED_TRANSFORMS_COLLECTION = "approved_transforms"
_chroma_persistent_client = None


def _get_chroma_persistent_client():
    """Lazy singleton PersistentClient under backend/chroma_db/."""
    global _chroma_persistent_client
    if _chroma_persistent_client is None:
        try:
            import chromadb  # type: ignore

            os.makedirs(_CHROMA_DB_PATH, exist_ok=True)
            _chroma_persistent_client = chromadb.PersistentClient(path=_CHROMA_DB_PATH)
            logger.info(
                "[ChromaDB] Persistent client ready at %s",
                os.path.abspath(_CHROMA_DB_PATH),
            )
        except Exception as exc:
            logger.error("[ChromaDB] Failed to init client: %s", exc, exc_info=True)
            raise
    return _chroma_persistent_client


def _get_approved_transforms_collection():
    """Collection: document = schema/metadata JSON; metadata holds approved code + timestamp."""
    client = _get_chroma_persistent_client()
    return client.get_or_create_collection(
        name=_APPROVED_TRANSFORMS_COLLECTION,
        metadata={"description": "Human-approved transform snippets keyed by dataset schema"},
    )


def _retrieve_similar_approved_code(metadata_json: str) -> str | None:
    """RAG: similarity search on stored schema profiles; returns approved code from metadata."""
    if not (metadata_json or "").strip():
        logger.info("[Transform/RAG] Empty input_data — skipping retrieval.")
        return None
    try:
        collection = _get_approved_transforms_collection()
        try:
            n_docs = collection.count()
        except Exception as cnt_exc:
            logger.warning("[Transform/RAG] count() failed: %s", cnt_exc)
            n_docs = 0
        if n_docs == 0:
            logger.info("[Transform/RAG] Collection empty — no few-shot injection.")
            return None

        result = collection.query(query_texts=[metadata_json], n_results=1)
        metas_nested = result.get("metadatas") if isinstance(result, dict) else None
        if not metas_nested or not isinstance(metas_nested[0], list):
            logger.info("[Transform/RAG] No metadata in query result.")
            return None
        meta0 = metas_nested[0][0] if metas_nested[0] else None
        if not isinstance(meta0, dict):
            return None
        code = meta0.get("approved_code")
        if code is None:
            return None
        snippet = str(code).strip()
        if not snippet:
            logger.info("[Transform/RAG] Hit had empty approved_code metadata.")
            return None
        logger.info("[Transform/RAG] Retrieved similar approved snippet (%d chars)", len(snippet))
        return snippet
    except Exception as exc:
        logger.warning("[Transform/RAG] Retrieval skipped: %s", exc, exc_info=True)
        return None

# Gemini prompt budget — compact profile JSON only (no raw ProfileReport HTML/JSON)
_MAX_METADATA_BYTES = 6000


def _derive_cleaned_path(csv_path: str) -> str:
    """Derive cleaned CSV next to the source file (same directory as INPUT).

    Examples:
      .../data/sales.csv           →  .../data/cleaned_sales.csv
      .../temp_data/upload.csv     →  .../temp_data/cleaned_upload.csv
    """
    abs_csv = os.path.abspath(csv_path)
    parent = os.path.dirname(abs_csv)
    basename = os.path.basename(abs_csv)
    name, ext = os.path.splitext(basename)
    return os.path.join(parent, f"cleaned_{name}{ext}")


# ---------------------------------------------------------------------------
# Lazy Gemini Client
# ---------------------------------------------------------------------------
_gemini_model = None

TRANSFORM_CODE_FALLBACK = """def transform_data(df):
    \"\"\"Fallback when Gemini is unavailable — hygiene + imputation; returns DataFrame.\"\"\"
    df = df.copy()
    df.drop_duplicates(inplace=True)
    for _col in list(df.select_dtypes(include=["number"]).columns):
        if not df[_col].isna().any():
            continue
        _med = df[_col].median()
        if pd.notna(_med):
            df[_col] = df[_col].fillna(_med)
            continue
        _mean = df[_col].mean()
        if pd.notna(_mean):
            df[_col] = df[_col].fillna(_mean)
            continue
        df.drop(columns=[_col], inplace=True)
    for _col in df.select_dtypes(include=["object", "string"]).columns:
        df[_col] = df[_col].fillna("")
    df.dropna(how="all", inplace=True)
    print(f"Fallback transform_data: {len(df)} rows")
    return df
"""


def _strip_llm_code_fences(text: str) -> str:
    """Remove common markdown code fences from model output."""
    t = (text or "").strip()
    if not t:
        return t
    t = re.sub(r"^\s*```(?:python|py)?\s*\r?\n?", "", t, count=1, flags=re.IGNORECASE)
    t = re.sub(r"\r?\n?\s*```\s*$", "", t, count=1)
    return t.strip()


def _extract_transform_data_function(source: str) -> str:
    """Keep only `def transform_data(df): ...` when possible; drop prose / extra cells."""
    body = _strip_llm_code_fences(source).strip()
    if not body:
        return body
    try:
        tree = ast.parse(body)
        for node in tree.body:
            if isinstance(node, ast.FunctionDef) and node.name == "transform_data":
                seg = ast.get_source_segment(body, node)
                if seg:
                    return seg.strip()
    except SyntaxError:
        logger.debug("[Transform] ast.parse failed; falling back to regex slice.")

    m = re.search(
        r"(?ms)^def\s+transform_data\s*\(\s*df\s*\)\s*:.*",
        body,
    )
    if m:
        return m.group(0).strip()
    return body


_GEMINI_TRANSFORM_RULES = """OUTPUT CONTRACT — VIOLATION OF ANY RULE INVALIDATES YOUR ANSWER:

1. SINGLE TOP-LEVEL FUNCTION ONLY: Output exactly ONE Python function, named precisely `transform_data`, with signature `def transform_data(df):` (single argument `df`). Do NOT output a flat script, module boilerplate, or multiple definitions at module level except this one function.
2. NO IMPORTS: Do NOT write `import`, `from ... import`, or `__import__`. The runtime already provides `pd` (pandas) and `np` (numpy) in global scope inside your execution environment.
3. NO I/O: Do NOT call `pd.read_csv`, `pd.read_table`, `to_csv`, `open()`, or any file/path/API reads or writes. Only mutate the passed-in `df` (prefer `df = df.copy()` first if you avoid inplace ops) and `return df` at the end.
4. NO SAMPLING THE INPUT: Do NOT use `.head()`, `.tail()`, `.sample()`, `nrows=`, or otherwise discard rows to approximate the full dataset. Transform every row of `df`.
5. HYGIENE: Include sensible cleaning (e.g. dedupe, typed fills). NEVER blindly `fillna(0)` on numeric columns unless the schema clearly warrants it; prefer median/mean or drop when justified.
6. RETURN VALUE: Always `return df` with `df` a pandas DataFrame.
7. PURE CODE ONLY: Output ONLY the Python function — NO markdown fences, NO backticks, NO explanations before or after the code."""


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
# Neuro-symbolic helpers (data quality features + error classification)
# ---------------------------------------------------------------------------

def _per_column_quality_metrics(df: pd.DataFrame) -> dict[str, dict[str, float]]:
    """Per-column null_pct, unique_pct, and skewness (numeric columns only; else 0)."""
    n = int(len(df))
    if n <= 0:
        return {}
    out: dict[str, dict[str, float]] = {}
    for col in df.columns:
        key = str(col)
        s = df[col]
        null_pct = float(s.isna().sum() / n * 100.0)
        n_unique = int(s.nunique(dropna=True))
        unique_pct = float(n_unique / n * 100.0)
        skewness = 0.0
        if pd.api.types.is_numeric_dtype(s):
            clean = s.dropna()
            if len(clean) >= 3:
                try:
                    sk = float(clean.skew())
                    skewness = sk if math.isfinite(sk) else 0.0
                except Exception:
                    skewness = 0.0
        out[key] = {
            "null_pct":    round(null_pct, 4),
            "unique_pct":  round(unique_pct, 4),
            "skewness":    round(skewness, 4),
        }
    return out


def _aggregate_dq_features_for_model(per_col: dict[str, dict[str, float]]) -> tuple[float, float, float]:
    """Single-row vector (mean null %, mean unique %, mean skewness) for tabular DQ models."""
    if not per_col:
        return 0.0, 0.0, 0.0
    nulls = [v["null_pct"] for v in per_col.values()]
    uniqs = [v["unique_pct"] for v in per_col.values()]
    skews = [v["skewness"] for v in per_col.values()]
    return (
        float(sum(nulls) / len(nulls)),
        float(sum(uniqs) / len(uniqs)),
        float(sum(skews) / len(skews)),
    )


def _predict_data_quality_label(vec3: tuple[float, float, float]) -> str | None:
    """Predict dataset-level quality label from (null_pct, unique_pct, skewness) aggregates."""
    if data_quality_model is None:
        return None
    try:
        import numpy as np

        X = np.asarray([vec3], dtype=np.float64)
        pred = data_quality_model.predict(X)
        raw = pred[0] if getattr(pred, "__len__", None) else pred
        lab = str(raw).strip()
        return lab or None
    except Exception as exc:
        logger.warning("[NeuroSymbolic] data_quality_model.predict failed: %s", exc, exc_info=True)
        return None


def _inject_neuro_symbolic_data_quality(df: pd.DataFrame, metadata_json: str) -> str:
    """Enrich profile JSON with per-column null_pct / unique_pct / skewness and optional ML label."""
    per_col = _per_column_quality_metrics(df)
    try:
        meta = json.loads(metadata_json)
    except json.JSONDecodeError:
        return metadata_json
    if not isinstance(meta, dict) or meta.get("error"):
        return metadata_json
    cols = meta.get("columns")
    if not isinstance(cols, list):
        return metadata_json
    for entry in cols:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if name is None:
            continue
        m = per_col.get(str(name))
        if m:
            entry["null_pct"] = m["null_pct"]
            entry["unique_pct"] = m["unique_pct"]
            entry["skewness"] = m["skewness"]
    f1, f2, f3 = _aggregate_dq_features_for_model(per_col)
    label = _predict_data_quality_label((f1, f2, f3))
    if label is not None:
        meta["predicted_data_quality_label"] = label
    return _cap_metadata_dict_to_str(meta)


def _extract_traceback_from_feedback(text: str) -> str:
    """If the user pasted a Python traceback into rejection text, return that segment."""
    t = (text or "").strip()
    if not t:
        return ""
    marker = "Traceback (most recent call last):"
    if marker in t:
        idx = t.index(marker)
        return t[idx:].strip()[:16000]
    return ""


def _traceback_for_error_classifier(state: PipelineState, rejection_text: str) -> str:
    """Prefer explicit state.traceback (e.g. injected by API), else parsed / raw feedback."""
    tb = (state.get("traceback") or "").strip()
    if tb:
        return tb[:16000]
    ex = _extract_traceback_from_feedback(rejection_text)
    if ex:
        return ex
    return (rejection_text or "").strip()[:16000]


def _predict_error_category_from_traceback(tb: str) -> str:
    """Classify error from traceback or short error string (sklearn text pipeline)."""
    if error_classifier_model is None:
        return ""
    text = (tb or "").strip()
    if not text:
        return ""
    try:
        pred = error_classifier_model.predict([text])
    except Exception:
        try:
            import numpy as np

            pred = error_classifier_model.predict(np.array([text], dtype=object))
        except Exception as exc:
            logger.warning("[NeuroSymbolic] error_classifier_model.predict failed: %s", exc, exc_info=True)
            return ""
    try:
        import numpy as np

        flat = np.asarray(pred).reshape(-1)
        raw = flat[0] if flat.size else ""
        return str(raw).strip()
    except Exception:
        return ""


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
    human_feedback:     str   # Latest HITL decision: "Approve" | "Reject: <text>"
    rejection_feedback: str   # Extracted text from the last rejection
    healing_iterations: int   # Reject loop counter (capped at MAX_HEALING_ITERATIONS)
    traceback:          NotRequired[str]  # Optional sandbox / exec traceback for ML routing
    # Corrective Gemini prompt fragment (built in healing_node when ML + traceback available)
    healing_llm_error_context: NotRequired[str]
    # Multimodal audio (optional): set `audio_path` to an existing file to enter the audio branch
    audio_path:         NotRequired[str]
    audio_transcript: NotRequired[str]


def _route_multimodal_entry(state: PipelineState) -> str:
    """Entry router: valid `audio_path` → audio preprocessing; otherwise CSV discovery."""
    raw = (state.get("audio_path") or "").strip()
    if not raw:
        return "discovery"
    path = os.path.abspath(raw)
    if os.path.isfile(path):
        logger.info("[Router] Entry → audio_preprocessing (%s)", os.path.basename(path))
        return "audio_preprocessing"
    logger.warning(
        "[Router] audio_path is not a readable file (%s) — falling back to discovery.",
        path,
    )
    return "discovery"


def _is_speech_like_audio_class(pred: str) -> bool:
    """Heuristic match for positive speech classes (e.g. Speech/Human) vs noise/music labels."""
    s = (pred or "").strip().lower()
    if not s:
        return False
    if any(x in s for x in ("non-speech", "non_speech", "noise", "music", "ambient", "silence")):
        return False
    if any(x in s for x in ("speech", "human", "voice", "spoken")):
        return True
    if s in ("1", "true", "yes", "pos", "positive"):
        return True
    return False


def _build_audio_input_data_json(
    *,
    audio_path: str,
    prediction: str | None,
    transcript: str,
    notes: list[str],
    error: str | None,
) -> str:
    """JSON for Gemini / Chroma: transcript + classifier metadata, capped to `_MAX_METADATA_BYTES`."""

    def _byte_len(s: str) -> int:
        return len(s.encode("utf-8"))

    payload: dict = {
        "modality": "audio",
        "audio_path": os.path.basename(audio_path),
        "audio_classifier_prediction": prediction,
        "audio_transcript": transcript,
        "notes": notes,
    }
    if error:
        payload["error"] = error

    t = transcript
    while True:
        payload["audio_transcript"] = t
        raw = json.dumps(payload, indent=2)
        if _byte_len(raw) <= _MAX_METADATA_BYTES:
            return raw
        if len(t) <= 64:
            return json.dumps(
                {
                    "modality": "audio",
                    "audio_path": os.path.basename(audio_path),
                    "audio_classifier_prediction": prediction,
                    "notes": notes,
                    "error": error or "audio_metadata_truncated",
                    "audio_transcript": (t[:512] + "…") if t else "",
                },
                separators=(",", ":"),
            )
        t = t[: max(64, len(t) * 3 // 4)]


# ---------------------------------------------------------------------------
# Node 0 — Audio preprocessing (MFCC + classifier + optional Whisper)
# ---------------------------------------------------------------------------

def audio_preprocessing_node(state: PipelineState) -> PipelineState:
    """Load audio, extract MFCC means, classify; transcribe with Whisper when speech-like."""
    audio_path = (state.get("audio_path") or "").strip()
    notes: list[str] = []
    prediction: str | None = None
    transcript = ""
    err: str | None = None
    status = "Audio Preprocessing Complete"

    if not audio_path:
        err = "missing_audio_path"
        status = "Audio preprocessing skipped (no path)."
        meta = _build_audio_input_data_json(
            audio_path="",
            prediction=None,
            transcript="",
            notes=notes + [err],
            error=err,
        )
        return {
            **state,
            "audio_transcript": "",
            "input_data":         meta,
            "status":             status,
            "generated_code":     "",
            "edited_code":        "",
            "human_feedback":     "",
            "rejection_feedback": "",
            "healing_iterations": 0,
            "traceback":                "",
            "healing_llm_error_context": "",
        }

    abs_audio = os.path.abspath(audio_path)
    if not os.path.isfile(abs_audio):
        err = "invalid_audio_path"
        notes.append(f"Not a file: {abs_audio}")
        status = "Audio preprocessing failed (invalid path)."
        meta = _build_audio_input_data_json(
            audio_path=abs_audio,
            prediction=None,
            transcript="",
            notes=notes,
            error=err,
        )
        return {
            **state,
            "audio_transcript": "",
            "input_data":         meta,
            "status":             status,
            "generated_code":     "",
            "edited_code":        "",
            "human_feedback":     "",
            "rejection_feedback": "",
            "healing_iterations": 0,
            "traceback":                "",
            "healing_llm_error_context": "",
        }

    try:
        if librosa is None:
            raise RuntimeError("librosa is not installed (required for MFCC extraction).")

        y, sr = librosa.load(abs_audio, sr=22050)
        mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
        features = np.mean(mfcc, axis=1)
        if features.shape[0] != 13:
            notes.append(f"unexpected_mfcc_shape_{features.shape!r}")

        if audio_classifier_model is not None:
            try:
                X = np.asarray(features, dtype=np.float64).reshape(1, -1)
                pred_arr = audio_classifier_model.predict(X)
                flat = np.asarray(pred_arr).reshape(-1)
                prediction = str(flat[0]).strip() if flat.size else None
                logger.info("[Audio] Classifier prediction: %s", prediction)
            except Exception as clf_exc:
                logger.warning("[Audio] Classifier predict failed: %s", clf_exc, exc_info=True)
                notes.append(f"classifier_error: {clf_exc}")
                prediction = None
        else:
            notes.append("audio_classifier_model_unavailable")

        speech_like = _is_speech_like_audio_class(prediction or "")

        if speech_like:
            wm = _lazy_load_whisper_model()
            if wm is not None:
                try:
                    result = wm.transcribe(abs_audio)
                    if isinstance(result, dict):
                        transcript = (result.get("text") or "").strip()
                    else:
                        transcript = str(result).strip()
                    logger.info("[Audio] Whisper transcript length=%d", len(transcript))
                except Exception as w_exc:
                    logger.warning("[Audio] Whisper transcribe failed: %s", w_exc, exc_info=True)
                    notes.append(f"whisper_error: {w_exc}")
            else:
                notes.append("whisper_model_unavailable")
        else:
            if prediction:
                notes.append("non_speech_like_class_skipping_whisper")
            else:
                notes.append("no_classifier_prediction_skipping_whisper")

    except Exception as exc:
        logger.error("[Audio] Preprocessing failed: %s", exc, exc_info=True)
        err = str(exc)
        status = "Audio preprocessing degraded (see input_data.error)."
        notes.append(f"preprocessing_exception: {exc}")

    meta = _build_audio_input_data_json(
        audio_path=abs_audio,
        prediction=prediction,
        transcript=transcript,
        notes=notes,
        error=err,
    )

    return {
        **state,
        "audio_transcript": transcript,
        "input_data":         meta,
        "status":             status,
        "generated_code":     "",
        "edited_code":        "",
        "human_feedback":     "",
        "rejection_feedback": "",
        "healing_iterations": 0,
        "traceback":                "",
        "healing_llm_error_context": "",
    }


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
        metadata_json = _inject_neuro_symbolic_data_quality(df, metadata_json)
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
        "traceback":                "",
        "healing_llm_error_context": "",
        "audio_transcript":         "",
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
    healing_llm_error_ctx = (state.get("healing_llm_error_context") or "").strip()

    audio_modality_preamble = ""
    try:
        _parsed = json.loads(metadata_json or "{}")
        if isinstance(_parsed, dict) and _parsed.get("modality") == "audio":
            audio_modality_preamble = (
                "MULTIMODAL CONTEXT: The profile JSON describes an AUDIO input (`audio_transcript`, classifier output). "
                "Generate `transform_data(df)` that is sensible for downstream use of that transcript/metadata "
                "together with the usual pandas hygiene rules.\n\n"
            )
    except Exception:
        pass

    logger.info(
        "[Transform] Generating code via Gemini (iter=%d, corrective=%s)",
        healing_iterations, bool(rejection_feedback),
    )
    logger.info("[Transform] Sandbox paths INPUT_CSV=%s OUTPUT_CSV=%s", csv_path, cleaned_path)

    retrieved_code = _retrieve_similar_approved_code(metadata_json)
    few_shot_block = ""
    if retrieved_code:
        few_shot_block = (
            "Here is a highly rated, human-approved snippet for a similar dataset schema:\n"
            f"{retrieved_code}\n"
            "Adapt its logic into ONE function only: `def transform_data(df):` — no imports, no CSV I/O, "
            "only in-memory `df` work and `return df`. If the snippet uses flat scripts or file I/O, rewrite it.\n\n"
        )
        logger.info("[Transform] Few-shot block attached from policy memory.")

    critical_reject = ""
    if rejection_feedback:
        critical_reject = (
            "CRITICAL: Your previous code was rejected. "
            f"Human Feedback: {rejection_feedback}. "
            "You MUST fix this in your new code.\n\n"
        )

    if rejection_feedback:
        # ── Corrective prompt ──────────────────────────────────────────
        prompt = (
            "You are an expert Data Engineer Python Agent. Implement transformations using pandas/numpy "
            "according to reviewer feedback and the schema profile.\n\n"
            f"{audio_modality_preamble}"
            f"{few_shot_block}"
            f"{critical_reject}"
            f"{healing_llm_error_ctx}"
            f"{_GEMINI_TRANSFORM_RULES}\n\n"
            f"REJECTION FEEDBACK: \"{rejection_feedback}\"\n\n"
            "Dataset metadata profile (JSON):\n"
            f"{metadata_json}\n\n"
            "Produce a CORRECTED `transform_data(df)` that applies hygiene first, then fixes the feedback "
            "for this schema. You may use `print(...)` inside the function for a one-line row-count summary.\n"
        )
    else:
        # ── First-run prompt ───────────────────────────────────────────
        prompt = (
            "You are an expert Data Engineer Python Agent. Implement cleaning and transformations with pandas/numpy "
            "for the dataset described below.\n\n"
            f"{audio_modality_preamble}"
            f"{few_shot_block}"
            f"{_GEMINI_TRANSFORM_RULES}\n\n"
            "Dataset metadata profile (JSON):\n"
            f"{metadata_json}\n\n"
            "After hygiene, apply at least three meaningful transformations suited to this schema "
            "(e.g. parse dates, coerce numerics, standardize strings, handle outliers).\n"
            "Output only `def transform_data(df):` as specified; you may `print` a one-line row-count summary inside it.\n"
        )

    generated_code = TRANSFORM_CODE_FALLBACK
    try:
        model = _get_gemini()
        response = model.generate_content(prompt)
        raw = (response.text or "").strip()
        normalized = _extract_transform_data_function(raw)
        valid_fn = bool(
            normalized
            and re.search(r"^\s*def\s+transform_data\s*\(\s*df\s*\)\s*:", normalized, re.MULTILINE)
        )
        if valid_fn:
            generated_code = normalized
            logger.info("[Transform] Gemini code normalized (%d chars)", len(generated_code))
        else:
            if raw:
                logger.warning(
                    "[Transform] Model output missing valid `def transform_data(df):` — using fallback."
                )
            else:
                logger.warning("[Transform] Gemini returned empty — using fallback.")

    except Exception as exc:
        logger.error("[Transform] Gemini error: %s", exc, exc_info=True)
        generated_code = TRANSFORM_CODE_FALLBACK

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
        "action_required":  "Resume with 'Approve' or 'Reject: <feedback>'. Code must define transform_data(df) only.",
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
        # Extract user's textual feedback from "Reject: <message>"
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
                "healing_llm_error_context": "",
                "status": (
                    f"Max healing attempts ({MAX_HEALING_ITERATIONS}) reached. "
                    "Using last generated code."
                ),
            }

        tb_for_ml = _traceback_for_error_classifier(state, rejection_text)
        err_cat = _predict_error_category_from_traceback(tb_for_ml)
        healing_llm_error_context = ""
        if err_cat:
            print(
                f"\n\033[1;95m🧠 [NEURO-SYMBOLIC ML ACTIVATED] Error Classified as: {err_cat}\033[0m\n"
            )
            logger.info("[Healing] error_classifier predicted: %s", err_cat[:120])
            healing_llm_error_context = (
                "Neuro-symbolic error classification (local ML model on traceback / error text):\n"
                f"Predicted error category: {err_cat}\n"
                "Treat this label as a strong prior about the failure mode when revising the code.\n\n"
            )

        return {
            **state,
            "rejection_feedback":  rejection_text,
            "healing_iterations":  new_iterations,
            "status":              f"Healing: Re-generating code (attempt {new_iterations}/{MAX_HEALING_ITERATIONS})",
            "generated_code":      "",
            "edited_code":         "",
            "human_feedback":      feedback,  # preserve for _should_loop_back routing
            "healing_llm_error_context": healing_llm_error_context,
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
        "healing_llm_error_context": "",
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
    """Persist approved transform policy to ChromaDB (`approved_transforms`).

    Document body = dataset metadata JSON (`input_data`); metadata holds the
    approved/edited code and a UNIX timestamp. Code execution is done in FastAPI
    `/approve` before this node runs.
    """
    feedback = (state.get("human_feedback") or "").strip().lower()
    logger.info("[Orchestrator] Processing — human_feedback prefix: %s", feedback[:48])

    if feedback.startswith("reject"):
        # Max iterations hit — record as rejected
        return {
            **state,
            "status": (
                f"Pipeline Rejected after {state.get('healing_iterations', 0)} "
                "healing attempts. Please restart and provide clearer instructions."
            ),
        }

    # ── Approved → persist schema + code to ChromaDB ─────────────────
    schema_doc = (state.get("input_data") or "").strip()
    code_body = (state.get("edited_code") or state.get("generated_code") or "").strip()
    csv_path = state.get("active_csv_path") or CSV_PATH
    cleaned_path = _derive_cleaned_path(csv_path)
    csv_ready = os.path.isfile(cleaned_path)

    if not schema_doc:
        logger.warning("[Orchestrator] Missing input_data — skipping Chroma persist.")
        return {
            **state,
            "status": (
                f"Pipeline Complete. {os.path.basename(cleaned_path)} "
                f"{'ready ✓' if csv_ready else 'pending ✗'}."
            ),
        }

    if not code_body:
        logger.warning("[Orchestrator] No code to persist (edited/generated empty) — skipping Chroma add.")
        return {
            **state,
            "status": (
                f"Pipeline Complete. {os.path.basename(cleaned_path)} "
                f"{'ready ✓' if csv_ready else 'pending ✗'}."
            ),
        }

    ts = str(int(time.time()))
    entry_id = f"approved_{uuid.uuid4().hex}"

    try:
        collection = _get_approved_transforms_collection()
        collection.add(
            ids=[entry_id],
            documents=[schema_doc],
            metadatas=[{
                "approved_code":   code_body,
                "timestamp":       ts,
                "source_file":     os.path.basename(csv_path),
                "human_feedback":  state.get("human_feedback") or "",
                "healing_iters":   str(state.get("healing_iterations", 0)),
            }],
        )
        doc_count = collection.count()
        status_msg = (
            f"Pipeline Complete. {os.path.basename(cleaned_path)} "
            f"{'ready ✓' if csv_ready else 'pending ✗'}. "
            f"ChromaDB `{_APPROVED_TRANSFORMS_COLLECTION}`: {doc_count} entries."
        )
        logger.info(
            "[Orchestrator] Saved approved transform id=%s ts=%s (collection_size=%d)",
            entry_id,
            ts,
            doc_count,
        )
        return {**state, "status": status_msg}

    except Exception as exc:
        logger.error("[Orchestrator] ChromaDB persist failed: %s", exc, exc_info=True)
        return {
            **state,
            "status": (
                f"Pipeline Complete. {os.path.basename(cleaned_path)} "
                f"{'ready ✓' if csv_ready else 'pending ✗'} "
                f"(ChromaDB error: {exc})."
            ),
        }


# ---------------------------------------------------------------------------
# Graph Construction
# ---------------------------------------------------------------------------

def build_graph() -> StateGraph:
    """Compile the LAM-ADEP v3 pipeline graph.

    Topology:
      START → audio_preprocessing | discovery → transform (HITL interrupt)
                                                    ↓
                        healing ──(reject, iter ≤ MAX)──→ transform
                                ↓    (approve OR iter > MAX)
                          orchestrator → END
    """
    builder = StateGraph(PipelineState)

    builder.add_node("audio_preprocessing", audio_preprocessing_node)
    builder.add_node("discovery",    discovery_node)
    builder.add_node("transform",    transform_node)
    builder.add_node("healing",      healing_node)
    builder.add_node("orchestrator", orchestrator_node)

    builder.add_conditional_edges(
        START,
        _route_multimodal_entry,
        {
            "audio_preprocessing": "audio_preprocessing",
            "discovery":           "discovery",
        },
    )
    builder.add_edge("audio_preprocessing", "transform")
    builder.add_edge("discovery",    "transform")
    builder.add_edge("transform",    "healing")

    builder.add_conditional_edges(
        "healing",
        _should_loop_back,
        {"transform": "transform", "orchestrator": "orchestrator"},
    )
    builder.add_edge("orchestrator", END)

    checkpoint_path = os.path.join(_BACKEND_DIR, "checkpoints.db")
    try:
        conn = sqlite3.connect(checkpoint_path, check_same_thread=False)
        checkpointer = SqliteSaver(conn)
        logger.info(
            "[Checkpoint] SqliteSaver attached (%s)",
            os.path.abspath(checkpoint_path),
        )
    except Exception as exc:
        logger.error(
            "[Checkpoint] Failed to open %s: %s",
            checkpoint_path,
            exc,
            exc_info=True,
        )
        raise

    compiled = builder.compile(checkpointer=checkpointer)
    logger.info(
        "Pipeline graph compiled v3 (multimodal audio entry, healing loop, ydata-profiling, dynamic CSV)."
    )
    return compiled
