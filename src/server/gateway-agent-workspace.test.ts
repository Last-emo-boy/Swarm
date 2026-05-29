import { strict as assert } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SwarmPolicy } from "../protocol/types.js";
import type { AgentWorkspaceProjection } from "../runtime/agent-workspace.js";
import { SwarmGatewayServer } from "./gateway.js";

test("Gateway exposes Agent Workspace projection and read-only sections", async () => {
  const fixture = createFixture();
  const server = new SwarmGatewayServer({
    host: "127.0.0.1",
    port: 0,
    workspace: fixture.workspace,
    databasePath: fixture.databasePath
  });

  try {
    seedParentSession(server, fixture);
    server.runtime.workerStateStore.create({
      worker_id: "worker-agent-workspace-1",
      display_name: "Ada",
      role_title: "Coder",
      parent_session_id: "agent-workspace-parent",
      capability: "code.implement",
      objective: "Implement Agent Workspace projection.",
      status: "running",
      agent_spec_id: "coder",
      invocation_mode: "parallel",
      file_scope: ["src/runtime/agent-workspace.ts"],
      tool_budget: { max_turns: 3, max_tool_calls: 9 },
      requested_by: "main_swarm",
      blocked_reason: "Waiting for test approval."
    });

    const started = await server.start();
    const health = await readJson<GatewayHealthPayload>(`${started.url}/health`);
    assert(health.routes.includes("/v1/agent-workspace"));
    assert(health.routes.includes("/v1/agent-workspace/tasks"));
    assert(health.routes.includes("/v1/agent-workspace/tasks/:id"));
    assert(health.routes.includes("/v1/agent-workspace/teammates"));
    assert(health.routes.includes("/v1/agent-workspace/teammates/:id"));
    assert(health.routes.includes("/v1/agent-workspace/attention"));
    assert(health.routes.includes("/v1/agent-workspace/runtime"));
    assert(health.routes.includes("/v1/agent-workspace/automations"));
    assert(health.routes.includes("/v1/agent-workspace/automation-status"));

    const projection = await readJson<AgentWorkspaceProjection>(`${started.url}/v1/agent-workspace?workflow=${encodeURIComponent(fixture.workflowPath)}`);
    assert.equal(projection.schema_version, "swarm.agent_workspace.v1");
    assert.equal(projection.workspace_path, fixture.workspace);
    assert(projection.teammates.some((item) => item.id === "worker-agent-workspace-1"));
    assert(projection.tasks.some((item) => item.id === "worker-agent-workspace-1"));
    assert(projection.attention.some((item) => item.kind === "blocked_worker"));
    assert(projection.readiness.some((item) => item.id === "gateway_projection"));
    assert(projection.automations.some((item) => item.product_label === "Automations" && item.route.startsWith("/v1/symphony")));

    const tasks = await readJson<{ schema_version: string; tasks: AgentWorkspaceProjection["tasks"] }>(`${started.url}/v1/agent-workspace/tasks?workflow=${encodeURIComponent(fixture.workflowPath)}`);
    assert.equal(tasks.schema_version, projection.schema_version);
    assert(tasks.tasks.some((item) => item.id === "worker-agent-workspace-1"));

    const taskDetail = await readJson<{ schema_version: string; task: AgentWorkspaceProjection["task_details"][number] }>(`${started.url}/v1/agent-workspace/tasks/worker-agent-workspace-1?workflow=${encodeURIComponent(fixture.workflowPath)}`);
    assert.equal(taskDetail.task.id, "worker-agent-workspace-1");
    assert.match(taskDetail.task.objective, /Agent Workspace projection/);

    const teammates = await readJson<{ schema_version: string; teammates: AgentWorkspaceProjection["teammates"] }>(`${started.url}/v1/agent-workspace/teammates?workflow=${encodeURIComponent(fixture.workflowPath)}`);
    assert.equal(teammates.schema_version, projection.schema_version);
    assert.deepEqual(teammates.teammates.map((item) => item.id), projection.teammates.map((item) => item.id));

    const teammate = await readJson<{ schema_version: string; teammate: AgentWorkspaceProjection["teammates"][number] }>(`${started.url}/v1/agent-workspace/teammates/worker-agent-workspace-1?workflow=${encodeURIComponent(fixture.workflowPath)}`);
    assert.equal(teammate.teammate.id, "worker-agent-workspace-1");
    assert.equal(teammate.teammate.current_task, "Implement Agent Workspace projection.");

    const attention = await readJson<{ schema_version: string; attention: AgentWorkspaceProjection["attention"] }>(`${started.url}/v1/agent-workspace/attention?workflow=${encodeURIComponent(fixture.workflowPath)}`);
    assert.equal(attention.schema_version, projection.schema_version);
    assert(attention.attention.some((item) => item.kind === "blocked_worker"));

    const runtime = await readJson<{ runtime: { status: string; readiness: unknown[]; teammates: number; automations: number } }>(`${started.url}/v1/agent-workspace/runtime?workflow=${encodeURIComponent(fixture.workflowPath)}`);
    assert(runtime.runtime.readiness.length > 0);
    assert.equal(runtime.runtime.teammates, projection.summary.teammates);
    assert.equal(runtime.runtime.automations, projection.summary.automations);

    const automationStatus = await readJson<{ automation_status: AgentWorkspaceProjection["automations"]; summary: { automations: number } }>(`${started.url}/v1/agent-workspace/automation-status?workflow=${encodeURIComponent(fixture.workflowPath)}`);
    assert.equal(automationStatus.summary.automations, projection.summary.automations);
    assert(automationStatus.automation_status.every((item) => item.product_label === "Automations"));
  } finally {
    await server.stop();
    fixture.close();
  }
});

