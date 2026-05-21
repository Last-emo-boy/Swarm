import { strict as assert } from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SwarmPolicy, WorkItem } from "../protocol/types.js";
import { SwarmRuntime } from "./runtime.js";

test("WorkItem Gateway/user/self normalization projects through WorkSnapshot", () => {
  const fixture = createFixture();
  const runtime = new SwarmRuntime({
    workspace: fixture.workspace,
    databasePath: fixture.databasePath,
    approvalHandler: async () => true
  });

  try {
    const sources: WorkItem[] = [
      {
        source: "user",
        source_id: "prompt-42",
        human_id: "USER-42",
        title: "Interactive TUI chat request",
        description: "User asks the local runtime to summarize workspace status.",
        labels: ["interactive", "tui"],
        state: "active",
        metadata: { mode: "tui_chat", channel: "local" }
      },
      {
        source: "gateway",
        source_id: "gateway-run-42",
        human_id: "GW-42",
        title: "Gateway capability invocation",
        description: "Gateway request invokes a local capability without starting an HTTP server.",
        labels: ["gateway", "capability"],
        state: "active",
        metadata: { request_id: "req-gateway-42", route: "capabilities.invoke" }
      },
      {
        source: "self",
        source_id: "self-review-42",
        human_id: "SELF-42",
        title: "Self improvement follow-up",
        description: "Self review creates a deterministic improvement work item without provider execution.",
        labels: ["self-improvement", "review"],
        state: "active",
        metadata: { mode: "self_review", trigger: "manual" }
      }
    ];

    const projectedBySource = new Map<string, WorkItem>();
    for (const source of sources) {
      const sessionId = seedSourceSession(runtime, fixture, source);
      const projected = runtime.getWorkSnapshot(sessionId).session.source;
      assertNormalizedWorkItem(projected, source);
      projectedBySource.set(source.source, projected!);
    }
    assert(projectedBySource.get("user")?.source === "user");
    assert(projectedBySource.get("gateway")?.source === "gateway");
    assert(projectedBySource.get("self")?.source === "self");
  } finally {
    runtime.dispose();
    fixture.close();
  }
});

function seedSourceSession(runtime: SwarmRuntime, fixture: Fixture, source: WorkItem): string {
  const sessionId = `${source.source}-normalization-1`;
  const lease = runtime.workspaceLeaseStore.create({
    lease_id: `lease-${sessionId}`,
    session_id: sessionId,
    workspace_root: fixture.workspace,
    workspace_path: fixture.workspace,
    scope: ["src/runtime/work-item-normalization.test.ts"],
    write_boundary: "workspace",
    metadata: { kind: "normalization-test" },
    created_at: AT
  });
  runtime.sessionStore.create({
    swarm_id: `swarm-${sessionId}`,
    session_id: sessionId,
    user_request_id: `user-req-${sessionId}`,
    source,
    workspace_lease_id: lease.lease_id,
    objective: source.description ?? source.title,
    status: "running",
    coordinator: { agent_id: "main_swarm", role: "controller" },
    participants: [],
    created_at: AT,
    updated_at: AT,
    policy: policy()
  });
  return sessionId;
}

function assertNormalizedWorkItem(actual: WorkItem | undefined, expected: WorkItem): void {
  assert(actual, `Missing projected source for ${expected.source}`);
  assert.equal(actual.source, expected.source);
  assert.equal(actual.source_id, expected.source_id);
  assert.equal(actual.human_id, expected.human_id);
  assert.equal(actual.title, expected.title);
  assert.equal(actual.description, expected.description);
  assert.deepEqual(actual.labels, expected.labels);
  assert.equal(actual.state, "active");
  assert.deepEqual(actual.metadata, expected.metadata);
  assert.equal(actual.external_id, undefined, `${expected.source} should use source_id/human_id instead of external_id`);
}

function policy(): SwarmPolicy {
  return {
    max_agents: 4,
    max_parallel_tasks: 2,
    timeout_ms: 10_000,
    retry: { max_attempts: 1, backoff_ms: 100 },
    require_review: true,
    consensus: "reviewer_approval",
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

type Fixture = {
  root: string;
  workspace: string;
  databasePath: string;
  close(): void;
};

function createFixture(): Fixture {
  const root = join(tmpdir(), `swarm-work-item-normalization-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "src", "runtime"), { recursive: true });
  return {
    root,
    workspace,
    databasePath: join(root, "swarm.db"),
    close: () => {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

const AT = "2026-05-12T00:00:00.000Z";
