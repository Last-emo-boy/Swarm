import { strict as assert } from "node:assert";
import test from "node:test";
import {
  commandCandidatesForInput,
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
  assert.equal(commands.get("view")?.group, "Core");
  assert.equal(commands.get("capabilities")?.group, "Config");
});

test("slash command help exposes Kernel, Symphony, and extension operator namespaces", () => {
  assert.match(renderSlashHelp({ includeAdvanced: true }), /\/kernel \[workflow_path\]/);
  assert.match(renderSlashHelp({ namespace: "symphony" }), /\/symphony \[workflow_path\]/);
  assert.match(renderSlashHelp({ namespace: "symphony" }), /\/symphony-daemon \[daemon_id\]/);
  assert.match(renderSlashHelp({ namespace: "debug" }), /\/approvals \[session_id\]/);
  assert.match(renderSlashHelp({ namespace: "ext" }), /\/capabilities \[kind\|provider\|query\|all\]/);
});

test("default slash help stays on the main path unless advanced help is requested", () => {
  const basicHelp = renderSlashHelp();

  assert.match(basicHelp, /\/help/);
  assert.match(basicHelp, /\/view \[chat\|trace\|overview\|output\|sessions\|attempts\|agents\|blackboard\]/);
  assert.match(basicHelp, /\/kernel \[workflow_path\]/);
  assert.doesNotMatch(basicHelp, /Ctrl\+N|Ctrl\+P|pane switch/i);
  assert.doesNotMatch(basicHelp, /\/symphony-start/);
  assert.match(renderSlashHelp({ includeAdvanced: true }), /\/symphony-start/);
});

test("slash command candidates include required commands and aliases", () => {
  assert.equal(commandCandidatesForInput("/ker", 4, { includeAdvanced: true })[0]?.name, "kernel");
  assert.deepEqual(commandCandidatesForInput("/status", 7, { includeAdvanced: true }).map((command) => command.name).slice(0, 2), ["status", "kernel"]);
  assert.equal(commandCandidatesForInput("/sym", 4, { includeAdvanced: true })[0]?.name, "symphony");
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
});
