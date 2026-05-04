import { EventEmitter } from "node:events";
import type { AgentCard, BlackboardEntry, GeneratedPlan, SwarmEnvelope } from "../protocol/types.js";
import type { ToolApprovalRequest } from "../tools/types.js";

export type SessionOutcome = {
  changed_files: string[];
  intermediate_artifacts: string[];
  tests_run: string[];
  final_summary: string;
};

export type RuntimeEvent =
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "controller"; id: string; action: string; reason: string; confidence?: number; instruction?: string }
  | { type: "queue"; operation: "enqueue" | "dequeue" | "clear"; id?: string; priority?: "now" | "next" | "later"; size: number }
  | { type: "agent"; card: AgentCard }
  | { type: "envelope"; envelope: SwarmEnvelope }
  | { type: "plan"; session_id: string; plan: GeneratedPlan }
  | { type: "task"; task_id: string; title: string; status: string }
  | { type: "task_attempt"; task_id: string; title: string; attempt: number; status: "started" | "completed" | "failed" }
  | { type: "blackboard"; entry: BlackboardEntry }
  | { type: "approval"; request: ToolApprovalRequest; status: "pending" | "approved" | "denied" }
  | { type: "live_message"; id: string; session_id?: string; content: string; status: "received" | "processing" | "applied" }
  | { type: "control"; message_id: string; action: "continue_current" | "inject_next_turn" | "interrupt_and_redirect" | "ask_clarification"; reason: string; instruction: string }
  | { type: "final"; session_id: string; content: string; artifact_path?: string; outcome?: SessionOutcome }
  | { type: "error"; message: string }
  | { type: "tool_result"; task_id: string; title: string; action: string; summary: string; content?: string; status?: "success" | "partial" | "failed"; outputRef?: string; attempt?: number; errorCode?: string }
  | { type: "progress"; completed: number; total: number };

export class RuntimeEvents extends EventEmitter {
  emitEvent(event: RuntimeEvent): void {
    this.emit("event", event);
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.on("event", listener);
    return () => this.off("event", listener);
  }
}
