import { DeterministicDemoProvider } from "@/lib/provider";
import {
  addUsage,
  EMPTY_USAGE,
  topologicalOrder,
  validateWorkflow,
  type RunRequest,
  type WorkflowStreamEvent,
} from "@/lib/workflow";

export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

function sleep(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Run cancelled", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Run cancelled", "AbortError"));
    }, { once: true });
  });
}

function splitOutput(value: string) {
  const words = value.split(" ");
  const chunks: string[] = [];
  const chunkSize = Math.max(3, Math.ceil(words.length / 7));
  for (let index = 0; index < words.length; index += chunkSize) {
    chunks.push(`${index === 0 ? "" : " "}${words.slice(index, index + chunkSize).join(" ")}`);
  }
  return chunks;
}

function now() {
  return new Date().toISOString();
}

export async function POST(request: Request) {
  let body: RunRequest;
  try {
    body = await request.json() as RunRequest;
    validateWorkflow(body.nodes, body.edges);
    if (!body.input?.trim()) throw new Error("Add a workflow brief before running.");
  } catch (error) {
    return Response.json(
      { message: error instanceof Error ? error.message : "Invalid workflow payload." },
      { status: 400 },
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const runId = `run_${crypto.randomUUID().slice(0, 8)}`;
      const runStarted = Date.now();
      const provider = new DeterministicDemoProvider();
      const outputs = new Map<string, string>();
      let totalUsage = { ...EMPTY_USAGE };
      let retries = 0;

      const emit = (event: WorkflowStreamEvent) => {
        controller.enqueue(encoder.encode(`event: workflow\ndata: ${JSON.stringify(event)}\n\n`));
      };

      try {
        const order = topologicalOrder(body.nodes, body.edges);
        const nodeById = new Map(body.nodes.map((node) => [node.id, node]));
        emit({ type: "run.started", runId, nodeCount: order.length, startedAt: now() });
        emit({ type: "log", level: "info", message: "Execution graph validated; SSE stream opened.", at: now() });
        order.forEach((nodeId) => emit({ type: "node.queued", nodeId }));

        for (const nodeId of order) {
          const node = nodeById.get(nodeId);
          if (!node) continue;
          const upstreamIds = body.edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source);
          const upstreamOutputs = upstreamIds.map((id) => outputs.get(id)).filter((value): value is string => Boolean(value));
          const shouldFailOnce = body.injectFailure && node.kind === "validator";
          const maxAttempts = shouldFailOnce ? 2 : 1;

          for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const attemptStarted = Date.now();
            emit({ type: "node.started", nodeId, attempt, startedAt: now() });
            emit({ type: "log", level: "info", message: `${node.label} started · attempt ${attempt}`, at: now() });
            await sleep(node.kind === "ai" ? 260 : 170, request.signal);

            if (shouldFailOnce && attempt === 1) {
              retries += 1;
              emit({
                type: "node.failed",
                nodeId,
                attempt,
                message: "Provider timeout while evaluating the policy gate.",
                recoverable: true,
              });
              emit({ type: "log", level: "warn", message: `${node.label} timed out; retry scheduled in 1.6 s.`, at: now() });
              emit({ type: "node.retrying", nodeId, nextAttempt: 2, delayMs: 1_600 });
              await sleep(1_600, request.signal);
              continue;
            }

            const result = await provider.execute(node, { brief: body.input, upstreamOutputs });
            for (const delta of splitOutput(result.output)) {
              emit({ type: "node.output.delta", nodeId, delta });
              await sleep(node.kind === "ai" ? 68 : 34, request.signal);
            }

            outputs.set(nodeId, result.output);
            if (result.usage.totalTokens > 0) {
              totalUsage = addUsage(totalUsage, result.usage);
              emit({ type: "usage.updated", nodeId, usage: result.usage });
            }
            emit({
              type: "node.completed",
              nodeId,
              attempt,
              durationMs: Date.now() - attemptStarted,
              output: result.output,
            });
            emit({ type: "log", level: "success", message: `${node.label} completed.`, at: now() });
          }
        }

        emit({
          type: "run.completed",
          runId,
          durationMs: Date.now() - runStarted,
          usage: totalUsage,
          retries,
        });
        emit({ type: "log", level: "success", message: "Workflow completed; usage ledger reconciled.", at: now() });
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          emit({ type: "run.failed", runId, message: error instanceof Error ? error.message : "Run failed." });
        }
      } finally {
        try {
          controller.close();
        } catch {
          // The browser may have cancelled the stream after navigation.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
