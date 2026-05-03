import { EventEmitter } from "node:events";
import type { AgentCard, BlackboardEntry, GeneratedPlan, SwarmEnvelope } from "../protocol/types.js";
import type { ToolApprovalRequest } from "../tools/types.js";

export type RuntimeEvent =
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "agent"; card: AgentCard }
  | { type: "envelope"; envelope: SwarmEnvelope }
  | { type: "plan"; session_id: string; plan: GeneratedPlan }
  | { type: "task"; task_id: string; title: string; status: string }
  | { type: "blackboard"; entry: BlackboardEntry }
  | { type: "approval"; request: ToolApprovalRequest; status: "pending" | "approved" | "denied" }
  | { type: "final"; session_id: string; content: string; artifact_path?: string }
  | { type: "error"; message: string };

export class RuntimeEvents extends EventEmitter {
  emitEvent(event: RuntimeEvent): void {
    this.emit("event", event);
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.on("event", listener);
    return () => this.off("event", listener);
  }
}
