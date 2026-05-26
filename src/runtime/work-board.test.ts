import { strict as assert } from "node:assert";
import test from "node:test";
import type {
  TaskContractSummary,
  WorkContractHandoff,
  WorkContractSummary,
  WorkHeartbeatState,
  WorkSnapshot
} from "../protocol/types.js";
import { buildWorkBoardFromSnapshots, formatWorkBoard } from "./work-board.js";

const GENERATED_AT = "2026-05-24T00:10:00.000Z";

test("work board projects handoff conflict claims into blocked recovery actions", () => {
  const handoff = handoffContract({
    handoff_id: "handoff-conflict",
    worker_id: "worker-conflict",
    protocol_status: "conflict",
    heartbeat_state: "blocked",
    conflict_reason: "Two workers claimed the same handoff lease.",
    claim_owner: "worker:worker-conflict",
    owner_agent_id: "worker:worker-conflict",
    last_checkpoint: {
      artifact: "artifact://handoff-conflict.checkpoint",
      summary: "conflict checkpoint"
    }
  });

  const board = buildWorkBoardFromSnapshots({
    scope: { kind: "session", session_id: "session-work-board-handoff" },
    snapshots: [snapshotWithHandoff(handoff)],
    generatedAt: GENERATED_AT
  });

  const claim = board.claims.find((item) => item.claim_id === "handoff:handoff-conflict");
  assert(claim, "expected handoff claim");
  assert.equal(claim.status, "conflict");
  assert.equal(claim.claim_owner, "worker:worker-conflict");
  assert.equal(claim.heartbeat_state, "blocked");
  assert.equal(claim.conflict_reason, "Two workers claimed the same handoff lease.");
  assert.equal(claim.last_artifact, "artifact://handoff-conflict.checkpoint");
  assert.equal(claim.recovery, "Two workers claimed the same handoff lease.");

  assert.equal(board.summary.claims, 1);
  assert.equal(board.summary.blocked, 1);
  assert(board.blocked.some((action) => action.source === "claim" && action.id === "handoff:handoff-conflict"));
  assert(board.next_actions.some((action) => action.action === "Two workers claimed the same handoff lease."));
  assert.match(formatWorkBoard(board, { filter: "blocked" }), /handoff:handoff-conflict/);
});

test("work board projects handoff timeout claims into blocked recovery actions", () => {
  const handoff = handoffContract({
    handoff_id: "handoff-timeout",
    worker_id: "worker-timeout",
    protocol_status: "timeout",
    heartbeat_state: "stale",
    stale_reason: "Handoff lease expired at 2026-05-24T00:09:00.000Z.",
    claim_owner: "worker:worker-timeout",
    owner_agent_id: "worker:worker-timeout",
    return_contract: {
      result: {
        output_ref: "artifact://handoff-timeout.partial",
        summary: "partial timeout result"
      }
    }
  });

  const board = buildWorkBoardFromSnapshots({
    scope: { kind: "session", session_id: "session-work-board-handoff" },
    snapshots: [snapshotWithHandoff(handoff)],
    generatedAt: GENERATED_AT
  });

  const claim = board.claims.find((item) => item.claim_id === "handoff:handoff-timeout");
  assert(claim, "expected handoff claim");
  assert.equal(claim.status, "timeout");
  assert.equal(claim.claim_owner, "worker:worker-timeout");
  assert.equal(claim.heartbeat_state, "stale");
  assert.equal(claim.stale_reason, "Handoff lease expired at 2026-05-24T00:09:00.000Z.");
  assert.equal(claim.last_artifact, "artifact://handoff-timeout.partial");
  assert.match(claim.recovery ?? "", /timed out/);

  assert.equal(board.summary.claims, 1);
  assert.equal(board.summary.blocked, 1);
  assert(board.blocked.some((action) => action.source === "claim" && action.id === "handoff:handoff-timeout"));
  assert(board.next_actions.some((action) => /timed out/.test(action.action)));
  assert.match(formatWorkBoard(board, { filter: "blocked" }), /handoff-timeout timed out/);
});

function snapshotWithHandoff(handoff: WorkContractHandoff): WorkSnapshot {
  return {
    session: {
      session_id: "session-work-board-handoff",
      swarm_id: "swarm-work-board-handoff",
      objective: "Validate handoff claim projection",
      status: "running",
      created_at: "2026-05-24T00:00:00.000Z",
      updated_at: "2026-05-24T00:09:30.000Z"
    },
    attempts: [],
    workers: [],
    graph: { tasks: [], edges: [] },
    blackboard_counts: {},
    changed_files: [],
    checks: [],
    usage_summary: {},
    task_contracts: {
      summary: emptyTaskSummary(),
      tasks: []
    },
    work_contracts: {
      summary: workSummary({ active_handoffs: 1, scoped_targets: handoff.scope }),
      active_workers: [],
      resumable_workers: [],
      active_handoffs: [handoff]
    }
  };
}

function handoffContract(input: {
  handoff_id: string;
  worker_id: string;
  protocol_status: WorkContractHandoff["protocol_status"];
  heartbeat_state: WorkHeartbeatState;
  stale_reason?: string;
  conflict_reason?: string;
  claim_owner: string;
  owner_agent_id: string;
  last_checkpoint?: unknown;
  return_contract?: unknown;
}): WorkContractHandoff {
  return {
    handoff_id: input.handoff_id,
    worker_id: input.worker_id,
    source_agent: "main_swarm",
    target_agent_spec_id: "handoff_specialist",
    reason: "Focused ownership transfer",
    status: "active",
    protocol_status: input.protocol_status,
    requester_agent_id: "main_swarm",
    owner_agent_id: input.owner_agent_id,
    claim_owner: input.claim_owner,
    scope: ["src/runtime/runtime.ts"],
    lease_age: {
      since: "2026-05-24T00:05:00.000Z",
      age_ms: 300_000,
      label: "5m"
    },
    heartbeat_state: input.heartbeat_state,
    stale_reason: input.stale_reason,
    conflict_reason: input.conflict_reason,
    lease_expires_at: "2026-05-24T00:09:00.000Z",
    accepted_at: "2026-05-24T00:05:00.000Z",
    last_checkpoint: input.last_checkpoint,
    return_contract: input.return_contract,
    write_policy: "scoped_write",
    file_scope: ["src/runtime/runtime.ts"],
    updated_at: "2026-05-24T00:09:00.000Z"
  };
}

function emptyTaskSummary(): TaskContractSummary {
  return {
    total: 0,
    pending: 0,
    running: 0,
    blocked: 0,
    completed: 0,
    failed: 0,
    read_only: 0,
    scoped_write: 0,
    workspace_write: 0,
    scoped_targets: []
  };
}

function workSummary(overrides: Partial<WorkContractSummary> = {}): WorkContractSummary {
  return {
    active_workers: 0,
    running_workers: 0,
    pending_workers: 0,
    resumable_workers: 0,
    active_handoffs: 0,
    read_only: 0,
    scoped_write: 1,
    workspace_write: 0,
    scoped_targets: [],
    ...overrides
  };
}
