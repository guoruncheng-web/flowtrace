export type WorkflowNodeKind = "trigger" | "ai" | "validator" | "human" | "output";

export type NodeRunStatus =
  | "idle"
  | "queued"
  | "running"
  | "retrying"
  | "succeeded"
  | "failed";

export interface WorkflowNodeInput {
  id: string;
  kind: WorkflowNodeKind;
  label: string;
  prompt: string;
}

export interface WorkflowEdgeInput {
  id: string;
  source: string;
  target: string;
}

export interface RunRequest {
  nodes: WorkflowNodeInput[];
  edges: WorkflowEdgeInput[];
  input: string;
  injectFailure: boolean;
}

export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costMicros: number;
}

export type WorkflowStreamEvent =
  | { type: "run.started"; runId: string; nodeCount: number; startedAt: string }
  | { type: "run.completed"; runId: string; durationMs: number; usage: UsageSnapshot; retries: number }
  | { type: "run.failed"; runId: string; message: string }
  | { type: "node.queued"; nodeId: string }
  | { type: "node.started"; nodeId: string; attempt: number; startedAt: string }
  | { type: "node.output.delta"; nodeId: string; delta: string }
  | { type: "node.failed"; nodeId: string; attempt: number; message: string; recoverable: boolean }
  | { type: "node.retrying"; nodeId: string; nextAttempt: number; delayMs: number }
  | { type: "node.completed"; nodeId: string; attempt: number; durationMs: number; output: string }
  | { type: "usage.updated"; nodeId: string; usage: UsageSnapshot }
  | { type: "log"; level: "info" | "warn" | "success"; message: string; at: string };

export const MODEL_PROFILE = {
  name: "Atlas Mini · demo profile",
  inputUsdPerMillion: 0.15,
  outputUsdPerMillion: 0.6,
} as const;

const MAX_NODES = 24;
const MAX_EDGES = 60;

export function validateWorkflow(nodes: WorkflowNodeInput[], edges: WorkflowEdgeInput[]) {
  if (nodes.length < 2 || nodes.length > MAX_NODES) {
    throw new Error(`A workflow must contain between 2 and ${MAX_NODES} nodes.`);
  }

  if (edges.length > MAX_EDGES) {
    throw new Error(`A workflow cannot contain more than ${MAX_EDGES} connections.`);
  }

  const ids = new Set<string>();
  for (const node of nodes) {
    if (!node.id || !node.label.trim() || !node.prompt.trim()) {
      throw new Error("Every node needs an id, label, and instruction.");
    }
    if (ids.has(node.id)) throw new Error(`Duplicate node id: ${node.id}`);
    ids.add(node.id);
  }

  const connections = new Set<string>();
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) {
      throw new Error(`Connection ${edge.id} references a missing node.`);
    }
    if (edge.source === edge.target) {
      throw new Error("A node cannot connect to itself.");
    }
    const connection = `${edge.source}->${edge.target}`;
    if (connections.has(connection)) {
      throw new Error(`Duplicate connection: ${connection}`);
    }
    connections.add(connection);
  }

  topologicalOrder(nodes, edges);
}

export function topologicalOrder(nodes: WorkflowNodeInput[], edges: WorkflowEdgeInput[]) {
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));

  for (const edge of edges) {
    if (!incoming.has(edge.source) || !incoming.has(edge.target)) continue;
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  }

  const queue = nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
  const order: string[] = [];

  while (queue.length) {
    const id = queue.shift();
    if (!id) break;
    order.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const nextIncoming = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, nextIncoming);
      if (nextIncoming === 0) queue.push(next);
    }
  }

  if (order.length !== nodes.length) {
    throw new Error("The workflow contains a cycle. Remove the looping connection before running.");
  }

  return order;
}

export function wouldCreateCycle(
  nodes: WorkflowNodeInput[],
  edges: WorkflowEdgeInput[],
  candidate: Pick<WorkflowEdgeInput, "source" | "target">,
) {
  try {
    topologicalOrder(nodes, [
      ...edges,
      { id: `candidate-${candidate.source}-${candidate.target}`, ...candidate },
    ]);
    return false;
  } catch {
    return true;
  }
}

export function estimateTokens(text: string) {
  const normalized = text.trim();
  if (!normalized) return 0;
  const cjkCharacters = normalized.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  const remainingCharacters = normalized.length - cjkCharacters;
  return Math.max(1, Math.ceil(cjkCharacters * 0.8 + remainingCharacters / 4));
}

export function calculateUsage(input: string, output: string): UsageSnapshot {
  const inputTokens = estimateTokens(input);
  const outputTokens = estimateTokens(output);
  const inputCostMicros = inputTokens * MODEL_PROFILE.inputUsdPerMillion;
  const outputCostMicros = outputTokens * MODEL_PROFILE.outputUsdPerMillion;

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costMicros: Math.max(1, Math.round(inputCostMicros + outputCostMicros)),
  };
}

export function addUsage(left: UsageSnapshot, right: UsageSnapshot): UsageSnapshot {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    costMicros: left.costMicros + right.costMicros,
  };
}

export const EMPTY_USAGE: UsageSnapshot = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costMicros: 0,
};
