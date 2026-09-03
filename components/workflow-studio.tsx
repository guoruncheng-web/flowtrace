"use client";

import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { memo, useCallback, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  addUsage,
  EMPTY_USAGE,
  MODEL_PROFILE,
  wouldCreateCycle,
  type NodeRunStatus,
  type UsageSnapshot,
  type WorkflowNodeInput,
  type WorkflowNodeKind,
  type WorkflowStreamEvent,
} from "@/lib/workflow";

type WorkflowNodeData = Record<string, unknown> & {
  label: string;
  kind: WorkflowNodeKind;
  prompt: string;
  status: NodeRunStatus;
  attempt: number;
  output: string;
  error?: string;
  durationMs?: number;
  usage: UsageSnapshot;
};

type CanvasNode = Node<WorkflowNodeData, "workflow">;
type CanvasEdge = Edge;
type RunState = "ready" | "running" | "completed" | "failed" | "stopped";

interface LogEntry {
  id: string;
  level: "info" | "warn" | "success";
  message: string;
  at: string;
}

const KIND_META: Record<WorkflowNodeKind, { eyebrow: string; icon: string; color: string }> = {
  trigger: { eyebrow: "INPUT", icon: "IN", color: "#7bdcff" },
  ai: { eyebrow: "MODEL", icon: "AI", color: "#a996ff" },
  validator: { eyebrow: "GUARD", icon: "OK", color: "#ffbf69" },
  human: { eyebrow: "CONTROL", icon: "H", color: "#ff8eaa" },
  output: { eyebrow: "DELIVERY", icon: "OUT", color: "#82e6b8" },
};

const STATUS_LABEL: Record<NodeRunStatus, string> = {
  idle: "Idle",
  queued: "Queued",
  running: "Running",
  retrying: "Retrying",
  succeeded: "Complete",
  failed: "Failed",
};

function usage() {
  return { ...EMPTY_USAGE };
}

function createInitialNodes(): CanvasNode[] {
  return [
    {
      id: "brief",
      type: "workflow",
      position: { x: 20, y: 180 },
      data: {
        label: "Campaign brief",
        kind: "trigger",
        prompt: "Receive and normalize the customer brief.",
        status: "idle",
        attempt: 0,
        output: "",
        usage: usage(),
      },
    },
    {
      id: "signals",
      type: "workflow",
      position: { x: 300, y: 180 },
      data: {
        label: "Extract signals",
        kind: "ai",
        prompt: "Extract the strongest customer pains, evidence, and desired outcomes.",
        status: "idle",
        attempt: 0,
        output: "",
        usage: usage(),
      },
    },
    {
      id: "guard",
      type: "workflow",
      position: { x: 580, y: 70 },
      data: {
        label: "Risk & budget gate",
        kind: "validator",
        prompt: "Block sensitive data and runs that exceed the configured cost ceiling.",
        status: "idle",
        attempt: 0,
        output: "",
        usage: usage(),
      },
    },
    {
      id: "plan",
      type: "workflow",
      position: { x: 580, y: 300 },
      data: {
        label: "Draft launch plan",
        kind: "ai",
        prompt: "Turn validated signals into a concise, measurable launch plan.",
        status: "idle",
        attempt: 0,
        output: "",
        usage: usage(),
      },
    },
    {
      id: "approval",
      type: "workflow",
      position: { x: 875, y: 180 },
      data: {
        label: "Owner approval",
        kind: "human",
        prompt: "Record an explicit owner checkpoint before delivery.",
        status: "idle",
        attempt: 0,
        output: "",
        usage: usage(),
      },
    },
    {
      id: "publish",
      type: "workflow",
      position: { x: 1160, y: 180 },
      data: {
        label: "Publish brief",
        kind: "output",
        prompt: "Package the approved result for delivery.",
        status: "idle",
        attempt: 0,
        output: "",
        usage: usage(),
      },
    },
  ];
}

function createInitialEdges(): CanvasEdge[] {
  return [
    { id: "e-brief-signals", source: "brief", target: "signals" },
    { id: "e-signals-guard", source: "signals", target: "guard" },
    { id: "e-signals-plan", source: "signals", target: "plan" },
    { id: "e-guard-approval", source: "guard", target: "approval" },
    { id: "e-plan-approval", source: "plan", target: "approval" },
    { id: "e-approval-publish", source: "approval", target: "publish" },
  ].map((edge) => ({
    ...edge,
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
  }));
}

