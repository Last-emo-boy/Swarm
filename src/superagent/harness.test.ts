/**
 * The harness registry: the arguments each kind passes (the flags verified against `claude --help` 2.1.285 and
 * `codex exec --help` 0.163.0), how it reads the events those CLIs printed in recorded runs, profiles and their keys, the
 * budget stop, and how a request's harness choice becomes its ticket's execution. No harness or model runs here.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { SuperagentClient } from "./client.js";
import { HARNESS_KINDS, HarnessProfileSchema, HarnessSetupError, harnessIds, resolveHarness, runTurn, type TurnEvents, type TurnRequest } from "./harness.js";
import { SettingsSchema, settingsPath, writeSettings } from "./settings.js";
import { writeFakeHarnesses } from "./testing/fake-harness.js";

const request: TurnRequest = {
  directory: "/work/fix-typo", instructions: "## Swarm superagent\nReport with mcp__ticket__report.",
  tools: { command: "/usr/bin/node", args: ["/swarm/index.js", "superagent", "mcp", "--ticket", "t1"], env: { SWARM_SUPERAGENT_HOME: "/state", SWARM_SUPERAGENT_DEPLOYMENT: "{\"repository\":\"a/b\"}" } },
  permission: "full-auto", blockedCommands: ["npm-publish"], writable: ["/src/app/.git"], variables: ["HOME", "PATH", "SWARM_SUPERAGENT_HOME"], extra: []
};
const fresh = (): TurnEvents => ({ text: "", done: false, steps: 0, toolCalls: 0 });
const read = (kind: keyof typeof HARNESS_KINDS, events: unknown[]): TurnEvents => {
  const turn = fresh();
  for (const event of events) HARNESS_KINDS[kind].read(event as Record<string, unknown>, turn);
  return turn;
};
/** The value after a flag. */
const after = (args: readonly string[], flag: string) => args[args.indexOf(flag) + 1];

test("Claude Code runs a turn headless with the ticket tools only, its permission mode and the blocked commands denied", () => {
  const args = HARNESS_KINDS.claude.args(request);
  assert.deepEqual(args.slice(0, 4), ["-p", "--output-format", "stream-json", "--verbose"]);
  assert.equal(after(args, "--append-system-prompt"), request.instructions);
  assert.deepEqual(JSON.parse(after(args, "--mcp-config")!), { mcpServers: { ticket: { type: "stdio", ...request.tools } } });
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(after(args, "--allowedTools"), "mcp__ticket");
  assert.deepEqual(args.slice(args.indexOf("--disallowedTools") + 1, args.indexOf("--disallowedTools") + 3), ["Bash(npm-publish)", "Bash(npm-publish *)"]);
  assert.equal(after(args, "--permission-mode"), "auto");
  assert.equal(after(args, "--permission-prompts"), "none");
  assert.ok(!args.includes("--resume"));

  const later = HARNESS_KINDS.claude.args({ ...request, session: "845fd0c6-64b4-452e-a53d-dc059b4ed0ff", permission: "yolo", model: "sonnet", extra: ["--effort", "high"] });
  assert.equal(after(later, "--resume"), "845fd0c6-64b4-452e-a53d-dc059b4ed0ff");
  assert.equal(after(later, "--model"), "sonnet");
  assert.equal(after(later, "--effort"), "high");
  assert.ok(later.includes("--dangerously-skip-permissions") && !later.includes("--permission-mode"));
});

