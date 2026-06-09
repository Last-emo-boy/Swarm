import { strict as assert } from "node:assert";
import test from "node:test";
import {
  commandCandidatesForInput,
  formatToolOutputPreview,
  parseSlashCommandLine,
  renderSlashHelp,
  slashCommands
} from "./slash-commands.js";

test("slash command registry includes required operator surface commands", () => {
  const commands = new Map(slashCommands.map((command) => [command.name, command]));

  assert.equal(commands.get("kernel")?.group, "Kernel");
  assert.equal(commands.get("kernel")?.aliases?.includes("status"), true);
  assert.equal(commands.get("symphony")?.group, "Symphony");
  assert.equal(commands.get("approvals")?.group, "Kernel");
  assert.equal(commands.get("doctor")?.group, "Core");
  assert.equal(commands.get("review")?.usage, "/review [focus]");
  assert.equal(commands.get("density")?.usage, "/density [auto|compact|default|comfortable]");
  assert.equal(commands.get("view")?.group, "Core");
  assert.equal(commands.get("plan")?.usage, "/plan [objective]");
  assert.equal(commands.get("approve")?.usage, "/approve [approval_id] [message]");
  assert.equal(commands.get("blackboard")?.description, "Query shared facts.");
  assert.equal(commands.get("memory")?.usage, "/memory [saved_work]");
  assert.equal(commands.get("resume")?.usage, "/resume [saved_work] [note]");
  assert.equal(commands.get("continue")?.description, "Continue the most recent work with a quick freshness check.");
  assert.equal(commands.get("evals")?.usage, "/evals [--release-gate|--cache-lab|--tui-replay]");
  assert.equal(commands.get("swarm")?.group, "Agents");
  assert.equal(commands.get("swarm")?.usage, "/swarm [summary|ownership|mailbox <actor_id>|agent <actor_id>]");
  assert.equal(commands.get("ownership")?.usage, "/ownership");
  assert.equal(commands.get("mailbox")?.usage, "/mailbox <actor_id>");
  assert.equal(commands.get("agent")?.usage, "/agent <actor_id|agent_spec_id>");
  assert.equal(commands.get("capabilities")?.group, "Config");
});

test("slash command help exposes Kernel, Symphony, and extension operator namespaces", () => {
  assert.match(renderSlashHelp({ includeAdvanced: true }), /\/kernel \[workflow_path\]/);
  assert.match(renderSlashHelp({ namespace: "symphony" }), /\/symphony \[workflow_path\]/);
  assert.match(renderSlashHelp({ namespace: "symphony" }), /\/symphony-daemon \[daemon_id\]/);
  assert.match(renderSlashHelp({ namespace: "debug" }), /\/approvals \[session_id\]/);
  assert.match(renderSlashHelp({ namespace: "debug" }), /\/debug <latest\|timeline\|trace\|blackboard\|audit\|usage\|cache\|events>/);
  assert.match(renderSlashHelp({ namespace: "debug" }), /\/debug blackboard - Query shared facts\./);
  assert.doesNotMatch(renderSlashHelp({ namespace: "debug" }), /Query blackboard facts|shared board facts/);
  assert.match(renderSlashHelp({ namespace: "debug" }), /\/debug timeline \[actor:<id>\|task:<id>\|correlation:<id>\|category:<kind>\]/);
  assert.match(renderSlashHelp({ namespace: "swarm" }), /\/swarm/);
  assert.match(renderSlashHelp({ namespace: "swarm" }), /\/mailbox <actor_id>/);
  assert.match(renderSlashHelp({ namespace: "ext" }), /\/capabilities \[kind\|provider\|query\|all\]/);
});

