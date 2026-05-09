"""
LAM-ADEP FastAPI Server v3 — /upload /reject /memory + Dynamic CSV Paths
"""
from __future__ import annotations

import io, logging, multiprocessing, os, queue, time, traceback, uuid
from contextlib import asynccontextmanager
from typing import Any, Optional

import pandas as pd
from dotenv import load_dotenv
from fastapi import FastAPI, Request, UploadFile, File
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from langgraph.types import Command
from pydantic import BaseModel, Field

# ── Bootstrap ───────────────────────────────────────────────────────────────
_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
_ENV_PATH    = os.path.join(_BACKEND_DIR, ".env")
load_dotenv(dotenv_path=_ENV_PATH, override=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
)
logger = logging.getLogger("lam_adep.api")

from agent_graph import (  # noqa: E402
    PipelineState, build_graph,
    CSV_PATH, _DATA_DIR, _derive_cleaned_path,
    MAX_HEALING_ITERATIONS,
)

# ── Multiprocessing Sandbox ──────────────────────────────────────────────────

def _sandbox_worker(
    code: str, csv_path: str, cleaned_path: str,
    result_queue: multiprocessing.Queue,
) -> None:
    import sys
    stdout_buf, stderr_buf = io.StringIO(), io.StringIO()
    try:
        for old, new in [
            ("backend/data/supermarket_sales.csv", csv_path),
            ("backend/data/cleaned_sales.csv",     cleaned_path),
            ("data/supermarket_sales.csv",          csv_path),
            ("data/cleaned_sales.csv",              cleaned_path),
            ("supermarket_sales.csv",               csv_path),
            ("cleaned_sales.csv",                   cleaned_path),
        ]:
            code = code.replace(old, new)

        sys.stdout, sys.stderr = stdout_buf, stderr_buf
        exec(compile(code, "<sandbox>", "exec"),  # noqa: S102
             {
                 "__builtins__": __builtins__,
                 "CSV_PATH": csv_path,
                 "CLEANED_PATH": cleaned_path,
                 "INPUT_CSV": csv_path,
                 "OUTPUT_CSV": cleaned_path,
             })
        sys.stdout, sys.stderr = sys.__stdout__, sys.__stderr__
        result_queue.put({"success": True, "stdout": stdout_buf.getvalue(), "stderr": stderr_buf.getvalue()})
    except Exception as exc:
        sys.stdout, sys.stderr = sys.__stdout__, sys.__stderr__
        result_queue.put({
            "success": False, "error": str(exc),
            "traceback": traceback.format_exc(),
            "stdout": stdout_buf.getvalue(), "stderr": stderr_buf.getvalue(),
        })


def run_code_in_sandbox(code: str, csv_path: str, cleaned_path: str, timeout: int = 30) -> dict[str, Any]:
    if not (code and code.strip()):
        return {"success": False, "error": "No code provided."}
    ctx = multiprocessing.get_context("spawn")
    rq: multiprocessing.Queue = ctx.Queue()
    proc = ctx.Process(target=_sandbox_worker, args=(code, csv_path, cleaned_path, rq), daemon=True)
    proc.start()
    proc.join(timeout=timeout)
    if proc.is_alive():
        proc.kill(); proc.join()
        return {"success": False, "error": f"Timed out after {timeout}s.", "stdout": "", "stderr": ""}
    try:
        result = rq.get_nowait()
    except queue.Empty:
        result = {"success": False, "error": "Worker crashed without result.", "stdout": "", "stderr": ""}
    if result.get("success"):
        logger.info("[Sandbox] OK. stdout=%r", (result.get("stdout") or "")[:200])
    else:
        logger.error("[Sandbox] FAIL: %s", result.get("error", "?"))
    return result


# ── Analytics ────────────────────────────────────────────────────────────────


def _first_raw_csv_in_data_dir() -> str | None:
    try:
        for name in sorted(os.listdir(_DATA_DIR)):
            if not name.lower().endswith(".csv"):
                continue
            if name.lower().startswith("cleaned_"):
                continue
            path = os.path.join(_DATA_DIR, name)
            if os.path.isfile(path):
                return path
    except OSError:
        pass
    return None


