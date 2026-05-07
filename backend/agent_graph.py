"""
LAM-ADEP Agentic Data Engineering Pipeline — LangGraph Workflow
===============================================================
Production MVP with REAL LLM calls and data processing.

Architecture
------------
- Local LLM  : Ollama → qwen2.5-coder:3b  (via ChatOllama) for Discovery and Transform
- Vector DB  : ChromaDB ephemeral            (RLHF knowledge store)
- Data       : pandas for CSV profiling

Nodes
-----
1. discovery_node    — Read CSV, profile schema, call Ollama for analysis.
2. transform_node    — Send analysis to Ollama, get cleaning code.
   ** HITL INTERRUPT immediately AFTER this node **
3. healing_node      — Mock self-healing pass (append comment).
4. orchestrator_node — If approved, persist code to ChromaDB for RLHF.

Checkpointing is handled by MemorySaver (in-memory, thread-safe).
"""

from __future__ import annotations

import logging
import os
from typing import TypedDict

import pandas as pd
from dotenv import load_dotenv
from langchain_core.messages import HumanMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, StateGraph
from langgraph.types import interrupt, Command

# ---------------------------------------------------------------------------
# Environment & Logging
# ---------------------------------------------------------------------------
load_dotenv()

logger = logging.getLogger("lam_adep.graph")

# Path to the dataset (relative to where the server is started)
CSV_PATH = os.path.join(os.path.dirname(__file__), "data", "supermarket_sales.csv")

# ---------------------------------------------------------------------------
# Lazy LLM Client Initialization
# ---------------------------------------------------------------------------
# We initialise at call-time, not import-time, so the server boots even if
# Ollama is temporarily down.

_ollama_llm = None

# Always a non-None string so frontends that expect `generated_code` never break.
TRANSFORM_CODE_FALLBACK = "# Fallback: Error generating code"


def _get_ollama():
    """Lazy-init the local Ollama client (qwen2.5-coder:3b)."""
    global _ollama_llm
    if _ollama_llm is None:
        from langchain_ollama import ChatOllama
        _ollama_llm = ChatOllama(
            model="qwen2.5-coder:3b",
            temperature=0.3,
            timeout=120,          # generous timeout for local inference
        )
        logger.info("Ollama client initialised (qwen2.5-coder:3b)")
    return _ollama_llm


# ---------------------------------------------------------------------------
# Graph State Schema
# ---------------------------------------------------------------------------

class PipelineState(TypedDict):
    """Typed dictionary that travels through every node."""

    input_data: str        # Schema analysis from Discovery (LLM output)
    status: str            # Human-readable status tag
    generated_code: str    # Cleaning code from Transform (LLM output)
    human_feedback: str    # Feedback received at the HITL gate


# ---------------------------------------------------------------------------
# Node 1 — Discovery Agent (Component 1)
# ---------------------------------------------------------------------------

