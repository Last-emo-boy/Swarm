import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultSwarmSettings } from "../config/settings.js";
import type { CapabilityDescriptor } from "../extensions/types.js";
import type { OpenAIProvider } from "../providers/openai-provider.js";
import { CodingAgentLoop, collectCodingLoopOutcomeSignals, evaluateCodingLoopCacheLab } from "./coding-agent-loop.js";
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

test("coding loop gives JSON repair enough output budget for large tool call payloads", async () => {
  const requests: GenerateTextRequest[] = [];
  const result = await runCodingLoopWithFakeProvider((request) => {
    requests.push(request);
    if (request.usage?.purpose === "coding_loop_json_repair") {
      return Promise.resolve(JSON.stringify({
        status: "completed",
        summary: "Recovered",
        message: "Recovered the response without executing a truncated tool call.",
        files_touched: [],
        next_actions: [],
        tool_calls: []
      }));
    }
    return Promise.resolve(JSON.stringify({
      status: "continue",
      summary: "Needs repair",
      message: "The next response should be repaired.",
      files_touched: [],
      next_actions: [],
      tool_calls: []
    }));
  });

  const mainRequest = requests.find((request) => request.usage?.purpose === "main_coding_loop");
  const repairRequest = requests.find((request) => request.usage?.purpose === "coding_loop_json_repair");
  assert(mainRequest, "expected main coding loop request");
  assert(repairRequest, "expected repair request");
  assert.equal(result.status, "completed");
  assert.equal(repairRequest.maxOutputTokens, mainRequest.maxOutputTokens);
  assert.equal(repairRequest.maxOutputTokens, 8_000);
});