def resolve_analytics_csv(csv_filename: str | None) -> str | None:
    """Pick a dataset path for /analytics (never assumes a fixed filename)."""
    if csv_filename:
        path = os.path.join(_DATA_DIR, csv_filename)
        return path if os.path.isfile(path) else None
    if _active_csv_path and os.path.isfile(_active_csv_path):
        return _active_csv_path
    sample = _first_raw_csv_in_data_dir()
    if sample:
        return sample
    return None


def compute_analytics(csv_path: str | None = None) -> dict[str, Any]:
    path = csv_path
    if not path:
        path = resolve_analytics_csv(None)
    if not path or not os.path.isfile(path):
        return {
            "success": False, "error": "DATASET_MISSING",
            "message": "No CSV found. Upload via POST /upload or pass csv_filename.",
            "dataset_file": None,
        }
    try:
        df = pd.read_csv(path)
    except Exception as exc:
        return {"success": False, "error": "READ_FAILED", "message": str(exc)}

    row_count = int(len(df))

    def _num(col: str) -> float:
        try:
            return float(pd.to_numeric(df[col], errors="coerce").mean(skipna=True) or 0)
        except Exception:
            return 0.0

    def _sum(col: str) -> float:
        try:
            return float(pd.to_numeric(df[col], errors="coerce").sum(skipna=True) or 0)
        except Exception:
            return 0.0

    avg_unit_price  = _num("Unit price")
    sum_gross       = _sum("gross income")
    sum_total       = _sum("Total")

    daily_sales: list[dict] = []
    try:
        w = df.copy()
        w["_date"]  = pd.to_datetime(w["Date"], errors="coerce") if "Date" in w.columns else pd.NaT
        w["_total"] = pd.to_numeric(w["Total"], errors="coerce") if "Total" in w.columns else 0.0
        w["_gi"]    = pd.to_numeric(w["gross income"], errors="coerce") if "gross income" in w.columns else 0.0
        w["_day"]   = w["_date"].dt.normalize()
        dated = w.dropna(subset=["_date"])
        if not dated.empty:
            daily = (
                dated.groupby("_day", as_index=False)
                .agg(dt=("_total", "sum"), dg=("_gi", "sum"))
                .rename(columns={"_day": "_date"})
                .sort_values("_date").head(10)
            )
            for _, row in daily.iterrows():
                ts = pd.Timestamp(row["_date"])
                daily_sales.append({
                    "date": ts.strftime("%Y-%m-%d"), "label": ts.strftime("%b %d"),
                    "total_sales": round(float(row["dt"]), 2),
                    "gross_income": round(float(row["dg"]), 2),
                })
    except Exception as exc:
        logger.warning("Daily aggregation skipped: %s", exc)

    return {
        "success": True,
        "row_count": row_count,
        "avg_unit_price": round(avg_unit_price, 4),
        "sum_gross_income": round(sum_gross, 2),
        "sum_total_sales": round(sum_total, 2),
        "daily_sales": daily_sales,
        "dataset_file": os.path.basename(path),
    }


def _empty_analytics_payload(note: str | None = None) -> dict[str, Any]:
    """Stable shape when no CSV is available or analytics fails."""
    body: dict[str, Any] = {
        "success": True,
        "row_count": 0,
        "avg_unit_price": 0.0,
        "sum_gross_income": 0.0,
        "sum_total_sales": 0.0,
        "daily_sales": [],
        "dataset_file": None,
    }
    if note:
        body["note"] = note
    return body


def _chroma_seq(val: Any) -> list[Any]:
    if val is None:
        return []
    if isinstance(val, (list, tuple)):
        return list(val)
    return [val]


# ── App Lifespan ─────────────────────────────────────────────────────────────
_compiled_graph = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _compiled_graph
    logger.info("Compiling LangGraph pipeline v3 …")
    _compiled_graph = build_graph()
    logger.info("Server ready.")
    yield
    logger.info("Shutting down.")