test("Codex runs `exec --json` with the ticket tools as an approved MCP server, the sandbox of the permission mode, and resumes by thread id", () => {
  const args = HARNESS_KINDS.codex.args({ ...request, extra: ["--profile", "cli"] });
  assert.deepEqual(args.slice(0, 3), ["exec", "--profile", "cli"]);
  assert.equal(args.at(-1), "-", "the prompt comes on standard input");
  assert.equal(after(args, "-C"), request.directory);
  assert.equal(after(args, "-s"), "workspace-write");
  assert.equal(after(args, "--add-dir"), "/src/app/.git");
  assert.ok(args.includes("--json") && args.includes("--skip-git-repo-check"));
  // Every -c value is TOML that is also JSON, as Swarm writes it.
  const config = new Map(args.flatMap((arg, index) => arg === "-c" ? [args[index + 1]!.split(/=(.*)/s).slice(0, 2) as [string, string]] : [])
    .map(([key, value]) => [key, JSON.parse(value)] as const));
  assert.equal(config.get("approval_policy"), "never");
  assert.equal(config.get("sandbox_workspace_write.network_access"), true);
  assert.equal(config.get("developer_instructions"), request.instructions);
  assert.equal(config.get("mcp_servers.ticket.command"), "/usr/bin/node");
  assert.deepEqual(config.get("mcp_servers.ticket.args"), request.tools.args);
  assert.equal(config.get("mcp_servers.ticket.env.SWARM_SUPERAGENT_DEPLOYMENT"), "{\"repository\":\"a/b\"}");
  assert.deepEqual(config.get("mcp_servers.ticket.env_vars"), ["HOME", "PATH"], "the server inherits the worker's other variables");
  assert.equal(config.get("mcp_servers.ticket.default_tools_approval_mode"), "approve");
  assert.ok(!args.includes("resume"));

  const later = HARNESS_KINDS.codex.args({ ...request, session: "01a1ae67-cd55-7852-9e9a-ee91085830f4", permission: "yolo", model: "gpt-5.5" });
  assert.deepEqual(later.slice(-3), ["resume", "01a1ae67-cd55-7852-9e9a-ee91085830f4", "-"], "exec's flags come before resume");
  assert.equal(after(later, "-m"), "gpt-5.5");
  assert.ok(later.includes("--dangerously-bypass-approvals-and-sandbox") && !later.includes("-s"));
});

test("Claude Code's stream-json events give the session, the final words, the model and the usage of a turn", () => {
  const turn = read("claude", [
    { type: "system", subtype: "init", session_id: "845fd0c6", model: "claude-opus-5-5[1m]", mcp_servers: [{ name: "ticket", status: "connected", source: "dynamic" }], permissionMode: "auto" },
    { type: "assistant", message: { id: "msg_1", model: "claude-opus-5-5", content: [{ type: "thinking", thinking: "" }] }, session_id: "845fd0c6" },
    { type: "assistant", message: { id: "msg_1", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "toolu_1", name: "mcp__ticket__report", input: { state: "ready", summary: "ok" } }] }, session_id: "845fd0c6" },
    { type: "user", message: { role: "user", content: [{ tool_use_id: "toolu_1", type: "tool_result", content: [{ type: "text", text: "{\"reported\":true}" }] }] } },
    { type: "assistant", message: { id: "msg_2", model: "claude-opus-5-5", content: [{ type: "text", text: "done" }] }, session_id: "845fd0c6" },
    { type: "result", subtype: "success", is_error: false, num_turns: 2, result: "done", session_id: "845fd0c6", total_cost_usd: 0.2212404,
      usage: { input_tokens: 4360, cache_creation_input_tokens: 38831, cache_read_input_tokens: 34327, output_tokens: 139, output_tokens_details: { thinking_tokens: 58 } },
      modelUsage: { "claude-opus-5-5[1m]": { inputTokens: 4360, outputTokens: 139, cacheReadInputTokens: 34327, cacheCreationInputTokens: 38831, costUSD: 0.2212404 } } }
  ]);
  assert.equal(turn.done, true);
  assert.equal(turn.session, "845fd0c6");
  assert.equal(turn.text, "done");
  assert.equal(turn.model, "claude-opus-5-5[1m]");
  assert.deepEqual([turn.steps, turn.toolCalls], [2, 1], "a message's blocks come as several events and count as one step");
  assert.deepEqual(turn.usage, { inputTokens: 4360, outputTokens: 139, cachedInputTokens: 34327, cacheCreationInputTokens: 38831, reasoningOutputTokens: 58, costUsd: 0.2212404 });

  const refused = read("claude", [
    { type: "system", subtype: "init", session_id: "cd54af82", model: "claude-opus-5-5[1m]", mcp_servers: [{ name: "ticket", status: "failed" }] },
    { type: "result", subtype: "success", is_error: true, api_error_status: 400, result: "API Error: 400 Unexpected value(s) `advisor-tool-2026-03-01` for the `anthropic-beta` header.", session_id: "cd54af82" }
  ]);
  assert.equal(refused.done, false);
  assert.match(refused.error ?? "", /API Error: 400/);
  assert.equal(refused.toolsDown, "failed");

  const lost = read("claude", [{ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, errors: ["No conversation found with session ID: 0000"] }]);
  assert.ok(HARNESS_KINDS.claude.lost(lost.error ?? ""));
});

