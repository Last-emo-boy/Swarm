import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultSwarmSettings } from "../config/settings.js";
import type { CapabilityDescriptor } from "../extensions/types.js";
import type { OpenAIProvider } from "../providers/openai-provider.js";
import { CodingAgentLoop, collectCodingLoopOutcomeSignals } from "./coding-agent-loop.js";
import { RuntimeEvents, type RuntimeEvent } from "./events.js";

type GenerateTextRequest = Parameters<OpenAIProvider["generateText"]>[0];

test("collectCodingLoopOutcomeSignals records nested workspace changes from move and copy results", () => {
  const signals = collectCodingLoopOutcomeSignals([
    {
      source: "src/old.ts",
      destination: "src/new.ts",
      change: { path: "src/new.ts", operation: "move" }
    },
    {
      source: "src/template.ts",
      destination: "src/copied.ts",
      change: { path: "src/copied.ts", operation: "copy" }
    }
  ]);

  assert.deepEqual(signals.changed_files, ["src/new.ts", "src/copied.ts"]);
});

test("collectCodingLoopOutcomeSignals records json and notebook edit result shapes", () => {
  const signals = collectCodingLoopOutcomeSignals([
    { path: "package.json", operation: "set" },
    { path: "tsconfig.json", operation: "merge" },
    { path: "data.json", operation: "delete" },
    {
      path: "notebooks/demo.ipynb",
      editMode: "replace",
      change: { path: "notebooks/demo.ipynb", operation: "edit" }
    }
  ]);

  assert.deepEqual(signals.changed_files, [
    "package.json",
    "tsconfig.json",
    "data.json",
    "notebooks/demo.ipynb"
  ]);
});

test("collectCodingLoopOutcomeSignals recursively collects changed files and output refs", () => {
  const signals = collectCodingLoopOutcomeSignals({
    operation: "update",
    path: "src/runtime/runtime.ts",
    outputRef: { path: ".swarm/tool-output/result.md" },
    nested: {
      operation: "mkdir",
      path: "docs/generated",
      outputRef: { path: ".swarm/tool-output/nested.md" }
    }
  });

  assert.deepEqual(signals.changed_files, ["src/runtime/runtime.ts", "docs/generated"]);
  assert.deepEqual(signals.intermediate_artifacts, [
    ".swarm/tool-output/result.md",
    ".swarm/tool-output/nested.md"
  ]);
});

test("coding loop treats repaired bare continue with final content as completed", async () => {
  const calls: string[] = [];
  const result = await runCodingLoopWithFakeProvider((request) => {
    const purpose = request.usage?.purpose ?? "";
    calls.push(purpose);
    return Promise.resolve(JSON.stringify({
      status: "continue",
      summary: purpose === "coding_loop_json_repair" ? "Optimization review ready" : "Need to finalize optimization review",
      message: "The project can be optimized by tightening runtime protocol recovery and adding regression coverage.",
      files_touched: [],
      next_actions: [],
      tool_calls: []
    }));
  });

  assert.equal(result.status, "completed");
  assert.equal(calls.filter((purpose) => purpose === "coding_loop_json_repair").length, 1);
  assert.match(result.content, /runtime protocol recovery/);
  assert.doesNotMatch(result.content, /Swarm could not repair/);
});

test("coding loop still fails closed when repaired tool calls remain malformed", async () => {
  const result = await runCodingLoopWithFakeProvider(() => Promise.resolve(JSON.stringify({
    status: "continue",
    summary: "Read package metadata",
    message: "Read package metadata before continuing.",
    files_touched: [],
    next_actions: [],
    tool_calls: [
      { id: "read_package", action: "file.read", inputs: {} }
    ]
  })));

  assert.equal(result.status, "failed");
  assert.match(result.content, /Swarm could not repair the model tool call JSON/);
  assert.match(result.content, /file\.read/);
});

test("coding loop activity keeps turn budget metadata out of default messages", async () => {
  const events = new RuntimeEvents();
  const recorded: RuntimeEvent[] = [];
  events.onEvent((event) => recorded.push(event));

  await runCodingLoopWithFakeProvider(() => Promise.resolve(JSON.stringify({
    status: "completed",
    summary: "Optimization review ready",
    message: "The project can be optimized by tightening runtime protocol recovery.",
    files_touched: [],
    next_actions: [],
    tool_calls: []
  })), { events });

  const activity = recorded.filter((event): event is Extract<RuntimeEvent, { type: "loop_activity" }> => event.type === "loop_activity");
  const thinking = activity.find((event) => event.phase === "thinking");
  const completed = activity.find((event) => event.phase === "turn_complete");

  assert(thinking, "expected a thinking activity");
  assert.equal(thinking.message, "Swarm is thinking");
  assert.equal(thinking.turn, 1);
  assert.equal(thinking.max_turns, 3);
  assert.doesNotMatch(thinking.message, /\bturn\s+\d+\/\d+\b/i);
  assert(completed, "expected a turn completion activity");
  assert.doesNotMatch(completed.message, /\bturn\s+\d+\/\d+\b/i);
});