def discovery_node(state: PipelineState) -> PipelineState:
    """Read the first 200 rows of the CSV, profile the schema, and send it
    to the local Ollama model for analysis and cleaning suggestions."""
    logger.info("[Discovery] Reading CSV and profiling schema …")

    try:
        # ── 1. Load and profile data ──────────────────────────────────
        df = pd.read_csv(CSV_PATH)
        df = df.head(200)

        # Build a markdown profile string
        schema_lines = []
        schema_lines.append("## Dataset Schema (first 200 rows)\n")
        schema_lines.append(f"**Shape:** {df.shape[0]} rows × {df.shape[1]} columns\n")
        schema_lines.append("### Columns & Data Types\n")
        schema_lines.append("| Column | Dtype | Non-Null Count | Sample Values |")
        schema_lines.append("|--------|-------|----------------|---------------|")

        for col in df.columns:
            non_null = df[col].notna().sum()
            samples = ", ".join(str(v) for v in df[col].head(3).tolist())
            schema_lines.append(
                f"| {col} | {df[col].dtype} | {non_null}/{len(df)} | {samples} |"
            )

        schema_lines.append("\n### First 3 Rows (Markdown Table)\n")
        schema_lines.append(df.head(3).to_markdown(index=False))

        schema_str = "\n".join(schema_lines)
        logger.info("[Discovery] Schema profile built (%d chars)", len(schema_str))

        # ── 2. Call Local Ollama LLM ──────────────────────────────────
        prompt = (
            "You are a Data Profiler. Analyze this Supermarket Sales dataset schema. "
            "Identify data types and suggest exactly 3 data cleaning steps "
            "(e.g., handling nulls, formatting dates, fixing types).\n\n"
            f"{schema_str}"
        )

        llm = _get_ollama()
        response = llm.invoke([HumanMessage(content=prompt)])
        analysis = response.content
        logger.info("[Discovery] Ollama analysis received (%d chars)", len(analysis))

    except Exception as exc:
        # Graceful degradation — never crash the graph
        logger.error("[Discovery] LLM/data error: %s", exc, exc_info=True)
        analysis = (
            f"[Discovery Agent Error] Could not complete analysis: {exc}\n"
            "Falling back to raw schema summary.\n\n"
            + (schema_str if "schema_str" in dir() else "Schema unavailable.")
        )

    return {
        **state,
        "input_data": analysis,
        "status": "Discovery Complete",
        "generated_code": "",
        "human_feedback": "",
    }


# ---------------------------------------------------------------------------
# Node 2 — Transform Agent (Component 2)
# ---------------------------------------------------------------------------

def transform_node(state: PipelineState) -> PipelineState:
    """Take the Discovery analysis and ask the local Ollama model to generate a
    complete pandas cleaning script. Then pause for human review (HITL)."""
    logger.info("[Transform] Generating cleaning code via Ollama …")

    analysis = state.get("input_data", "")
    generated_code = TRANSFORM_CODE_FALLBACK

    try:
        prompt = (
            "Based on this schema analysis, write a complete Python script using pandas "
            "to load 'backend/data/supermarket_sales.csv', take the first 200 rows, "
            "apply the suggested cleaning steps, and save the output to "
            "'backend/data/cleaned_sales.csv'. "
            "Return ONLY the raw python code string without markdown blocks.\n\n"
            f"Schema Analysis:\n{analysis}"
        )

        llm = _get_ollama()
        response = llm.invoke([HumanMessage(content=prompt)])
        raw = response.content
        if raw is None:
            raw = ""
        generated_code = str(raw).strip()

        # Strip markdown fences if the model wraps them anyway
        if generated_code.startswith("```"):
            lines = generated_code.split("\n")
            lines = [l for l in lines if not l.strip().startswith("```")]
            generated_code = "\n".join(lines).strip()

        if not generated_code:
            generated_code = TRANSFORM_CODE_FALLBACK

        logger.info(
            "[Transform] Ollama code generated (%d chars)", len(generated_code)
        )

    except Exception as exc:
        logger.error("[Transform] Ollama error: %s", exc, exc_info=True)
        generated_code = TRANSFORM_CODE_FALLBACK

    updated_state = {
        **state,
        "status": "Code Generated. Pending Approval",
        "generated_code": generated_code,
    }

    # ── HITL Gate ─────────────────────────────────────────────────────
    # The interrupt() call pauses the graph and sends a payload back to
    # the caller.  When the caller resumes with Command(resume=...),
    # the node re-executes and interrupt() returns the resume value.
    human_decision: str = interrupt(
        {
            "message": "Review the generated transformation code.",
            "generated_code": generated_code,
            "action_required": "Send Command(resume='Approve') or Command(resume='Reject') to continue.",
        }
    )

    # After resume — record the human decision
    updated_state["human_feedback"] = human_decision
    logger.info("[Transform] Human decision received: %s", human_decision)

    return updated_state


