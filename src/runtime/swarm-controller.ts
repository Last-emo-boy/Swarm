import { randomUUID } from "node:crypto";
import { OpenAIProvider } from "../providers/openai-provider.js";
import { RuntimeEvents } from "./events.js";
import { CommandQueue, type QueuePriority } from "./command-queue.js";
import { routeExecution, type ExecutionRoute, type RunOptions } from "./execution-router.js";
import type { ExecutionResult } from "./orchestrator.js";

type ControllerInput = {
  kind: "run" | "live_message" | "worker_notification" | "interrupt";
  content: string;
};

export type ControllerLiveDecision = {
  action: "continue_current" | "inject_next_turn" | "interrupt_and_redirect" | "ask_clarification";
  reason: string;
  instruction: string;
};

export type SwarmControllerHandlers = {
  executeRoute: (objective: string, route: ExecutionRoute) => Promise<ExecutionResult>;
  handleLiveMessage: (content: string) => Promise<void>;
  handleInterrupt: (content: string) => void;
};

export class SwarmController {
  private readonly queue = new CommandQueue<ControllerInput>();
  private draining = false;

  constructor(
    private readonly provider: OpenAIProvider,
    private readonly events: RuntimeEvents,
    private readonly handlers: SwarmControllerHandlers
  ) {}

  async run(objective: string, options: RunOptions = {}): Promise<ExecutionResult> {
    const route = await routeExecution(objective, this.provider, options);
    this.events.emitEvent({
      type: "controller",
      id: `ctrl_${randomUUID()}`,
      action: `run_${route.mode}`,
      reason: route.reason,
      confidence: route.confidence,
      instruction: objective,
      details: {
        route
      }
    });
    return this.handlers.executeRoute(objective, route);
  }

  async submitUserMessage(content: string, priority: QueuePriority = "next"): Promise<void> {
    const item = this.queue.enqueue({
      id: `cmd_${randomUUID()}`,
      value: { kind: "live_message", content },
      priority
    });
    this.events.emitEvent({ type: "queue", operation: "enqueue", id: item.id, priority: item.priority, size: this.queue.length });
    await this.drain();
  }

  interrupt(content: string): void {
    const item = this.queue.enqueue({
      id: `cmd_${randomUUID()}`,
      value: { kind: "interrupt", content },
      priority: "now"
    });
    this.events.emitEvent({ type: "queue", operation: "enqueue", id: item.id, priority: item.priority, size: this.queue.length });
    void this.drain();
  }

  enqueueWorkerNotification(content: string): void {
    const item = this.queue.enqueue({
      id: `cmd_${randomUUID()}`,
      value: { kind: "worker_notification", content },
      priority: "later"
    });
    this.events.emitEvent({ type: "queue", operation: "enqueue", id: item.id, priority: item.priority, size: this.queue.length });
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      for (;;) {
        const item = this.queue.dequeue();
        if (!item) {
          break;
        }
        this.events.emitEvent({ type: "queue", operation: "dequeue", id: item.id, priority: item.priority, size: this.queue.length });
        if (item.value.kind === "interrupt") {
          this.handlers.handleInterrupt(item.value.content);
        } else if (item.value.kind === "live_message") {
          await this.handlers.handleLiveMessage(item.value.content);
        } else if (item.value.kind === "worker_notification") {
          await this.handlers.handleLiveMessage(item.value.content);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
