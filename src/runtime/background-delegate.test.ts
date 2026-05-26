import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentInvocationRequest } from "./agent-specs.js";
import { auditProtocolMigration, buildProtocolReplay } from "./protocol-replay.js";
import { SwarmRuntime } from "./runtime.js";
import type { SwarmPolicy } from "../protocol/types.js";
import type { ToolResult } from "../tools/types.js";

test("parallel agent.delegate launches in the background and records completion later", async () => {
  const fixture = createFixture();
  const runtime = new SwarmRuntime({
    workspace: fixture.workspace,
    databasePath: fixture.databasePath,
    approvalHandler: async () => true
  });
  const sessionId = "session-background-delegate";
  let releaseWorker: (() => void) | undefined;
  let workerGenerateStarted = false;
  let workerGenerateCompleted = false;
  const workerGate = new Promise<void>((resolve) => {
    releaseWorker = resolve;
  });

  try {
    seedSession(runtime, sessionId);
    runtimeProvider(runtime).generateText = async (request) => {
      if (request.usage?.purpose === "agent_spawn_decision") {
        return JSON.stringify({
          agent_spec_id: "researcher",
          invocation_mode: "parallel",
          reason: "Independent background research can run while main continues.",
          confidence: 1,
          display_name: "Async Scout",
          role_title: "Background Researcher",
          persona_brief: "Investigates the assigned question and returns concise evidence."
        });
      }
      workerGenerateStarted = true;
      await workerGate;
      workerGenerateCompleted = true;
      return JSON.stringify({
        status: "completed",
        summary: "Background research complete",
        message: "Background research complete with concise evidence.",
        files_touched: [],
        next_actions: [],
        tool_calls: []
      });
    };

    const launch = runtimeAccess(runtime).invokeAgent({
      parent_session_id: sessionId,
      requested_by: "main_swarm",
      capability: "code.research",
      task: "Research the independent cache hit path as a background subagent and report concise evidence for the main agent.",
      preferred_agent_spec_id: "researcher",
      preferred_mode: "parallel",
      file_scope: ["src/runtime/runtime.ts"],
      spawn_reason: "background delegate test"
    });
    const launched = await Promise.race([
      launch,
      delay(250).then(() => "timeout" as const)
    ]);

    if (launched === "timeout") {
      assert.fail("parallel delegate did not return before the worker completed.");
    }
    assert.equal(launched.status, "partial");
    assert.match(launched.summary, /launched in background/);
    await waitFor(() => workerGenerateStarted);
    assert.equal(workerGenerateCompleted, false);

    const data = launched.data as { worker_id?: string; background?: boolean; worker_status?: string };
    assert.equal(data.background, true);
    assert(data.worker_id, "expected launched result to include worker_id");
    assert.equal(runtime.workerStateStore.get(data.worker_id)?.status, "running");

    releaseWorker?.();
    await waitFor(() => runtime.workerStateStore.get(data.worker_id!)?.status === "completed");
    const worker = runtime.workerStateStore.get(data.worker_id);
    assert.equal(worker?.last_result, "Background research complete with concise evidence.");
    assert.match(runtime.sessionContextStore.renderForSession(sessionId), /Completed .*Background research complete/);

    const workerActorId = `worker:${data.worker_id}`;
    const mailbox = runtime.agentActorStore.mailbox(workerActorId);
    assert.equal(mailbox.inbox_total, 1);
    assert.equal(mailbox.outbox_total >= 4, true);
    assert.equal(mailbox.current_task_id, undefined);
    assert.equal(mailbox.current_worker_id, undefined);

    const trace = runtime.traceStore.list(sessionId).filter((envelope) => envelope.task_id === data.worker_id);
    assert.deepEqual(trace.map((envelope) => envelope.type), [
      "task.assign",
      "task.accept",
      "task.start",
      "task.checkpoint",
      "task.result"
    ]);

    const assignment = trace.find((envelope) => envelope.type === "task.assign");
    assert(assignment, "expected durable task.assign envelope");
    const assignmentDelivery = runtime.envelopeDeliveryStore.list({ envelopeId: assignment.id });
    assert.equal(assignmentDelivery.length, 1);
    assert.equal(assignmentDelivery[0]?.recipient_agent_id, workerActorId);
    assert.equal(assignmentDelivery[0]?.status, "acked");

    const responseDeliveries = runtime.envelopeDeliveryStore.list({ sessionId, agentId: workerActorId });
    assert(responseDeliveries.some((delivery) => delivery.type === "task.accept" && delivery.status === "delivered"));
    assert(responseDeliveries.some((delivery) => delivery.type === "task.start" && delivery.status === "delivered"));
    assert(responseDeliveries.some((delivery) => delivery.type === "task.checkpoint" && delivery.status === "delivered"));
    assert(responseDeliveries.some((delivery) => delivery.type === "task.result" && delivery.status === "delivered"));

    const replay = buildProtocolReplay({
      sessionId,
      envelopes: runtime.traceStore.list(sessionId),
      deliveries: runtime.envelopeDeliveryStore.list({ sessionId }),
      actors: runtime.agentActorStore.list(),
      blackboard: runtime.blackboardStore.list(sessionId)
    });
    const replayWorker = replay.workers.find((item) => item.worker_id === data.worker_id);
    assert.equal(replayWorker?.status, "completed");
    assert.equal(replayWorker?.owner_agent_id, workerActorId);
    assert.equal(replayWorker?.capability, "code.research");
    assert.equal(replayWorker?.checkpoints.length, 1);
    assert.equal(replayWorker?.result?.output_ref?.includes(`${data.worker_id}.result`), true);

    const audit = auditProtocolMigration({
      sessionId,
      replay,
      workers: runtime.workerStateStore.listByParent(sessionId),
      handoffs: runtime.handoffStore.listByParent(sessionId),
      symphonyClaims: []
    });
    assert.equal(audit.status, "pass");
    assert.equal(audit.summary.errors, 0);
    assert.equal(audit.summary.direct_workers, 1);
    assert.equal(audit.summary.replay_workers, 1);

    const status = await runtimeAccess(runtime).invokeCapability("local_tool.AgentStatus", { worker_id: data.worker_id }, sessionId, { taskId: "agent-status-test" });
    assert.equal(status.status, "success");
    assert.match(status.summary, /completed/);
    assert.match(status.content ?? "", /Background research complete/);

    const list = await runtimeAccess(runtime).invokeCapability("local_tool.AgentList", { parent_session_id: sessionId, status: "completed" }, sessionId, { taskId: "agent-list-test" });
    assert.equal(list.status, "success");
    assert.match(list.content ?? "", new RegExp(data.worker_id));
  } finally {
    releaseWorker?.();
    runtime.dispose();
    fixture.close();
  }
});