test("coding loop permits read-workspace files_touched without write evidence", async () => {
  const events = new RuntimeEvents();
  const recorded: RuntimeEvent[] = [];
  events.onEvent((event) => recorded.push(event));

  const result = await runCodingLoopWithFakeProvider(() => Promise.resolve(JSON.stringify({
    status: "completed",
    summary: "Repository scan complete",
    message: "I inspected the repository README and source files without changing them.",
    files_touched: ["README.md", "src/index.ts"],
    next_actions: [],
    tool_calls: []
  })), { events });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.outcome?.changed_files, []);
  assert.equal(recorded.some((event) =>
    event.type === "tool_result" && event.action === "workspace.verify" && event.errorCode === "UNVERIFIED_WORKSPACE_CHANGE"
  ), false);
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

test("coding loop shared fact activity hides blackboard tool names", async () => {
  const events = new RuntimeEvents();
  const recorded: RuntimeEvent[] = [];
  events.onEvent((event) => recorded.push(event));

  await runCodingLoopWithFakeProvider((request) => {
    const sawFailure = promptInputText(request.user).includes("Shared facts are only available");
    return Promise.resolve(JSON.stringify(sawFailure
      ? {
          status: "completed",
          summary: "Captured shared fact failure",
          message: "Captured shared fact failure.",
          files_touched: [],
          next_actions: [],
          tool_calls: []
        }
      : {
          status: "continue",
          summary: "Save a shared decision",
          message: "Save a shared decision for the team.",
          files_touched: [],
          next_actions: [],
          tool_calls: [
            {
              id: "save_decision",
              action: "blackboard.write",
              inputs: {
                key: "decision/auth",
                type: "decision",
                value: { approved: true }
              }
            }
          ]
        }));
  }, { events });

  const runningTool = recorded.find((event): event is Extract<RuntimeEvent, { type: "loop_activity" }> =>
    event.type === "loop_activity" && event.phase === "running_tool" && event.tool === "blackboard.write"
  );
  assert(runningTool, "expected shared fact running activity");
  assert.equal(runningTool.message, "Running Save shared fact decision/auth");
  assert.doesNotMatch(runningTool.message, /BlackboardWrite|blackboard/i);
});

test("coding loop exposes LSP semantic evidence for the next edit-planning turn", async () => {
  const requests: GenerateTextRequest[] = [];

  await runCodingLoopWithFakeProvider((request) => {
    requests.push(request);
    const sawEvidence = promptInputText(request.user).includes("swarm.semantic_evidence.prompt.v1");
    return Promise.resolve(JSON.stringify(sawEvidence
      ? {
          status: "completed",
          summary: "Used semantic evidence",
          message: "Used semantic evidence before planning the edit.",
          files_touched: [],
          next_actions: [],
          tool_calls: []
        }
      : {
          status: "continue",
          summary: "Inspect symbol",
          message: "Inspect symbol definition first.",
          files_touched: [],
          next_actions: [],
          tool_calls: [
            { id: "definition_add", action: "lsp.definition", inputs: { file: "src/use.ts", line: 2, column: 22 } }
          ]
        }));
  }, {
    setupWorkspace: (workspace) => {
      mkdirSync(join(workspace, "src"), { recursive: true });
      writeFileSync(join(workspace, "package.json"), "{\"type\":\"module\"}\n", "utf8");
      writeFileSync(join(workspace, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: true
        },
        include: ["src/**/*.ts"]
      }, null, 2), "utf8");
      writeFileSync(join(workspace, "src", "math.ts"), [
        "export function add(left: number, right: number): number {",
        "  return left + right;",
        "}",
        ""
      ].join("\n"), "utf8");
      writeFileSync(join(workspace, "src", "use.ts"), [
        "import { add } from \"./math.js\";",
        "export const total = add(1, 2);",
        ""
      ].join("\n"), "utf8");
    }
  });

  assert.equal(requests.length, 2);
  const context = promptBlockTextBySection(requests[1].user, "context");
  assert.match(context, /swarm\.semantic_evidence\.prompt\.v1/);
  assert.match(context, /"guidance": "Use these semantic_evidence ids when planning edits/);
  assert.match(context, /"evidence_id": "sem:[a-f0-9]{12}"/);
  assert.match(context, /"source": "lsp"/);
  assert.match(context, /"action": "lsp\.definition"/);
  assert.match(context, /"symbol": "add"/);
  assert.match(context, /"range": \{/);
  assert.match(context, /"staleness": "fresh"/);
  assert.match(context, /src\/math\.ts/);
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
  assert.equal(failedEdit.recovery?.category, "tool");
  assert.match(failedEdit.content ?? "", /Recovery detail:/);
  assert.match(failedEdit.content ?? "", /Next:/);
  assert.doesNotMatch(failedEdit.recoverySuggestion ?? "", /capability diagnostics/i);
  assert.doesNotMatch(failedEdit.content ?? "", /sk-test/);
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

test("coding loop keeps agent memory context in non-cacheable context block", async () => {
  const firstRequests: GenerateTextRequest[] = [];
  const secondRequests: GenerateTextRequest[] = [];
  const workspace = mkdtempSync(join(tmpdir(), "swarm-coding-loop-agent-memory-"));
  const complete = JSON.stringify({
    status: "completed",
    summary: "Done",
    message: "Done",
    files_touched: [],
    next_actions: [],
    tool_calls: []
  });

  try {
    await runCodingLoopWithFakeProvider((request) => {
      firstRequests.push(request);
      return Promise.resolve(complete);
    }, {
      workspace,
      agentMemoryContext: () => [
        "Agent memory summary:",
        "actor_id=worker:memory-test",
        "cache_stable_summary_hash=amx:abc123def456",
        "cache_stable_summary:",
        "- Prefer session projection tests."
      ].join("\n")
    });
    await runCodingLoopWithFakeProvider((request) => {
      secondRequests.push(request);
      return Promise.resolve(complete);
    }, {
      workspace,
      agentMemoryContext: () => [
        "Agent memory summary:",
        "actor_id=worker:memory-test",
        "cache_stable_summary_hash=amx:changed999999",
        "cache_stable_summary:",
        "- Prefer gateway projection tests."
      ].join("\n")
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }

  assert.equal(firstRequests.length, 1);
  assert.equal(secondRequests.length, 1);
  assert.equal(firstRequests[0].cache?.key, secondRequests[0].cache?.key);
  const user = firstRequests[0].user;
  assert(Array.isArray(user));
  const contextBlock = promptBlockBySection(user, "context");
  assert(contextBlock, "expected context block");
  assert.equal(contextBlock.cache, false);
  assert.match(contextBlock.text, /agent_memory_context/);
  assert.match(contextBlock.text, /worker:memory-test/);
  assert.match(contextBlock.text, /Prefer session projection tests/);
  const cacheableText = user.filter((block) => block.cache).map((block) => block.text).join("\n");
  assert.doesNotMatch(cacheableText, /worker:memory-test|Prefer session projection tests|agent_memory_context/);
  assert.match(promptBlockTextBySection(secondRequests[0].user, "context"), /Prefer gateway projection tests/);
});

test("coding loop renders cacheable dynamic capability payload deterministically", async () => {
  const alpha = testCapability("mcp__alpha__read");
  const beta = testCapability("mcp__beta__read");

  const first = await captureCacheableUserPrompt([beta, alpha]);
  const second = await captureCacheableUserPrompt([alpha, beta]);

  assert.equal(first, second);
  assert(first.indexOf("mcp__alpha__read") < first.indexOf("mcp__beta__read"));
});

test("ToolSearch discovers local tools design-only tools deferred MCP tools and skills", async () => {
  const events = new RuntimeEvents();
  const toolResults: Extract<RuntimeEvent, { type: "tool_result" }>[] = [];
  events.onEvent((event) => {
    if (event.type === "tool_result" && event.action === "ToolSearch") {
      toolResults.push(event);
    }
  });
  const responses = [
    JSON.stringify({
      status: "continue",
      summary: "Search tool catalog",
      message: "Looking up tools.",
      files_touched: [],
      next_actions: [],
      tool_calls: [
        { id: "local", action: "ToolSearch", inputs: { query: "PowerShell", limit: 4 } },
        { id: "design", action: "ToolSearch", inputs: { query: "schedule automation", limit: 6 } },
        { id: "mcp", action: "ToolSearch", inputs: { query: "github", limit: 4 } },
        { id: "skill", action: "ToolSearch", inputs: { query: "quality review", kind: "skill", limit: 4 } }
      ]
    }),
    JSON.stringify({
      status: "completed",
      summary: "Tool catalog searched",
      message: "Tool catalog searched.",
      files_touched: [],
      next_actions: [],
      tool_calls: []
    })
  ];
  await runCodingLoopWithFakeProvider(() => Promise.resolve(responses.shift() ?? responses[responses.length - 1]), {
    events,
    maxToolCalls: 6,
    listModelCapabilities: async () => [
      localCapability({
        id: "local_tool.PowerShell",
        name: "PowerShell",
        title: "PowerShell",
        description: "Run Windows-native PowerShell commands.",
        metadata: { action: "powershell.exec", aliases: ["PowerShell", "powershell.exec"] },
        concurrencyClass: "verify_exclusive",
        permissionName: "PowerShell"
      }),
      localCapability({
        id: "local_tool.ScheduleCreate",
        name: "ScheduleCreate",
        title: "Create Schedule",
        description: "Design-gated schedule creation surface.",
        searchHint: "Automation lifecycle control, currently design-only without durable scheduler runtime.",
        metadata: { action: "schedule.create", aliases: ["ScheduleCronTool", "schedule.create"] },
        permissionName: "Schedule"
      }),
      testCapability("mcp__github__search_code", {
        providerId: "mcp:github",
        title: "GitHub code search",
        description: "Search GitHub code.",
        searchHint: "github search code",
        alwaysLoad: false,
        shouldDefer: true
      }),
      skillCapability("quality-review", "Quality Review", "Review code quality and risks.")
    ]
  });

  assert.equal(toolResults.length, 4);
  const combined = toolResults.map((result) => result.content ?? "").join("\n");
  assert.match(combined, /powershell\.exec/);
  assert.match(combined, /ScheduleCreate/);
  assert.match(combined, /schedule\.create/);
  assert.match(combined, /mcp__github__search_code \(load next turn\)/);
  assert.match(combined, /activate with: skill\.activate \{ name: "quality-review" \}/);
  const mcpResult = toolResults.find((result) => result.task_id === "mcp");
  assert.match(mcpResult?.summary ?? "", /loaded 1 MCP tools/);
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
  const firstWorkspace = promptBlockTextBySection(firstUser, "workspace");
  const secondWorkspace = promptBlockTextBySection(secondUser, "workspace");
  assert.equal(promptBlockBySection(firstUser, "workspace")?.cache, true);
  assert.equal(promptBlockBySection(secondUser, "workspace")?.cache, true);
  assert.equal(firstWorkspace, secondWorkspace);
  assert.doesNotMatch(firstWorkspace, /dirty|recent_files|src\/old\.ts|src\/new\.ts/);
  assert.doesNotMatch(firstWorkspace, /index_manifests|\.swarm\/index/);

  const firstContext = promptBlockTextBySection(firstUser, "context");
  const secondContext = promptBlockTextBySection(secondUser, "context");
  assert.equal(promptBlockBySection(firstUser, "context")?.cache, false);
  assert.equal(promptBlockBySection(secondUser, "context")?.cache, false);
  assert.match(secondContext, /prompt_packing/);
  assert.match(secondContext, /stable_prefix_sections/);
  assert.match(secondContext, /context_order/);
  assert.match(firstContext, /src\/old\.ts/);
  assert.match(secondContext, /src\/new\.ts/);
  assert.match(secondContext, /2 dirty file\(s\)/);
});

test("coding loop orders prompt sections for a stable cache prefix", async () => {
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
    durableContext: () => "Pinned detail that must remain outside the cacheable prefix.",
    workspaceIndex: {
      recentFiles: [{ path: "src/context.ts", size: 123, mtimeMs: 200 }],
      gitStatusSummary: "1 dirty file(s)",
      dirtyFiles: ["src/context.ts"]
    }
  });

  const user = requests[0].user;
  assert(Array.isArray(user));
  assert.deepEqual(user.map((block) => block.section), ["system", "tools", "workspace", "task", "context", "volatile_footer"]);
  assert.deepEqual(user.map((block) => block.cache === true), [true, true, true, false, false, false]);
  assert.match(promptBlockTextBySection(user, "task"), /Think about how this project can be optimized/);
  assert.match(promptBlockTextBySection(user, "context"), /Pinned detail/);
  assert.doesNotMatch(
    user.filter((block) => block.cache).map((block) => block.text).join("\n"),
    /Pinned detail|remaining_turns|tool_results|live_user_messages/
  );
});

test("coding loop schedules workspace context blocks deterministically with budget metadata", async () => {
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
    workspaceIndex: {
      recentFiles: [
        { path: "src/zeta.ts", size: 30, mtimeMs: 300 },
        { path: "src/alpha.ts", size: 10, mtimeMs: 100 },
        { path: "src/middle.ts", size: 20, mtimeMs: 200 }
      ],
      gitStatusSummary: "2 dirty file(s)",
      dirtyFiles: ["src/zeta.ts", "README.md"]
    }
  });

  const user = requests[0].user;
  assert(Array.isArray(user));
  const context = promptBlockTextBySection(user, "context");
  assert.match(context, /"included_context_blocks": 5/);
  assert.match(context, /"dropped_context_blocks": 0/);
  assert.match(context, /"context_block_limit": 20/);
  assert.match(context, /"context_order": "source,path,relevance_desc"/);
  assert.match(context, /"volatile_tail_budget_tokens": 4000/);
  assert.match(context, /"included_context_tokens_estimate": \d+/);
  assert.match(context, /"prefix_identity_hint": "pcx:[a-f0-9]{12}"/);

  const readmeIndex = context.indexOf('"path": "README.md"');
  const dirtyZetaIndex = context.indexOf('"path": "src/zeta.ts"');
  const recentAlphaIndex = context.indexOf('"path": "src/alpha.ts"');
  const recentMiddleIndex = context.indexOf('"path": "src/middle.ts"');
  const recentZetaIndex = context.lastIndexOf('"path": "src/zeta.ts"');
  assert(readmeIndex >= 0);
  assert(dirtyZetaIndex > readmeIndex);
  assert(recentAlphaIndex > dirtyZetaIndex);
  assert(recentMiddleIndex > recentAlphaIndex);
  assert(recentZetaIndex > recentMiddleIndex);
});

test("coding loop records context overflow packing decisions", async () => {
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
    workspaceIndex: {
      recentFiles: [],
      gitStatusSummary: "25 dirty file(s)",
      dirtyFiles: Array.from({ length: 25 }, (_, index) => `src/dirty-${String(index).padStart(2, "0")}.ts`)
    }
  });

  const user = requests[0].user;
  assert(Array.isArray(user));
  const context = promptBlockTextBySection(user, "context");
  assert.match(context, /"included_context_blocks": 20/);
  assert.match(context, /"dropped_context_blocks": 5/);
  assert.match(context, /"overflow_reason": "context_block_limit"/);
  assert.match(context, /"dropped_context_tokens_estimate": \d+/);
});