test("worker coding loop annotates activity with the running worker identity", async () => {
  const events = new RuntimeEvents();
  const recorded: RuntimeEvent[] = [];
  events.onEvent((event) => recorded.push(event));

  await runCodingLoopWithFakeProvider(() => Promise.resolve(JSON.stringify({
    status: "completed",
    summary: "Worker evidence ready",
    message: "Worker evidence ready.",
    files_touched: [],
    next_actions: [],
    tool_calls: []
  })), { events, role: "worker", workerId: "worker-identity-1" });

  const thinking = recorded.find((event): event is Extract<RuntimeEvent, { type: "loop_activity" }> =>
    event.type === "loop_activity" && event.phase === "thinking"
  );
  assert(thinking, "expected worker thinking activity");
  assert.equal(thinking.agent?.worker_id, "worker-identity-1");
});

test("coding loop gives actionable recovery for unmatched file.edit replacement", async () => {
  const events = new RuntimeEvents();
  const recorded: RuntimeEvent[] = [];
  events.onEvent((event) => recorded.push(event));

  await runCodingLoopWithFakeProvider((request) => {
    const priorToolFailed = promptInputText(request.user).match(/str_replace requires exactly one match/i);
    return Promise.resolve(JSON.stringify(priorToolFailed
      ? {
          status: "completed",
          summary: "Captured failed edit recovery",
          message: "Captured failed edit recovery.",
          files_touched: [],
          next_actions: [],
          tool_calls: []
        }
      : {
          status: "continue",
          summary: "Try an edit with stale text",
          message: "Try an edit with stale text.",
          files_touched: [],
          next_actions: [],
          tool_calls: [
            { id: "read_target", action: "file.read", inputs: { path: "src/example.ts" } },
            { id: "edit_target", action: "file.edit", inputs: { path: "src/example.ts", oldText: "missing text", newText: "replacement" } }
          ]
        }));
  }, {
    events,
    setupWorkspace: (workspace) => {
      mkdirSync(join(workspace, "src"), { recursive: true });
      writeFileSync(join(workspace, "src", "example.ts"), "export const value = 1;\n", "utf8");
    }
  });

  const failedEdit = recorded.find((event): event is Extract<RuntimeEvent, { type: "tool_result" }> =>
    event.type === "tool_result" && event.task_id === "edit_target"
  );
  assert(failedEdit, "expected failed edit tool result");
  assert.equal(failedEdit.status, "failed");
  assert.match(failedEdit.summary, /str_replace requires exactly one match/);
  assert.match(failedEdit.recoverySuggestion ?? "", /file\.grep|unique oldText/);
  assert.doesNotMatch(failedEdit.recoverySuggestion ?? "", /capability diagnostics/i);
});

test("coding loop gives actionable recovery for partial-read file.edit refusal", async () => {
  const events = new RuntimeEvents();
  const recorded: RuntimeEvent[] = [];
  events.onEvent((event) => recorded.push(event));

  await runCodingLoopWithFakeProvider((request) => {
    const priorToolFailed = promptInputText(request.user).match(/after only reading lines/i);
    return Promise.resolve(JSON.stringify(priorToolFailed
      ? {
          status: "completed",
          summary: "Captured partial-read recovery",
          message: "Captured partial-read recovery.",
          files_touched: [],
          next_actions: [],
          tool_calls: []
        }
      : {
          status: "continue",
          summary: "Try an edit after a partial read",
          message: "Try an edit after a partial read.",
          files_touched: [],
          next_actions: [],
          tool_calls: [
            { id: "read_target_part", action: "file.read", inputs: { path: "src/example.ts", startLine: 1, endLine: 1 } },
            { id: "edit_target_after_partial", action: "file.edit", inputs: { path: "src/example.ts", oldText: "export const value = 1;", newText: "export const value = 2;" } }
          ]
        }));
  }, {
    events,
    setupWorkspace: (workspace) => {
      mkdirSync(join(workspace, "src"), { recursive: true });
      writeFileSync(join(workspace, "src", "example.ts"), [
        "export const value = 1;",
        "export const other = 2;",
        ""
      ].join("\n"), "utf8");
    }
  });

  const failedEdit = recorded.find((event): event is Extract<RuntimeEvent, { type: "tool_result" }> =>
    event.type === "tool_result" && event.task_id === "edit_target_after_partial"
  );
  assert(failedEdit, "expected failed edit tool result");
  assert.equal(failedEdit.status, "failed");
  assert.match(failedEdit.summary, /after only reading lines/);
  assert.match(failedEdit.recoverySuggestion ?? "", /Read the full target file/);
  assert.doesNotMatch(failedEdit.recoverySuggestion ?? "", /capability diagnostics/i);
});

