import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SwarmRuntime } from "./runtime.js";
import type { RuntimeEvent } from "./events.js";
import { buildWorkRecordFromRuntimeEvent } from "./work-protocol.js";
import type { WorkTaskRecord } from "./work-protocol.js";

test("scoped-write runtime invoke preserves policy and writes inside file scope", async () => {
  const fixture = createFixture();
  const runtime = createRuntimeFixture(fixture);
  const events = captureToolResults(runtime);

  try {
    const result = await runtime.invokeCapability(
      "local_tool.Write",
      {
        path: "src/allowed.txt",
        content: "inside scope\n"
      },
      "scoped-session",
      {
        taskId: "scoped-write-allowed",
        title: "Scoped write allowed",
        source: "runtime",
        writePolicy: "scoped_write",
        fileScope: ["src/allowed.txt"]
      }
    );

    assert.equal(result.status, "success");
    assert.equal(existsSync(join(fixture.workspace, "src", "allowed.txt")), true);
    assert.equal(readFileSync(join(fixture.workspace, "src", "allowed.txt"), "utf8"), "inside scope\n");

    const event = requireToolResult(events, "scoped-write-allowed");
    assert.equal(event.write_policy, "scoped_write");
    assert.deepEqual(event.file_scope, ["src/allowed.txt"]);
    assert.equal(event.status, "success");

    const record = buildWorkRecordFromRuntimeEvent(event, "2026-05-12T05:30:00.000Z") as WorkTaskRecord;
    assert.equal(record.kind, "task");
    assert.equal(record.phase, "completed");
    assert.equal(record.write_policy, "scoped_write");
    assert.deepEqual(record.file_scope, ["src/allowed.txt"]);
    assert.equal(record.result_status, "success");
  } finally {
    runtime.dispose();
    fixture.close();
  }
});

test("scoped-write runtime invoke denies writes outside file scope and records sandbox metadata", async () => {
  const fixture = createFixture();
  const runtime = createRuntimeFixture(fixture);
  const events = captureToolResults(runtime);

  try {
    const result = await runtime.invokeCapability(
      "local_tool.Write",
      {
        path: "src/blocked.txt",
        content: "outside scope\n"
      },
      "scoped-session",
      {
        taskId: "scoped-write-denied",
        title: "Scoped write denied",
        source: "runtime",
        writePolicy: "scoped_write",
        fileScope: ["src/allowed.txt"]
      }
    );

    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "PERMISSION_DENIED");
    assert.match(result.summary, /outside delegated file scope/);
    assert.equal(existsSync(join(fixture.workspace, "src", "blocked.txt")), false);

    const event = requireToolResult(events, "scoped-write-denied");
    assert.equal(event.write_policy, "scoped_write");
    assert.deepEqual(event.file_scope, ["src/allowed.txt"]);
    assert.equal(event.status, "failed");
    assert.equal(event.sandbox?.decision, "deny");
    assert.equal(event.sandbox?.policy, "scoped_write");
    assert.equal(event.sandbox?.subject, "tool_action");
    assert.deepEqual(event.sandbox?.targets, ["src/blocked.txt"]);
    assert.deepEqual(event.sandbox?.file_scope, ["src/allowed.txt"]);

    const record = buildWorkRecordFromRuntimeEvent(event, "2026-05-12T05:31:00.000Z") as WorkTaskRecord;
    assert.equal(record.kind, "task");
    assert.equal(record.phase, "failed");
    assert.equal(record.write_policy, "scoped_write");
    assert.deepEqual(record.file_scope, ["src/allowed.txt"]);
    assert.equal(record.sandbox?.status, "denied");
    assert.equal(record.sandbox?.policy, "scoped_write");
    assert.deepEqual(record.sandbox?.targets, ["src/blocked.txt"]);
    assert.deepEqual(record.sandbox?.file_scope, ["src/allowed.txt"]);
  } finally {
    runtime.dispose();
    fixture.close();
  }
});

type Fixture = {
  root: string;
  workspace: string;
  databasePath: string;
  close(): void;
};

function createFixture(): Fixture {
  const root = join(tmpdir(), `swarm-scoped-write-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "src"), { recursive: true });
  return {
    root,
    workspace,
    databasePath: join(root, "swarm.db"),
    close: () => {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function createRuntimeFixture(fixture: Fixture): SwarmRuntime {
  const runtime = new SwarmRuntime({
    workspace: fixture.workspace,
    databasePath: fixture.databasePath,
    approvalHandler: async () => true
  });
  runtime.settings.tools.directWrite = true;
  runtime.settings.permissions.defaultMode = "full-auto";
  runtime.settings.permissions.allow = ["Write(**)", "Read(**)", "LS(**)", "Grep(**)", "Glob(**)", "Stat(**)"];
  runtime.settings.permissions.ask = [];
  runtime.settings.permissions.deny = [];
  return runtime;
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

function requireToolResult(
  events: Extract<RuntimeEvent, { type: "tool_result" }>[],
  taskId: string
): Extract<RuntimeEvent, { type: "tool_result" }> {
  const event = events.find((candidate) => candidate.task_id === taskId);
  assert(event, `Expected tool_result event for ${taskId}.`);
  return event;
}
