import { strict as assert } from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WorkItem } from "../protocol/types.js";
import { SwarmRuntime } from "./runtime.js";
import type { SelfReviewResult } from "./self-review.js";

test("improveSelf persists a normalized self-improvement WorkItem source", async () => {
  const fixture = createFixture();
  const runtime = new SwarmRuntime({
    workspace: fixture.workspace,
    databasePath: fixture.databasePath,
    approvalHandler: async () => true
  });
  const calls: Array<{ purpose?: string }> = [];
  let turn = 0;

  runtimeAccess(runtime).selfReview = async () => ({
    summary: "stubbed self-review",
    findings: ["deterministic finding"],
    recommendations: ["write focused evidence"],
    inspected: {
      logs: 0,
      sessions: 0,
      artifacts: 0
    }
  });
  runtimeProvider(runtime).generateText = async (request) => {
    calls.push({ purpose: request.usage?.purpose });
    turn += 1;
    if (turn === 1) {
      return JSON.stringify({
        status: "continue",
        summary: "run deterministic verification",
        message: "run deterministic verification",
        files_touched: [],
        next_actions: [],
        tool_calls: [{
          id: "verify-self-source",
          action: "code.test",
          inputs: {
            command: "node -e \"process.exit(0)\"",
            timeoutMs: 5000
          },
          reason: "Record verification evidence without model/provider calls."
        }]
      });
    }
    return JSON.stringify({
      status: "completed",
      summary: "self-improvement evidence complete",
      message: "self-improvement evidence complete",
      tool_calls: [],
      files_touched: [],
      next_actions: []
    });
  };

  try {
    const result = await runtime.improveSelf();

    assert.equal(result.status, "completed");
    assert.match(result.session_id, /^loop_/);
    assert.equal(result.content, "self-improvement evidence complete");
    assert.deepEqual(calls.map((call) => call.purpose), ["main_coding_loop", "main_coding_loop"]);

    const row = runtime.sessionStore.get(result.session_id);
    assert(row, "improveSelf should persist a WorkSession row");
    const source = JSON.parse(row.source_json ?? "null") as WorkItem;
    assert.equal(source.source, "self");
    assert.equal(source.source_id, result.session_id);
    assert.equal(source.human_id, result.session_id);
    assert.match(source.title, /^Improve Swarm itself based on the following self-review evidence\./);
    assert.deepEqual(source.labels, ["self-improvement", "review"]);
    assert.equal(source.state, "active");
    assert.equal(source.metadata?.mode, "self_improvement");
    assert.equal(source.external_id, undefined);

    const snapshotSource = runtime.getWorkSnapshot(result.session_id).session.source;
    assert.deepEqual(snapshotSource, source);
    assert.equal(snapshotSource?.external_id, undefined);
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
  const root = join(tmpdir(), `swarm-work-item-self-improvement-source-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

function runtimeAccess(runtime: SwarmRuntime): {
  selfReview: () => Promise<SelfReviewResult>;
} {
  return runtime as unknown as {
    selfReview: () => Promise<SelfReviewResult>;
  };
}
