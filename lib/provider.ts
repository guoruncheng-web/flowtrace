import { calculateUsage, type UsageSnapshot, type WorkflowNodeInput } from "./workflow";

export interface StepContext {
  brief: string;
  upstreamOutputs: string[];
}

export interface StepResult {
  output: string;
  usage: UsageSnapshot;
}

export interface WorkflowProvider {
  execute(node: WorkflowNodeInput, context: StepContext): Promise<StepResult>;
}

function compact(value: string, max = 118) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

export class DeterministicDemoProvider implements WorkflowProvider {
  async execute(node: WorkflowNodeInput, context: StepContext): Promise<StepResult> {
    const source = compact(context.brief || "No brief supplied.");
    const upstream = compact(context.upstreamOutputs.at(-1) ?? source);
    let output: string;

    switch (node.kind) {
      case "trigger":
        output = `Brief accepted: ${source}`;
        break;
      case "ai":
        output = node.label.toLowerCase().includes("plan")
          ? `Launch plan: open with the clearest customer outcome, ship one measurable activation path, and review adoption after 48 hours. Evidence used: ${upstream}`
          : `Signals extracted: onboarding friction, unclear usage costs, and a need for a visible approval boundary. Source: ${source}`;
        break;
      case "validator":
        output = "Policy gate passed: no sensitive data detected; estimated run cost is within the configured budget.";
        break;
      case "human":
        output = "Approval checkpoint recorded: scope, audience, and budget are ready for owner review.";
        break;
      case "output":
        output = `Delivery package ready. ${upstream}`;
        break;
    }

    const usage = node.kind === "ai"
      ? calculateUsage(`${node.prompt}\n${context.brief}\n${context.upstreamOutputs.join("\n")}`, output)
      : { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0 };

    return { output, usage };
  }
}