test("call_subagent agent.delegate waits for protocol result and matches worker projection", async () => {
  const fixture = createFixture();
  const runtime = new SwarmRuntime({
    workspace: fixture.workspace,
    databasePath: fixture.databasePath,
    approvalHandler: async () => true
  });
  const sessionId = "session-call-subagent-delegate";

  try {
    seedSession(runtime, sessionId);
    runtimeProvider(runtime).generateText = async (request) => {
      if (request.usage?.purpose === "agent_spawn_decision") {
        return JSON.stringify({
          agent_spec_id: "researcher",
          invocation_mode: "call_subagent",
          reason: "Synchronous focused research should return before main continues.",
          confidence: 1,
          display_name: "Sync Scout",
          role_title: "Focused Researcher",
          persona_brief: "Returns concise synchronous evidence."
        });
      }
      return JSON.stringify({
        status: "completed",
        summary: "Synchronous research complete",
        message: "Synchronous research complete with concise evidence.",
        files_touched: [],
        next_actions: [],
        tool_calls: []
      });
    };

    const result = await runtimeAccess(runtime).invokeAgent({
      parent_session_id: sessionId,
      requested_by: "main_swarm",
      capability: "code.research",
      task: "Research the synchronous cache hit path as a subagent and return before the main agent continues.",
      preferred_agent_spec_id: "researcher",
      preferred_mode: "call_subagent",
      file_scope: ["src/runtime/runtime.ts"],
      spawn_reason: "call subagent ownership test"
    });

    assert.equal(result.status, "success");
    assert.match(result.summary, /Research Agent completed/);
    const data = result.data as { worker_id?: string; worker_status?: string; background?: boolean };
    assert(data.worker_id, "expected result to include worker_id");
    assert.equal(data.background, undefined);
    assert.equal(data.worker_status, "completed");

    const worker = runtime.workerStateStore.get(data.worker_id);
    assert.equal(worker?.status, "completed");
    assert.equal(worker?.last_result, "Synchronous research complete with concise evidence.");

    const workerActorId = `worker:${data.worker_id}`;
    const mailbox = runtime.agentActorStore.mailbox(workerActorId);
    assert.equal(mailbox.inbox_total, 1);
    assert.equal(mailbox.outbox_total >= 4, true);
    assert.equal(mailbox.current_task_id, undefined);

    const trace = runtime.traceStore.list(sessionId).filter((envelope) => envelope.task_id === data.worker_id);
    assert.deepEqual(trace.map((envelope) => envelope.type), [
      "task.assign",
      "task.accept",
      "task.start",
      "task.checkpoint",
      "task.result"
    ]);
    const assignment = trace.find((envelope) => envelope.type === "task.assign");
    assert(assignment);
    assert.equal(runtime.envelopeDeliveryStore.list({ envelopeId: assignment.id })[0]?.status, "acked");

    const replay = buildProtocolReplay({
      sessionId,
      envelopes: runtime.traceStore.list(sessionId),
      deliveries: runtime.envelopeDeliveryStore.list({ sessionId }),
      actors: runtime.agentActorStore.list(),
      blackboard: runtime.blackboardStore.list(sessionId)
    });
    const replayWorker = replay.workers.find((item) => item.worker_id === data.worker_id);
    assert.equal(replayWorker?.status, "completed");
    assert.equal(replayWorker?.owner_agent_id, workerActorId);
    assert.equal(replayWorker?.result?.summary, "Synchronous research complete with concise evidence.");

    const audit = auditProtocolMigration({
      sessionId,
      replay,
      workers: runtime.workerStateStore.listByParent(sessionId),
      handoffs: runtime.handoffStore.listByParent(sessionId),
      symphonyClaims: []
    });
    assert.equal(audit.status, "pass");
    assert.equal(audit.summary.errors, 0);
  } finally {
    runtime.dispose();
    fixture.close();
  }
});