app = FastAPI(
    title="LAM-ADEP Pipeline API v3",
    version="3.0.0",
    description="Metadata-First + Healing Loop + Dynamic Upload",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _safe_json(data: dict[str, Any], status_code: int = 200) -> JSONResponse:
    """JSONResponse expects content=…; never pass (status_code, body) positionally."""
    return JSONResponse(content=data, status_code=status_code)


# ── Exception Handlers ────────────────────────────────────────────────────────

@app.exception_handler(RequestValidationError)
async def _val_err(request: Request, exc: RequestValidationError):
    return _safe_json({"success": False, "error": "Validation Error", "detail": exc.errors()})


@app.exception_handler(Exception)
async def _global_err(request: Request, exc: Exception):
    logger.error("Unhandled: %s %s — %s", request.method, request.url.path, exc, exc_info=True)
    return _safe_json({
        "success": False,
        "error": str(exc),
        "detail": traceback.format_exception_only(type(exc), exc)[-1].strip(),
    })


# ── Schemas ───────────────────────────────────────────────────────────────────

class StartRequest(BaseModel):
    input_data:   str = Field(default="sample_data")
    csv_filename: Optional[str] = Field(
        default=None,
        description="Filename of an already-uploaded CSV under backend/data/. "
                    "Leave empty to use the default supermarket_sales.csv.",
    )

class ApproveRequest(BaseModel):
    thread_id:   str
    action:      str
    edited_code: Optional[str] = None

class RejectRequest(BaseModel):
    thread_id: str
    feedback:  str = Field(default="", description="Human reviewer's textual feedback for Gemini.")

class APIResponse(BaseModel):
    success:   bool = True
    thread_id: str  = ""
    state:     dict[str, Any] = {}
    message:   str  = ""
    paused:    bool = False


# ── Helpers ───────────────────────────────────────────────────────────────────

def _to_dict(state) -> dict[str, Any]:
    return dict(state.values) if hasattr(state, "values") else dict(state)

def _cfg(thread_id: str) -> dict:
    return {"configurable": {"thread_id": thread_id}}

_latest_status: dict[str, Any] = {}
_active_csv_path: str | None = CSV_PATH if os.path.isfile(CSV_PATH) else None


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/", tags=["Health"])
async def health():
    return {"success": True, "message": "LAM-ADEP API v3 running."}


@app.get("/status", tags=["Pipeline"])
async def get_status():
    return _latest_status


@app.get("/state/{thread_id}", tags=["Pipeline"])
async def get_thread_state(thread_id: str):
    """Return raw graph checkpoint state for a thread (used by HITL UI hydration)."""
    try:
        config = _cfg(thread_id)
        snapshot = _compiled_graph.get_state(config)
        if not snapshot:
            return _safe_json({"success": False, "error": "THREAD_NOT_FOUND", "state": {}})
        values = _to_dict(snapshot)
        return _safe_json({
            "success": True,
            "thread_id": thread_id,
            "paused": bool(snapshot.next),
            "state": values,
        })
    except Exception as exc:
        logger.warning("[State] failed for thread %s: %s", thread_id, exc, exc_info=True)
        return _safe_json({"success": False, "error": "STATE_READ_FAILED", "state": {}})


@app.post("/upload", tags=["Data"])
async def upload_dataset(file: UploadFile = File(...)):
    """Upload a CSV dataset. Saves to backend/data/<filename>.

    The returned `csv_filename` should be passed to POST /start as
    `csv_filename` so the pipeline processes the uploaded file.
    """
    global _active_csv_path

    if not file.filename or not file.filename.lower().endswith(".csv"):
        return _safe_json({
            "success": False, "error": "Only CSV files are accepted.",
        })

    safe_name = os.path.basename(file.filename)   # strip any path traversal
    dest_path = os.path.join(_DATA_DIR, safe_name)

    try:
        contents = await file.read()
        if len(contents) > 50 * 1024 * 1024:   # 50 MB limit
            return _safe_json({"success": False, "error": "File exceeds 50 MB limit."})

        os.makedirs(_DATA_DIR, exist_ok=True)
        with open(dest_path, "wb") as f:
            f.write(contents)

        # Quick validation — make sure it's a readable CSV
        df_check = pd.read_csv(dest_path, nrows=5)
        _active_csv_path = dest_path

        logger.info("[Upload] Saved %s (%d bytes, %d cols)", safe_name, len(contents), len(df_check.columns))
        return _safe_json({
            "success":      True,
            "csv_filename": safe_name,
            "path":         dest_path,
            "columns":      list(df_check.columns),
            "message":      f"'{safe_name}' uploaded successfully. Pass csv_filename to /start.",
        })

    except Exception as exc:
        logger.error("[Upload] Failed: %s", exc)
        return _safe_json({"success": False, "error": str(exc)})


@app.get("/download", tags=["Pipeline"])
async def download_cleaned(csv_filename: Optional[str] = None):
    if csv_filename:
        stem = os.path.splitext(os.path.basename(csv_filename))[0]
        path = os.path.join(_DATA_DIR, f"cleaned_{stem}.csv")
    elif _active_csv_path:
        path = _derive_cleaned_path(_active_csv_path)
    else:
        path = None

    if not path or not os.path.isfile(path):
        return _safe_json({"success": False, "error": "FILE_NOT_FOUND",
                           "message": "Cleaned CSV not ready yet."})
    return FileResponse(path=path, filename=os.path.basename(path), media_type="text/csv")


@app.get("/analytics", tags=["Analytics"])
async def get_analytics(csv_filename: Optional[str] = None):
    try:
        path = resolve_analytics_csv(csv_filename)
        if not path or not os.path.isfile(path):
            return _safe_json(_empty_analytics_payload("no_csv_uploaded_or_found"))
        payload = compute_analytics(path)
        if payload.get("success") is False:
            return _safe_json(_empty_analytics_payload(str(payload.get("message", ""))))
        return _safe_json(dict(payload))
    except Exception as exc:
        logger.warning("[Analytics] degraded empty response: %s", exc, exc_info=True)
        return _safe_json(_empty_analytics_payload("analytics_error"))


@app.get("/memory", tags=["RLHF"])
async def get_memory():
    """Return approved scripts from ChromaDB; never 500 on empty/missing/invalid store."""
    memory: list[dict[str, Any]] = []
    try:
        import chromadb  # type: ignore

        chroma_dir = os.path.join(_BACKEND_DIR, "chroma_db")
        os.makedirs(chroma_dir, exist_ok=True)
        client     = chromadb.PersistentClient(path=chroma_dir)
        collection = client.get_or_create_collection("rlhf_pipeline_knowledge")
        results    = collection.get(include=["documents", "metadatas"])

        if not isinstance(results, dict):
            return _safe_json({"success": True, "count": 0, "items": [], "memory": []})

        docs  = _chroma_seq(results.get("documents"))
        metas = _chroma_seq(results.get("metadatas"))
        n     = min(len(docs), len(metas))

        for i in range(n):
            try:
                doc_raw, meta_raw = docs[i], metas[i]
                if doc_raw is None and meta_raw is None:
                    continue
                code = doc_raw if isinstance(doc_raw, str) else (
                    "" if doc_raw is None else str(doc_raw)
                )
                if isinstance(meta_raw, dict):
                    meta: dict[str, Any] = dict(meta_raw)
                elif meta_raw is None:
                    meta = {}
                else:
                    meta = {"value": meta_raw}
                memory.append({"code": code, "metadata": meta})
            except Exception:
                continue
    except ModuleNotFoundError:
        logger.warning("[Memory] chromadb not installed; returning empty memory.")
    except Exception as exc:
        logger.warning("[Memory] returning empty memory: %s", exc, exc_info=True)

    return _safe_json({
        "success": True,
        "count":   len(memory),
        "items":   memory,
        "memory":  memory,
    })


@app.post("/start", response_model=APIResponse, tags=["Pipeline"])
async def start_pipeline(body: StartRequest):
    """Start the pipeline. If csv_filename is provided, uses that dataset."""
    global _active_csv_path

    thread_id = str(uuid.uuid4())
    config    = _cfg(thread_id)

    # Resolve CSV path: explicit upload selection > last active > any CSV in data/
    if body.csv_filename:
        safe = os.path.basename(body.csv_filename)
        csv_path = os.path.join(_DATA_DIR, safe)
        if not os.path.isfile(csv_path):
            return APIResponse(
                success=False, thread_id=thread_id,
                message=f"'{safe}' not found in data/. Upload via POST /upload first.",
            )
        _active_csv_path = csv_path
    elif _active_csv_path and os.path.isfile(_active_csv_path):
        csv_path = _active_csv_path
    else:
        fallback = _first_raw_csv_in_data_dir()
        if fallback:
            csv_path = fallback
            _active_csv_path = fallback
        else:
            return APIResponse(
                success=False, thread_id=thread_id,
                message="No dataset available. Upload a CSV via POST /upload and pass csv_filename on /start.",
            )

    logger.info(
        "Starting pipeline — thread %s — CSV: %s",
        thread_id,
        os.path.basename(csv_path),
    )

    initial: PipelineState = {
        "active_csv_path":    csv_path,
        "input_data":         body.input_data,
        "status":             "Initialized",
        "generated_code":     "",
        "edited_code":        "",
        "human_feedback":     "",
        "rejection_feedback": "",
        "healing_iterations": 0,
    }

    _compiled_graph.invoke(initial, config=config)
    snapshot      = _compiled_graph.get_state(config)
    current_state = _to_dict(snapshot)

    global _latest_status
    _latest_status = {
        "status":            "paused_for_approval",
        "current_stage":     "transform",
        "thread_id":         thread_id,
        "message":           "Pipeline paused at HITL gate. Review generated code.",
        "stages_completed":  ["discovery"],
        "generated_code":    current_state.get("generated_code", ""),
        "active_csv":        os.path.basename(csv_path),
        "healing_iterations": 0,
    }

    return APIResponse(
        success=True, thread_id=thread_id, state=current_state,
        message="Pipeline paused. Review and optionally edit the generated code, then Approve.",
        paused=True,
    )


@app.post("/approve", response_model=APIResponse, tags=["Pipeline"])
async def approve_pipeline(body: ApproveRequest):
    """Approve pipeline. Runs sandbox on edited code, then resumes graph."""
    config   = _cfg(body.thread_id)
    snapshot = _compiled_graph.get_state(config)
    if not snapshot or not snapshot.next:
        return APIResponse(success=False, thread_id=body.thread_id,
                           message="No paused pipeline for this thread_id.")

    action_lower  = body.action.strip().lower()
    state_values  = _to_dict(snapshot)
    csv_path = state_values.get("active_csv_path") or (_active_csv_path or "") or CSV_PATH
    if not csv_path or not os.path.isfile(csv_path):
        return APIResponse(
            success=False, thread_id=body.thread_id,
            message="Pipeline state missing active_csv_path — restart the pipeline.",
        )
    cleaned_path  = _derive_cleaned_path(csv_path)
    sandbox_result: dict[str, Any] = {}

    if action_lower == "approve":
        code_to_run = (body.edited_code or "").strip() or state_values.get("generated_code", "")

        logger.info("[Approve] Sandbox start (timeout=30s) …")
        sandbox_result = run_code_in_sandbox(code_to_run, csv_path, cleaned_path, timeout=30)

        if not sandbox_result.get("success"):
            logger.warning("[Approve] Sandbox failed — guaranteed fallback.")
            try:
                df = pd.read_csv(csv_path, low_memory=False)
                df.drop_duplicates(inplace=True)
                if "Date" in df.columns:
                    df["Date"] = pd.to_datetime(df["Date"], errors="coerce")
                num_cols = df.select_dtypes(include=["number"]).columns
                for c in num_cols:
                    if df[c].isna().any():
                        _m = df[c].median()
                        df[c] = df[c].fillna(0 if pd.isna(_m) else _m)
                for c in df.select_dtypes(include=["object", "string"]).columns:
                    df[c] = df[c].fillna("")
                df.dropna(how="all", inplace=True)
                df.to_csv(cleaned_path, index=False)
                sandbox_result["fallback"] = "pandas guaranteed fallback used"
            except Exception as fb_err:
                sandbox_result["fallback_error"] = str(fb_err)
        else:
            if not os.path.isfile(cleaned_path):
                try:
                    _fb = pd.read_csv(csv_path, low_memory=False)
                    _fb.drop_duplicates(inplace=True)
                    _fb.to_csv(cleaned_path, index=False)
                except Exception:
                    pass

        if body.edited_code and body.edited_code.strip():
            _compiled_graph.update_state(
                config,
                {"edited_code": body.edited_code.strip(), "generated_code": body.edited_code.strip()},
            )

    _compiled_graph.invoke(Command(resume=body.action), config=config)
    snapshot_after = _compiled_graph.get_state(config)
    final_state    = _to_dict(snapshot_after)
    still_paused   = bool(snapshot_after.next)

    global _latest_status

    if still_paused:
        hit_iter = int(final_state.get("healing_iterations", 0))
        csv_live = final_state.get("active_csv_path") or csv_path
        _latest_status = {
            "status":             "paused_for_approval",
            "current_stage":      "transform",
            "thread_id":          body.thread_id,
            "message":            final_state.get("status", "Review regenerated code."),
            "stages_completed":   ["discovery"],
            "generated_code":     final_state.get("generated_code", ""),
            "active_csv":         os.path.basename(str(csv_live)),
            "healing_iterations": hit_iter,
        }
        return APIResponse(
            success=True,
            thread_id=body.thread_id,
            state=final_state,
            message=final_state.get("status", "Paused for human review."),
            paused=True,
        )

    csv_ready = os.path.isfile(cleaned_path)
    msg = (
        f"Pipeline complete. {os.path.basename(cleaned_path)} {'ready ✓' if csv_ready else '✗'}. "
        f"Sandbox: {'OK' if sandbox_result.get('success') else 'fallback'}."
        if action_lower == "approve"
        else "Pipeline finished after review."
    )
    _latest_status = {
        "status":            "completed",
        "current_stage":     "orchestrator",
        "thread_id":         body.thread_id,
        "message":           final_state.get("status", "Pipeline Complete"),
        "stages_completed":  ["discovery", "transform", "healing", "orchestrator"],
        "generated_code":    final_state.get("generated_code", ""),
        "sandbox":           sandbox_result,
        "active_csv":        os.path.basename(csv_path),
    }

    return APIResponse(
        success=True, thread_id=body.thread_id, state=final_state,
        message=msg, paused=False,
    )


@app.post("/reject", response_model=APIResponse, tags=["Pipeline"])
async def reject_pipeline(body: RejectRequest):
    """Reject the current code and trigger a healing re-generation loop.

    The pipeline resumes through healing_node → transform_node (corrective
    Gemini prompt) → new HITL interrupt with regenerated code.
    Returns when the new code is ready for review (paused again).
    """
    config   = _cfg(body.thread_id)
    snapshot = _compiled_graph.get_state(config)
    if not snapshot or not snapshot.next:
        return APIResponse(success=False, thread_id=body.thread_id,
                           message="No paused pipeline for this thread_id.")

    state_values = _to_dict(snapshot)
    current_iter = state_values.get("healing_iterations", 0)

    if current_iter >= MAX_HEALING_ITERATIONS:
        return APIResponse(
            success=False, thread_id=body.thread_id,
            message=(
                f"Max healing attempts ({current_iter}/{MAX_HEALING_ITERATIONS}) reached. "
                "Please restart the pipeline."
            ),
        )

    feedback_text = (body.feedback or "").strip() or "Please improve the generated code."
    resume_value  = f"Reject:{feedback_text}"

    logger.info("[Reject] Thread %s — iter %d — feedback: %s",
                body.thread_id, current_iter, feedback_text[:80])

    # Invoke resumes transform → healing → (back to) transform → NEW interrupt
    _compiled_graph.invoke(Command(resume=resume_value), config=config)

    snapshot2     = _compiled_graph.get_state(config)
    current_state = _to_dict(snapshot2)
    new_iter      = current_state.get("healing_iterations", current_iter + 1)
    new_code      = current_state.get("generated_code", "")
    csv_path      = current_state.get("active_csv_path") or CSV_PATH

    global _latest_status
    _latest_status = {
        "status":            "paused_for_approval",
        "current_stage":     "transform",
        "thread_id":         body.thread_id,
        "message":           (
            f"Code regenerated (attempt {new_iter}/{MAX_HEALING_ITERATIONS}). Review and approve."
        ),
        "stages_completed":  ["discovery"],
        "generated_code":    new_code,
        "healing_iterations": new_iter,
        "active_csv":        os.path.basename(csv_path),
    }

    return APIResponse(
        success=True, thread_id=body.thread_id, state=current_state,
        message=(
            f"Code regenerated (attempt {new_iter}/{MAX_HEALING_ITERATIONS}). "
            "Review the new code in Monaco Editor."
        ),
        paused=True,
    )


# ── Standalone ────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    multiprocessing.freeze_support()
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False, log_level="info")
