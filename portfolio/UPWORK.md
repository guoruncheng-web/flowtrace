# Upwork portfolio draft

## Title

Visual AI Workflow Builder with Live SSE Execution

## Role

Full-Stack Developer

## Description

I built Flowtrace, an interactive node-based workflow demo for complex AI operations. Users can drag, connect, add, edit, and delete React Flow nodes. Runs are validated as DAGs on both client and server, executed in topological order, and streamed through a real SSE endpoint. The inspector shows partial output, per-node duration, automatic retry and recovery, token usage, and estimated cost. The public demo uses a deterministic provider, so it requires no model API key or external charges.

## Skills and deliverables

- React
- Next.js
- TypeScript
- Node.js
- React Flow
- Server-Sent Events
- API development
- Responsive web design
- Automated testing

## Suggested gallery order

1. `source/flowtrace-completed.jpg` — completed graph, live cost ledger, and server timeline
2. `source/flowtrace-canvas.png` — editable starter workflow and node library
3. `source/flowtrace-retry.jpg` — validator selected after automatic recovery, showing attempt #2 and one retry

## Links

- Live demo: add after production deployment
- Source: add after repository creation

## Accuracy note

Do not describe the public provider as a live language model. It is a deterministic, input-aware demo runtime behind a typed provider interface. The canvas, DAG validation, SSE transport, retry state, and usage ledger are functional.