test("handoff agent.delegate records ownership transfer protocol lifecycle", async () => {
  const fixture = createFixture();
  const runtime = new SwarmRuntime({
    workspace: fixture.workspace,
    databasePath: fixture.databasePath,
    approvalHandler: async () => true
  });
  const sessionId = "session-handoff-delegate";

  try {
    seedSession(runtime, sessionId);
    runtimeProvider(runtime).generateText = async (request) => {
      if (request.usage?.purpose === "agent_spawn_decision") {
        return JSON.stringify({
          agent_spec_id: "handoff_specialist",
          invocation_mode: "handoff",
          reason: "Focused handoff specialist should own this protocol segment.",
          confidence: 1,
          display_name: "Protocol Handoff",
          role_title: "Handoff Protocol Specialist",
          persona_brief: "Owns the handoff segment and returns a precise result contract."
        });
      }
      return JSON.stringify({
        status: "completed",
        summary: "Handoff protocol review complete",
        message: "Handoff protocol review complete with ownership evidence.",
        files_touched: [],
        next_actions: [],
        tool_calls: []
      });
    };

    const result = await runtimeAccess(runtime).invokeAgent({
      parent_session_id: sessionId,
      requested_by: "main_swarm",
      capability: "handoff.deep_work",
      task: "Own the focused handoff ownership protocol review and return concrete evidence for the main Swarm.",
      preferred_agent_spec_id: "handoff_specialist",
      preferred_mode: "handoff",
      file_scope: ["src/runtime/runtime.ts", "src/storage/handoff-store.ts"],
      spawn_reason: "handoff ownership lifecycle test"
    });

    assert.equal(result.status, "success");
    assert.match(result.summary, /Handoff Specialist completed/);
    const data = result.data as { worker_id?: string; handoff_id?: string; worker_status?: string };
    assert(data.worker_id, "expected result to include worker_id");
    assert(data.handoff_id, "expected result to include handoff_id");
    assert.equal(data.worker_status, "completed");

    const workerActorId = `worker:${data.worker_id}`;
    const workerTrace = runtime.traceStore.list(sessionId).filter((envelope) => envelope.task_id === data.worker_id);
    assert.deepEqual(workerTrace.map((envelope) => envelope.type), [
      "task.assign",
      "task.accept",
      "task.start",
      "task.checkpoint",
      "task.result"
    ]);

    const handoffTrace = runtime.traceStore.list(sessionId).filter((envelope) => envelope.task_id === data.handoff_id);
    assert.deepEqual(handoffTrace.map((envelope) => envelope.type), [
      "handoff.request",
      "handoff.accept",
      "handoff.checkpoint",
      "handoff.return"
    ]);
    assert(handoffTrace.every((envelope) => envelope.task_id === data.handoff_id));

    const requestEnvelope = handoffTrace.find((envelope) => envelope.type === "handoff.request");
    assert(requestEnvelope);
    const requestPayload = requestEnvelope.payload as Record<string, unknown>;
    assert.equal(requestPayload.owner_agent_id, undefined);
    assert.equal(requestPayload.target_agent_id, workerActorId);

    const handoff = runtime.handoffStore.get(data.handoff_id);
    assert.equal(handoff?.status, "returned");
    assert.equal(handoff?.protocol_status, "returned");
    assert.equal(handoff?.owner_agent_id, workerActorId);
    assert.equal(handoff?.request_envelope_id, handoffTrace[0]?.id);
    assert.equal(handoff?.accept_envelope_id, handoffTrace[1]?.id);
    assert.equal(handoff?.return_envelope_id, handoffTrace[3]?.id);
    assert(handoff?.last_checkpoint, "expected handoff checkpoint projection");
    assert(handoff?.return_contract, "expected handoff return contract projection");
    assert.equal(asRecord(handoff?.return_contract).worker_status, "completed");
    assert.equal(asRecord(asRecord(handoff?.return_contract).result).summary, "Handoff protocol review complete with ownership evidence.");

    const replay = buildProtocolReplay({
      sessionId,
      envelopes: runtime.traceStore.list(sessionId),
      deliveries: runtime.envelopeDeliveryStore.list({ sessionId }),
      actors: runtime.agentActorStore.list(),
      blackboard: runtime.blackboardStore.list(sessionId)
    });
    const replayHandoff = replay.handoffs.find((item) => item.handoff_id === data.handoff_id);
    assert.equal(replayHandoff?.status, "returned");
    assert.equal(replayHandoff?.protocol_status, "returned");
    assert.equal(replayHandoff?.owner_agent_id, workerActorId);
    assert.equal(replayHandoff?.request_envelope_id, handoff?.request_envelope_id);
    assert.equal(replayHandoff?.accept_envelope_id, handoff?.accept_envelope_id);
    assert.equal(replayHandoff?.return_envelope_id, handoff?.return_envelope_id);

    const audit = auditProtocolMigration({
      sessionId,
      replay,
      workers: runtime.workerStateStore.listByParent(sessionId),
      handoffs: runtime.handoffStore.listByParent(sessionId),
      symphonyClaims: []
    });
    assert.equal(audit.status, "pass");
    assert.equal(audit.summary.errors, 0);
    assert.equal(audit.summary.direct_handoffs, 1);
    assert.equal(audit.summary.replay_handoffs, 1);
  } finally {
    runtime.dispose();
    fixture.close();
  }
});

