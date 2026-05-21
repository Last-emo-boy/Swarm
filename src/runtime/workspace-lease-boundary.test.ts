import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SwarmPolicy, WorkItem } from "../protocol/types.js";
import { SwarmRuntime } from "./runtime.js";
import type { RuntimeEvent } from "./events.js";
import type { SandboxDecision } from "./sandbox-policy.js";

test("lease-resolved local tool write boundary isolates session workspaces", async () => {
  const fixture = createFixture();
  const runtime = createRuntimeFixture(fixture);
  const events = captureToolResults(runtime);

  try {
    seedSessionWithLease(runtime, {
      sessionId: "lease-boundary-session-a",
      swarmId: "swarm-lease-boundary-a",
      leaseId: "lease-boundary-a",
      workspaceRoot: fixture.root,
      workspacePath: fixture.leaseA
    });
    seedSessionWithLease(runtime, {
      sessionId: "lease-boundary-session-b",
      swarmId: "swarm-lease-boundary-b",
      leaseId: "lease-boundary-b",
      workspaceRoot: fixture.root,
      workspacePath: fixture.leaseB
    });

    const relativePath = "src/shared-note.txt";
    const resultA = await runtime.invokeCapability(
      "local_tool.Write",
      {
        path: relativePath,
        content: "session A owns this file\n"
      },
      "lease-boundary-session-a",
      {
        taskId: "lease-boundary-write-a",
        title: "Lease boundary write A",
        source: "runtime",
        writePolicy: "scoped_write",
        fileScope: [relativePath]
      }
    );
    const resultB = await runtime.invokeCapability(
      "local_tool.Write",
      {
        path: relativePath,
        content: "session B owns this file\n"
      },
      "lease-boundary-session-b",
      {
        taskId: "lease-boundary-write-b",
        title: "Lease boundary write B",
        source: "runtime",
        writePolicy: "scoped_write",
        fileScope: [relativePath]
      }
    );

    assert.equal(resultA.status, "success");
    assert.equal(resultB.status, "success");
    assert.equal(readFileSync(join(fixture.leaseA, relativePath), "utf8"), "session A owns this file\n");
    assert.equal(readFileSync(join(fixture.leaseB, relativePath), "utf8"), "session B owns this file\n");
    assert.equal(existsSync(join(fixture.startupWorkspace, relativePath)), false);

    const readA = await runtime.invokeCapability(
      "local_tool.Read",
      { path: relativePath },
      "lease-boundary-session-a",
      {
        taskId: "lease-boundary-read-a",
        title: "Lease boundary read A",
        source: "runtime",
        writePolicy: "scoped_write",
        fileScope: [relativePath]
      }
    );
    const editA = await runtime.invokeCapability(
      "local_tool.Edit",
      {
        path: relativePath,
        old_string: "session A owns this file\n",
        new_string: "session A edited this file\n"
      },
      "lease-boundary-session-a",
      {
        taskId: "lease-boundary-edit-a",
        title: "Lease boundary edit A",
        source: "runtime",
        writePolicy: "scoped_write",
        fileScope: [relativePath]
      }
    );

    assert.equal(readA.status, "success");
    assert.equal(editA.status, "success");
    assert.equal(readFileSync(join(fixture.leaseA, relativePath), "utf8"), "session A edited this file\n");
    assert.equal(readFileSync(join(fixture.leaseB, relativePath), "utf8"), "session B owns this file\n");

    const siblingTarget = join(fixture.leaseB, "src", "sibling-denied.txt");
    const denied = await runtime.invokeCapability(
      "local_tool.Write",
      {
        path: siblingTarget,
        content: "session A must not cross into session B\n"
      },
      "lease-boundary-session-a",
      {
        taskId: "lease-boundary-denied-sibling",
        title: "Lease boundary denied sibling",
        source: "runtime",
        writePolicy: "scoped_write",
        fileScope: [relativePath]
      }
    );

    assert.equal(denied.status, "failed");
    assert.equal(denied.errorCode, "PERMISSION_DENIED");
    assert.equal(existsSync(siblingTarget), false);

    const deniedEvent = requireToolResult(events, "lease-boundary-denied-sibling");
    assert.equal(deniedEvent.sandbox?.decision, "deny");
    assert.equal(deniedEvent.sandbox?.policy, "scoped_write");
    assert.equal(deniedEvent.sandbox?.subject, "tool_action");
    assert.deepEqual(deniedEvent.sandbox?.file_scope, [relativePath]);
    assert.ok(
      (deniedEvent.sandbox?.targets ?? []).some((target) => target.includes("../lease-b/src/sibling-denied.txt")),
      `Expected denied sandbox target to include sibling lease path, got ${JSON.stringify(deniedEvent.sandbox?.targets)}`
    );
    assertSandboxDecision(deniedEvent.sandbox);

    assertToolResult(events, "lease-boundary-write-a", {
      status: "success",
      writePolicy: "scoped_write",
      fileScope: [relativePath]
    });
    assertToolResult(events, "lease-boundary-write-b", {
      status: "success",
      writePolicy: "scoped_write",
      fileScope: [relativePath]
    });
    assertToolResult(events, "lease-boundary-edit-a", {
      status: "success",
      writePolicy: "scoped_write",
      fileScope: [relativePath]
    });

    const attemptsA = runtime.runAttemptStore.list("lease-boundary-session-a");
    const attemptsB = runtime.runAttemptStore.list("lease-boundary-session-b");
    assert.equal(
      attemptsA.find((attempt) => attempt.task_id === "lease-boundary-write-a")?.workspace_path,
      fixture.leaseA
    );
    assert.equal(
      attemptsA.find((attempt) => attempt.task_id === "lease-boundary-edit-a")?.workspace_path,
      fixture.leaseA
    );
    assert.equal(
      attemptsA.find((attempt) => attempt.task_id === "lease-boundary-denied-sibling")?.workspace_path,
      fixture.leaseA
    );
    assert.equal(
      attemptsB.find((attempt) => attempt.task_id === "lease-boundary-write-b")?.workspace_path,
      fixture.leaseB
    );

    const snapshotA = runtime.getWorkSnapshot("lease-boundary-session-a");
    const snapshotB = runtime.getWorkSnapshot("lease-boundary-session-b");
    assert.equal(snapshotA.workspace?.workspace_path, fixture.leaseA);
    assert.equal(snapshotB.workspace?.workspace_path, fixture.leaseB);
    assert.equal(snapshotA.workspace?.write_boundary, "workspace");
    assert.equal(snapshotB.workspace?.write_boundary, "workspace");
    assert.equal(snapshotA.attempts.every((attempt) => attempt.workspace_path === fixture.leaseA), true);
    assert.equal(snapshotB.attempts.every((attempt) => attempt.workspace_path === fixture.leaseB), true);
  } finally {
    runtime.dispose();
    fixture.close();
  }
});

