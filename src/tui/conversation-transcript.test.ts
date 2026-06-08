import { strict as assert } from "node:assert";
import test from "node:test";
import {
  appendTranscriptMessage,
  createStartupLogoMessage,
  runtimeEventTranscriptMessage,
  slashCommandTranscriptMessage,
  slashToolUseTranscriptMessage
} from "./conversation-transcript.js";

test("startup logo message carries compact welcome metadata", () => {
  const message = createStartupLogoMessage({
    version: "0.1.0",
    cwd: "E:\\Playground\\Swarm",
    model: "openai/gpt"
  });

  assert.equal(message.kind, "logo");
  assert.match(message.brief, /Swarm/);
  assert.match(message.brief, /Local workspace/);
  assert.match(message.brief, /v0\.1\.0/);
  assert.match(message.brief, /openai\/gpt/);
  assert.doesNotMatch(message.brief, /Symphony|Local Swarm Runtime|model not configured/i);
});

test("startup logo message hides missing model fallback copy", () => {
  const message = createStartupLogoMessage({
    cwd: "E:\\Playground\\Swarm",
    model: "model not configured"
  });

  assert.equal(message.detail, undefined);
  assert.match(message.brief, /Local workspace/);
  assert.doesNotMatch(message.brief, /model not configured/i);
});

test("slash command and tool use become transcript messages", () => {
  assert.deepEqual(slashCommandTranscriptMessage("/shell npm test"), {
    role: "user",
    kind: "command",
    brief: "/shell npm test",
    title: "Command"
  });

  const tool = slashToolUseTranscriptMessage({
    type: "shell.exec",
    command: "npm test",
    cwd: "."
  });
  assert.equal(tool.kind, "tool_use");
  assert.equal(tool.status, "running");
  assert.match(tool.brief, /Run shell command: npm test/);
  assert.match(tool.detail ?? "", /Command: npm test/);
});

test("structured question and plan tools render product-facing transcript text", () => {
  const question = slashToolUseTranscriptMessage({
    type: "ask_user_question",
    prompt: "Choose the implementation scope",
    choices: [{ label: "Minimal" }, { label: "Complete" }]
  });
  assert.equal(question.kind, "tool_use");
  assert.match(question.brief, /Ask user Choose the implementation scope/);
  assert.match(question.detail ?? "", /Question: Choose the implementation scope/);

  const approval = slashToolUseTranscriptMessage({
    type: "plan.exit",
    plan: "1. Inspect\n2. Edit\n3. Verify",
    summary: "Plan ready"
  });
  assert.match(approval.brief, /Request plan approval Plan ready/);
  assert.match(approval.detail ?? "", /Plan: 1\. Inspect/);
});

test("runtime loop activity and tool results become visible transcript rows", () => {
  const thinking = runtimeEventTranscriptMessage({
    type: "loop_activity",
    session_id: "sess",
    phase: "thinking",
    message: "Swarm is thinking"
  });
  assert.equal(thinking?.kind, "thinking");
  assert.equal(thinking?.status, "running");

  const toolResult = runtimeEventTranscriptMessage({
    type: "tool_result",
    session_id: "sess",
    task_id: "task",
    title: "Run tests",
    action: "shell.exec",
    summary: "command exited 0",
    content: "$ npm test\nok\nnext line\nextra line\nhidden line",
    status: "success"
  });
  assert.equal(toolResult?.kind, "tool_result");
  assert.equal(toolResult?.status, "success");
  assert.match(toolResult?.preview ?? "", /shell\.exec: command exited 0/);
  assert.doesNotMatch(toolResult?.preview ?? "", /hidden line/);
});

test("runtime transcript rows include the running agent identity", () => {
  const thinking = runtimeEventTranscriptMessage({
    type: "loop_activity",
    session_id: "worker-loop-1",
    phase: "thinking",
    message: "Worker is thinking",
    agent: {
      worker_id: "worker-1",
      display_name: "Ada",
      role_title: "Diff Investigator",
      agent_spec_id: "researcher",
      invocation_mode: "call_subagent"
    }
  });
  assert.equal(thinking?.kind, "thinking");
  assert.match(thinking?.brief ?? "", /Ada \/ Diff Investigator: Worker is thinking/);

  const completed = runtimeEventTranscriptMessage({
    type: "agent_run_completed",
    worker: {
      worker_id: "worker-1",
      display_name: "Ada",
      role_title: "Diff Investigator",
      parent_session_id: "parent-1",
      worker_session_id: "worker-loop-1",
      agent_spec_id: "researcher",
      invocation_mode: "call_subagent",
      capability: "code.inspect",
      objective: "Inspect diff",
      status: "completed",
      file_scope: [],
      tool_budget: { max_turns: 2, max_tool_calls: 4 },
      created_at: "2026-05-14T00:00:00.000Z",
      updated_at: "2026-05-14T00:00:01.000Z"
    },
    result: "Found the relevant event path.\nSecond line"
  });
  assert.equal(completed?.kind, "progress");
  assert.equal(completed?.status, "success");
  assert.match(completed?.preview ?? "", /Ada \/ Diff Investigator/);
  assert.match(completed?.preview ?? "", /Found the relevant event path/);
});

test("duplicate transcript messages collapse by visible signature", () => {
  const first = slashCommandTranscriptMessage("/help");
  const messages = appendTranscriptMessage([first], slashCommandTranscriptMessage("/help"));

  assert.equal(messages.length, 1);
});
