"""
LAM-ADEP Agentic Data Engineering Pipeline — LangGraph Workflow
===============================================================
Stateful graph with three processing nodes and a Human-in-the-Loop
(HITL) interrupt gate between Transform and Healing/Orchestrator.

Nodes
-----
1. discovery_node   — Mock semantic discovery of source schemas.
2. transform_node   — Mock transformation code generation.
   ** HITL INTERRUPT immediately AFTER this node **
3. healing_node     — Mock self-healing + RLHF vector-DB persistence.

Checkpointing is handled by MemorySaver (in-memory, thread-safe).
"""

from __future__ import annotations

import logging
from typing import TypedDict

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, StateGraph
from langgraph.types import interrupt, Command

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logger = logging.getLogger("lam_adep.graph")

# ---------------------------------------------------------------------------
# Graph State Schema
# ---------------------------------------------------------------------------

class PipelineState(TypedDict):
    """Typed dictionary that travels through every node."""

    input_data: str        # Raw input payload (stringified)
    status: str            # Human-readable status tag
    generated_code: str    # Code produced by the Transform node
    human_feedback: str    # Feedback received at the HITL gate


# ---------------------------------------------------------------------------
# Node Definitions
# ---------------------------------------------------------------------------

def discovery_node(state: PipelineState) -> PipelineState:
    """Node 1 — Semantic Discovery (mock).

    In production this would probe data-source schemas, catalogue columns,
    infer types, and build a semantic metadata graph.
    """
    logger.info("[Discovery] Processing input data …")

    return {
        **state,
        "status": "Discovery Complete",
        "generated_code": "",          # no code yet
        "human_feedback": "",          # no feedback yet
    }


def transform_node(state: PipelineState) -> PipelineState:
    """Node 2 — Transformation Code Generation (mock).

    In production this would call an LLM to generate Polars / SQL
    transformation code based on the discovered schema.

    After this node the graph will pause (HITL interrupt) so a human
    can review the generated code before it is executed.
    """
    logger.info("[Transform] Generating transformation code …")

    mock_code = (
        "import polars as pl\n\n"
        "# --- Auto-generated transformation pipeline ---\n"
        "df = pl.read_csv('source.csv')\n"
        "df = df.filter(pl.col('value').is_not_null())\n"
        "df = df.with_columns(pl.col('value').cast(pl.Float64).alias('value_clean'))\n"
        "df.write_parquet('output.parquet')\n"
    )

    updated_state = {
        **state,
        "status": "Code Ready. Pending Approval",
        "generated_code": mock_code,
    }

    # ── HITL gate ──────────────────────────────────────────────────────
    # The interrupt() call pauses the graph and sends a payload back to
    # the caller.  When the caller resumes with Command(resume=...),
    # the node re-executes and interrupt() returns the resume value.
    human_decision: str = interrupt(
        {
            "message": "Review the generated transformation code.",
            "generated_code": mock_code,
            "action_required": "Send Command(resume='Approve') or Command(resume='Reject') to continue.",
        }
    )

    # After resume — record whatever the human sent back.
    updated_state["human_feedback"] = human_decision
    logger.info("[Transform] Human decision received: %s", human_decision)

    return updated_state


def healing_node(state: PipelineState) -> PipelineState:
    """Node 3 — Self-Healing & RLHF Orchestrator (mock).

    In production this would:
      • validate the executed output,
      • trigger self-healing retries on failure,
      • persist the human-feedback vector to a Qdrant / Pinecone DB
        for RLHF fine-tuning loops.
    """
    feedback = state.get("human_feedback", "")
    logger.info("[Healing] Running self-healing with feedback: %s", feedback)

    if feedback.strip().lower() == "reject":
        return {
            **state,
            "status": "Pipeline Rejected by Human — awaiting revision",
        }

    return {
        **state,
        "status": "Pipeline Complete",
    }


# ---------------------------------------------------------------------------
# Graph Construction
# ---------------------------------------------------------------------------

def build_graph() -> StateGraph:
    """Construct and compile the LAM-ADEP pipeline graph.

    Returns the compiled graph (with MemorySaver checkpointer) ready for
    `graph.invoke()` / `graph.stream()` calls.
    """
    builder = StateGraph(PipelineState)

    # Register nodes
    builder.add_node("discovery", discovery_node)
    builder.add_node("transform", transform_node)
    builder.add_node("healing", healing_node)

    # Linear edge chain: discovery → transform → healing → END
    builder.set_entry_point("discovery")
    builder.add_edge("discovery", "transform")
    builder.add_edge("transform", "healing")
    builder.add_edge("healing", END)

    # Compile with in-memory checkpointer for thread persistence
    checkpointer = MemorySaver()
    compiled = builder.compile(checkpointer=checkpointer)

    logger.info("Pipeline graph compiled successfully.")
    return compiled