test("coding loop keeps durable context out of the cacheable system prefix", async () => {
  const requests: GenerateTextRequest[] = [];

  await runCodingLoopWithFakeProvider((request) => {
    requests.push(request);
    return Promise.resolve(JSON.stringify({
      status: "completed",
      summary: "Done",
      message: "Done",
      files_touched: [],
      next_actions: [],
      tool_calls: []
    }));
  }, {
    durableContext: () => "Files and paths seen: src/providers/openai-provider.ts"
  });

  assert.equal(requests.length, 1);
  const system = requests[0].system;
  const user = requests[0].user;
  assert(Array.isArray(system));
  assert(Array.isArray(user));
  assert.doesNotMatch(system.map((block) => block.text).join("\n"), /Files and paths seen/);
  const userText = user.map((block) => block.text).join("\n");
  assert.match(userText, /durable_session_context/);
  assert.match(userText, /src\/providers\/openai-provider\.ts/);
  assert.equal(user[user.length - 1]?.cache, false);
});

test("coding loop renders cacheable dynamic capability payload deterministically", async () => {
  const alpha = testCapability("mcp__alpha__read");
  const beta = testCapability("mcp__beta__read");

  const first = await captureCacheableUserPrompt([beta, alpha]);
  const second = await captureCacheableUserPrompt([alpha, beta]);

  assert.equal(first, second);
  assert(first.indexOf("mcp__alpha__read") < first.indexOf("mcp__beta__read"));
});