test("takeBackHandoff emits durable ownership transition", async () => {
  const fixture = createFixture();
  const runtime = new SwarmRuntime({
    workspace: fixture.workspace,
    databasePath: fixture.databasePath,
    approvalHandler: async () => true
  });
  const sessionId = "session-handoff-take-back";
  let releaseWorker: (() => void) | undefined;
  let workerGenerateStarted = false;
  const workerGate = new Promise<void>((resolve) => {
    releaseWorker = resolve;
  });

  try {
    seedSession(runtime, sessionId);
    runtimeProvider(runtime).generateText = async (request) => {
      if (request.usage?.purpose === "agent_spawn_decision") {
        return JSON.stringify({
          agent_spec_id: "handoff_specialist",
          invocation_mode: "handoff",
          reason: "Focused handoff specialist should be recoverable by take-back.",
          confidence: 1,
          display_name: "Recoverable Handoff",
          role_title: "Recoverable Handoff Specialist",
          persona_brief: "Keeps enough state for main Swarm to take back ownership."
        });
      }
      workerGenerateStarted = true;
      await workerGate;
      return JSON.stringify({
        status: "completed",
        summary: "Worker finished after take-back",
        message: "Worker finished after take-back.",
        files_touched: [],
        next_actions: [],
        tool_calls: []
      });
    };

    const running = runtimeAccess(runtime).invokeAgent({
      parent_session_id: sessionId,
      requested_by: "main_swarm",
      capability: "handoff.deep_work",
      task: "Start a focused handoff that main Swarm will take back while the worker is still running.",
      preferred_agent_spec_id: "handoff_specialist",
      preferred_mode: "handoff",
      file_scope: ["src/runtime/runtime.ts", "src/storage/handoff-store.ts"],
      spawn_reason: "handoff take-back test"
    });

    await waitFor(() => workerGenerateStarted && runtime.handoffStore.listByParent(sessionId).length === 1);
    const activeHandoff = runtime.handoffStore.listByParent(sessionId)[0];
    assert.equal(activeHandoff?.status, "active");
    assert(activeHandoff.owner_agent_id, "expected accepted handoff owner before take-back");
    const previousOwner = activeHandoff.owner_agent_id;

    const takenBack = runtime.takeBackHandoff(activeHandoff.handoff_id);
    assert.equal(takenBack.status, "taken_back");
    assert.equal(takenBack.protocol_status, "taken_back");
    assert.equal(takenBack.owner_agent_id, "main_swarm");
    assert(takenBack.take_back_envelope_id, "expected take-back envelope id");

    releaseWorker?.();
    const result = await running;
    assert.equal(result.status, "partial");
    assert.equal((result.data as { worker_status?: string }).worker_status, "stopped");

    const handoffTrace = runtime.traceStore.list(sessionId).filter((envelope) => envelope.task_id === activeHandoff.handoff_id);
    assert.deepEqual(handoffTrace.map((envelope) => envelope.type), [
      "handoff.request",
      "handoff.accept",
      "handoff.checkpoint",
      "handoff.take_back"
    ]);
    const takeBackEnvelope = handoffTrace.find((envelope) => envelope.type === "handoff.take_back");
    assert(takeBackEnvelope);
    assert.equal(takeBackEnvelope.id, takenBack.take_back_envelope_id);
    const payload = takeBackEnvelope.payload as Record<string, unknown>;
    assert.equal(payload.requester_agent_id, "main_swarm");
    assert.equal(payload.reason, "Taken back by main Swarm.");
    assert.equal(payload.previous_owner, previousOwner);
    assert.equal(payload.resulting_owner, "main_swarm");

    const stored = runtime.handoffStore.get(activeHandoff.handoff_id);
    assert.equal(stored?.status, "taken_back");
    assert.equal(stored?.protocol_status, "taken_back");
    assert.equal(stored?.take_back_envelope_id, takeBackEnvelope.id);
    assert.equal(stored?.owner_agent_id, "main_swarm");

    const workerTrace = runtime.traceStore.list(sessionId).filter((envelope) => envelope.task_id === activeHandoff.worker_id);
    assert.deepEqual(workerTrace.map((envelope) => envelope.type), [
      "task.assign",
      "task.accept",
      "task.start",
      "task.checkpoint",
      "task.cancel"
    ]);

    const replay = buildProtocolReplay({
      sessionId,
      envelopes: runtime.traceStore.list(sessionId),
      deliveries: runtime.envelopeDeliveryStore.list({ sessionId }),
      actors: runtime.agentActorStore.list(),
      blackboard: runtime.blackboardStore.list(sessionId)
    });
    const replayHandoff = replay.handoffs.find((item) => item.handoff_id === activeHandoff.handoff_id);
    assert.equal(replayHandoff?.status, "taken_back");
    assert.equal(replayHandoff?.protocol_status, "taken_back");
    assert.equal(replayHandoff?.owner_agent_id, "main_swarm");
    assert.equal(replayHandoff?.take_back_envelope_id, takeBackEnvelope.id);
  } finally {
    releaseWorker?.();
    runtime.dispose();
    fixture.close();
  }
});

