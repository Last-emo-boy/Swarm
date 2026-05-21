import { randomUUID } from "node:crypto";
import { OpenAIProvider } from "../providers/openai-provider.js";
import { RuntimeEvents } from "./events.js";
import { CommandQueue, type QueuePriority } from "./command-queue.js";
import { routeExecution, type ExecutionRoute, type RunOptions } from "./execution-router.js";
import type { ExecutionResult } from "./orchestrator.js";

type ControllerInput = {
  kind: "run" | "live_message" | "worker_notification" | "interrupt";
  content: string;
  requestId?: string;
  resolve?: (decision: ControllerLiveDecision | undefined) => void;
  reject?: (error: unknown) => void;
};

export type ControllerLiveDecision = {
  message_id: string;
  action: "continue_current" | "inject_next_turn" | "interrupt_and_redirect" | "ask_clarification";
  reason: string;
  instruction: string;
};

export type SwarmControllerHandlers = {
  executeRoute: (objective: string, route: ExecutionRoute, options: RunOptions) => Promise<ExecutionResult>;
  handleLiveMessage: (content: string, requestId?: string) => Promise<ControllerLiveDecision | undefined>;
  handleInterrupt: (content: string, requestId?: string) => ControllerLiveDecision | void;
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
    return this.handlers.executeRoute(objective, route, options);
  }

  submitUserMessage(content: string, priority: QueuePriority = "next", requestId?: string): Promise<ControllerLiveDecision | undefined> {
    const result = new Promise<ControllerLiveDecision | undefined>((resolve, reject) => {
      const item = this.queue.enqueue({
        id: `cmd_${randomUUID()}`,
        value: { kind: "live_message", content, requestId, resolve, reject },
        priority
      });
      this.events.emitEvent({ type: "queue", queue: "control", operation: "enqueue", id: item.id, priority: item.priority, size: this.queue.length });
    });
    void this.drain();
    return result;
  }

  submitWorkerNotification(content: string, priority: QueuePriority = "later"): void {
    const item = this.queue.enqueue({
      id: `cmd_${randomUUID()}`,
      value: { kind: "worker_notification", content },
      priority
    });
    this.events.emitEvent({ type: "queue", queue: "control", operation: "enqueue", id: item.id, priority: item.priority, size: this.queue.length });
    void this.drain();
  }

  interrupt(content: string, requestId?: string): void {
    const item = this.queue.enqueue({
      id: `cmd_${randomUUID()}`,
      value: { kind: "interrupt", content, requestId },
      priority: "now"
    });
    this.events.emitEvent({ type: "queue", queue: "control", operation: "enqueue", id: item.id, priority: item.priority, size: this.queue.length });
    void this.drain();
  }

  enqueueWorkerNotification(content: string): void {
    this.submitWorkerNotification(content);
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
        this.events.emitEvent({ type: "queue", queue: "control", operation: "dequeue", id: item.id, priority: item.priority, size: this.queue.length });
        try {
          if (item.value.kind === "interrupt") {
            const decision = this.handlers.handleInterrupt(item.value.content, item.value.requestId);
            item.value.resolve?.(decision ?? undefined);
          } else if (item.value.kind === "live_message") {
            const decision = await this.handlers.handleLiveMessage(item.value.content, item.value.requestId);
            item.value.resolve?.(decision);
          } else if (item.value.kind === "worker_notification") {
            const decision = await this.handlers.handleLiveMessage(item.value.content, item.value.requestId);
            item.value.resolve?.(decision);
          }
        } catch (error) {
          item.value.reject?.(error);
          if (!item.value.reject) {
            this.events.emitEvent({
              type: "log",
              level: "warn",
              message: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