# ---------------------------------------------------------------------------
# Node 3 — Healing Agent (Component 3) — MOCK
# ---------------------------------------------------------------------------

def healing_node(state: PipelineState) -> PipelineState:
    """Mock self-healing pass.

    In the full production version this would:
      • Execute the generated code in a sandboxed environment,
      • Catch runtime errors and re-prompt the LLM for fixes,
      • Validate output data quality.

    For the MVP we simply append a healing-passed comment.
    """
    logger.info("[Healing] Running mock self-healing pass …")

    code = state.get("generated_code", "")
    code_with_healing = code + "\n# Healing passed\n"

    return {
        **state,
        "generated_code": code_with_healing,
        "status": "Healing Complete",
    }


# ---------------------------------------------------------------------------
# Node 4 — Orchestrator / RLHF (Component 4)
# ---------------------------------------------------------------------------

def orchestrator_node(state: PipelineState) -> PipelineState:
    """If the human approved, persist the generated code into a local
    ChromaDB collection to simulate RAG-based RLHF knowledge storage.

    If rejected, record the rejection and skip persistence.
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
        import chromadb

        client = chromadb.Client()  # ephemeral in-memory client
        collection = client.get_or_create_collection(
            name="rlhf_pipeline_knowledge",
            metadata={"description": "Approved pipeline code for RLHF"},
        )

        code = state.get("generated_code", "")
        
        # ── Execute the code ───────────────────────────────────────────
        try:
            logger.info("[Orchestrator] Executing generated code...")
            # Fix paths if the LLM output 'backend/data/' but we are inside 'backend/'
            code_to_exec = code.replace("backend/data/", "data/")
            exec(code_to_exec, globals())
            logger.info("[Orchestrator] Code execution successful. cleaned_sales.csv should be created.")
        except Exception as e:
            logger.error("[Orchestrator] Code execution failed: %s", e)
            # We still proceed to save the knowledge, or handle it as needed.

        collection.add(
            documents=[code],
            ids=[f"pipeline_code_{hash(code) & 0xFFFFFFFF}"],
            metadatas=[{
                "feedback": state.get("human_feedback", ""),
                "status": "approved",
                "source": "transform_agent",
            }],
        )

        doc_count = collection.count()
        logger.info(
            "[Orchestrator] Code saved to ChromaDB (collection has %d docs)",
            doc_count,
        )

        return {
            **state,
            "status": f"Pipeline Complete. Knowledge saved to ChromaDB. ({doc_count} docs in collection)",
        }

    except Exception as exc:
        logger.error("[Orchestrator] ChromaDB error: %s", exc, exc_info=True)
        return {
            **state,
            "status": f"Pipeline Complete (ChromaDB save failed: {exc})",
        }


# ---------------------------------------------------------------------------
# Graph Construction
# ---------------------------------------------------------------------------

def build_graph() -> StateGraph:
    """Construct and compile the LAM-ADEP pipeline graph.

    Returns the compiled graph (with MemorySaver checkpointer) ready for
    `graph.invoke()` / `graph.stream()` calls.

    Flow: discovery → transform (HITL) → healing → orchestrator → END
    """
    builder = StateGraph(PipelineState)

    # Register nodes
    builder.add_node("discovery", discovery_node)
    builder.add_node("transform", transform_node)
    builder.add_node("healing", healing_node)
    builder.add_node("orchestrator", orchestrator_node)

    # Linear edge chain: discovery → transform → healing → orchestrator → END
    builder.set_entry_point("discovery")
    builder.add_edge("discovery", "transform")
    builder.add_edge("transform", "healing")
    builder.add_edge("healing", "orchestrator")
    builder.add_edge("orchestrator", END)

    # Compile with in-memory checkpointer for thread persistence
    checkpointer = MemorySaver()
    compiled = builder.compile(checkpointer=checkpointer)

    logger.info("Pipeline graph compiled successfully (4 nodes).")
    return compiled