test("default slash help stays on the main path unless advanced help is requested", () => {
  const basicHelp = renderSlashHelp();

  assert.match(basicHelp, /Start/);
  assert.match(basicHelp, /\/review \[area\]/);
  assert.match(basicHelp, /\/plan \[task\]/);
  assert.match(basicHelp, /\/approve \[id\]/);
  assert.match(basicHelp, /\/continue \[note\]/);
  assert.match(basicHelp, /\/onboard/);
  assert.match(basicHelp, /\/review \[area\][\s\S]*\/plan \[task\][\s\S]*\/approve \[id\][\s\S]*\/continue \[note\][\s\S]*\/onboard/);
  assert.match(basicHelp, /\/help all/);
  assert.doesNotMatch(basicHelp, /^Advanced$/m);
  assert.doesNotMatch(basicHelp, /^Work$|^Ask$|^Setup$/m);
  assert.doesNotMatch(basicHelp, /implementation plan|local coding session|result-first Codebase Deep Review|provider, API key, and model once|approval_id|objective|focus|message/);
  assert.doesNotMatch(basicHelp, /Recovery|\/why|\/help debug|\/help work|\/help ext|\/doctor \[workflow_path\]|\/work <board\|sessions\|attempts\|output\|files\|checks>|\/checkpoint <list\|create\|revert>|\/revert last/);
  assert.doesNotMatch(basicHelp, /Ctrl\+N|Ctrl\+P|pane switch/i);
  assert.doesNotMatch(basicHelp, /Kernel|Gateway|Symphony|MCP|LSP|full_swarm|route|planner|worker|aggregator/);
  assert.match(renderSlashHelp({ namespace: "main" }), /\/help all/);
  assert.match(renderSlashHelp({ namespace: "work" }), /\/work <board\|sessions\|attempts\|output\|files\|checks\|workers>/);
  assert.match(renderSlashHelp({ namespace: "work" }), /\/checkpoint <list\|create\|revert>/);
  assert.match(renderSlashHelp({ namespace: "work" }), /\/work checks - Review verification results\./);
  assert.doesNotMatch(renderSlashHelp({ namespace: "work" }), /work-session artifacts|unified work board|List recent work sessions|Show recorded checks|Show recorded workspace changes|Inspect sessions|List persisted task graph|Inspect the task graph|trace, audit, and usage|worker agents|List, create, or revert|Revert the latest/);
  assert.doesNotMatch(basicHelp, /\/symphony-start/);
  assert.match(renderSlashHelp({ includeAdvanced: true }), /\/symphony-start/);
  assert.doesNotMatch(renderSlashHelp({ includeAdvanced: true }), /coding-loop session|preflight summary|remembered session context/);
});

test("slash command candidates include required commands and aliases", () => {
  assert.equal(commandCandidatesForInput("/ker", 4, { includeAdvanced: true })[0]?.name, "kernel");
  assert.deepEqual(commandCandidatesForInput("/status", 7, { includeAdvanced: true }).map((command) => command.name).slice(0, 2), ["status", "kernel"]);
  assert.equal(commandCandidatesForInput("/sym", 4, { includeAdvanced: true })[0]?.name, "symphony");
  assert.equal(commandCandidatesForInput("/debug l", 8, { includeAdvanced: true })[0]?.name, "latest");
  assert.equal(commandCandidatesForInput("/debug t", 8, { includeAdvanced: true })[0]?.name, "timeline");
  assert.equal(commandCandidatesForInput("/pla", 4)[0]?.name, "plan");
  assert.equal(commandCandidatesForInput("/rev", 4)[0]?.name, "review");
  assert.equal(commandCandidatesForInput("/appr", 5).some((command) => command.name === "approve"), true);
  assert.equal(commandCandidatesForInput("/swa", 4, { includeAdvanced: true })[0]?.name, "swarm");
  assert.equal(commandCandidatesForInput("/mail", 5, { includeAdvanced: true })[0]?.name, "mailbox");
});

test("slash command candidates keep the empty menu on the main path", () => {
  const names = commandCandidatesForInput("/", 1).map((command) => command.name);

  assert.deepEqual(names.slice(0, 5), ["review", "plan", "approve", "continue", "onboard"]);
  assert(names.includes("review"));
  assert(names.includes("plan"));
  assert(names.includes("approve"));
  assert(names.includes("onboard"));
  assert(names.includes("continue"));
  assert(!names.includes("why"));
  assert(!names.includes("doctor"));
  assert(!names.includes("resume"));
  assert(!names.includes("work"));
  assert(!names.includes("checkpoint"));
  assert(!names.includes("revert"));
  assert(!names.includes("debug"));
  assert(!names.includes("ext"));
  assert(!names.includes("symphony"));
  assert(!names.includes("swarm"));
  assert(!names.includes("approval"));
  assert(!names.includes("density"));
});