type GatewayHealthPayload = {
  ok: boolean;
  routes: string[];
};

function seedParentSession(server: SwarmGatewayServer, fixture: ReturnType<typeof createFixture>): void {
  const now = new Date().toISOString();
  const lease = server.runtime.workspaceLeaseStore.create({
    lease_id: "lease-agent-workspace-parent",
    session_id: "agent-workspace-parent",
    workspace_root: fixture.workspace,
    workspace_path: fixture.workspace,
    scope: ["src/runtime/agent-workspace.ts"],
    write_boundary: "workspace",
    metadata: { kind: "gateway-agent-workspace-test" },
    created_at: now
  });
  server.runtime.sessionStore.create({
    swarm_id: "swarm-agent-workspace-parent",
    session_id: "agent-workspace-parent",
    user_request_id: "gateway-agent-workspace-test",
    workspace_lease_id: lease.lease_id,
    objective: "Gateway Agent Workspace projection parent session",
    status: "running",
    coordinator: { agent_id: "main_swarm", role: "controller" },
    participants: [],
    created_at: now,
    updated_at: now,
    policy: policy()
  });
}

function policy(): SwarmPolicy {
  return {
    max_agents: 4,
    max_parallel_tasks: 2,
    timeout_ms: 60_000,
    retry: { max_attempts: 1, backoff_ms: 100 },
    require_review: false,
    consensus: "coordinator_decision",
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

function createFixture(): {
  root: string;
  workspace: string;
  workflowPath: string;
  databasePath: string;
  close(): void;
} {
  const root = join(tmpdir(), `swarm-gateway-agent-workspace-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const workflowPath = join(root, "WORKFLOW.md");
  writeFileSync(workflowPath, workflowText(workspace), "utf8");
  return {
    root,
    workspace,
    workflowPath,
    databasePath: join(root, "swarm.db"),
    close: () => {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function workflowText(workspace: string): string {
  return [
    "---",
    "name: Agent Workspace Gateway Test",
    `workspace_root: ${JSON.stringify(workspace)}`,
    "agent:",
    "  max_concurrent_agents: 2",
    "polling:",
    "  interval_ms: 1000",
    "---",
    "",
    "- id: AW-1",
    "  title: Verify Agent Workspace projection",
    "  state: Todo"
  ].join("\n");
}

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = await response.json() as T;
  assert.equal(response.ok, true, JSON.stringify(body));
  return body;
}