type Fixture = {
  root: string;
  startupWorkspace: string;
  leaseA: string;
  leaseB: string;
  databasePath: string;
  close(): void;
};

function createFixture(): Fixture {
  const root = join(tmpdir(), `swarm-workspace-lease-boundary-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const startupWorkspace = join(root, "startup-workspace");
  const leaseA = join(root, "lease-a");
  const leaseB = join(root, "lease-b");
  mkdirSync(join(startupWorkspace, "src"), { recursive: true });
  mkdirSync(join(leaseA, "src"), { recursive: true });
  mkdirSync(join(leaseB, "src"), { recursive: true });
  return {
    root,
    startupWorkspace,
    leaseA,
    leaseB,
    databasePath: join(root, "swarm.db"),
    close: () => {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function createRuntimeFixture(fixture: Fixture): SwarmRuntime {
  const runtime = new SwarmRuntime({
    workspace: fixture.startupWorkspace,
    databasePath: fixture.databasePath,
    approvalHandler: async () => true
  });
  runtime.settings.tools.directWrite = true;
  runtime.settings.permissions.defaultMode = "full-auto";
  runtime.settings.permissions.allow = ["Write(**)", "Edit(**)", "Read(**)", "LS(**)", "Grep(**)", "Glob(**)", "Stat(**)"];
  runtime.settings.permissions.ask = [];
  runtime.settings.permissions.deny = [];
  return runtime;
}

function seedSessionWithLease(
  runtime: SwarmRuntime,
  input: {
    sessionId: string;
    swarmId: string;
    leaseId: string;
    workspaceRoot: string;
    workspacePath: string;
  }
): void {
  const lease = runtime.workspaceLeaseStore.create({
    lease_id: input.leaseId,
    session_id: input.sessionId,
    workspace_root: input.workspaceRoot,
    workspace_path: input.workspacePath,
    scope: ["src/shared-note.txt"],
    write_boundary: "workspace",
    metadata: { kind: "lease-resolved local tool write boundary" },
    created_at: AT
  });
  const source: WorkItem = {
    source: "runtime",
    source_id: input.sessionId,
    title: "WorkspaceLease write boundary fixture",
    description: "Focused test session for WorkspaceLease local tool isolation",
    labels: ["test", "workspace-lease"],
    state: "active",
    metadata: { lease_id: lease.lease_id }
  };
  runtime.sessionStore.create({
    swarm_id: input.swarmId,
    session_id: input.sessionId,
    user_request_id: `${input.sessionId}-request`,
    source,
    workspace_lease_id: lease.lease_id,
    objective: "Prove WorkspaceLease workspace_path is the local tool write boundary",
    status: "running",
    coordinator: { agent_id: "main_swarm", role: "controller" },
    participants: [],
    created_at: AT,
    updated_at: AT,
    policy: policy()
  });
}

function captureToolResults(runtime: SwarmRuntime): Extract<RuntimeEvent, { type: "tool_result" }>[] {
  const events: Extract<RuntimeEvent, { type: "tool_result" }>[] = [];
  runtime.events.onEvent((event) => {
    if (event.type === "tool_result") {
      events.push(event);
    }
  });
  return events;
}

function assertToolResult(
  events: Extract<RuntimeEvent, { type: "tool_result" }>[],
  taskId: string,
  expected: {
    status: "success" | "partial" | "failed";
    writePolicy: string;
    fileScope: string[];
  }
): void {
  const event = requireToolResult(events, taskId);
  assert.equal(event.status, expected.status);
  assert.equal(event.write_policy, expected.writePolicy);
  assert.deepEqual(event.file_scope, expected.fileScope);
}

function requireToolResult(
  events: Extract<RuntimeEvent, { type: "tool_result" }>[],
  taskId: string
): Extract<RuntimeEvent, { type: "tool_result" }> {
  const event = events.find((candidate) => candidate.task_id === taskId);
  assert(event, `Expected tool_result event for ${taskId}.`);
  return event;
}

function assertSandboxDecision(sandbox: SandboxDecision | undefined): asserts sandbox is SandboxDecision {
  assert(sandbox, "Expected sandbox metadata on denied tool_result event.");
  assert.equal(sandbox.decision, "deny");
}

function policy(): SwarmPolicy {
  return {
    max_agents: 4,
    max_parallel_tasks: 2,
    timeout_ms: 10_000,
    retry: { max_attempts: 1, backoff_ms: 100 },
    require_review: false,
    consensus: "coordinator_decision",
    approval_mode: "auto",
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

const AT = "2026-05-12T00:00:00.000Z";