test("coding loop cache lab distinguishes volatile tail changes from stable prefix drift", async () => {
  const firstRequests: GenerateTextRequest[] = [];
  const secondRequests: GenerateTextRequest[] = [];
  const driftRequests: GenerateTextRequest[] = [];
  const workspace = mkdtempSync(join(tmpdir(), "swarm-cache-lab-replay-"));
  const complete = JSON.stringify({
    status: "completed",
    summary: "Done",
    message: "Done",
    files_touched: [],
    next_actions: [],
    tool_calls: []
  });

  try {
    await runCodingLoopWithFakeProvider((request) => {
      firstRequests.push(request);
      return Promise.resolve(complete);
    }, {
      workspace,
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
      workspace,
      workspaceIndex: {
        recentFileName: "src/new.ts",
        gitStatusSummary: "3 dirty file(s)",
        dirtyFiles: ["src/new.ts", "README.md", "package.json"]
      }
    });
    await runCodingLoopWithFakeProvider((request) => {
      driftRequests.push(request);
      return Promise.resolve(complete);
    }, {
      workspace,
      workspaceIndex: {
        recentFileName: "src/new.ts",
        gitStatusSummary: "3 dirty file(s)",
        dirtyFiles: ["src/new.ts", "README.md", "package.json"]
      },
      allowedTools: ["Read", "Grep"]
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }

  const first = firstRequests[0];
  const second = secondRequests[0];
  const drift = driftRequests[0];
  assert(Array.isArray(first.system));
  assert(Array.isArray(first.user));
  assert(Array.isArray(second.system));
  assert(Array.isArray(second.user));
  assert(Array.isArray(drift.system));
  assert(Array.isArray(drift.user));

  const lab = evaluateCodingLoopCacheLab([
    {
      label: "first",
      cacheKey: first.cache?.key,
      system: first.system,
      user: first.user,
      cachedInputTokens: 0,
      totalInputWithCacheTokens: 6000
    },
    {
      label: "volatile-tail-change",
      cacheKey: second.cache?.key,
      system: second.system,
      user: second.user,
      cachedInputTokens: 4200,
      totalInputWithCacheTokens: 6000
    },
    {
      label: "tool-schema-drift",
      cacheKey: drift.cache?.key,
      system: drift.system,
      user: drift.user,
      cachedInputTokens: 0,
      totalInputWithCacheTokens: 6000
    }
  ]);

  assert.equal(lab.replays[0]?.missReason, "cold_start");
  assert.equal(lab.replays[1]?.prefixDrift, false);
  assert.deepEqual(lab.replays[1]?.changedSections, []);
  assert.equal(lab.replays[1]?.hitRate, 0.7);
  assert.equal(lab.replays[1]?.stablePrefixIdentity, lab.baseline?.stablePrefixIdentity);
  assert(lab.replays[1]?.volatileTailTokensEstimate !== lab.replays[0]?.volatileTailTokensEstimate);
  assert.equal(lab.replays[2]?.prefixDrift, true);
  assert.equal(lab.replays[2]?.missReason, "prefix_drift");
  assert.deepEqual(lab.replays[2]?.changedSections, ["system", "tools"]);
  assert.match(lab.replays[2]?.stablePrefixIdentity ?? "", /^pcx:[a-f0-9]{12}$/);
});

async function captureCacheableUserPrompt(capabilities: CapabilityDescriptor[]): Promise<string> {
  let cacheableUserPrompt = "";
  await runCodingLoopWithFakeProvider((request) => {
    const user = request.user;
    assert(Array.isArray(user));
    cacheableUserPrompt = promptBlockTextBySection(user, "tools");
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
      cacheableUserPrompt: promptBlockTextBySection(user, "tools")
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

function localCapability(overrides: Partial<CapabilityDescriptor> & Pick<CapabilityDescriptor, "id" | "name" | "description">): CapabilityDescriptor {
  return {
    id: overrides.id,
    kind: "local_tool",
    source: "builtin",
    trust: "builtin",
    providerId: "local-tools",
    name: overrides.name,
    title: overrides.title,
    description: overrides.description,
    inputSchema: overrides.inputSchema ?? { type: "object", properties: {} },
    riskClass: overrides.riskClass ?? "r1",
    permissionName: overrides.permissionName ?? overrides.name,
    modelVisible: overrides.modelVisible ?? true,
    userVisible: overrides.userVisible ?? true,
    status: overrides.status ?? "available",
    alwaysLoad: overrides.alwaysLoad,
    shouldDefer: overrides.shouldDefer,
    readOnly: overrides.readOnly,
    concurrencyClass: overrides.concurrencyClass,
    searchHint: overrides.searchHint,
    metadata: overrides.metadata
  };
}

function skillCapability(name: string, title: string, description: string): CapabilityDescriptor {
  return {
    id: `skill.${name}`,
    kind: "skill",
    source: "user",
    trust: "trusted",
    providerId: "skills",
    name,
    title,
    description,
    inputSchema: { type: "object", properties: { name: { type: "string" } } },
    riskClass: "r1",
    permissionName: `SkillInvoke(${name})`,
    modelVisible: true,
    userVisible: true,
    status: "available",
    readOnly: false,
    concurrencyClass: "write_exclusive"
  };
}

function testCapability(name: string, overrides: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  return {
    id: `mcp_tool.test.${name}`,
    kind: "mcp_tool",
    source: "mcp",
    trust: "trusted",
    providerId: "mcp:test",
    name,
    title: overrides.title,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    riskClass: "r0",
    permissionName: `McpTool(test:${name})`,
    modelVisible: true,
    userVisible: true,
    status: "available",
    alwaysLoad: true,
    readOnly: true,
    concurrencyClass: "read_parallel",
    ...overrides
  };
}

function promptInputText(input: GenerateTextRequest["user"]): string {
  if (typeof input === "string") {
    return input;
  }
  return input.map((block) => block.text).join("\n");
}

function promptBlockBySection(input: GenerateTextRequest["user"], section: string) {
  assert(Array.isArray(input));
  return input.find((block) => block.section === section);
}

function promptBlockTextBySection(input: GenerateTextRequest["user"], section: string): string {
  const block = promptBlockBySection(input, section);
  assert(block, `expected prompt block section ${section}`);
  return block.text;
}

async function runCodingLoopWithFakeProvider(
  generateText: (request: GenerateTextRequest) => Promise<string>,
  options: {
    events?: RuntimeEvents;
    role?: "main" | "worker";
    workerId?: string;
    durableContext?: (sessionId: string) => string | Promise<string>;
    agentMemoryContext?: (sessionId: string) => string | Promise<string>;
    listModelCapabilities?: () => Promise<CapabilityDescriptor[]>;
    allowedTools?: string[];
    maxToolCalls?: number;
    workspace?: string;
    setupWorkspace?: (workspace: string) => void;
    workspaceIndex?: {
      recentFileName?: string;
      recentFiles?: Array<{ path: string; size?: number; mtimeMs?: number }>;
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
      maxToolCalls: options.maxToolCalls ?? 3,
      expectedSideEffects: "read_workspace",
      durableContext: options.durableContext,
      agentMemoryContext: options.agentMemoryContext,
      listModelCapabilities: options.listModelCapabilities,
      allowedTools: options.allowedTools,
      workspaceIndex: options.workspaceIndex ? {
        root: workspace,
        generatedAt: "2026-05-15T00:00:00.000Z",
        packageManager: "npm",
        detected: ["node", "typescript"],
        scripts: { test: "node --test", check: "tsc --noEmit" },
        recentFiles: workspaceIndexRecentFiles(workspace, options.workspaceIndex),
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

function workspaceIndexRecentFiles(
  workspace: string,
  input: {
    recentFileName?: string;
    recentFiles?: Array<{ path: string; size?: number; mtimeMs?: number }>;
  }
): Array<{ path: string; size: number; mtimeMs: number }> {
  const files = input.recentFiles ?? (input.recentFileName ? [{ path: input.recentFileName }] : []);
  return files.map((file, index) => ({
    path: join(workspace, file.path),
    size: file.size ?? 123,
    mtimeMs: file.mtimeMs ?? index + 1
  }));
}
