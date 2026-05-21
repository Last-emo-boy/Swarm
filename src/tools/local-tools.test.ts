import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultSwarmSettings } from "../config/settings.js";
import { normalizeToolAction, runLocalTool } from "./local-tools.js";
import type { LocalToolContext } from "./types.js";

test("file.grep falls back to bounded JS search when ripgrep is unavailable", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-grep-fallback-"));
  const previousPath = process.env.PATH;
  const previousPathExt = process.env.PATHEXT;
  try {
    await writeFile(join(workspace, "alpha.txt"), "first\nneedle here\n", "utf8");
    await writeFile(join(workspace, "beta.log"), "needle ignored by include\n", "utf8");
    process.env.PATH = "";
    process.env.PATHEXT = "";

    const result = await runLocalTool({
      type: "file.grep",
      root: ".",
      pattern: "needle",
      include: "*.txt",
      maxMatches: 5
    }, context(workspace));

    assert.equal(result.status, "success");
    assert.deepEqual(result.data, [{
      path: "alpha.txt",
      line: 2,
      text: "needle here",
      before: undefined,
      after: undefined
    }]);
    assert.equal(result.metadata?.engine, "js-fallback");
    assert.equal(result.metadata?.fileLimit, 2000);
    assert.equal(result.metadata?.truncated, false);
    assert.equal(result.metadata?.scannedFiles, 1);
  } finally {
    process.env.PATH = previousPath;
    if (previousPathExt === undefined) {
      delete process.env.PATHEXT;
    } else {
      process.env.PATHEXT = previousPathExt;
    }
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Agent run_in_background normalizes to parallel delegate mode", () => {
  const action = normalizeToolAction({
    action: "Agent",
    prompt: "Check the cache hit path.",
    subagent_type: "researcher",
    run_in_background: true
  });

  assert(action.type === "agent.delegate");
  assert.equal(action.preferred_mode, "parallel");
  assert.equal(action.run_in_background, true);
  assert.equal(action.preferred_agent_spec_id, "researcher");
});

test("agent control aliases normalize to worker control tools", () => {
  const list = normalizeToolAction({ action: "AgentList", parent_session_id: "session-1", status: "running", limit: 5 });
  assert.equal(list.type, "agent.list");
  assert.equal(list.parent_session_id, "session-1");
  assert.equal(list.status, "running");

  const status = normalizeToolAction({ action: "worker.status", worker_id: "worker-1" });
  assert.equal(status.type, "agent.status");
  assert.equal(status.worker_id, "worker-1");

  const recall = normalizeToolAction({ action: "agent.continue", worker_id: "worker-1", message: "finish the report", run_in_background: true });
  assert.equal(recall.type, "agent.continue");
  assert.equal(recall.run_in_background, true);
});

test("LSP tool normalization preserves file/path aliases and 0-based compatibility inputs", () => {
  const hover = normalizeToolAction({
    action: "LspHover",
    file: "src/example.ts",
    lineZeroBased: 4,
    character: 8,
    maxItems: 7,
    timeout_ms: 1234
  });
  assert.equal(hover.type, "lsp.hover");
  assert.equal(hover.path, "src/example.ts");
  assert.equal(hover.file, "src/example.ts");
  assert.equal(hover.line, 5);
  assert.equal(hover.column, 9);
  assert.equal(hover.character, 8);
  assert.equal(hover.maxResults, 7);
  assert.equal(hover.timeoutMs, 1234);

  const diagnostics = normalizeToolAction({
    action: "lsp.diagnostics",
    path: "src/example.ts",
    diagnostics_timeout_ms: 99
  });
  assert.equal(diagnostics.type, "lsp.diagnostics");
  assert.equal(diagnostics.diagnosticsTimeoutMs, 99);
});

test("LSP range normalization accepts range objects and explicit start/end fields", () => {
  const fromRange = normalizeToolAction({
    action: "lsp.code_actions",
    file: "src/example.ts",
    range: {
      start: { line: 3, character: 2 },
      end: { line: 4, character: 12 }
    },
    maxResults: 5
  });
  assert.equal(fromRange.type, "lsp.code_actions");
  assert.deepEqual(fromRange.range, {
    start: { line: 3, column: 3 },
    end: { line: 4, column: 13 }
  });
  assert.equal(fromRange.startCharacter, 2);
  assert.equal(fromRange.endCharacter, 12);
  assert.equal(fromRange.maxResults, 5);

  const fromFields = normalizeToolAction({
    action: "lsp.code_actions",
    path: "src/example.ts",
    startLine: 2,
    startCharacter: 0,
    endLine: 2,
    endCharacter: 9
  });
  assert.equal(fromFields.type, "lsp.code_actions");
  assert.deepEqual(fromFields.range, {
    start: { line: 2, column: 1 },
    end: { line: 2, column: 10 }
  });
  assert.equal(fromFields.startCharacter, 0);
  assert.equal(fromFields.endCharacter, 9);
});

function context(workspace: string): LocalToolContext {
  const settings = defaultSwarmSettings();
  settings.permissions.defaultMode = "full-auto";
  return { workspace, settings };
}
