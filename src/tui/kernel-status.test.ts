import { strict as assert } from "node:assert";
import test from "node:test";
import { formatCompactIdleRows, formatKernelStatusView } from "./SwarmChatApp.js";
import { compactWorkSnapshotLines, formatWorkSnapshot } from "./work-snapshot-display.js";
import { applyWorkRecordToTuiState, summarizeTaskWritePolicies, type TuiWorkState } from "./work-state.js";
import type { RuntimeEvent } from "../runtime/events.js";
import { liveControlProjection } from "../runtime/live-control-status.js";
import { SWARM_WORK_PROTOCOL_VERSION, type WorkProtocolRecord } from "../runtime/work-protocol.js";
import { buildWorkBoardFromSnapshots } from "../runtime/work-board.js";
import type { WorkSnapshot, WorkspaceLease, RunAttempt, SwarmSession } from "../protocol/types.js";
import type { WorkerRecord } from "../storage/worker-state-store.js";
import type { HandoffSessionRecord } from "../storage/handoff-store.js";
import type { ApprovalRecord } from "../storage/approval-store.js";
import type { AgentActorRecord, AgentMailboxMessage, AgentMailboxProjection } from "../storage/agent-actor-store.js";
import type { AgentMemoryProjection } from "../storage/agent-memory-store.js";
import type { SymphonyStatus } from "../symphony/status.js";
import type { SymphonyDaemonRecord } from "../symphony/daemon.js";
import type { LspStatusReport } from "../lsp/manager.js";