test("Codex's JSON events give the thread, the final message and the usage; warnings and reconnects do not fail a turn", () => {
  const turn = read("codex", [
    { type: "thread.started", thread_id: "01a1ae67-cd55-7852-9e9a-ee91085830f4" },
    { type: "item.completed", item: { id: "item_0", type: "error", message: "Codex is ignoring 1 unrecognized configuration setting." } },
    { type: "turn.started" },
    { type: "error", message: "Reconnecting... 1/5" },
    { type: "item.completed", item: { id: "item_4", type: "agent_message", text: "I'll call the ticket report tool.\n" } },
    { type: "item.started", item: { id: "item_5", type: "mcp_tool_call", server: "ticket", tool: "report", arguments: { state: "ready" }, status: "in_progress" } },
    { type: "item.completed", item: { id: "item_5", type: "mcp_tool_call", server: "ticket", tool: "report", arguments: { state: "ready" },
      result: { content: [{ type: "text", text: "{\"reported\":true}" }] }, error: null, status: "completed" } },
    { type: "item.completed", item: { id: "item_6", type: "agent_message", text: "Reported once." } },
    { type: "turn.completed", usage: { input_tokens: 146600, cached_input_tokens: 96885, cache_write_input_tokens: 0, output_tokens: 139, reasoning_output_tokens: 0 } }
  ]);
  assert.equal(turn.done, true);
  assert.equal(turn.session, "01a1ae67-cd55-7852-9e9a-ee91085830f4");
  assert.equal(turn.text, "Reported once.");
  assert.deepEqual([turn.steps, turn.toolCalls], [2, 1]);
  assert.deepEqual(turn.usage, { inputTokens: 146600, outputTokens: 139, cachedInputTokens: 96885, cacheCreationInputTokens: 0, reasoningOutputTokens: 0 });

  const failed = read("codex", [{ type: "thread.started", thread_id: "t" }, { type: "turn.failed", error: { message: "stream disconnected before completion" } }]);
  assert.equal(failed.done, false);
  assert.equal(failed.error, "stream disconnected before completion");
  assert.ok(HARNESS_KINDS.codex.lost("Error: thread/resume: thread/resume failed: no rollout found for thread id 0000 (code -32600)"));
});

