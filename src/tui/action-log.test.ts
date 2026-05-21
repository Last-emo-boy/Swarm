import { strict as assert } from "node:assert";
import test from "node:test";
import { runtimeEventToActionRow } from "./action-log.js";
import { nextMainPane } from "./main-panes.js";

test("tool result action rows keep successful output behind details", () => {
  const row = runtimeEventToActionRow({
    type: "tool_result",
    session_id: "session-1",
    task_id: "task-1",
    title: "Read file",
    action: "file.read",
    summary: "Read README.md",
    content: "line 1\nline 2\nline 3",
    status: "success",
    outputRef: "tool-output-1"
  }, 0);

  assert.equal(row.kind, "tool");
  assert.equal(row.status, "success");
  assert.equal(row.title, "Tool file.read");
  assert.equal(row.summary, "Read README.md");
  assert(row.details.includes("line 1"));
});

test("tool result action rows show the running agent identity", () => {
  const row = runtimeEventToActionRow({
    type: "tool_result",
    session_id: "worker-loop-1",
    task_id: "task-1",
    title: "Read file",
    action: "file.read",
    summary: "Read README.md",
    content: "line 1",
    status: "success",
    agent: {
      worker_id: "worker-1",
      display_name: "Ada",
      role_title: "Diff Investigator",
      agent_spec_id: "researcher",
      invocation_mode: "call_subagent"
    }
  }, 0);

  assert(row.details.includes("agent=Ada / Diff Investigator"));
  assert(row.details.includes("worker=worker-1"));
});

test("activity action rows show the running agent identity", () => {
  const row = runtimeEventToActionRow({
    type: "loop_activity",
    session_id: "worker-loop-1",
    phase: "running_tool",
    message: "running code build",
    turn: 2,
    tool: "code.build",
    task_id: "task-1",
    agent: {
      worker_id: "worker-1",
      display_name: "Ada",
      role_title: "Diff Investigator",
      agent_spec_id: "researcher",
      invocation_mode: "call_subagent"
    }
  }, 0);

  assert.equal(row.kind, "work:activity");
  assert.equal(row.summary, "Ada / Diff Investigator: running code build");
  assert(row.details.includes("agent=Ada / Diff Investigator"));
  assert(row.details.includes("worker=worker-1"));
  assert(row.details.includes("agent_spec=researcher"));
  assert(row.details.includes("mode=call_subagent"));
});

test("main pane navigation remains explicit through slash view routing", () => {
  assert.equal(nextMainPane("overview", 1), "output");
  assert.equal(nextMainPane("overview", -1), "log");
  assert.equal(nextMainPane("blackboard", 1), "chat");
});
