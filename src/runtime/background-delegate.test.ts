import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentInvocationRequest } from "./agent-specs.js";
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