test("coding loop renders allowed tool order deterministically for cache keys", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "swarm-coding-loop-tool-order-"));
  try {
    const first = await capturePromptCacheShape({ allowedTools: ["Grep", "Read", "Bash"], workspace });
    const second = await capturePromptCacheShape({ allowedTools: ["Bash", "Read", "Grep"], workspace });

    assert.equal(first.cacheKey, second.cacheKey);
    assert.equal(first.systemText, second.systemText);
    assert.equal(first.cacheableUserPrompt, second.cacheableUserPrompt);
    assert(first.systemText.indexOf("Allowed tools: Read, Grep, Bash.") >= 0);
    assert(first.cacheableUserPrompt.indexOf("\"action\": \"Read\"") < first.cacheableUserPrompt.indexOf("\"action\": \"Grep\""));
    assert(first.cacheableUserPrompt.indexOf("\"action\": \"Grep\"") < first.cacheableUserPrompt.indexOf("\"action\": \"Bash\""));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("coding loop keeps volatile workspace state out of cacheable prompt blocks", async () => {
  const firstRequests: GenerateTextRequest[] = [];
  const secondRequests: GenerateTextRequest[] = [];

  const complete = JSON.stringify({
    status: "completed",
    summary: "Done",
    message: "Done",
    files_touched: [],
    next_actions: [],
    tool_calls: []
  });

  await runCodingLoopWithFakeProvider((request) => {
    firstRequests.push(request);
    return Promise.resolve(complete);
  }, {
    workspaceIndex: {
      recentFileName: "src/old.ts",
      gitStatusSummary: "clean",
      dirtyFiles: []
    }
  });
  await runCodingLoopWithFakeProvider((request) => {
    secondRequests.push(request);
    return Promise.resolve(complete);
  }, {
    workspaceIndex: {
      recentFileName: "src/new.ts",
      gitStatusSummary: "2 dirty file(s)",
      dirtyFiles: ["src/new.ts", "README.md"]
    }
  });

  const firstUser = firstRequests[0].user;
  const secondUser = secondRequests[0].user;
  assert(Array.isArray(firstUser));
  assert(Array.isArray(secondUser));
  assert.equal(firstUser[0]?.cache, true);
  assert.equal(secondUser[0]?.cache, true);
  assert.equal(firstUser[0]?.text, secondUser[0]?.text);
  assert.doesNotMatch(firstUser[0]?.text ?? "", /dirty|recent_files|src\/old\.ts|src\/new\.ts/);

  assert.equal(firstUser[1]?.cache, false);
  assert.equal(secondUser[1]?.cache, false);
  assert.match(firstUser[1]?.text ?? "", /src\/old\.ts/);
  assert.match(secondUser[1]?.text ?? "", /src\/new\.ts/);
  assert.match(secondUser[1]?.text ?? "", /2 dirty file\(s\)/);
});

async function captureCacheableUserPrompt(capabilities: CapabilityDescriptor[]): Promise<string> {
  let cacheableUserPrompt = "";
  await runCodingLoopWithFakeProvider((request) => {
    const user = request.user;
    assert(Array.isArray(user));
    cacheableUserPrompt = user[0]?.text ?? "";
    return Promise.resolve(JSON.stringify({
      status: "completed",
      summary: "Done",
      message: "Done",
      files_touched: [],
      next_actions: [],
      tool_calls: []
    }));
  }, {
    listModelCapabilities: async () => capabilities
  });
  return cacheableUserPrompt;
}

async function capturePromptCacheShape(options: { allowedTools: string[]; workspace: string }): Promise<{ cacheKey?: string; systemText: string; cacheableUserPrompt: string }> {
  let shape: { cacheKey?: string; systemText: string; cacheableUserPrompt: string } = {
    systemText: "",
    cacheableUserPrompt: ""
  };
  await runCodingLoopWithFakeProvider((request) => {
    const system = request.system;
    const user = request.user;
    assert(Array.isArray(system));
    assert(Array.isArray(user));
    shape = {
      cacheKey: request.cache?.key,
      systemText: system.map((block) => block.text).join("\n"),
      cacheableUserPrompt: user[0]?.text ?? ""
    };
    return Promise.resolve(JSON.stringify({
      status: "completed",
      summary: "Done",
      message: "Done",
      files_touched: [],
      next_actions: [],
      tool_calls: []
    }));
  }, {
    allowedTools: options.allowedTools,
    workspace: options.workspace
  });
  return shape;
}

function testCapability(name: string): CapabilityDescriptor {
  return {
    id: `mcp_tool.test.${name}`,
    kind: "mcp_tool",
    source: "mcp",
    trust: "trusted",
    providerId: "mcp:test",
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    riskClass: "r0",
    permissionName: `McpTool(test:${name})`,
    modelVisible: true,
    userVisible: true,
    status: "available",
    alwaysLoad: true,
    readOnly: true,
    concurrencyClass: "read_parallel"
  };
}

function promptInputText(input: GenerateTextRequest["user"]): string {
  if (typeof input === "string") {
    return input;
  }
  return input.map((block) => block.text).join("\n");
}

async function runCodingLoopWithFakeProvider(
  generateText: (request: GenerateTextRequest) => Promise<string>,
  options: {
    events?: RuntimeEvents;
    role?: "main" | "worker";
    workerId?: string;
    durableContext?: (sessionId: string) => string | Promise<string>;
    listModelCapabilities?: () => Promise<CapabilityDescriptor[]>;
    allowedTools?: string[];
    workspace?: string;
    setupWorkspace?: (workspace: string) => void;
    workspaceIndex?: {
      recentFileName: string;
      gitStatusSummary: string;
      dirtyFiles: string[];
    };
  } = {}
) {
  const ownsWorkspace = !options.workspace;
  const workspace = options.workspace ?? mkdtempSync(join(tmpdir(), "swarm-coding-loop-test-"));
  options.setupWorkspace?.(workspace);
  const settings = defaultSwarmSettings();
  settings.permissions.defaultMode = "yolo";
  const provider = {
    workerModel: "test-model",
    generateText
  } as unknown as OpenAIProvider;
  try {
    const loop = new CodingAgentLoop({
      workspace,
      settings,
      provider,
      events: options.events ?? new RuntimeEvents(),
      role: options.role,
      workerId: options.workerId,
      maxTurns: 3,
      maxToolCalls: 3,
      expectedSideEffects: "read_workspace",
      durableContext: options.durableContext,
      listModelCapabilities: options.listModelCapabilities,
      allowedTools: options.allowedTools,
      workspaceIndex: options.workspaceIndex ? {
        root: workspace,
        generatedAt: "2026-05-15T00:00:00.000Z",
        packageManager: "npm",
        detected: ["node", "typescript"],
        scripts: { test: "node --test", check: "tsc --noEmit" },
        recentFiles: [{
          path: join(workspace, options.workspaceIndex.recentFileName),
          size: 123,
          mtimeMs: Date.now()
        }],
        files: [],
        git: {
          isRepo: true,
          branch: "main",
          head: "0123456789abcdef",
          dirtyFiles: options.workspaceIndex.dirtyFiles,
          statusSummary: options.workspaceIndex.gitStatusSummary
        },
        counts: {
          files: 42,
          recent: 1
        },
        manifests: {
          workspace: ".swarm/index/workspace.json",
          files: ".swarm/index/files.json",
          packages: ".swarm/index/packages.json",
          git: ".swarm/index/git.json",
          recent: ".swarm/index/recent.json"
        }
      } : undefined,
      emitFinal: false,
      emitProgress: false
    });
    return await loop.run("Think about how this project can be optimized.");
  } finally {
    if (ownsWorkspace) {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
}