test("kernel status formatter covers sessions, attempts, leases, approvals, handoffs, Symphony, daemons, and snapshot lines", () => {
  const state = buildTuiState();
  const runtime = kernelRuntimeFixture();
  const detail = formatKernelStatusView({
    runtime: runtime as never,
    busy: false,
    runMode: "auto",
    lastRoute: {
      mode: "coding_loop",
      confidence: 0.82,
      reason: "operator-test",
      requiresWorkspace: true,
      needsParallelism: false
    },
    lastSessionId: "session-1",
    taskCompleted: state.taskCompleted,
    taskTotal: state.taskTotal,
    taskStates: state.taskStates,
    toolResults: [
      {
        task_id: "task-1",
        title: "Write scoped file",
        action: "file.write",
        summary: "created file",
        status: "success"
      }
    ],
    workers: new Map([["worker-memory-1", workerRecord("worker-memory-1")]]),
    handoffs: new Map([["handoff-memory-1", handoffRecord("handoff-memory-1")]]),
    symphonyStatus: symphonyStatusFixture(),
    symphonyDaemons: [symphonyDaemonFixture()],
    events: runtimeEventsFixture()
  });

  assert.match(detail, /Swarm Kernel/);
  assert.match(detail, /state=idle mode=auto last_session=session-1/);
  assert.match(detail, /latest_route=work\/82% workspace=true parallel=false reason=operator-test/);
  assert.match(detail, /Current Work/);
  assert.match(detail, /task-1 \[completed\].*policy=scoped_write.*scope=src\/allowed\.txt/);
  assert.match(detail, /Recent Sessions/);
  assert.match(detail, /session-1 \[running\].*Ship operator surface/);
  assert.match(detail, /Last Session Snapshot/);
  assert.match(detail, /workspace=.* boundary=workspace/);
  assert.match(detail, /Work Board/);
  assert.match(detail, /sessions=1 active=1 workers=2 active_workers=1 resumable=1 tasks=1 claims=2 blocked=1 failed=0 checks=1 artifacts=1/);
  assert.match(detail, /next=warning claim:handoff:handoff-1/);
  assert.match(detail, /Shared Board/);
  assert.match(detail, /participants=1 active=1 inactive=0 inbox=0 outbox=1 Workspace Claims=2 negotiations=0 squads=0 warnings=0/);
  assert.match(detail, /worker:kernel-1 \[worker\/busy\/fresh\].*task=task-1 worker=worker-1/);
  assert.match(detail, /owner=actor_task:task-1 \[busy\] agent=worker:kernel-1/);
  assert.match(detail, /owner=handoff:handoff-1 \[accepted\] agent=worker:worker-1 env=env_handoff_kernel/);
  assert.match(detail, /Run Attempts/);
  assert.match(detail, /tool_call task-1 \[completed\] #1/);
  assert.match(detail, /Workspace Access/);
  assert.match(detail, /lease-1 boundary=workspace/);
  assert.match(detail, /Workers/);
  assert.match(detail, /worker-1/);
  assert.match(detail, /Approvals/);
  assert.match(detail, /approval-1 \[pending\] r1\/write file.write src\/allowed.txt/);
  assert.match(detail, /Handoffs/);
  assert.match(detail, /handoff-1 \[active\] main_swarm -> reviewer Review scoped write/);
    assert.match(detail, /Symphony/);
    assert.match(detail, /sessions=2 running=1 retrying=1 capacity=1\/3/);
    assert.match(detail, /live_control=retrying severity=warning/);
    assert.match(detail, /daemons=daemon-1:running:ticks=4/);
    assert.match(detail, /symphony-session \[running\] live=running\/info SYM-1/);
  assert.match(detail, /lsp=unknown value=NO PROVIDER tone=muted severity=info/);
  assert.match(detail, /Board/);
  assert.match(detail, /decision\/operator \[decision\] tags=p3,tui/);
  assert.match(detail, /Recent Events/);
  assert.match(detail, /approval: pending/);
});

test("kernel status formatter derives LSP service health from live status report", () => {
  const state = buildTuiState();
  const detail = formatKernelStatusView({
    runtime: kernelRuntimeFixture() as never,
    busy: false,
    runMode: "auto",
    taskCompleted: state.taskCompleted,
    taskTotal: state.taskTotal,
    taskStates: state.taskStates,
    toolResults: [],
    workers: new Map(),
    handoffs: new Map(),
    symphonyStatus: symphonyStatusFixture(),
    symphonyDaemons: [],
    lspStatusReport: lspStatusReportFixture("unavailable"),
    events: []
  });

  assert.match(detail, /lsp=not-configured value=NO PROVIDER tone=warning severity=warning/);
});

test("work snapshot formatters expose operator kernel contract detail without Ink rendering", () => {
  const snapshot = workSnapshotFixture();
  const compact = compactWorkSnapshotLines(snapshot);
  const detail = formatWorkSnapshot(snapshot);

  assert(compact.some((line) => line.includes("session-1 [running] source=gateway")));
  assert(compact.some((line) => line.includes("contracts=running 1 pending 0 active 1 resumable 1 handoffs 1")));
  assert(compact.some((line) => line.includes("scope=src/allowed.txt, docs/PRD.md")));

  assert.match(detail, /Workspace/);
  assert.match(detail, /Runs: 1/);
  assert.match(detail, /Tasks: 1/);
  assert.match(detail, /Task Contracts: total=1 pending=0 running=1 blocked=0 completed=0 failed=0 ro=0 scoped=1 workspace=0/);
  assert.match(detail, /Team: 1/);
  assert.match(detail, /Work Contracts: running=1 pending=0 active=1 resumable=1 handoffs=1 ro=0 scoped=2 workspace=0/);
  assert.match(detail, /handoff-1 \[active\].*policy=scoped_write scope=docs\/PRD.md/);
  assert.match(detail, /Changes: 1/);
  assert.match(detail, /Verification: 1/);
  assert.match(detail, /Review: approve 0.92 - good/);
  assert.match(detail, /Context Memory/);
});

test("compact idle rows prioritize attention states and shorten noisy ids", () => {
  const rows = formatCompactIdleRows([
    {
      key: "healthy",
      id: "session-healthy-completed-123456789",
      title: "Healthy completed output with a very long summary that should stay compact inside a narrow idle pane",
      status: "completed",
      meta: ["saved", "updated=00:10"],
      priority: 10
    },
    {
      key: "running",
      id: "worker-running-123456789",
      title: "Apply compact row polish",
      status: "running",
      meta: ["coder", "scope=src/tui/SwarmChatApp.tsx"],
      priority: 75
    },
    {
      key: "blocked",
      id: "attempt-blocked-123456789",
      title: "Recover blocked worker",
      status: "blocked",
      meta: ["worker_run", "error=blocked"],
      priority: 85
    },
    {
      key: "failed",
      id: "session-failed-123456789",
      title: "Failed idle pane render",
      status: "failed",
      meta: ["gateway", "updated=00:09"],
      priority: 95
    }
  ]);

  assert.match(rows[0] ?? "", /\[ERR\] session-fai/);
  assert.match(rows[1] ?? "", /\[WARN\] attempt-bl/);
  assert.match(rows[2] ?? "", /\[RUN\] worker-run/);
  assert.match(rows[3] ?? "", /\[OK\] session-hea/);
  assert(rows.every((line) => !line.includes("123456789")));
  assert(rows.every((line) => line.length < 150));
});

test("TUI work state preserves task policy and scope from work protocol records", () => {
  let state: TuiWorkState = {
    taskStates: new Map(),
    taskCompleted: 0,
    taskTotal: 0
  };
  state = applyWorkRecordToTuiState(state, {
    schema_version: SWARM_WORK_PROTOCOL_VERSION,
    kind: "task",
    at: "2026-05-12T00:00:00.000Z",
    task_id: "task-1",
    title: "Scoped task",
    phase: "completed",
    status: "success",
    capability: "file.write",
    write_policy: "scoped_write",
    file_scope: ["src/allowed.txt"],
    summary: "done",
    result_status: "success"
  } as WorkProtocolRecord);

  assert.equal(state.taskCompleted, 1);
  assert.equal(state.taskTotal, 1);
  assert.equal(state.taskStates.get("task-1")?.writePolicy, "scoped_write");
  assert.deepEqual(state.taskStates.get("task-1")?.fileScope, ["src/allowed.txt"]);
  assert.deepEqual(summarizeTaskWritePolicies(state.taskStates), {
    readOnly: 0,
    scopedWrite: 1,
    workspaceWrite: 0,
    mutating: 1,
    scopedTargets: ["src/allowed.txt"]
  });
});

function buildTuiState(): TuiWorkState {
  return applyWorkRecordToTuiState({
    taskStates: new Map(),
    taskCompleted: 0,
    taskTotal: 0
  }, {
    schema_version: SWARM_WORK_PROTOCOL_VERSION,
    kind: "task",
    at: "2026-05-12T00:00:00.000Z",
    task_id: "task-1",
    title: "Write scoped file",
    phase: "completed",
    status: "completed",
    capability: "file.write",
    write_policy: "scoped_write",
    file_scope: ["src/allowed.txt"],
    summary: "created file",
    result_status: "success"
  } as WorkProtocolRecord);
}

function kernelRuntimeFixture(): {
  listRecentSessionsForWorkspace(limit?: number): SwarmSession[];
  listRecentAttemptsForWorkspace(limit?: number): RunAttempt[];
  listRecentLeasesForWorkspace(limit?: number): WorkspaceLease[];
  listRecentWorkersForWorkspace(limit?: number): WorkerRecord[];
  listRecentApprovalsForWorkspace(limit?: number): ApprovalRecord[];
  listHandoffsForWorkspace(limit?: number): HandoffSessionRecord[];
  listRecentBlackboardForWorkspace(limit?: number): Array<{
    created_at: string;
    session_id: string;
    key: string;
    type: string;
    tags?: string[];
  }>;
  getWorkspacePath(): string;
  artifactStore: {
    list(sessionId: string): Array<{
      artifact_id: string;
      session_id: string;
      path: string;
      type: string;
      summary?: string;
      created_at?: string;
    }>;
  };
  sessionStore: {
    listRecent(limit?: number): Array<SwarmSession & { workspace_lease_id?: string | null }>;
  };
  workspaceLeaseStore: {
    get(leaseId: string): WorkspaceLease | undefined;
    getBySession(sessionId: string): WorkspaceLease | undefined;
  };
  agentActorStore: {
    list(input?: { now?: string }): AgentActorRecord[];
    mailbox(actorId: string): AgentMailboxProjection;
    listMailboxMessages(actorId: string, direction: "inbox" | "outbox", options?: { limit?: number }): AgentMailboxMessage[];
  };
  agentMemoryStore: {
    project(actorId: string): AgentMemoryProjection;
  };
  getWorkSnapshot(sessionId: string): WorkSnapshot;
} {
  return {
    listRecentSessionsForWorkspace: () => [sessionRecord()],
    listRecentAttemptsForWorkspace: () => [runAttempt()],
    listRecentLeasesForWorkspace: () => [workspaceLease()],
    listRecentWorkersForWorkspace: () => [workerRecord("worker-1")],
    listRecentApprovalsForWorkspace: () => [approvalRecord()],
    listHandoffsForWorkspace: () => [handoffRecord("handoff-1")],
    listRecentBlackboardForWorkspace: () => [{
      created_at: "2026-05-12T00:08:00.000Z",
      session_id: "session-1",
      key: "decision/operator",
      type: "decision",
      tags: ["p3", "tui"]
    }],
    getWorkspacePath: () => "E:/tmp/root/workspace",
    artifactStore: {
      list: (sessionId) => [{
        artifact_id: "artifact-1",
        session_id: sessionId,
        path: "reports/work-board.md",
        type: "report",
        summary: "Work board fixture",
        created_at: "2026-05-12T00:09:00.000Z"
      }]
    },
    sessionStore: {
      listRecent: () => [{ ...sessionRecord(), workspace_lease_id: "lease-1" }]
    },
    workspaceLeaseStore: {
      get: () => workspaceLease(),
      getBySession: () => workspaceLease()
    },
    agentActorStore: {
      list: () => [agentActorRecord()],
      mailbox: () => agentMailboxProjection(),
      listMailboxMessages: (_actorId, direction) => direction === "inbox" ? [agentInboxMessage()] : [agentOutboxMessage()]
    },
    agentMemoryStore: {
      project: (actorId) => agentMemoryProjection(actorId)
    },
    getWorkSnapshot: () => workSnapshotFixture()
  };
}

function agentActorRecord(): AgentActorRecord {
  return {
    actor_id: "worker:kernel-1",
    kind: "worker",
    name: "Kernel Worker",
    role: "coder",
    status: "busy",
    capabilities: ["file.write"],
    load: { running_tasks: 1, max_tasks: 2 },
    current_task_id: "task-1",
    current_worker_id: "worker-1",
    current_session_id: "session-1",
    current_ownership: { kind: "task", task_id: "task-1" },
    heartbeat_state: "fresh",
    last_heartbeat_at: "2026-05-12T00:10:00.000Z",
    last_seen_at: "2026-05-12T00:10:00.000Z",
    registered_at: "2026-05-12T00:05:00.000Z",
    updated_at: "2026-05-12T00:10:00.000Z",
    metadata: {}
  };
}

function agentMailboxProjection(): AgentMailboxProjection {
  return {
    actor_id: "worker:kernel-1",
    inbox_total: 1,
    inbox_pending: 0,
    inbox_delivered: 0,
    inbox_acked: 1,
    inbox_failed: 0,
    outbox_total: 1,
    outbox_pending: 1,
    outbox_delivered: 0,
    outbox_acked: 0,
    outbox_failed: 0,
    current_task_id: "task-1",
    current_worker_id: "worker-1",
    current_session_id: "session-1"
  };
}

function agentInboxMessage(): AgentMailboxMessage {
  return {
    delivery_id: "delivery-kernel-inbox",
    envelope_id: "env_task_assign_kernel",
    direction: "inbox",
    session_id: "session-1",
    swarm_id: "swarm-1",
    task_id: "task-1",
    type: "task.assign",
    intent: "Assign kernel task",
    status: "acked",
    from_agent_id: "main_swarm",
    recipient_agent_id: "worker:kernel-1",
    queued_at: "2026-05-12T00:05:00.000Z",
    acked_at: "2026-05-12T00:05:01.000Z"
  };
}

function agentOutboxMessage(): AgentMailboxMessage {
  return {
    delivery_id: "delivery-kernel-outbox",
    envelope_id: "env_task_progress_kernel",
    direction: "outbox",
    session_id: "session-1",
    swarm_id: "swarm-1",
    task_id: "task-1",
    type: "task.progress",
    intent: "Report kernel progress",
    status: "queued",
    from_agent_id: "worker:kernel-1",
    recipient_agent_id: "main_swarm",
    queued_at: "2026-05-12T00:06:00.000Z"
  };
}

function agentMemoryProjection(actorId: string): AgentMemoryProjection {
  return {
    actor_id: actorId,
    profile_summary: "",
    cache_stable_summary: "Recent task experience:\n- Kernel status rendered swarm memory.",
    cache_stable_summary_hash: "amx:kernel123456",
    frozen: false,
    last_learned_at: "2026-05-12T00:06:00.000Z",
    last_compacted_at: "2026-05-12T00:06:00.000Z",
    updated_at: "2026-05-12T00:06:00.000Z",
    metadata: {},
    health: "active",
    entries: 1,
    recent_tasks: ["Kernel status rendered swarm memory."],
    learned_constraints: [],
    failure_patterns: [],
    trusted_tools: []
  };
}

function workSnapshotFixture(): WorkSnapshot {
  return {
    session: {
      session_id: "session-1",
      swarm_id: "swarm-1",
      objective: "Ship operator surface",
      status: "running",
      source: {
        source: "gateway",
        source_id: "run-1",
        title: "Gateway run",
        labels: ["p3"],
        metadata: {}
      },
      created_at: "2026-05-12T00:00:00.000Z",
      updated_at: "2026-05-12T00:10:00.000Z"
    },
    workspace: workspaceLease(),
    attempts: [runAttempt()],
    workers: [workerRecord("worker-1")],
    graph: {
      tasks: [{
        session_id: "session-1",
        swarm_id: "swarm-1",
        task_id: "task-1",
        title: "Write scoped file",
        status: "running",
        attempt: 1,
        required_capabilities: ["file.write"],
        dependencies: [],
        capability: "file.write",
        write_policy: "scoped_write",
        file_scope: ["src/allowed.txt"],
        updated_at: "2026-05-12T00:04:00.000Z"
      }],
      edges: []
    },
    blackboard_counts: { decision: 1 },
    changed_files: ["src/allowed.txt"],
    checks: ["npm test"],
    review: {
      target_task_id: "task-1",
      reviewer: { agent_id: "reviewer" },
      verdict: "approve",
      score: 0.92,
      summary: "good"
    },
    usage_summary: { approval: 1 },
    task_contracts: {
      summary: {
        total: 1,
        pending: 0,
        running: 1,
        blocked: 0,
        completed: 0,
        failed: 0,
        read_only: 0,
        scoped_write: 1,
        workspace_write: 0,
        scoped_targets: ["src/allowed.txt"]
      },
      tasks: [{
        task_id: "task-1",
        title: "Write scoped file",
        status: "running",
        attempt: 1,
        capability: "file.write",
        write_policy: "scoped_write",
        file_scope: ["src/allowed.txt"],
        dependencies: [],
        updated_at: "2026-05-12T00:04:00.000Z"
      }]
    },
    work_contracts: {
      summary: {
        active_workers: 1,
        running_workers: 1,
        pending_workers: 0,
        resumable_workers: 1,
        active_handoffs: 1,
        read_only: 0,
        scoped_write: 2,
        workspace_write: 0,
        scoped_targets: ["src/allowed.txt", "docs/PRD.md"]
      },
      active_workers: [{
        worker_id: "worker-1",
        display_name: "Worker One",
        status: "running",
        capability: "local_tool.Write",
        objective: "Write scoped file",
        agent_spec_id: "coder",
        invocation_mode: "call_subagent",
        write_policy: "scoped_write",
        file_scope: ["src/allowed.txt"],
        updated_at: "2026-05-12T00:05:00.000Z"
      }],
      resumable_workers: [{
        worker_id: "worker-2",
        display_name: "Worker Two",
        status: "stopped",
        capability: "local_tool.Write",
        objective: "Resume scoped file",
        write_policy: "scoped_write",
        file_scope: ["docs/PRD.md"],
        updated_at: "2026-05-12T00:06:00.000Z"
      }],
      active_handoffs: [{
        handoff_id: "handoff-1",
        worker_id: "worker-1",
        source_agent: "main_swarm",
        target_agent_spec_id: "reviewer",
        reason: "Review scoped write",
        status: "active",
        write_policy: "scoped_write",
        file_scope: ["docs/PRD.md"],
        scope: ["docs/PRD.md"],
        updated_at: "2026-05-12T00:07:00.000Z"
      }]
    },
    context_summary: {
      entries: 2,
      compactions: 1,
      health: "compacted",
      last_compacted_at: "2026-05-12T00:09:00.000Z",
      latest_compaction: {
        compaction_id: "cmp-1",
        pre_tokens: 1000,
        post_tokens: 400,
        strategy: "test",
        created_at: "2026-05-12T00:09:00.000Z"
      }
    },
    final_outcome: {
      changed_files: ["src/allowed.txt"],
      intermediate_artifacts: [],
      tests_run: ["npm test"],
      final_summary: "not done"
    }
  };
}

function sessionRecord(): SwarmSession {
  return {
    swarm_id: "swarm-1",
    session_id: "session-1",
    user_request_id: "request-1",
    source: {
      source: "gateway",
      source_id: "run-1",
      title: "Gateway run",
      labels: ["p3"],
      metadata: {}
    },
    objective: "Ship operator surface",
    status: "running",
    coordinator: { agent_id: "main_swarm" },
    participants: [],
    created_at: "2026-05-12T00:00:00.000Z",
    updated_at: "2026-05-12T00:10:00.000Z",
    policy: {
      max_agents: 2,
      max_parallel_tasks: 1,
      timeout_ms: 120000,
      retry: { max_attempts: 1, backoff_ms: 0 },
      require_review: false,
      consensus: "coordinator_decision",
      safety: {
        require_human_approval_for: [],
        forbidden_capabilities: [],
        sandbox_required: true
      },
      memory: {
        allow_read: true,
        allow_write: true,
        retention: "session"
      }
    }
  };
}

function workspaceLease(): WorkspaceLease {
  return {
    lease_id: "lease-1",
    session_id: "session-1",
    workspace_root: "E:/tmp/root",
    workspace_path: "E:/tmp/root/workspace",
    scope: ["src/allowed.txt"],
    write_boundary: "workspace",
    created_at: "2026-05-12T00:01:00.000Z",
    metadata: {}
  };
}

function runAttempt(): RunAttempt {
  return {
    attempt_id: "attempt-1",
    session_id: "session-1",
    task_id: "task-1",
    kind: "tool_call",
    status: "completed",
    attempt: 1,
    title: "Write scoped file",
    started_at: "2026-05-12T00:02:00.000Z",
    ended_at: "2026-05-12T00:03:00.000Z",
    last_event_at: "2026-05-12T00:03:00.000Z",
    workspace_path: "E:/tmp/root/workspace",
    metadata: {}
  };
}

function workerRecord(workerId: string): WorkerRecord {
  return {
    worker_id: workerId,
    display_name: "Worker One",
    parent_session_id: "session-1",
    capability: "local_tool.Write",
    objective: "Write scoped file",
    status: "running",
    file_scope: ["src/allowed.txt"],
    tool_budget: { max_turns: 3, max_tool_calls: 10 },
    task_packet: {
      objective: "Write scoped file",
      agent_spec_id: "coder",
      invocation_mode: "call_subagent",
      persona_snapshot: "Coder",
      file_scope: ["src/allowed.txt"],
      allowed_tools: ["Write"],
      write_policy: "scoped_write",
      permission_context: {
        default_mode: "ask",
        allow: [],
        ask: [],
        deny: [],
        additional_directories: []
      },
      budget: { max_turns: 3, max_tool_calls: 10 },
      expected_output: "Summary",
      return_conditions: ["done"]
    },
    created_at: "2026-05-12T00:05:00.000Z",
    updated_at: "2026-05-12T00:06:00.000Z"
  };
}

function handoffRecord(handoffId: string): HandoffSessionRecord {
  return {
    handoff_id: handoffId,
    worker_id: "worker-1",
    parent_session_id: "session-1",
    source_agent: "main_swarm",
    target_agent_spec_id: "reviewer",
    reason: "Review scoped write",
    status: "active",
    protocol_status: "accepted",
    owner_agent_id: "worker:worker-1",
    last_envelope_id: "env_handoff_kernel",
    task_packet: {
      objective: "Review scoped file",
      agent_spec_id: "reviewer",
      invocation_mode: "handoff",
      persona_snapshot: "Reviewer",
      file_scope: ["docs/PRD.md"],
      allowed_tools: ["Read"],
      write_policy: "scoped_write",
      permission_context: {
        default_mode: "ask",
        allow: [],
        ask: [],
        deny: [],
        additional_directories: []
      },
      budget: { max_turns: 2, max_tool_calls: 5 },
      expected_output: "Review",
      return_conditions: ["reviewed"]
    },
    created_at: "2026-05-12T00:07:00.000Z",
    updated_at: "2026-05-12T00:07:00.000Z"
  };
}

function approvalRecord(): ApprovalRecord {
  return {
    approval_id: "approval-1",
    session_id: "session-1",
    task_id: "task-1",
    action: "file.write",
    summary: "Write file: src/allowed.txt",
    detail: "Path: src/allowed.txt",
    risk: "write",
    risk_class: "r1",
    target: "src/allowed.txt",
    status: "pending",
    challenge: {
      id: "approval-1",
      session_id: "session-1",
      task_id: "task-1",
      action: "file.write",
      summary: "Write file: src/allowed.txt",
      detail: "Path: src/allowed.txt",
      risk: "write",
      risk_class: "r1",
      target: "src/allowed.txt",
      why_now: "Need to write scoped file.",
      predicted_impact: "Creates a scoped file.",
      rollback_plan: "Delete the file.",
      permission_decision: "ask",
      permission_mode: "ask",
      permission_name: "Write",
      permission_rule: "Write(**)"
    },
    created_at: "2026-05-12T00:11:00.000Z",
    updated_at: "2026-05-12T00:11:00.000Z"
  };
}

function symphonyStatusFixture(): SymphonyStatus {
  const workBoard = buildWorkBoardFromSnapshots({
    scope: {
      kind: "symphony",
      workspace_path: "E:/tmp/root/workspace"
    },
    snapshots: [workSnapshotFixture()],
    generatedAt: "2026-05-12T00:12:00.000Z"
  });
  return {
    workflow: {
      ok: true,
      workflow: {
        path: "E:/tmp/WORKFLOW.md",
        config: {},
        prompt_template: "Implement {{issue.title}}"
      }
    },
    generated_at: "2026-05-12T00:12:00.000Z",
    totals: {
      sessions: 2,
      running: 1,
      completed: 0,
      failed: 0,
      cancelled: 0,
      retrying: 1
    },
    scheduler: {
      claimed: ["fake:SYM-1"],
      completed: [],
      running: [{
        key: "fake:SYM-1",
        session_id: "symphony-session",
        work_item: {
          source: "symphony",
          source_id: "SYM-1",
          human_id: "SYM-1",
          title: "Symphony work",
          labels: [],
          metadata: {}
        },
        workspace_path: "E:/tmp/symphony",
        started_at: "2026-05-12T00:12:00.000Z",
        status: "running",
        live_control: liveControlProjection({
          status: "running",
          source: "symphony.session",
          summary: "symphony.session symphony-session: running",
          legacyStatus: "running"
        })
      }],
      retrying: [{
        key: "fake:SYM-2",
        work_item: {
          source: "symphony",
          source_id: "SYM-2",
          human_id: "SYM-2",
          title: "Retry work",
          labels: [],
          metadata: {}
        },
        attempt: 2,
        due_at: "2026-05-12T00:30:00.000Z",
        error: "retry",
        live_control: liveControlProjection({
          status: "retrying",
          source: "symphony.retry",
          summary: "symphony retry fake:SYM-2 attempt=2"
        })
      }],
      capacity: {
        max_concurrent: 3,
        running: 1,
        available: 2
      }
    },
    live_control: liveControlProjection({
      status: "retrying",
      source: "symphony",
      summary: "symphony sessions=2 running=1 retrying=1"
    }),
    work_board: workBoard,
    sessions: []
  };
}

function symphonyDaemonFixture(): SymphonyDaemonRecord {
  return {
    daemon_id: "daemon-1",
    daemon_key: "daemon-key",
    status: "running",
    workflow_path: "E:/tmp/WORKFLOW.md",
    create_workspace: false,
    execute: false,
    max_ticks: 5,
    tick_count: 4,
    created_at: "2026-05-12T00:13:00.000Z",
    started_at: "2026-05-12T00:13:00.000Z",
    updated_at: "2026-05-12T00:14:00.000Z",
    history: []
  };
}

function lspStatusReportFixture(status: "ready" | "unavailable" | "failed" | "exited"): LspStatusReport {
  return {
    workspace: "E:/tmp/workspace",
    generatedAt: "2026-05-12T00:15:00.000Z",
    providers: [{
      providerId: "python",
      root: "E:/tmp/workspace",
      status,
      languageIds: ["python"],
      logPath: "E:/tmp/lsp/python.log",
      metadataPath: "E:/tmp/lsp/python.json",
      detected: true,
      available: status !== "unavailable",
      reason: status === "unavailable" ? "Install pyright-langserver or set SWARM_LSP_PYTHON_COMMAND." : undefined
    }]
  };
}

function runtimeEventsFixture(): RuntimeEvent[] {
  return [
    {
      type: "approval",
      request: approvalRecord().challenge,
      status: "pending"
    }
  ];
}
