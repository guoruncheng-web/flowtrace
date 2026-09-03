import { describe, expect, it } from "vitest";
import { DeterministicDemoProvider } from "../lib/provider";
import {
  addUsage,
  calculateUsage,
  EMPTY_USAGE,
  estimateTokens,
  topologicalOrder,
  validateWorkflow,
  wouldCreateCycle,
  type WorkflowEdgeInput,
  type WorkflowNodeInput,
} from "../lib/workflow";

const nodes: WorkflowNodeInput[] = [
  { id: "input", kind: "trigger", label: "Input", prompt: "Receive the brief." },
  { id: "extract", kind: "ai", label: "Extract", prompt: "Extract the key signals." },
  { id: "guard", kind: "validator", label: "Guard", prompt: "Validate policy." },
  { id: "draft", kind: "ai", label: "Draft plan", prompt: "Write the plan." },
  { id: "publish", kind: "output", label: "Publish", prompt: "Deliver the result." },
];

const edges: WorkflowEdgeInput[] = [
  { id: "e1", source: "input", target: "extract" },
  { id: "e2", source: "extract", target: "guard" },
  { id: "e3", source: "extract", target: "draft" },
  { id: "e4", source: "guard", target: "publish" },
  { id: "e5", source: "draft", target: "publish" },
];

describe("workflow graph", () => {
  it("orders a branching DAG after all of its dependencies", () => {
    const order = topologicalOrder(nodes, edges);

    expect(order[0]).toBe("input");
    expect(order.indexOf("extract")).toBeGreaterThan(order.indexOf("input"));
    expect(order.indexOf("publish")).toBeGreaterThan(order.indexOf("guard"));
    expect(order.indexOf("publish")).toBeGreaterThan(order.indexOf("draft"));
  });

  it("blocks a candidate connection that closes a cycle", () => {
    expect(wouldCreateCycle(nodes, edges, { source: "publish", target: "input" })).toBe(true);
    expect(wouldCreateCycle(nodes, edges, { source: "guard", target: "draft" })).toBe(false);
  });

  it("rejects cycles, missing endpoints, and duplicate connections", () => {
    expect(() => validateWorkflow(nodes, [
      ...edges,
      { id: "cycle", source: "publish", target: "input" },
    ])).toThrow(/cycle/i);

    expect(() => validateWorkflow(nodes, [
      ...edges,
      { id: "missing", source: "unknown", target: "input" },
    ])).toThrow(/missing node/i);

    expect(() => validateWorkflow(nodes, [
      ...edges,
      { id: "duplicate", source: "input", target: "extract" },
    ])).toThrow(/duplicate connection/i);
  });
});

describe("usage ledger", () => {
  it("estimates Latin and CJK text without returning fractional tokens", () => {
    expect(estimateTokens("launch the workflow")).toBeGreaterThan(0);
    expect(estimateTokens("创建工作流")).toBeGreaterThan(0);
    expect(Number.isInteger(estimateTokens("mixed 工作流 input"))).toBe(true);
  });

  it("calculates and accumulates visible model cost", () => {
    const first = calculateUsage("a".repeat(400), "b".repeat(200));
    const second = calculateUsage("short prompt", "short output");
    const total = addUsage(EMPTY_USAGE, addUsage(first, second));

    expect(first.inputTokens).toBe(100);
    expect(first.outputTokens).toBe(50);
    expect(total.totalTokens).toBe(first.totalTokens + second.totalTokens);
    expect(total.costMicros).toBeGreaterThan(0);
  });
});

describe("deterministic demo provider", () => {
  it("returns repeatable dynamic output and charges only model steps", async () => {
    const provider = new DeterministicDemoProvider();
    const context = { brief: "Reduce onboarding friction.", upstreamOutputs: ["Users need clearer setup steps."] };
    const modelNode = nodes.find((node) => node.id === "draft")!;
    const guardNode = nodes.find((node) => node.id === "guard")!;

    const first = await provider.execute(modelNode, context);
    const second = await provider.execute(modelNode, context);
    const guard = await provider.execute(guardNode, context);

    expect(first).toEqual(second);
    expect(first.output).toContain("Launch plan");
    expect(first.usage.totalTokens).toBeGreaterThan(0);
    expect(guard.usage.totalTokens).toBe(0);
  });
});