const WorkflowNodeCard = memo(function WorkflowNodeCard({ data, selected }: NodeProps<CanvasNode>) {
  const meta = KIND_META[data.kind];
  const isBusy = data.status === "running" || data.status === "retrying";
  const isTerminal = data.status === "succeeded" || data.status === "failed";

  return (
    <article
      className={`workflow-node status-${data.status}${selected ? " selected" : ""}`}
      style={{ "--node-accent": meta.color } as CSSProperties}
    >
      {data.kind !== "trigger" ? <Handle className="node-handle" type="target" position={Position.Left} /> : null}
      <div className="node-topline">
        <span className="node-icon">{meta.icon}</span>
        <div>
          <small>{meta.eyebrow}</small>
          <strong>{data.label}</strong>
        </div>
        <i className={isBusy ? "status-pulse" : "status-dot"} />
      </div>
      <p>{data.prompt}</p>
      <div className="node-footer">
        <span>{STATUS_LABEL[data.status]}{data.attempt > 1 ? ` · #${data.attempt}` : ""}</span>
        {data.usage.totalTokens > 0 ? <b>{data.usage.totalTokens} tok</b> : null}
        {data.durationMs ? <b>{data.durationMs} ms</b> : null}
        {isTerminal && data.error ? <b className="node-error">Retryable</b> : null}
      </div>
      {data.kind !== "output" ? <Handle className="node-handle" type="source" position={Position.Right} /> : null}
    </article>
  );
});

const nodeTypes = { workflow: WorkflowNodeCard };

function toWorkflowInput(nodes: CanvasNode[]): WorkflowNodeInput[] {
  return nodes.map((node) => ({
    id: node.id,
    kind: node.data.kind,
    label: node.data.label,
    prompt: node.data.prompt,
  }));
}

function parsePacket(packet: string) {
  const lines = packet.split("\n");
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  return data ? JSON.parse(data) as WorkflowStreamEvent : null;
}

function formatCost(costMicros: number) {
  return `$${(costMicros / 1_000_000).toFixed(5)}`;
}

