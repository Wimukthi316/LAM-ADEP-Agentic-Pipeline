"use client";

import ReactFlow, {
  Background,
  type Edge,
  type Node,
  type NodeTypes,
} from "reactflow";
import PipelineNode from "@/components/PipelineNode";

const NODE_TYPES: NodeTypes = {
  pipeline: PipelineNode,
};

const FIT_VIEW_OPTIONS = { padding: 0.3 };

const PRO_OPTIONS = { hideAttribution: true };

export default function PipelineFlowGraph({
  nodes,
  edges,
}: {
  nodes: Node[];
  edges: Edge[];
}) {
  return (
    <div className="h-[220px]">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        proOptions={PRO_OPTIONS}
      >
        <Background color="#1c2333" gap={20} size={1} />
      </ReactFlow>
    </div>
  );
}