test("slash command candidates keep advanced commands behind explicit detail", () => {
  const defaultNames = commandCandidatesForInput("/sw", 3).map((command) => command.name);

  assert(!defaultNames.includes("swarm"));
  assert(!defaultNames.includes("symphony"));
  assert(!defaultNames.includes("debug"));
  assert(!defaultNames.includes("trace"));
  assert.equal(commandCandidatesForInput("/why", 4, { includeAdvanced: true }).some((command) => command.name === "why"), true);
  assert.equal(commandCandidatesForInput("/doc", 4, { includeAdvanced: true }).some((command) => command.name === "doctor"), true);
  assert.equal(commandCandidatesForInput("/sw", 3, { includeAdvanced: true }).some((command) => command.name === "swarm"), true);
  assert.equal(commandCandidatesForInput("/res", 4, { includeAdvanced: true }).some((command) => command.name === "resume"), true);
  assert.equal(commandCandidatesForInput("/symphony s", 11).some((command) => command.name === "status"), true);
});

test("slash command parser preserves raw args for operator commands", () => {
  assert.deepEqual(parseSlashCommandLine('/approvals session-1 --status "pending"'), {
    command: "approvals",
    args: ["session-1", "--status", "pending"],
    rawArgs: 'session-1 --status "pending"',
    argSpans: [
      { value: "session-1", start: 11, end: 20 },
      { value: "--status", start: 21, end: 29 },
      { value: "pending", start: 30, end: 39 }
    ],
    source: '/approvals session-1 --status "pending"'
  });
  assert.deepEqual(parseSlashCommandLine("/evals --release-gate"), {
    command: "evals",
    args: ["--release-gate"],
    rawArgs: "--release-gate",
    argSpans: [
      { value: "--release-gate", start: 7, end: 21 }
    ],
    source: "/evals --release-gate"
  });
  assert.deepEqual(parseSlashCommandLine("/evals --cache-lab"), {
    command: "evals",
    args: ["--cache-lab"],
    rawArgs: "--cache-lab",
    argSpans: [
      { value: "--cache-lab", start: 7, end: 18 }
    ],
    source: "/evals --cache-lab"
  });
  assert.deepEqual(parseSlashCommandLine("/evals --tui-replay"), {
    command: "evals",
    args: ["--tui-replay"],
    rawArgs: "--tui-replay",
    argSpans: [
      { value: "--tui-replay", start: 7, end: 19 }
    ],
    source: "/evals --tui-replay"
  });
  assert.deepEqual(parseSlashCommandLine("/mailbox worker:surface-1"), {
    command: "mailbox",
    args: ["worker:surface-1"],
    rawArgs: "worker:surface-1",
    argSpans: [
      { value: "worker:surface-1", start: 9, end: 25 }
    ],
    source: "/mailbox worker:surface-1"
  });
  assert.deepEqual(parseSlashCommandLine("/review auth and permissions"), {
    command: "review",
    args: ["auth", "and", "permissions"],
    rawArgs: "auth and permissions",
    argSpans: [
      { value: "auth", start: 8, end: 12 },
      { value: "and", start: 13, end: 16 },
      { value: "permissions", start: 17, end: 28 }
    ],
    source: "/review auth and permissions"
  });
  assert.deepEqual(parseSlashCommandLine("/agent worker:surface-1"), {
    command: "agent",
    args: ["worker:surface-1"],
    rawArgs: "worker:surface-1",
    argSpans: [
      { value: "worker:surface-1", start: 7, end: 23 }
    ],
    source: "/agent worker:surface-1"
  });
});

test("tool output preview uses action-first recovery wording", () => {
  const preview = formatToolOutputPreview({
    task_id: "task-1",
    attempt: 2,
    action: "file.edit",
    status: "failed",
    summary: "Replacement was ambiguous.",
    recoverySuggestion: "Search for a unique old text, then retry.",
    outputRef: "outputs/task-1.txt",
    content: "first line\nsecond line"
  });

  assert.match(preview, /^task-1#2 file\.edit \[failed\]: Replacement was ambiguous\./);
  assert.match(preview, /Next: Search for a unique old text, then retry\./);
  assert.doesNotMatch(preview, /Recovery:/);
  assert.match(preview, /Saved: outputs\/task-1\.txt/);
});
