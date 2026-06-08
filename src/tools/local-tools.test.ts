import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultSwarmSettings } from "../config/settings.js";
import { DEFAULT_TOOL_NAMES } from "../runtime/coding-agent-loop.js";
import { builtinAgentSpecs } from "../runtime/agent-specs.js";
import type { BlackboardEntry } from "../protocol/types.js";
import { LOCAL_TOOL_SCHEMAS } from "./tool-contracts.js";
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

test("file.grep supports cc-style output modes, paging, case-insensitive search, and type filters", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-grep-modes-"));
  const previousPath = process.env.PATH;
  const previousPathExt = process.env.PATHEXT;
  try {
    await writeFile(join(workspace, "alpha.ts"), "Needle one\nneedle two\nother\n", "utf8");
    await writeFile(join(workspace, "beta.ts"), "needle beta\n", "utf8");
    await writeFile(join(workspace, "notes.md"), "needle markdown\n", "utf8");
    process.env.PATH = "";
    process.env.PATHEXT = "";

    const files = await runLocalTool({
      type: "file.grep",
      root: ".",
      pattern: "needle",
      outputMode: "files_with_matches",
      caseInsensitive: true,
      fileType: "ts",
      headLimit: 1
    }, context(workspace));

    assert.equal(files.status, "success");
    assert.deepEqual(files.data, ["alpha.ts"]);
    assert.equal(files.content, "alpha.ts");
    assert.equal(files.metadata?.outputMode, "files_with_matches");
    assert.equal(files.metadata?.appliedLimit, 1);
    assert.equal(files.metadata?.fileCount, 2);

    const counts = await runLocalTool({
      type: "file.grep",
      root: ".",
      pattern: "needle",
      outputMode: "count",
      caseInsensitive: true,
      fileType: "ts"
    }, context(workspace));

    assert.equal(counts.status, "success");
    assert.deepEqual(counts.data, [
      { path: "alpha.ts", count: 2 },
      { path: "beta.ts", count: 1 }
    ]);
    assert.equal(counts.content, "alpha.ts:2\nbeta.ts:1");

    const paged = await runLocalTool({
      type: "file.grep",
      root: ".",
      pattern: "needle",
      outputMode: "content",
      caseInsensitive: true,
      fileType: "ts",
      offset: 1,
      headLimit: 1,
      beforeContext: 1,
      afterContext: 1
    }, context(workspace));

    assert.equal(paged.status, "success");
    assert.match(paged.content ?? "", /alpha\.ts:2:needle two/);
    assert.match(paged.content ?? "", /alpha\.ts-Needle one/);
    assert.match(paged.content ?? "", /alpha\.ts-other/);
    assert.equal(paged.metadata?.appliedOffset, 1);
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

test("file.grep JS fallback supports multiline patterns", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-grep-multiline-"));
  const previousPath = process.env.PATH;
  const previousPathExt = process.env.PATHEXT;
  try {
    await writeFile(join(workspace, "alpha.ts"), "start\nmiddle\nfinish\n", "utf8");
    process.env.PATH = "";
    process.env.PATHEXT = "";

    const result = await runLocalTool({
      type: "file.grep",
      root: ".",
      pattern: "start[\\s\\S]*finish",
      outputMode: "content",
      multiline: true,
      fileType: "ts"
    }, context(workspace));

    assert.equal(result.status, "success");
    assert.match(result.content ?? "", /alpha\.ts:1:start\\nmiddle\\nfinish/);
    assert.equal(result.metadata?.matchCount, 1);
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

test("Grep aliases normalize cc-style search inputs", () => {
  const action = normalizeToolAction({
    action: "Grep",
    pattern: "Needle",
    path: "src",
    glob: "*.{ts,tsx}",
    output_mode: "count",
    head_limit: 10,
    offset: 2,
    "-i": true,
    "-B": 1,
    "-A": 3,
    type: "ts",
    multiline: true
  });

  assert.equal(action.type, "file.grep");
  assert.equal(action.root, "src");
  assert.equal(action.include, "*.{ts,tsx}");
  assert.equal(action.outputMode, "count");
  assert.equal(action.headLimit, 10);
  assert.equal(action.offset, 2);
  assert.equal(action.caseInsensitive, true);
  assert.equal(action.beforeContext, 1);
  assert.equal(action.afterContext, 3);
  assert.equal(action.fileType, "ts");
  assert.equal(action.multiline, true);
});

test("built-in agent specs expose only tools with local contracts", () => {
  const missing = builtinAgentSpecs.flatMap((spec) =>
    spec.tools
      .filter((tool) => !LOCAL_TOOL_SCHEMAS[tool])
      .map((tool) => `${spec.id}:${tool}`)
  );

  assert.deepEqual(missing, []);
});

test("default prompt tool names stay covered by contracts and normalizer aliases", () => {
  const missingContracts = DEFAULT_TOOL_NAMES.filter((tool) => !LOCAL_TOOL_SCHEMAS[tool]);
  assert.deepEqual(missingContracts, []);

  const missingNormalizedContracts = DEFAULT_TOOL_NAMES
    .map((tool) => ({ tool, action: normalizeToolAction(minimalInputsForTool(tool)).type }))
    .filter(({ action }) => !LOCAL_TOOL_SCHEMAS[action]);

  assert.deepEqual(missingNormalizedContracts, []);
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

test("PowerShell aliases normalize to powershell.exec", () => {
  const action = normalizeToolAction({
    action: "PowerShell",
    command: "Get-ChildItem .",
    cwd: "src",
    timeout: 1234,
    max_output_bytes: 4096,
    run_in_background: true,
    max_log_bytes: 8192
  });

  assert(action.type === "powershell.exec");
  assert.equal(action.command, "Get-ChildItem .");
  assert.equal(action.cwd, "src");
  assert.equal(action.timeoutMs, 1234);
  assert.equal(action.maxOutputBytes, 4096);
  assert.equal(action.runInBackground, true);
  assert.equal(action.maxLogBytes, 8192);
  assert.equal(normalizeToolAction({ action: "powershell_exec", command: "Get-Date" }).type, "powershell.exec");
  assert.equal(normalizeToolAction({ action: "Pwsh", command: "Get-Date" }).type, "powershell.exec");
});

test("structured interaction and plan-mode tools normalize cc-style aliases", () => {
  const question = normalizeToolAction({
    action: "AskUserQuestion",
    questions: [{
      question: "Which route should Swarm take?",
      options: [
        { label: "Plan", description: "Inspect first" },
        "Execute"
      ]
    }],
    recommended_choice: "Plan"
  });
  assert.equal(question.type, "ask_user_question");
  assert.equal(question.prompt, "Which route should Swarm take?");
  assert.equal(question.questions?.[0]?.options[0]?.label, "Plan");
  assert.equal(question.questions?.[0]?.options[1]?.label, "Execute");
  assert.equal(question.recommendedChoice, "Plan");

  const enter = normalizeToolAction({ action: "EnterPlanMode", objective: "Refactor the TUI" });
  assert.equal(enter.type, "plan.enter");
  assert.equal(enter.objective, "Refactor the TUI");

  const exit = normalizeToolAction({
    action: "ExitPlanMode",
    plan: "1. Inspect\n2. Edit\n3. Verify",
    allowed_prompts: [{ tool: "Edit", prompt: "Apply scoped layout edits" }]
  });
  assert.equal(exit.type, "plan.exit");
  assert.equal(exit.allowedPrompts?.[0]?.tool, "Edit");
});

test("runtime coordination helper aliases normalize cc-style inputs", () => {
  const message = normalizeToolAction({
    action: "SendMessageTool",
    workerId: "worker-1",
    content: "please report status",
    requireAck: true,
    ttlMs: 5000,
    metadata: { source: "test" }
  });
  assert.equal(message.type, "agent.message");
  assert.equal(message.worker_id, "worker-1");
  assert.equal(message.message, "please report status");
  assert.equal(message.require_ack, true);
  assert.equal(message.ttl_ms, 5000);
  assert.deepEqual(message.metadata, { source: "test" });

  const sleep = normalizeToolAction({ action: "SleepTool", ms: 25, reason: "poll" });
  assert.equal(sleep.type, "runtime.sleep");
  assert.equal(sleep.duration_ms, 25);
  assert.equal(sleep.reason, "poll");

  const output = normalizeToolAction({
    action: "SyntheticOutputTool",
    output: { ok: true },
    json_schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
    label: "final"
  });
  assert.equal(output.type, "structured.output");
  assert.deepEqual(output.value, { ok: true });
  assert.equal(output.label, "final");

  const repl = normalizeToolAction({ action: "REPLTool", mode: "headless" });
  assert.equal(repl.type, "repl.mode");
  assert.equal(repl.mode, "headless");
});

test("automation remote and team lifecycle aliases normalize cc-style inputs", () => {
  const scheduleCreate = normalizeToolAction({
    action: "ScheduleCronTool",
    cron: "0 9 * * 1",
    task: "Run weekly verification",
    recurring: true,
    time_zone: "Asia/Shanghai",
    dryRun: true
  });
  assert.equal(scheduleCreate.type, "schedule.create");
  assert.equal(scheduleCreate.prompt, "Run weekly verification");
  assert.equal(scheduleCreate.timezone, "Asia/Shanghai");
  assert.equal(scheduleCreate.dry_run, true);

  const scheduleList = normalizeToolAction({ action: "CronList", status: "active", limit: 5 });
  assert.equal(scheduleList.type, "schedule.list");
  assert.equal(scheduleList.status, "active");
  assert.equal(scheduleList.limit, 5);

  const scheduleDelete = normalizeToolAction({ action: "CronDelete", id: "sched-1", reason: "obsolete" });
  assert.equal(scheduleDelete.type, "schedule.delete");
  assert.equal(scheduleDelete.schedule_id, "sched-1");

  const remote = normalizeToolAction({ action: "RemoteTriggerTool", endpoint_id: "ci", tool: "build", args: { ref: "main" } });
  assert.equal(remote.type, "remote.trigger");
  assert.equal(remote.endpoint, "ci");
  assert.equal(remote.capability, "build");
  assert.deepEqual(remote.payload, { ref: "main" });

  const teamCreate = normalizeToolAction({ action: "TeamCreateTool", team_name: "review", description: "Review the release", roles: ["reviewer"], taskIds: ["task-1"] });
  assert.equal(teamCreate.type, "team.create");
  assert.equal(teamCreate.name, "review");
  assert.equal(teamCreate.objective, "Review the release");
  assert.deepEqual(teamCreate.roles, ["reviewer"]);
  assert.deepEqual(teamCreate.task_ids, ["task-1"]);

  const teamDelete = normalizeToolAction({ action: "TeamDeleteTool", teamId: "team-1", reason: "done" });
  assert.equal(teamDelete.type, "team.delete");
  assert.equal(teamDelete.team_id, "team-1");
});

test("automation remote and team lifecycle tools return recoverable design-only guidance", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-automation-design-"));
  try {
    const toolContext = context(workspace);
    const actions = [
      { type: "schedule.create", cron: "0 9 * * 1", prompt: "Run weekly verification" },
      { type: "schedule.list" },
      { type: "schedule.delete", schedule_id: "sched-1" },
      { type: "remote.trigger", endpoint: "ci", payload: { ref: "main" } },
      { type: "team.create", objective: "Review the release" },
      { type: "team.delete", team_id: "team-1" }
    ] as const;

    for (const action of actions) {
      const result = await runLocalTool(action, toolContext);
      assert.equal(result.status, "failed", action.type);
      assert.equal(result.errorCode, "DESIGN_ONLY_TOOL", action.type);
      assert.equal(result.recoverable, true, action.type);
      assert.equal(result.metadata?.availability, "design_only", action.type);
      assert.match(result.content ?? "", /not available in this Swarm runtime/, action.type);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("structured interaction tools return recoverable waiting metadata", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-interaction-tools-"));
  try {
    const question = await runLocalTool({
      type: "ask_user_question",
      prompt: "Choose implementation scope",
      choices: [{ label: "Minimal" }, { label: "Complete" }],
      allowFreeform: false
    }, context(workspace));

    assert.equal(question.status, "partial");
    assert.equal(question.recoverable, true);
    assert.equal(question.metadata?.interaction, "question");
    assert.equal(question.metadata?.requiresUserInput, true);
    assert.deepEqual(question.metadata?.choices, ["Minimal", "Complete"]);

    const enter = await runLocalTool({
      type: "plan.enter",
      objective: "Design the tool flow"
    }, context(workspace));
    assert.equal(enter.status, "success");
    assert.equal(enter.metadata?.planningMode, true);

    const approval = await runLocalTool({
      type: "plan.exit",
      plan: "1. Implement tools\n2. Run tests",
      summary: "Tool plan ready"
    }, context(workspace));
    assert.equal(approval.status, "partial");
    assert.equal(approval.recoverable, true);
    assert.equal(approval.metadata?.interaction, "plan_approval");
    assert.equal(approval.metadata?.requiresUserInput, true);
    assert.equal(approval.metadata?.readyForApproval, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("shared fact tools return product-facing summaries", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-shared-fact-tools-"));
  try {
    const entry = blackboardEntry();
    const toolContext: LocalToolContext = {
      ...context(workspace),
      blackboard: {
        write: () => entry,
        read: () => [entry],
        search: () => [entry],
        list: () => []
      }
    };

    const writeResult = await runLocalTool({
      type: "blackboard.write",
      key: "decision/auth",
      value: { approved: true },
      entryType: "decision"
    }, toolContext);
    assert.equal(writeResult.summary, "Saved shared fact decision/auth");
    assert.doesNotMatch(writeResult.summary, /blackboard/i);

    const readResult = await runLocalTool({ type: "blackboard.read", key: "decision/auth" }, toolContext);
    assert.equal(readResult.summary, "Read 1 shared fact");
    assert.doesNotMatch(readResult.summary, /blackboard/i);

    const searchResult = await runLocalTool({ type: "blackboard.search", query: "auth" }, toolContext);
    assert.equal(searchResult.summary, "Found 1 shared fact");
    assert.doesNotMatch(searchResult.summary, /blackboard/i);

    const listResult = await runLocalTool({ type: "blackboard.list" }, toolContext);
    assert.equal(listResult.summary, "Listed 0 shared facts");
    assert.equal(listResult.content, "(no shared facts)");
    assert.doesNotMatch(`${listResult.summary}\n${listResult.content}`, /blackboard/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("shared fact tools return product-facing validation errors", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-shared-fact-errors-"));
  try {
    assert.throws(
      () => normalizeToolAction({ action: "BlackboardWrite", type: "decision", value: {} }),
      /Saving a shared fact requires key/
    );
    assert.throws(
      () => normalizeToolAction({ action: "BlackboardRead" }),
      /Reading a shared fact requires entry_id or key/
    );
    assert.throws(
      () => normalizeToolAction({ action: "BlackboardWrite", key: "decision/auth", type: "invalid", value: {} }),
      /Shared fact type must be one of plan, observation, evidence, result, critique, decision, artifact/
    );

    await assert.rejects(
      runLocalTool({
        type: "blackboard.write",
        key: "decision/auth",
        value: { approved: true },
        entryType: "decision"
      }, context(workspace)),
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /Shared facts are only available inside a Swarm runtime session/);
        assert.doesNotMatch(message, /Blackboard/i);
        return true;
      }
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("shell.exec persists truncated foreground output with a retrievable outputRef", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-shell-output-"));
  const previousSwarmHome = process.env.SWARM_HOME;
  try {
    process.env.SWARM_HOME = join(workspace, ".swarm-home");
    const toolContext = context(workspace, "shell-output-session");
    const result = await runLocalTool({
      type: "shell.exec",
      command: "node -e \"process.stdout.write('x'.repeat(5000))\"",
      maxOutputBytes: 1024
    }, toolContext);

    assert.equal(result.status, "success");
    assert(result.outputRef);
    assert.equal(result.metadata?.hasMore, true);
    assert.equal(result.metadata?.persistedOutputPath, result.outputRef);
    assert.equal(typeof result.metadata?.persistedOutputSize, "number");
    const saved = await readFile(result.outputRef, "utf8");
    assert.match(saved, /x{4000}/);
    assert((result.content ?? "").length < saved.length);
  } finally {
    if (previousSwarmHome === undefined) {
      delete process.env.SWARM_HOME;
    } else {
      process.env.SWARM_HOME = previousSwarmHome;
    }
    await rm(workspace, { recursive: true, force: true });
  }
});

test("shell.exec guides obvious long-running foreground commands to background tools", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-shell-background-hint-"));
  try {
    const result = await runLocalTool({
      type: "shell.exec",
      command: "npm run dev"
    }, context(workspace));

    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "INVALID_INPUT");
    assert.match(result.recoverySuggestion ?? "", /run_in_background=true|ProcessStart/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
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

test("task and worktree aliases normalize to runtime control tools", () => {
  const create = normalizeToolAction({
    action: "TaskCreate",
    sessionId: "session-1",
    title: "Inspect task state",
    task_type: "analysis",
    write_policy: "scoped_write",
    paths: ["src/tools"],
    assigned_to: { agent_id: "worker-1", role: "reviewer" }
  });
  assert.equal(create.type, "task.create");
  assert.equal(create.session_id, "session-1");
  assert.equal(create.taskType, "analysis");
  assert.equal(create.write_policy, "scoped_write");
  assert.deepEqual(create.file_scope, ["src/tools"]);
  assert.deepEqual(create.assigned_to, { agent_id: "worker-1", role: "reviewer", capability: undefined });

  const output = normalizeToolAction({ action: "tasks.output", id: "task-1", workerId: "worker-1", limit: 128 });
  assert.equal(output.type, "task.output");
  assert.equal(output.task_id, "task-1");
  assert.equal(output.worker_id, "worker-1");
  assert.equal(output.max_bytes, 128);

  const enter = normalizeToolAction({ action: "enter_worktree", sessionId: "session-1", worktree_name: "task-7", preview: true });
  assert.equal(enter.type, "worktree.enter");
  assert.equal(enter.name, "task-7");
  assert.equal(enter.dry_run, true);

  const exit = normalizeToolAction({ action: "ExitWorktree", session_id: "session-1", lease_id: "lease-1", exit_mode: "remove", discard_changes: true });
  assert.equal(exit.type, "worktree.exit");
  assert.equal(exit.mode, "remove");
  assert.equal(exit.discardChanges, true);
});

test("task and worktree runtime control tools dispatch through local context", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-task-control-"));
  try {
    const calls: string[] = [];
    const toolContext: LocalToolContext = {
      ...context(workspace, "session-1"),
      taskId: "loop-task",
      taskControl: {
        create: (action, callContext) => {
          calls.push(`create:${action.title}:${callContext.sessionId}:${callContext.taskId}`);
          return { action: action.type, status: "success", summary: "created" };
        },
        update: (action) => {
          calls.push(`update:${action.task_id}:${action.status}`);
          return { action: action.type, status: "success", summary: "updated" };
        },
        get: (action) => {
          calls.push(`get:${action.task_id}`);
          return { action: action.type, status: "success", summary: "got" };
        },
        list: (action) => {
          calls.push(`list:${action.status ?? "all"}`);
          return { action: action.type, status: "success", summary: "listed" };
        },
        output: (action) => {
          calls.push(`output:${action.task_id ?? action.output_ref}`);
          return { action: action.type, status: "success", summary: "output" };
        },
        stop: (action) => {
          calls.push(`stop:${action.task_id}`);
          return { action: action.type, status: "success", summary: "stopped" };
        }
      },
      worktreeControl: {
        enter: (action, callContext) => {
          calls.push(`enter:${action.name}:${callContext.workspace}:${callContext.sessionId}`);
          return { action: action.type, status: "success", summary: "entered" };
        },
        exit: (action) => {
          calls.push(`exit:${action.mode}`);
          return { action: action.type, status: "success", summary: "exited" };
        }
      }
    };

    await runLocalTool({ type: "task.create", title: "Task one" }, toolContext);
    await runLocalTool({ type: "task.update", task_id: "task-1", status: "running" }, toolContext);
    await runLocalTool({ type: "task.get", task_id: "task-1" }, toolContext);
    await runLocalTool({ type: "task.list", status: "running" }, toolContext);
    await runLocalTool({ type: "task.output", task_id: "task-1" }, toolContext);
    await runLocalTool({ type: "task.stop", task_id: "task-1" }, toolContext);
    await runLocalTool({ type: "worktree.enter", name: "task-7" }, toolContext);
    await runLocalTool({ type: "worktree.exit", mode: "remove" }, toolContext);

    assert.deepEqual(calls, [
      "create:Task one:session-1:loop-task",
      "update:task-1:running",
      "get:task-1",
      "list:running",
      "output:task-1",
      "stop:task-1",
      `enter:task-7:${workspace}:session-1`,
      "exit:remove"
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime coordination helpers dispatch through local context and enforce structured output gates", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-runtime-control-"));
  try {
    const calls: string[] = [];
    const toolContext: LocalToolContext = {
      ...context(workspace, "session-1"),
      taskId: "loop-task",
      runtimeControl: {
        structuredOutputEnabled: true,
        sendAgentMessage: (action, callContext) => {
          calls.push(`message:${action.worker_id}:${callContext.sessionId}:${callContext.taskId}`);
          return { action: action.type, status: "success", summary: "message sent" };
        },
        recordStructuredOutput: (action) => {
          calls.push(`structured:${action.label}`);
          return { action: action.type, status: "success", summary: "structured output recorded", data: action.value };
        },
        replMode: (action) => {
          calls.push(`repl:${action.mode}`);
          return { action: action.type, status: "success", summary: "repl guidance" };
        }
      }
    };

    const message = await runLocalTool({ type: "agent.message", worker_id: "worker-1", message: "ping" }, toolContext);
    assert.equal(message.status, "success");

    const sleep = await runLocalTool({ type: "runtime.sleep", duration_ms: 0, reason: "test" }, toolContext);
    assert.equal(sleep.status, "success");
    assert.equal(sleep.metadata?.capped, false);

    const structured = await runLocalTool({
      type: "structured.output",
      value: { ok: true },
      schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
      label: "final"
    }, toolContext);
    assert.equal(structured.status, "success");

    const repl = await runLocalTool({ type: "repl.mode", mode: "headless" }, toolContext);
    assert.equal(repl.status, "success");

    assert.deepEqual(calls, [
      "message:worker-1:session-1:loop-task",
      "structured:final",
      "repl:headless"
    ]);

    const mismatched = await runLocalTool({
      type: "structured.output",
      value: { ok: "yes" },
      schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }
    }, context(workspace));
    assert.equal(mismatched.status, "failed");
    assert.equal(mismatched.errorCode, "STRUCTURED_OUTPUT_SCHEMA_MISMATCH");

    const gated = await runLocalTool({ type: "structured.output", value: { ok: true } }, context(workspace));
    assert.equal(gated.status, "failed");
    assert.equal(gated.errorCode, "STRUCTURED_OUTPUT_NOT_ENABLED");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("external context and config tools normalize cc-style aliases", () => {
  const configGet = normalizeToolAction({ action: "Config", setting: "tools.webSearch" });
  assert.equal(configGet.type, "config.get");
  assert.equal(configGet.setting, "tools.webSearch");

  const configSet = normalizeToolAction({ action: "Config", setting: "tools.webSearch", value: false });
  assert.equal(configSet.type, "config.set");
  assert.equal(configSet.setting, "tools.webSearch");
  assert.equal(configSet.value, false);

  const resources = normalizeToolAction({ action: "ListMcpResources", server: "docs", limit: 5 });
  assert.equal(resources.type, "mcp.resources");
  assert.equal(resources.server, "docs");
  assert.equal(resources.limit, 5);

  const read = normalizeToolAction({ action: "ReadMcpResource", server: "docs", uri: "file://guide.md", max_bytes: 128 });
  assert.equal(read.type, "mcp.read");
  assert.equal(read.server, "docs");
  assert.equal(read.uri, "file://guide.md");
  assert.equal(read.maxBytes, 128);

  const call = normalizeToolAction({ action: "MCPTool", server: "github", tool_name: "search_code", args: { q: "Swarm" } });
  assert.equal(call.type, "mcp.call");
  assert.equal(call.server, "github");
  assert.equal(call.tool, "search_code");
  assert.deepEqual(call.args, { q: "Swarm" });

  const skill = normalizeToolAction({ action: "SkillTool", skill: "quality-review", reason: "review" });
  assert.equal(skill.type, "skill.invoke");
  assert.equal(skill.name, "quality-review");
  assert.equal(skill.reason, "review");
});

test("config tools expose only safe settings and refuse secrets", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-config-tool-"));
  const previousSwarmHome = process.env.SWARM_HOME;
  try {
    process.env.SWARM_HOME = join(workspace, ".swarm-home");
    const toolContext = context(workspace);

    const list = await runLocalTool({ type: "config.get" }, toolContext);
    assert.equal(list.status, "success");
    assert.match(list.content ?? "", /tools\.webSearch/);
    assert.doesNotMatch(list.content ?? "", /primaryApiKey|providerApiKeys/);

    const set = await runLocalTool({ type: "config.set", setting: "tools.webSearch", value: false }, toolContext);
    assert.equal(set.status, "success");
    assert.equal(toolContext.settings.tools.webSearch, false);

    const denied = await runLocalTool({ type: "config.get", setting: "providerApiKeys.openai" }, toolContext);
    assert.equal(denied.status, "failed");
    assert.equal(denied.errorCode, "CONFIG_SETTING_UNSUPPORTED");
    assert.match(denied.recoverySuggestion ?? "", /Secrets/);
  } finally {
    if (previousSwarmHome === undefined) {
      delete process.env.SWARM_HOME;
    } else {
      process.env.SWARM_HOME = previousSwarmHome;
    }
    await rm(workspace, { recursive: true, force: true });
  }
});

test("mcp and skill tools dispatch through runtime external context with recoverable status", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-external-context-"));
  try {
    const calls: string[] = [];
    const toolContext: LocalToolContext = {
      ...context(workspace, "session-1"),
      taskId: "loop-task",
      externalContext: {
        listMcpServers: () => [
          { id: "docs", status: "connected", transport: "stdio", trust: "user", exposeResources: true, exposeTools: true, toolCount: 1, resourceCount: 1 },
          { id: "needs-auth", status: "failed", transport: "stdio", trust: "user", exposeResources: true, exposeTools: true, lastError: "authentication required" }
        ],
        listMcpResources: (serverId) => {
          calls.push(`resources:${serverId}`);
          return [{ uri: "file://guide.md", name: "Guide", mimeType: "text/markdown" }];
        },
        readMcpResource: (input) => {
          calls.push(`read:${input.serverId}:${input.uri}:${input.sessionId}`);
          return { action: "mcp.read", status: "success", summary: "read", content: "resource" };
        },
        callMcpTool: (input) => {
          calls.push(`call:${input.serverId}:${input.tool}:${input.args?.q}`);
          return { action: "mcp.call", status: "success", summary: "called" };
        },
        listSkills: () => [{ name: "quality-review", displayName: "Quality Review", trust: "trusted" }],
        invokeSkill: (input) => {
          calls.push(`skill:${input.name}:${input.reason}`);
          return { action: "skill.invoke", status: "success", summary: "activated" };
        }
      }
    };

    const resources = await runLocalTool({ type: "mcp.resources", server: "docs" }, toolContext);
    assert.equal(resources.status, "success");
    assert.match(resources.content ?? "", /docs: Guide/);

    const failed = await runLocalTool({ type: "mcp.read", server: "needs-auth", uri: "file://guide.md" }, toolContext);
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "MCP_SERVER_NOT_CONNECTED");
    assert.match(failed.recoverySuggestion ?? "", /authentication required/);

    await runLocalTool({ type: "mcp.read", server: "docs", uri: "file://guide.md" }, toolContext);
    await runLocalTool({ type: "mcp.call", server: "docs", tool: "search", args: { q: "Swarm" } }, toolContext);
    await runLocalTool({ type: "skill.invoke", name: "quality-review", reason: "review" }, toolContext);

    assert.deepEqual(calls, [
      "resources:docs",
      "read:docs:file://guide.md:session-1",
      "call:docs:search:Swarm",
      "skill:quality-review:review"
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("file.write still allows complete replacement of an existing file after a full read", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-write-complete-"));
  try {
    const target = join(workspace, "script.js");
    const original = Array.from({ length: 120 }, (_, index) => `export const before${index} = ${index};`).join("\n");
    const replacement = Array.from({ length: 120 }, (_, index) => `export const after${index} = ${index + 1};`).join("\n");
    await writeFile(target, original, "utf8");
    const toolContext = context(workspace, `complete-${Date.now()}`);

    await runLocalTool({ type: "file.read", path: "script.js" }, toolContext);
    const result = await runLocalTool({ type: "file.write", path: "script.js", content: replacement }, toolContext);

    assert.equal(result.status, "success");
    assert.match(result.summary, /updated \d+ bytes at script\.js/);
    assert.equal(await readFile(target, "utf8"), replacement);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("file.read returns a compact unchanged result for repeated identical reads", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-read-unchanged-"));
  try {
    const target = join(workspace, "script.js");
    await writeFile(target, "one\ntwo\nthree\n", "utf8");
    const toolContext = context(workspace, `read-unchanged-${Date.now()}`);

    const first = await runLocalTool({ type: "file.read", path: "script.js", offset: 2, limit: 1 }, toolContext);
    const second = await runLocalTool({ type: "file.read", path: "script.js", offset: 2, limit: 1 }, toolContext);

    assert.equal(first.content, "two");
    assert.equal(second.content, "");
    assert.equal(second.metadata?.unchanged, true);
    assert.equal(second.metadata?.startLine, 2);
    assert.equal(second.metadata?.endLine, 2);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("file.write allows write after metadata-only mtime drift when content is unchanged", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-write-mtime-drift-"));
  try {
    const target = join(workspace, "script.js");
    const original = "export const before = 1;\n";
    const replacement = "// Time Attack logic placeholder\n";
    await writeFile(target, original, "utf8");
    const toolContext = context(workspace, `mtime-drift-${Date.now()}`);

    await runLocalTool({ type: "file.read", path: "script.js" }, toolContext);
    const future = new Date(Date.now() + 60_000);
    await utimes(target, future, future);
    const result = await runLocalTool({ type: "file.write", path: "script.js", content: replacement }, toolContext);

    assert.equal(result.status, "success");
    assert.equal(await readFile(target, "utf8"), replacement);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("file.edit insert preserves existing CRLF line endings", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-edit-crlf-"));
  try {
    const target = join(workspace, "script.js");
    await writeFile(target, "one\r\ntwo\r\nthree\r\n", "utf8");
    const toolContext = context(workspace, `edit-crlf-${Date.now()}`);

    await runLocalTool({ type: "file.read", path: "script.js" }, toolContext);
    const result = await runLocalTool({
      type: "file.edit",
      path: "script.js",
      operation: "insert",
      line: 2,
      content: "inserted"
    }, toolContext);

    assert.equal(result.status, "success");
    assert.equal(await readFile(target, "utf8"), "one\r\ninserted\r\ntwo\r\nthree\r\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("file.edit refuses notebook files with notebook.edit recovery guidance", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-file-edit-notebook-"));
  try {
    const target = join(workspace, "analysis.ipynb");
    await writeFile(target, JSON.stringify({
      cells: [{
        id: "cell-1",
        cell_type: "markdown",
        metadata: {},
        source: ["old\n"]
      }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5
    }, null, 2), "utf8");
    const toolContext = context(workspace, `edit-notebook-${Date.now()}`);

    await runLocalTool({ type: "file.read", path: "analysis.ipynb" }, toolContext);
    const result = await runLocalTool({
      type: "file.edit",
      path: "analysis.ipynb",
      operation: "str_replace",
      oldText: "old",
      newText: "new"
    }, toolContext);

    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "INVALID_INPUT");
    assert.match(result.summary, /file\.edit cannot edit notebook files/);
    assert.match(result.recoverySuggestion ?? "", /Use notebook\.edit/);
    assert.equal(await readFile(target, "utf8"), JSON.stringify({
      cells: [{
        id: "cell-1",
        cell_type: "markdown",
        metadata: {},
        source: ["old\n"]
      }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5
    }, null, 2));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("notebook.edit requires newSource for replace and insert modes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-notebook-new-source-"));
  try {
    const target = join(workspace, "analysis.ipynb");
    await writeFile(target, JSON.stringify({
      cells: [{
        id: "cell-1",
        cell_type: "markdown",
        metadata: {},
        source: ["old\n"]
      }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5
    }, null, 2), "utf8");
    const toolContext = context(workspace, `notebook-new-source-${Date.now()}`);

    await runLocalTool({ type: "file.read", path: "analysis.ipynb" }, toolContext);
    await assert.rejects(
      runLocalTool({
        type: "notebook.edit",
        notebookPath: "analysis.ipynb",
        cellId: "cell-1",
        editMode: "replace"
      }, toolContext),
      /notebook\.edit replace requires new_source/
    );

    await runLocalTool({ type: "file.read", path: "analysis.ipynb" }, toolContext);
    await assert.rejects(
      runLocalTool({
        type: "notebook.edit",
        notebookPath: "analysis.ipynb",
        cellId: "cell-1",
        editMode: "insert"
      }, toolContext),
      /notebook\.edit insert requires new_source/
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
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

function context(workspace: string, sessionId = `test-${Date.now()}-${Math.random()}`): LocalToolContext {
  const settings = defaultSwarmSettings();
  settings.permissions.defaultMode = "full-auto";
  return { workspace, settings, sessionId };
}

function minimalInputsForTool(tool: string): Record<string, unknown> {
  const inputs: Record<string, Record<string, unknown>> = {
    Read: { file_path: "src/example.ts" },
    Glob: { pattern: "**/*.ts" },
    Grep: { pattern: "needle" },
    Write: { file_path: "src/example.ts", content: "export const value = 1;\n" },
    Edit: { file_path: "src/example.ts", old_string: "before", new_string: "after" },
    NotebookEdit: { notebook_path: "analysis.ipynb", cell_id: "cell-1", new_source: "updated", edit_mode: "replace" },
    Bash: { command: "npm test" },
    PowerShell: { command: "Get-ChildItem ." },
    "code.test": { command: "npm test" },
    "code.lint": {},
    ProcessStart: { command: "npm run dev" },
    ProcessStatus: {},
    ProcessList: {},
    ProcessTail: { processId: "proc-1" },
    ProcessGrep: { processId: "proc-1", pattern: "ready" },
    ProcessStop: { processId: "proc-1" },
    WebSearch: { query: "swarm cli" },
    WebFetch: { url: "https://example.com" },
    Config: { setting: "tools.webSearch" },
    McpResources: {},
    McpRead: { server: "docs", uri: "file://guide.md" },
    McpAuth: {},
    McpCall: { server: "docs", tool: "search", args: { q: "Swarm" } },
    SkillInvoke: { name: "quality-review" },
    "file.delete": { path: "src/example.ts" },
    TodoWrite: { todos: [] },
    AskUserQuestion: { prompt: "Choose next step", choices: [{ label: "Continue" }] },
    EnterPlanMode: { objective: "Plan the change" },
    ExitPlanMode: { plan: "1. Inspect\n2. Implement\n3. Verify" },
    BlackboardWrite: { key: "plan.current", type: "plan", value: {} },
    BlackboardSearch: {},
    BlackboardRead: { key: "plan.current" },
    BlackboardList: {},
    AgentList: {},
    AgentStatus: { worker_id: "worker-1" },
    AgentStop: { worker_id: "worker-1" },
    AgentContinue: { worker_id: "worker-1", message: "continue" },
    AgentMessage: { worker_id: "worker-1", message: "ping" },
    RuntimeSleep: { duration_ms: 0 },
    StructuredOutput: { value: { ok: true } },
    ReplMode: { mode: "interactive" },
    ScheduleCreate: { cron: "0 9 * * 1", prompt: "Run weekly verification" },
    ScheduleList: {},
    ScheduleDelete: { schedule_id: "sched-1" },
    RemoteTrigger: { endpoint: "ci", payload: { ref: "main" } },
    TeamCreate: { objective: "Review the release" },
    TeamDelete: { team_id: "team-1" },
    TaskCreate: { title: "Inspect task state" },
    TaskUpdate: { task_id: "task-1", status: "running" },
    TaskGet: { task_id: "task-1" },
    TaskList: {},
    TaskOutput: { task_id: "task-1" },
    TaskStop: { task_id: "task-1" },
    ToolSearch: { query: "grep" },
    "lsp.diagnostics": { file: "src/example.ts" },
    "lsp.hover": { file: "src/example.ts", line: 1, character: 0 },
    "lsp.definition": { file: "src/example.ts", line: 1, character: 0 },
    "lsp.references": { file: "src/example.ts", line: 1, character: 0 },
    "lsp.document_symbols": { file: "src/example.ts" },
    "lsp.workspace_symbols": { query: "Example" },
    "lsp.completion": { file: "src/example.ts", line: 1, character: 0 },
    "lsp.code_actions": { file: "src/example.ts", startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 1 },
    "lsp.rename_preview": { file: "src/example.ts", line: 1, character: 0, newName: "renamed" },
    "lsp.format": { file: "src/example.ts" }
  };
  return { action: tool, ...(inputs[tool] ?? {}) };
}

function blackboardEntry(overrides: Partial<BlackboardEntry> = {}): BlackboardEntry {
  return {
    entry_id: "entry-1",
    swarm_id: "swarm-1",
    session_id: "session-1",
    key: "decision/auth",
    value: { approved: true },
    type: "decision",
    created_by: { agent_id: "agent-1", role: "worker" },
    created_at: "2026-06-08T00:00:00.000Z",
    visibility: "team",
    version: 1,
    tags: ["decision"],
    ...overrides
  };
}
