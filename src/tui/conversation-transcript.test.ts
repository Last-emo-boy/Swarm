import { strict as assert } from "node:assert";
import test from "node:test";
import type { RuntimeEvent } from "../runtime/events.js";
import type { ConversationMessage } from "./conversation-layout.js";
import {
  appendTranscriptMessage,
  applyRuntimeEventToTranscript,
  slashCommandTranscriptMessage,
  slashToolUseTranscriptMessage,
  toolGroupSummary
} from "./conversation-transcript.js";

const apply = (events: RuntimeEvent[], start: ConversationMessage[] = []): ConversationMessage[] =>
  events.reduce(applyRuntimeEventToTranscript, start);

test("slash commands and their tools become transcript rows in user words", () => {
  assert.deepEqual(slashCommandTranscriptMessage("/shell npm test"), {
    role: "user",
    kind: "command",
    brief: "/shell npm test",
    title: "Command"
  });

  const tool = slashToolUseTranscriptMessage({ type: "shell.exec", command: "npm test", cwd: "." });
  assert.equal(tool.kind, "tool_use");
  assert.equal(tool.status, "running");
  assert.deepEqual([tool.tool?.verb, tool.tool?.target], ["Bash", "npm test"]);
  assert.match(tool.detail ?? "", /Command: npm test/);
});

test("a tool call is one row, updated in place as it waits for approval and returns", () => {
  const rows = apply([
    { type: "loop_activity", session_id: "s", phase: "thinking", message: "Swarm is thinking" },
    { type: "loop_activity", session_id: "s", phase: "running_tools", message: "Running 1 read-only tools: Read" },
    { type: "loop_activity", session_id: "s", phase: "running_tool", message: "Running shell.exec ls src", tool: "shell.exec", task_id: "t1" },
    { type: "loop_activity", session_id: "s", phase: "waiting_approval", message: "Waiting for approval: shell.exec ls src", tool: "shell.exec", task_id: "t1" }
  ]);
  assert.equal(rows.length, 1, "thinking and batch notices add no rows");
  assert.deepEqual([rows[0]?.tool?.verb, rows[0]?.tool?.target, rows[0]?.tool?.approval, rows[0]?.status], ["Bash", "ls src", "pending", "pending"]);

  const done = apply([
    { type: "approval", status: "approved", request: { id: "a1", task_id: "t1", action: "shell.exec", target: "ls src", summary: "Run shell command: ls src" } as never },
    { type: "tool_result", session_id: "s", task_id: "t1", title: "Run", action: "shell.exec", summary: "command exited 0", content: "a\nb", status: "success" }
  ], rows);
  assert.equal(done.length, 1);
  assert.deepEqual([done[0]?.status, done[0]?.tool?.approval, done[0]?.tool?.note], ["success", "approved", undefined]);
  assert.match(done[0]?.detail ?? "", /command exited 0[\s\S]*a\nb/);
});

test("a failed call says why in a few words, and a denied one says it was denied", () => {
  const failed = apply([
    { type: "loop_activity", session_id: "s", phase: "running_tool", message: "Running file.edit src/a.ts", tool: "file.edit", task_id: "t2" },
    { type: "tool_result", session_id: "s", task_id: "t2", title: "Edit", action: "file.edit", summary: "str_replace found 2 matches\nmore", status: "failed" }
  ]);
  assert.deepEqual([failed[0]?.tool?.verb, failed[0]?.status, failed[0]?.tool?.note], ["Edit", "error", "str_replace found 2 matches"]);

  const denied = apply([
    { type: "approval", status: "denied", request: { id: "a2", task_id: "t3", action: "shell.exec", target: "rm -rf build", summary: "Run" } as never }
  ]);
  assert.deepEqual([denied[0]?.tool?.verb, denied[0]?.tool?.target, denied[0]?.tool?.approval, denied[0]?.status], ["Bash", "rm -rf build", "denied", "error"]);
});

test("a subagent is one row from start to finish, named by its identity", () => {
  const worker = {
    worker_id: "worker-1",
    display_name: "Ada",
    role_title: "Diff Investigator",
    parent_session_id: "parent-1",
    worker_session_id: "worker-loop-1",
    agent_spec_id: "researcher",
    invocation_mode: "call_subagent" as const,
    capability: "code.inspect",
    objective: "Inspect diff",
    status: "completed" as const,
    file_scope: [],
    tool_budget: { max_turns: 2, max_tool_calls: 4 },
    created_at: "2026-05-14T00:00:00.000Z",
    updated_at: "2026-05-14T00:00:01.000Z"
  };
  const rows = apply([
    { type: "agent_run_started", worker: { ...worker, status: "running" }, task_packet: { objective: "Inspect diff" } } as never,
    { type: "loop_activity", session_id: "worker-loop-1", phase: "thinking", message: "Worker is thinking", agent: { worker_id: "worker-1" } },
    { type: "agent_run_completed", worker, result: "Found the relevant event path.\nSecond line" }
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]?.tool?.verb, rows[0]?.tool?.target, rows[0]?.status], ["Agent", "Ada / Diff Investigator: Inspect diff", "success"]);
  assert.match(rows[0]?.preview ?? "", /Found the relevant event path/);
});

test("a settled turn's calls fold into one line that counts what they did and what failed", () => {
  const row = (verb: string, status: ConversationMessage["status"] = "success", approval?: "denied"): Pick<ConversationMessage, "status" | "tool"> =>
    ({ status, tool: { verb, target: "x", ...(approval ? { approval } : {}) } });
  assert.deepEqual(toolGroupSummary([row("Read"), row("Read"), row("Bash", "error"), row("Edit"), row("Agent")]),
    { text: "Read 2 files, edited 1 file, ran 1 command, 1 agent", failed: 1, denied: 0 });
  assert.deepEqual(toolGroupSummary([row("Search"), row("Bash", "error", "denied")]),
    { text: "Ran 1 command, searched once", failed: 0, denied: 1 });
});

test("duplicate transcript messages collapse by visible signature", () => {
  const first = slashCommandTranscriptMessage("/help");
  const messages = appendTranscriptMessage([first], slashCommandTranscriptMessage("/help"));

  assert.equal(messages.length, 1);
});