function shortTime(value: string) {
  return new Date(value).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function WorkflowStudio() {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(createInitialNodes());
  const [edges, setEdges, onEdgesChange] = useEdgesState<CanvasEdge>(createInitialEdges());
  const [selectedId, setSelectedId] = useState<string>("signals");
  const [brief, setBrief] = useState("Turn customer feedback about slow onboarding and unclear AI costs into a concise launch plan. Require a policy and budget check before delivery.");
  const [injectFailure, setInjectFailure] = useState(true);
  const [runState, setRunState] = useState<RunState>("ready");
  const [runId, setRunId] = useState("No run yet");
  const [totalUsage, setTotalUsage] = useState<UsageSnapshot>({ ...EMPTY_USAGE });
  const [durationMs, setDurationMs] = useState(0);
  const [retryCount, setRetryCount] = useState(0);
  const [logs, setLogs] = useState<LogEntry[]>([
    { id: "ready", level: "info", message: "Canvas ready. Edit a step or run the workflow.", at: new Date().toISOString() },
  ]);
  const [notice, setNotice] = useState("Drag nodes or connect handles to edit the graph.");
  const abortRef = useRef<AbortController | null>(null);
  const idRef = useRef(7);

  const selectedNode = nodes.find((node) => node.id === selectedId);
  const inputNodes = useMemo(() => toWorkflowInput(nodes), [nodes]);
  const inputEdges = useMemo(() => edges.map(({ id, source, target }) => ({ id, source, target })), [edges]);
  const completedCount = nodes.filter((node) => node.data.status === "succeeded").length;

  const renderedEdges = useMemo(() => edges.map((edge) => {
    const source = nodes.find((node) => node.id === edge.source);
    const target = nodes.find((node) => node.id === edge.target);
    const active = source?.data.status === "succeeded" && ["running", "retrying", "succeeded"].includes(target?.data.status ?? "");
    const complete = source?.data.status === "succeeded" && target?.data.status === "succeeded";
    return {
      ...edge,
      animated: runState === "running" && (active || source?.data.status === "running"),
      className: complete ? "edge-complete" : active ? "edge-active" : "",
      style: { stroke: complete ? "#52dca1" : active ? "#a996ff" : "#465166", strokeWidth: active ? 2.3 : 1.6 },
    };
  }), [edges, nodes, runState]);

  const updateNode = useCallback((nodeId: string, update: Partial<WorkflowNodeData>) => {
    setNodes((current) => current.map((node) => node.id === nodeId
      ? { ...node, data: { ...node.data, ...update } }
      : node));
  }, [setNodes]);

  const appendLog = useCallback((entry: Omit<LogEntry, "id">) => {
    setLogs((current) => [
      ...current,
      { ...entry, id: `${Date.now()}-${Math.random().toString(16).slice(2)}` },
    ].slice(-60));
  }, []);

  const isValidConnection = useCallback((connection: Connection | CanvasEdge) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return false;
    return !wouldCreateCycle(inputNodes, inputEdges, { source: connection.source, target: connection.target });
  }, [inputEdges, inputNodes]);

  const onConnect = useCallback((connection: Connection) => {
    if (!isValidConnection(connection)) {
      setNotice("Connection blocked: workflows must stay acyclic.");
      return;
    }
    setEdges((current) => addEdge({
      ...connection,
      type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
    }, current));
    setNotice("Connection added. The execution order will be validated at runtime.");
  }, [isValidConnection, setEdges]);

  function addNode(kind: WorkflowNodeKind) {
    if (runState === "running") return;
    const id = `step-${idRef.current++}`;
    const defaults: Record<WorkflowNodeKind, { label: string; prompt: string }> = {
      trigger: { label: "New input", prompt: "Receive a structured workflow input." },
      ai: { label: "New AI step", prompt: "Transform the upstream context into a useful result." },
      validator: { label: "New guard", prompt: "Validate the output before it can continue." },
      human: { label: "New approval", prompt: "Require an explicit human checkpoint." },
      output: { label: "New delivery", prompt: "Package the final result for delivery." },
    };
    setNodes((current) => [...current, {
      id,
      type: "workflow",
      position: { x: 410 + (current.length % 3) * 250, y: 110 + (current.length % 2) * 210 },
      data: { ...defaults[kind], kind, status: "idle", attempt: 0, output: "", usage: usage() },
    }]);
    setSelectedId(id);
    setNotice(`${defaults[kind].label} added. Drag from a handle to connect it.`);
  }

  function removeSelectedNode() {
    if (!selectedNode || runState === "running") return;
    setNodes((current) => current.filter((node) => node.id !== selectedNode.id));
    setEdges((current) => current.filter((edge) => edge.source !== selectedNode.id && edge.target !== selectedNode.id));
    setSelectedId("");
    setNotice("Step and its connections removed.");
  }

  function resetRuntime() {
    setNodes((current) => current.map((node) => ({
      ...node,
      data: { ...node.data, status: "idle", attempt: 0, output: "", error: undefined, durationMs: undefined, usage: usage() },
    })));
    setTotalUsage({ ...EMPTY_USAGE });
    setDurationMs(0);
    setRetryCount(0);
    setLogs([]);
  }

  function resetWorkflow() {
    abortRef.current?.abort();
    setNodes(createInitialNodes());
    setEdges(createInitialEdges());
    setSelectedId("signals");
    setRunState("ready");
    setRunId("No run yet");
    setTotalUsage({ ...EMPTY_USAGE });
    setDurationMs(0);
    setRetryCount(0);
    setLogs([{ id: "reset", level: "info", message: "Starter workflow restored.", at: new Date().toISOString() }]);
    setNotice("Starter workflow restored.");
  }

  const handleStreamEvent = useCallback((event: WorkflowStreamEvent) => {
    switch (event.type) {
      case "run.started":
        setRunId(event.runId);
        setRunState("running");
        break;
      case "node.queued":
        updateNode(event.nodeId, { status: "queued" });
        break;
      case "node.started":
        updateNode(event.nodeId, { status: "running", attempt: event.attempt, output: "", error: undefined });
        break;
      case "node.output.delta":
        setNodes((current) => current.map((node) => node.id === event.nodeId
          ? { ...node, data: { ...node.data, output: `${node.data.output}${event.delta}` } }
          : node));
        break;
      case "node.failed":
        updateNode(event.nodeId, { status: "failed", attempt: event.attempt, error: event.message });
        break;
      case "node.retrying":
        setRetryCount((count) => count + 1);
        updateNode(event.nodeId, { status: "retrying", attempt: event.nextAttempt });
        break;
      case "usage.updated":
        updateNode(event.nodeId, { usage: event.usage });
        setTotalUsage((current) => addUsage(current, event.usage));
        break;
      case "node.completed":
        updateNode(event.nodeId, {
          status: "succeeded",
          attempt: event.attempt,
          durationMs: event.durationMs,
          output: event.output,
        });
        break;
      case "run.completed":
        setRunState("completed");
        setDurationMs(event.durationMs);
        setTotalUsage(event.usage);
        setRetryCount(event.retries);
        setNotice("Run completed. Every transition came through the SSE stream.");
        break;
      case "run.failed":
        setRunState("failed");
        setNotice(event.message);
        break;
      case "log":
        appendLog(event);
        break;
    }
  }, [appendLog, setNodes, updateNode]);

  async function runWorkflow() {
    if (runState === "running") return;
    resetRuntime();
    setRunState("running");
    setRunId("Opening stream…");
    setNotice("Validating graph and opening the SSE stream…");
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ nodes: inputNodes, edges: inputEdges, input: brief, injectFailure }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = await response.json() as { message?: string };
        throw new Error(error.message ?? "The workflow could not start.");
      }
      if (!response.body) throw new Error("The browser did not expose a response stream.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const packets = buffer.split("\n\n");
        buffer = packets.pop() ?? "";
        for (const packet of packets) {
          const event = parsePacket(packet);
          if (event) handleStreamEvent(event);
        }
        if (done) break;
      }
      if (buffer.trim()) {
        const event = parsePacket(buffer);
        if (event) handleStreamEvent(event);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      const message = error instanceof Error ? error.message : "The workflow failed.";
      setRunState("failed");
      setNotice(message);
      appendLog({ level: "warn", message, at: new Date().toISOString() });
    } finally {
      abortRef.current = null;
    }
  }

  function stopWorkflow() {
    abortRef.current?.abort();
    setRunState("stopped");
    setNotice("Run stopped by the operator.");
    appendLog({ level: "warn", message: "Operator stopped the active run.", at: new Date().toISOString() });
  }

  return (
    <main className="studio-shell">
      <header className="studio-header">
        <div className="brand-block">
          <span className="brand-symbol"><i /><i /><i /></span>
          <div><strong>Flowtrace</strong><small>Visual AI workflow runtime</small></div>
        </div>
        <div className="header-context">
          <span>Workspace</span><b>Launch intelligence</b><i>/</i><span>v3</span>
        </div>
        <div className="header-actions">
          <span className={`runtime-pill ${runState}`}><i />{runState === "running" ? "SSE LIVE" : runState.toUpperCase()}</span>
          <button className="button secondary" onClick={resetWorkflow} disabled={runState === "running"}>Reset</button>
          {runState === "running"
            ? <button className="button stop" onClick={stopWorkflow}>Stop run</button>
            : <button className="button primary" onClick={runWorkflow}><span>▶</span> Run workflow</button>}
        </div>
      </header>

      <div className="studio-grid">
        <aside className="node-library">
          <div className="aside-heading"><span>01</span><div><small>BUILD</small><strong>Node library</strong></div></div>
          <p className="aside-copy">Add a step, then connect its handles. Cycles are blocked before they reach the runtime.</p>
          <div className="library-list">
            {(["trigger", "ai", "validator", "human", "output"] as WorkflowNodeKind[]).map((kind) => {
              const meta = KIND_META[kind];
              return <button key={kind} onClick={() => addNode(kind)} disabled={runState === "running"} style={{ "--node-accent": meta.color } as CSSProperties}>
                <span>{meta.icon}</span><div><strong>{kind === "ai" ? "AI model" : kind[0].toUpperCase() + kind.slice(1)}</strong><small>{kind === "validator" ? "Policy · schema · budget" : kind === "human" ? "Explicit approval boundary" : `${meta.eyebrow.toLowerCase()} step`}</small></div><b>+</b>
              </button>;
            })}
          </div>
          <div className="run-input">
            <label htmlFor="workflow-brief"><span>RUN INPUT</span><b>{brief.length}/240</b></label>
            <textarea id="workflow-brief" value={brief} maxLength={240} onChange={(event) => setBrief(event.target.value)} disabled={runState === "running"} />
          </div>
          <label className="failure-toggle">
            <input type="checkbox" checked={injectFailure} onChange={(event) => setInjectFailure(event.target.checked)} disabled={runState === "running"} />
            <span><i /></span>
            <div><strong>Inject one timeout</strong><small>Prove automatic retry & recovery</small></div>
          </label>
          <div className="provider-note"><span>DEMO PROVIDER</span><strong>{MODEL_PROFILE.name}</strong><p>Deterministic public runtime · no API key or external model charges.</p></div>
        </aside>

        <section className="canvas-section">
          <div className="canvas-toolbar">
            <div><span>02</span><div><small>ORCHESTRATE</small><strong>Workflow canvas</strong></div></div>
            <p>{notice}</p>
            <span className="canvas-count">{nodes.length} steps · {edges.length} links</span>
          </div>
          <div className="flow-canvas">
            <ReactFlow<CanvasNode, CanvasEdge>
              nodes={nodes}
              edges={renderedEdges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              onNodeClick={(_, node) => setSelectedId(node.id)}
              onPaneClick={() => setSelectedId("")}
              onNodesDelete={(deleted) => {
                if (deleted.some((node) => node.id === selectedId)) setSelectedId("");
              }}
              nodesDraggable={runState !== "running"}
              nodesConnectable={runState !== "running"}
              elementsSelectable={runState !== "running"}
              fitView
              fitViewOptions={{ padding: 0.16, maxZoom: 0.92 }}
              minZoom={0.35}
              maxZoom={1.45}
              deleteKeyCode={["Backspace", "Delete"]}
              proOptions={{ hideAttribution: false }}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.3} color="#394257" />
              <Controls showInteractive={false} />
              <MiniMap
                nodeColor={(node) => KIND_META[(node.data as WorkflowNodeData).kind]?.color ?? "#8791a5"}
                maskColor="rgba(10, 12, 18, .76)"
                pannable
                zoomable
              />
            </ReactFlow>
            <div className="canvas-watermark"><span>LIVE DAG</span><b>Drag · connect · inspect</b></div>
          </div>
          <div className="canvas-statusbar">
            <span><i className="dot ready" />DAG guard active</span>
            <span><i className="dot stream" />POST /api/runs · text/event-stream</span>
            <span>{runId}</span>
          </div>
        </section>

        <aside className="inspector">
          <div className="aside-heading"><span>03</span><div><small>OBSERVE</small><strong>Run inspector</strong></div></div>
          <div className="metric-grid">
            <div><span>PROGRESS</span><strong>{completedCount}<small>/{nodes.length}</small></strong></div>
            <div><span>TOKENS</span><strong>{totalUsage.totalTokens}</strong></div>
            <div><span>COST EST.</span><strong>{formatCost(totalUsage.costMicros)}</strong></div>
            <div><span>RETRIES</span><strong>{retryCount}</strong></div>
          </div>

          {selectedNode ? <section className="step-editor">
            <header><div><span style={{ background: KIND_META[selectedNode.data.kind].color }}>{KIND_META[selectedNode.data.kind].icon}</span><div><small>SELECTED STEP</small><strong>{selectedNode.data.label}</strong></div></div><button onClick={removeSelectedNode} disabled={runState === "running"} title="Delete selected step">×</button></header>
            <label>Label<input value={selectedNode.data.label} maxLength={38} disabled={runState === "running"} onChange={(event) => updateNode(selectedNode.id, { label: event.target.value })} /></label>
            <label>Instruction<textarea value={selectedNode.data.prompt} maxLength={180} disabled={runState === "running"} onChange={(event) => updateNode(selectedNode.id, { prompt: event.target.value })} /></label>
            {selectedNode.data.output ? <div className="node-output"><span>LATEST OUTPUT</span><p>{selectedNode.data.output}</p></div> : null}
            {selectedNode.data.error ? <div className="node-output error"><span>RECOVERABLE ERROR</span><p>{selectedNode.data.error}</p></div> : null}
          </section> : <div className="no-selection"><span>◇</span><strong>Select a step</strong><p>Edit its instruction or inspect the latest streamed output.</p></div>}

          <section className="event-log">
            <header><div><small>SERVER EVENTS</small><strong>Execution timeline</strong></div><span>{runState === "running" ? "LIVE" : durationMs ? `${(durationMs / 1000).toFixed(1)}s` : "—"}</span></header>
            <div className="log-scroll">
              {logs.length ? [...logs].reverse().map((log) => <div className={`log-entry ${log.level}`} key={log.id}>
                <time>{shortTime(log.at)}</time><i /><p>{log.message}</p>
              </div>) : <div className="log-empty">Events will appear here as the server emits them.</div>}
            </div>
          </section>
          <footer className="inspector-footer"><span>Usage ledger</span><b>{totalUsage.inputTokens} in · {totalUsage.outputTokens} out</b><small>Estimated with a visible model price profile.</small></footer>
        </aside>
      </div>
    </main>
  );
}
