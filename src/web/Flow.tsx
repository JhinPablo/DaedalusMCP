import { useMemo, useState } from "react";
import {
  ReactFlow,
  Controls,
  Handle,
  Position,
  type NodeProps,
  type Node,
  type Edge,
} from "@xyflow/react";
import {
  ArrowUpRight,
  Check,
  Circle,
  GitBranch,
  MessageSquare,
  ScanLine,
  Terminal,
  Workflow,
} from "lucide-react";
import type { IdeaNode, Session } from "../shared/model";
const labels = {
  idea: "Idea",
  alternative: "Alternativa",
  critique: "Crítica",
  prompt: "Prompt",
  task: "Tarea",
  review: "Revisión",
};
const icons = {
  idea: MessageSquare,
  alternative: GitBranch,
  critique: ScanLine,
  prompt: Terminal,
  task: Workflow,
  review: Check,
};
type DecisionNode = Node<
  { item: IdeaNode; status?: string; selectedId?: string },
  "decision"
>;
function Decision({ data, selected }: NodeProps<DecisionNode>) {
  const Icon = icons[data.item.kind];
  return (
    <div
      className={`decision-node ${selected ? "selected" : ""} kind-${data.item.kind}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="node-type">
        <Icon size={14} />
        <span>{labels[data.item.kind]}</span>
        {data.status && <span className="node-state">{data.status}</span>}
      </div>
      <strong>{data.item.title}</strong>
      <p>
        {data.item.content.slice(0, 115)}
        {data.item.content.length > 115 ? "…" : ""}
      </p>
      <div className="node-foot">
        {data.item.collapsed ? "Rama contraída" : "Ver detalle"}
        <ArrowUpRight size={14} />
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const types = { decision: Decision };
export function Flow({
  session,
  selected,
  onSelect,
  compact = false,
}: {
  session: Session;
  selected?: string;
  onSelect: (id: string) => void;
  compact?: boolean;
}) {
  const [view, setView] = useState<"list" | "map">("list");
  const { nodes, edges } = useMemo(() => {
    const all = session.nodes,
      byId = new Map(all.map((n) => [n.id, n]));
    function hidden(n: IdeaNode, seen = new Set<string>()): boolean {
      if (!n.parentId) return false;
      if (seen.has(n.id)) return true;
      seen.add(n.id);
      const p = byId.get(n.parentId);
      return !!p && (!!p.collapsed || hidden(p, seen));
    }
    const visible = all.filter((n) => !hidden(n));
    const rows = new Map<number, number>();
    const depth = (n: IdeaNode, seen = new Set<string>()): number => {
      if (!n.parentId || seen.has(n.id)) return 0;
      seen.add(n.id);
      const p = byId.get(n.parentId);
      return p ? depth(p, seen) + 1 : 0;
    };
    const nodes: DecisionNode[] = visible.map((item) => {
      const col = depth(item),
        row = rows.get(col) ?? 0;
      rows.set(col, row + 1);
      return {
        id: item.id,
        type: "decision",
        position: { x: col * 340, y: row * 240 },
        selected: selected === item.id,
        data: {
          item,
          selectedId: selected,
          status:
            item.kind === "task"
              ? {
                  pending: "Pendiente",
                  running: "En curso",
                  completed: "Completada",
                  failed: "Revisar",
                }[session.tasks.find((t) => t.id === item.taskId)?.status ?? "pending"]
              : undefined,
        },
      };
    });
    const edges: Edge[] = visible
      .filter((n) => n.parentId && visible.some((p) => p.id === n.parentId))
      .map((n) => ({
        id: n.parentId + "-" + n.id,
        source: n.parentId!,
        target: n.id,
        type: "smoothstep",
        style: {
          stroke: n.kind === "prompt" ? "#1b6c80" : "#b5bdbf",
          strokeWidth: 1.3,
        },
      }));
    for (const node of visible.filter((n) => n.kind === "task")) {
      const task = session.tasks.find((t) => t.id === node.taskId);
      for (const dependency of task?.dependsOn.slice(1) ?? []) {
        const source = visible.find((n) => n.taskId === dependency);
        if (source)
          edges.push({
            id: source.id + "-" + node.id,
            source: source.id,
            target: node.id,
            type: "smoothstep",
            style: { stroke: "#b5bdbf", strokeWidth: 1.3 },
          });
      }
    }
    return { nodes, edges };
  }, [session, selected]);
  return (
    <div className={"flow-container " + (compact ? "compact-flow is-" + view : "")}>
      {compact && (
        <div className="flow-view-toggle" aria-label="Presentación del flujo">
          <button aria-pressed={view === "list"} onClick={() => setView("list")}>
            Decisiones
          </button>
          <button aria-pressed={view === "map"} onClick={() => setView("map")}>
            Mapa
          </button>
        </div>
      )}
      {(!compact || view === "map") && (
        <div className="desktop-flow">
          <ReactFlow
            key={session.id}
            nodes={nodes}
            edges={edges}
            nodeTypes={types}
            onNodeClick={(_, node) => onSelect(node.id)}
            fitView
            fitViewOptions={{
              padding: 0.16,
              maxZoom: 1,
              ...(compact ? { minZoom: 0.5 } : {}),
            }}
            minZoom={0.25}
            maxZoom={1.5}
            nodesDraggable={false}
            nodesConnectable={false}
            deleteKeyCode={null}
            proOptions={{ hideAttribution: true }}
            aria-label="Mapa de ideas y decisiones"
          >
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      )}
      <div className="mobile-flow" aria-label="Flujo de decisiones">
        {nodes.map((node) => (
          <button
            key={node.id}
            className={"mobile-flow-node " + (selected === node.id ? "active" : "")}
            onClick={() => onSelect(node.id)}
          >
            <small>
              {labels[node.data.item.kind]}
              {node.data.status ? " · " + node.data.status : ""}
            </small>
            <strong>{node.data.item.title}</strong>
            <span>{node.data.item.content.slice(0, 140)}</span>
            {compact && node.data.item.parentId && (
              <small className="flow-parent">
                Desde{" "}
                {session.nodes.find((n) => n.id === node.data.item.parentId)?.title ??
                  "la decisión anterior"}
              </small>
            )}
            <ArrowUpRight size={16} />
          </button>
        ))}
      </div>
    </div>
  );
}
export function WorkflowGuide() {
  return (
    <div className="workflow-guide" aria-label="Flujo de trabajo de Daedalus">
      <div className="guide-caption">
        <span className="line-dot" />
        Una idea toma forma
      </div>
      {[
        ["01", "Idea", "El punto de partida", "Define qué quieres conseguir."],
        [
          "02",
          "Exploración",
          "OpenCode · DeepSeek",
          "Brainstorming, enfoques y alternativas.",
        ],
        ["03", "Decisión", "Tu criterio", "Compara, critica y elige una dirección."],
        [
          "04",
          "Prompt aprobado",
          "Tu autorización",
          "Un plan concreto, antes de ejecutar.",
        ],
        [
          "05",
          "Construcción",
          "Codex · subagentes",
          "Tareas aisladas y avances visibles.",
        ],
        [
          "06",
          "Revisión",
          "Evidencia y pruebas",
          "Una mirada independiente al resultado.",
        ],
      ].map(([num, title, meta, description]) => (
        <div className={"guide-step step-" + num} key={num}>
          <span className="guide-number">{num}</span>
          <div>
            <span className="guide-meta">{meta}</span>
            <strong>{title}</strong>
            <p>{description}</p>
          </div>
          <Circle size={10} />
        </div>
      ))}
      <div className="guide-note">
        <GitBranch size={15} />
        Cada alternativa conserva su propio camino.
      </div>
    </div>
  );
}