function runtimeAccess(runtime: SwarmRuntime): {
  invokeAgent: (request: AgentInvocationRequest) => Promise<ToolResult>;
  invokeCapability: (
    capabilityId: string,
    args: Record<string, unknown>,
    sessionId?: string,
    options?: { taskId?: string }
  ) => Promise<ToolResult>;
} {
  return runtime as unknown as {
    invokeAgent: (request: AgentInvocationRequest) => Promise<ToolResult>;
    invokeCapability: (
      capabilityId: string,
      args: Record<string, unknown>,
      sessionId?: string,
      options?: { taskId?: string }
    ) => Promise<ToolResult>;
  };
}

function runtimeProvider(runtime: SwarmRuntime): {
  generateText: (request: {
    usage?: { purpose?: string };
  }) => Promise<string>;
} {
  return (runtime as unknown as {
    provider: {
      generateText: (request: {
        usage?: { purpose?: string };
      }) => Promise<string>;
    };
  }).provider;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value), "expected object record");
  return value as Record<string, unknown>;
}

function seedSession(runtime: SwarmRuntime, sessionId: string): void {
  runtime.sessionStore.create({
    swarm_id: `swarm_${sessionId}`,
    session_id: sessionId,
    user_request_id: "user-background-delegate",
    source: {
      source: "user",
      human_id: sessionId,
      title: "Background delegate test",
      description: "Background delegate test",
      labels: ["test", "delegate"],
      state: "active",
      metadata: { mode: "coding_loop" }
    },
    objective: "Validate background delegate launch",
    status: "running",
    coordinator: { agent_id: "main_swarm", role: "controller" },
    participants: [],
    created_at: "2026-05-15T00:00:00.000Z",
    updated_at: "2026-05-15T00:00:00.000Z",
    policy: policy()
  });
}

function policy(): SwarmPolicy {
  return {
    max_agents: 4,
    max_parallel_tasks: 2,
    timeout_ms: 10_000,
    retry: { max_attempts: 1, backoff_ms: 100 },
    require_review: false,
    consensus: "coordinator_decision",
    approval_mode: "on-request",
    network_access: "deny",
    allow_domains: [],
    human_approval_for: [],
    safety: {
      require_human_approval_for: [],
      forbidden_capabilities: [],
      sandbox_required: false
    },
    memory: {
      allow_read: true,
      allow_write: true,
      retention: "session"
    }
  };
}

function createFixture(): { root: string; workspace: string; databasePath: string; close(): void } {
  const root = mkdtempSync(join(tmpdir(), "swarm-background-delegate-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  return {
    root,
    workspace,
    databasePath: join(root, "swarm.db"),
    close: () => rmSync(root, { recursive: true, force: true })
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await delay(20);
  }
  assert.fail("Timed out waiting for condition.");
}
