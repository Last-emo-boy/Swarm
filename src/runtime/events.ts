import { EventEmitter } from "node:events";
import type { AgentCard, BlackboardEntry, GeneratedPlan, ReviewResult, SwarmEnvelope, SwarmSession, WorkSessionOutcome } from "../protocol/types.js";
import type { FileLockEvent, ToolApprovalRequest, WorkspaceChangeMetadata } from "../tools/types.js";
import type { WorkerRecord, WorkerStatus } from "../storage/worker-state-store.js";
import type { AgentSpawnDecision, AgentTaskPacket } from "./agent-specs.js";
import type { HandoffSessionRecord } from "../storage/handoff-store.js";

export type SessionOutcome = WorkSessionOutcome;

export type RuntimeEvent =
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "session"; session_id: string; status: SwarmSession["status"]; objective?: string; parent_session_id?: string }
  | { type: "controller"; id: string; action: string; reason: string; confidence?: number; instruction?: string; details?: Record<string, unknown> }
  | { type: "queue"; operation: "enqueue" | "dequeue" | "clear"; id?: string; priority?: "now" | "next" | "later"; size: number }
  | { type: "worker"; worker: WorkerRecord; status: WorkerStatus; message?: string }
  | { type: "agent_spawn_decision"; worker_id: string; decision: AgentSpawnDecision; task_packet: AgentTaskPacket }
  | { type: "agent_run_started"; worker: WorkerRecord; task_packet: AgentTaskPacket }
  | { type: "agent_run_completed"; worker: WorkerRecord; result: string }
  | { type: "handoff_started"; handoff: HandoffSessionRecord }
  | { type: "handoff_message"; handoff_id: string; message: string }
  | { type: "handoff_returned"; handoff: HandoffSessionRecord; result: string }
  | { type: "handoff_taken_back"; handoff: HandoffSessionRecord }
  | { type: "workspace_change"; session_id: string; change: WorkspaceChangeMetadata }
  | { type: "file_lock"; event: FileLockEvent }
  | { type: "review_started"; session_id: string; objective: string }
  | { type: "review_completed"; session_id: string; result: ReviewResult }
  | { type: "verification_started"; session_id: string; objective: string }
  | { type: "verification_completed"; session_id: string; result: ToolResultSummary }
  | { type: "self_review"; summary: string; findings: string[]; recommendations: string[]; inspected: { logs: number; sessions: number; artifacts: number } }
  | { type: "eval_result"; name: string; status: "pass" | "fail"; message: string }
  | { type: "agent"; card: AgentCard }
  | { type: "envelope"; envelope: SwarmEnvelope }
  | { type: "plan"; session_id: string; plan: GeneratedPlan }
  | { type: "task"; task_id: string; title: string; status: string }
  | { type: "task_attempt"; session_id?: string; task_id: string; title: string; attempt: number; status: "started" | "completed" | "failed" }
  | { type: "blackboard"; entry: BlackboardEntry }
  | { type: "approval"; request: ToolApprovalRequest; status: "pending" | "approved" | "denied" }
  | { type: "live_message"; id: string; session_id?: string; content: string; status: "received" | "processing" | "applied" }
  | { type: "control"; message_id: string; action: "continue_current" | "inject_next_turn" | "interrupt_and_redirect" | "ask_clarification"; reason: string; instruction: string }
  | { type: "loop_activity"; session_id: string; phase: "thinking" | "running_tools" | "running_tool" | "waiting_approval" | "turn_complete" | "completed" | "stopped"; message: string; turn?: number; tool?: string; task_id?: string }
  | { type: "final"; session_id: string; content: string; artifact_path?: string; outcome?: SessionOutcome }
  | { type: "error"; message: string }
  | { type: "tool_result"; session_id?: string; task_id: string; title: string; action: string; summary: string; content?: string; status?: "success" | "partial" | "failed"; outputRef?: string; attempt?: number; errorCode?: string; recoverySuggestion?: string }
  | { type: "progress"; completed: number; total: number };

export type ToolResultSummary = {
  status: "success" | "partial" | "failed";
  summary: string;
  content?: string;
  worker_id?: string;
};

export class RuntimeEvents extends EventEmitter {
  emitEvent(event: RuntimeEvent): void {
    this.emit("event", event);
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.on("event", listener);
    return () => this.off("event", listener);
  }
}