test("profiles change the built-in harnesses and add others, and read keys only from the environment", () => {
  assert.throws(() => HarnessProfileSchema.parse({ env: { ANTHROPIC_AUTH_TOKEN: "sk-secret" } }), /read from the environment/);
  assert.throws(() => SettingsSchema.parse({ executor: { harness: "glm" } }), /names no harness profile: glm/);
  assert.throws(() => SettingsSchema.parse({ executor: { harnesses: { glm: { model: "glm-4.6" } } } }), /needs a kind/);
  const settings = SettingsSchema.parse({ executor: { harness: "glm", harnesses: { glm: { kind: "claude", model: "glm-4.6",
    env: { ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic" }, keys: { ANTHROPIC_AUTH_TOKEN: "GLM_API_KEY" } } } } });
  assert.deepEqual(harnessIds(settings.executor.harnesses), ["claude", "codex", "glm"]);

  const bin = mkdtempSync(join(tmpdir(), "swarm-harness-bin-"));
  try {
    writeFakeHarnesses(bin, join(bin, "home"));
    const base = { PATH: bin, HOME: "/home/a", GLM_API_KEY: "k-1", CLAUDECODE: "1", CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1" };
    const glm = resolveHarness("glm", settings.executor.harnesses, "settings.json", base);
    assert.equal(glm.kind, HARNESS_KINDS.claude);
    assert.equal(glm.command, join(bin, "claude"));
    assert.equal(glm.model, "glm-4.6");
    assert.equal(glm.env.ANTHROPIC_AUTH_TOKEN, "k-1");
    assert.equal(glm.env.ANTHROPIC_BASE_URL, "https://open.bigmodel.cn/api/anthropic");
    assert.equal(glm.env.CLAUDECODE, undefined, "an enclosing Claude Code session's variables stay out");
    assert.equal(glm.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, undefined);
    assert.throws(() => resolveHarness("glm", settings.executor.harnesses, "settings.json", { PATH: bin }),
      (error: unknown) => error instanceof HarnessSetupError && /reads ANTHROPIC_AUTH_TOKEN from GLM_API_KEY, which is not set/.test(error.message));
    assert.throws(() => resolveHarness("codex", {}, "settings.json", { PATH: "/nowhere" }),
      (error: unknown) => error instanceof HarnessSetupError && /Codex is not installed on .*: no `codex` on PATH\. .*executor\.harnesses\.codex\.command in settings\.json/.test(error.message));
    assert.throws(() => resolveHarness("kimi", {}, "settings.json", base), /No harness "kimi" .*the profiles here are claude, codex/);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("a turn that goes past its budget is stopped and fails with why", async () => {
  const bin = mkdtempSync(join(tmpdir(), "swarm-harness-bin-"));
  try {
    writeFakeHarnesses(bin, join(bin, "home"));
    const harness = resolveHarness("claude", {}, "settings.json", { ...process.env, PATH: `${bin}:${process.env.PATH}` });
    const outcome = await runTurn(harness, { ...request, directory: bin, tools: { command: "/usr/bin/false", args: [], env: {} }, blockedCommands: [], writable: [] },
      "do the work", { steps: 0, toolCalls: 0 });
    assert.equal(outcome.status, "failed");
    assert.match(outcome.error ?? "", /ran out of budget after 1 model messages and 0 tool calls/);
    assert.equal(outcome.session !== undefined, true, "the session it ran in, to resume");
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

let stateDir: string;
beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), "swarm-harness-client-")); });
afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); });

/** Files a request and accepts it as a ticket at once, as the router would. */
function accepted(client: SuperagentClient, text: string, harness?: string) {
  const { triggerId } = client.request(text, undefined, harness ? { harness } : {});
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(triggerId)!;
  const { ticketId } = client.engine.decide(triggerId, { kind: "accept", title: text, scope: "x", reason: "asked", name: "fix-it", evalId: candidate.evalId });
  return client.store.tickets.get(ticketId!)!;
}

test("a ticket runs on the harness its request names, else on the settings' default, else on Swarm's own loop", () => {
  const client = new SuperagentClient({ stateDir });
  try {
    assert.equal(accepted(client, "fix the typo").execution?.harness, undefined);
    writeSettings({ executor: { harness: "codex" } }, settingsPath(stateDir));
    assert.equal(accepted(client, "fix the link").execution?.harness, "codex");
    assert.equal(accepted(client, "fix the title", "claude").execution?.harness, "claude");
    assert.throws(() => client.request("fix it", undefined, { harness: "kimi" }), /No harness "kimi": choose one of claude, codex/);
  } finally {
    client.close();
  }
});
