/**
 * Fake `claude`, `codex`, `kimi` and `opencode` executables for tests, with no model behind them. `writeFakeHarnesses`
 * puts them on a directory; each runs this file. Each answers its sign-in status command, and for a turn reads its
 * arguments as the real CLI would (the prompt on standard input or in `--prompt`, the ticket tools' MCP server from
 * `--mcp-config`, `-c mcp_servers.ticket.*`, the directory's `.kimi-code/mcp.json` or `OPENCODE_CONFIG_CONTENT`, the
 * session to resume), connects to that server, writes `harness.txt` in its working directory, reports ready through the
 * ticket tools and prints the events the real CLI prints, in the formats recorded from Claude Code 2.1.285, Codex CLI
 * 0.163.0 and OpenCode 1.18.21. Kimi Code 2.1.1's format comes from its `--output-format stream-json` writer in the binary
 * and from its session wire files, not from a recorded turn: the one live turn tried failed at sign-in. A turn without
 * ticket tools, as a delegated subagent runs, writes `harness.txt` and ends with its final words; a read-only one changes
 * nothing. Every invocation is appended to `calls.jsonl` under its home as one JSON line. `FAKE_HARNESS_SIGNED_OUT=1`
 * makes the status command report that nobody is signed in. A request that says "quietly" ends its turn without a report
 * until it is reminded, and one that says "flaky" fails its turn with an API error until it is told the turn failed, as
 * real models and endpoints did in live trials; one that says "slowly" takes a minute before it works, long enough to be
 * stopped.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Kind = "claude" | "codex" | "kimi" | "opencode";
const KINDS: Kind[] = ["claude", "codex", "kimi", "opencode"];

/** One recorded invocation of a fake harness. */
export interface FakeHarnessCall {
  kind: Kind;
  pid: number;
  args: string[];
  cwd: string;
  prompt?: string;
  /** The session the turn resumed, and the one it ran in. */
  resumed?: string;
  session?: string;
  instructions?: string;
  /** The ticket tools' MCP server as the turn was given it. */
  tools?: { command: string; args: string[]; env: Record<string, string>; inherited: string[] };
  /** OpenCode's agent permissions, or Kimi Code's agent tools, as the turn was given them. */
  permission?: unknown;
}

/** Writes the fake executables into `dir`; their sessions and log live under `home`. */
export function writeFakeHarnesses(dir: string, home: string): { log: string; calls(): FakeHarnessCall[] } {
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const self = fileURLToPath(import.meta.url);
  const tsx = import.meta.resolve("tsx");
  for (const kind of KINDS) {
    const file = join(dir, kind);
    writeFileSync(file, `#!/bin/sh\nFAKE_HARNESS_HOME='${home}' exec '${process.execPath}' --import '${tsx}' '${self}' ${kind} "$@"\n`);
    chmodSync(file, 0o755);
  }
  const log = join(home, "calls.jsonl");
  return { log, calls: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as FakeHarnessCall) : [] };
}

const print = (event: unknown) => process.stdout.write(`${JSON.stringify(event)}\n`);
/** A Codex thread id: a version 7 UUID, whose first 48 bits are the time it started. */
const threadId = (): string => {
  const hex = `${Date.now().toString(16).padStart(12, "0")}7${randomUUID().replace(/-/g, "").slice(13, 32)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};
const newSession: Record<Kind, () => string> = {
  claude: randomUUID, codex: threadId, kimi: () => `session_${randomUUID()}`,
  opencode: () => `ses_${randomUUID().replace(/-/g, "").slice(0, 26)}`
};
/** The value after a flag, as the CLI parses it. */
const after = (args: readonly string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

/** Codex's `-c key=value` overrides, with values as the TOML Swarm writes, which is also JSON. */
function codexConfig(args: readonly string[]): Map<string, unknown> {
  const config = new Map<string, unknown>();
  args.forEach((arg, index) => {
    if (arg !== "-c") return;
    const pair = args[index + 1] ?? "";
    const at = pair.indexOf("=");
    const raw = pair.slice(at + 1);
    let value: unknown = raw;
    try { value = JSON.parse(raw); } catch { /* A literal string, as Codex reads a value that is not TOML. */ }
    config.set(pair.slice(0, at), value);
  });
  return config;
}

type Server = { command: string; args?: string[]; env?: Record<string, string> };

/** Reads the turn's prompt, session, instructions and ticket tools from its arguments and files, as each CLI does. */
function parseCall(kind: Kind, args: string[]): FakeHarnessCall {
  const call: FakeHarnessCall = { kind, pid: process.pid, args, cwd: process.cwd() };
  const everything = Object.keys(process.env);
  if (kind === "claude") {
    const config = JSON.parse(after(args, "--mcp-config") ?? "{}") as { mcpServers?: Record<string, Server> };
    const server = config.mcpServers?.ticket;
    if (server) call.tools = { command: server.command, args: server.args ?? [], env: server.env ?? {}, inherited: everything };
    call.resumed = after(args, "--resume");
    call.instructions = after(args, "--append-system-prompt");
  } else if (kind === "codex") {
    const config = codexConfig(args);
    const command = config.get("mcp_servers.ticket.command");
    const env = Object.fromEntries([...config].flatMap(([key, value]) => key.startsWith("mcp_servers.ticket.env.") ? [[key.slice("mcp_servers.ticket.env.".length), String(value)]] : []));
    if (typeof command === "string") {
      call.tools = { command, args: config.get("mcp_servers.ticket.args") as string[], env, inherited: (config.get("mcp_servers.ticket.env_vars") as string[] | undefined) ?? [] };
    }
    const resume = args.indexOf("resume");
    call.resumed = resume >= 0 ? args[resume + 1] : undefined;
    call.instructions = config.get("developer_instructions") as string | undefined;
  } else if (kind === "kimi") {
    call.prompt = after(args, "--prompt");
    call.resumed = after(args, "--session");
    const agent = after(args, "--agent-file");
    if (agent) {
      const text = readFileSync(agent, "utf8");
      const [, front = "", body = ""] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text) ?? [];
      call.instructions = body;
      const tools = /^tools: (.*)$/m.exec(front)?.[1];
      if (tools) call.permission = tools.split(", ");
    }
    // Kimi Code reads project-level MCP servers from the working directory only when the workspace is trusted.
    const file = join(call.cwd, ".kimi-code", "mcp.json");
    if (process.env.KIMI_CODE_TRUST_WORKSPACE === "1" && existsSync(file)) {
      const server = (JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, Server> }).mcpServers?.ticket;
      if (server) call.tools = { command: server.command, args: server.args ?? [], env: server.env ?? {}, inherited: everything };
    }
  } else {
    call.resumed = after(args, "--session");
    const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      mcp?: Record<string, { command: string[]; environment?: Record<string, string> }>;
      instructions?: string[]; agent?: Record<string, { permission?: unknown }>;
    };
    const server = config.mcp?.ticket;
    if (server) call.tools = { command: server.command[0]!, args: server.command.slice(1), env: server.environment ?? {}, inherited: everything };
    call.instructions = config.instructions?.map((path) => readFileSync(path, "utf8")).join("\n");
    call.permission = config.agent?.[after(args, "--agent") ?? ""]?.permission;
  }
  return call;
}

async function callReport(tools: NonNullable<FakeHarnessCall["tools"]>, args: Record<string, unknown>): Promise<string> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const inherited = Object.fromEntries(tools.inherited.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
  const transport = new StdioClientTransport({ command: tools.command, args: tools.args, env: { ...inherited, ...tools.env }, stderr: "ignore" });
  const client = new Client({ name: "fake-harness", version: "1.0.0" });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    if (!listed.tools.some((tool) => tool.name === "report")) throw new Error("the ticket tools have no report tool");
    const result = await client.callTool({ name: "report", arguments: args }) as { content?: { type: string; text?: string }[] };
    return result.content?.map((part) => part.text ?? "").join("") ?? "";
  } finally {
    await client.close();
  }
}

/** Whether the turn was started read-only, as each CLI's flags or configuration say. */
const readOnly = (call: FakeHarnessCall): boolean =>
  call.kind === "claude" ? after(call.args, "--permission-mode") === "dontAsk"
    : call.kind === "codex" ? after(call.args, "-s") === "read-only"
      : call.kind === "kimi" ? Array.isArray(call.permission) && !call.permission.includes("Write")
        : (call.permission as Record<string, unknown> | undefined)?.["*"] === "deny";

/**
 * The fake's work for a turn: a file in its working directory, then a ready report whose message names the turn; without
 * ticket tools, final words that say what it wrote. A read-only turn changes nothing.
 */
async function work(call: FakeHarnessCall, turn: number): Promise<{ text: string; reported: string }> {
  if (sessionSays(call, "slowly")) await new Promise((resolve) => setTimeout(resolve, 60_000));
  if (readOnly(call)) return { text: `Reviewed the workspace on ${call.kind} without changing it.`, reported: "" };
  writeFileSync(join(call.cwd, "harness.txt"), `${call.kind} turn ${turn}\n`, { flag: "a" });
  if (!call.tools) return { text: `Wrote harness.txt on ${call.kind}.`, reported: "" };
  if (sessionSays(call, "quietly") && !/Your turn ended without calling the \S+ tool/.test(call.prompt ?? "")) {
    return { text: "I wrote harness.txt.", reported: "" };
  }
  const message = turn === 1 ? `Done on ${call.kind}.` : `Follow-up done on ${call.kind}.`;
  const reported = await callReport(call.tools, { state: "ready", summary: `Wrote harness.txt on ${call.kind} (turn ${turn}).`, message_for_person: message });
  return { text: `Reported ready: ${message}`, reported };
}

/** Whether the session's first prompt, which holds the request, says `word`; it is recorded with the session. */
const sessionSays = (call: FakeHarnessCall, word: string): boolean =>
  readFileSync(join(process.env.FAKE_HARNESS_HOME!, "sessions", `${call.session}.request`), "utf8").includes(word);

/** Kimi Code's session files: its index entry, and a wire file with each model call's token counts. */
function kimiSessionFiles(call: FakeHarnessCall): void {
  const home = process.env.KIMI_CODE_HOME;
  if (!home) return;
  const dir = join(home, "sessions", "wd_fake", call.session!);
  mkdirSync(join(dir, "agents", "main"), { recursive: true });
  if (!call.resumed) {
    writeFileSync(join(dir, "state.json"), JSON.stringify({ id: call.session, version: 2, cwd: call.cwd, createdAt: Date.now() }));
    appendFileSync(join(home, "session_index.jsonl"), `${JSON.stringify({ sessionId: call.session, sessionDir: dir, workDir: realpathSync(call.cwd) })}\n`);
  }
  appendFileSync(join(dir, "agents", "main", "wire.jsonl"), `${JSON.stringify({ type: "usage.record", agentId: "main", model: "kimi-code/k3",
    usage: { inputOther: 1779, output: 116, inputCacheRead: 15360, inputCacheCreation: 0 }, usageScope: "turn", time: Date.now() })}\n`);
}

/** Says that the resumed session is gone, as each CLI does, and exits. */
function lost(call: FakeHarnessCall): never {
  if (call.kind === "claude") {
    print({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, session_id: call.resumed, total_cost_usd: 0,
      errors: [`No conversation found with session ID: ${call.resumed}`] });
    process.stderr.write(`No conversation found with session ID: ${call.resumed}\n`);
  } else if (call.kind === "codex") {
    process.stderr.write(`Error: thread/resume: thread/resume failed: no rollout found for thread id ${call.resumed} (code -32600)\n`);
  } else if (call.kind === "kimi") {
    print({ role: "meta", type: "system.version", version: "2.1.1" });
    process.stderr.write(`error: failed to run prompt: Session "${call.resumed}" not found.\nSee log: /tmp/kimi-code.log\n`);
  } else {
    process.stderr.write("\u001b[91m\u001b[1mError: \u001b[0mSession not found\n");
  }
  process.exit(1);
}

/** Fails the turn with an API error, as each CLI reports one, and exits. */
function failed(call: FakeHarnessCall): never {
  const error = "API Error: 400 Unexpected value(s) `advisor-tool-2026-03-01` for the `anthropic-beta` header.";
  const session = call.session!;
  if (call.kind === "claude") {
    print({ type: "system", subtype: "init", session_id: session, model: "claude-opus-5-5[1m]", mcp_servers: [{ name: "ticket", status: "connected" }] });
    print({ type: "result", subtype: "success", is_error: true, api_error_status: 400, num_turns: 1, result: error, session_id: session, total_cost_usd: 0,
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }, modelUsage: {}, terminal_reason: "api_error" });
  } else if (call.kind === "codex") {
    print({ type: "thread.started", thread_id: session });
    print({ type: "turn.started" });
    print({ type: "turn.failed", error: { message: error } });
  } else if (call.kind === "kimi") {
    print({ role: "meta", type: "system.version", version: "2.1.1" });
    print({ role: "meta", type: "turn.step.retrying", failed_attempt: 1, next_attempt: 2, max_attempts: 3, delay_ms: 1000, error_name: "APIError",
      error_message: error, status_code: 400 });
    process.stderr.write(`error: failed to run prompt: ${error}\nSee log: /tmp/kimi-code.log\n`);
  } else {
    print({ type: "error", timestamp: Date.now(), sessionID: session, error: { name: "UnknownError", data: { message: "Unexpected server error. Check server logs for details.", ref: "err_f1a2" } } });
    process.stderr.write(`timestamp=2026-11-06T18:18:40.573Z level=ERROR run=49fc4359 message=failed ref=err_f1a2 error="${error.replace(/"/g, "\\\"")}" cause="${error}"\n`);
  }
  process.exit(1);
}

async function main(): Promise<void> {
  const [kind, ...args] = process.argv.slice(2) as [Kind, ...string[]];
  const home = process.env.FAKE_HARNESS_HOME!;
  const signedIn = process.env.FAKE_HARNESS_SIGNED_OUT !== "1";
  if (kind === "claude" && args[0] === "auth") {
    process.stdout.write(`${JSON.stringify({ loggedIn: signedIn, authMethod: signedIn ? "oauth_token" : "none", apiProvider: "firstParty" }, null, 2)}\n`);
    process.exit(signedIn ? 0 : 1);
  }
  if (kind === "codex" && args[0] === "login") {
    process.stdout.write(signedIn ? "Logged in using ChatGPT\n" : "Not logged in\n");
    process.exit(signedIn ? 0 : 1);
  }
  if (kind === "kimi" && args[0] === "provider") {
    process.stdout.write(`${JSON.stringify({ providers: { "managed:kimi-code": { baseUrl: "https://api.kimi.com/coding/v1", type: "kimi", apiKey: signedIn ? "fake-key" : "",
      oauth: { storage: "file", key: "oauth/kimi-code" } } }, models: { "kimi-code/k3": { provider: "managed:kimi-code", model: "k3", maxContextSize: 1048576 } } }, null, 2)}\n`);
    process.exit(0);
  }
  if (kind === "opencode" && args[0] === "auth") {
    process.stdout.write(`\u001b[0m\n┌  Credentials \u001b[90m~/.local/share/opencode/auth.json\n│\n${signedIn ? "●  DeepSeek \u001b[90mapi\n│\n└  1 credentials" : "└  0 credentials"}\n\n`);
    process.exit(0);
  }
  const sessions = join(home, "sessions");
  if (kind === "opencode" && args[0] === "export") {
    const id = args[1]!;
    if (!existsSync(join(sessions, id))) { process.stderr.write(`Session not found: ${id}\n`); process.exit(1); }
    process.stdout.write(`${JSON.stringify({ info: { id, directory: process.cwd(), agent: "swarm" }, messages: [
      { info: { role: "user", agent: "swarm" }, parts: [] },
      { info: { role: "assistant", providerID: "deepseek", modelID: "deepseek-flash", agent: "swarm", cost: 0.0032 }, parts: [] }
    ] }, null, 2)}\n`);
    return;
  }
  const call = parseCall(kind, args);
  if (kind !== "kimi") call.prompt = readFileSync(0, "utf8");
  const prompt = call.prompt ?? "";
  mkdirSync(sessions, { recursive: true });
  if (call.resumed && !existsSync(join(sessions, call.resumed))) {
    appendFileSync(join(home, "calls.jsonl"), `${JSON.stringify(call)}\n`);
    lost(call);
  }
  const session = call.resumed ?? newSession[kind]();
  call.session = session;
  const turns = (existsSync(join(sessions, session)) ? Number(readFileSync(join(sessions, session), "utf8")) : 0) + 1;
  writeFileSync(join(sessions, session), String(turns));
  if (turns === 1) writeFileSync(join(sessions, `${session}.request`), prompt);
  appendFileSync(join(home, "calls.jsonl"), `${JSON.stringify(call)}\n`);
  if (sessionSays(call, "flaky") && !prompt.includes("Your last turn failed")) failed(call);
  if (kind === "claude") {
    print({ type: "system", subtype: "init", cwd: call.cwd, session_id: session, tools: ["Bash", "mcp__ticket__report"],
      mcp_servers: call.tools ? [{ name: "ticket", status: "connected", source: "dynamic" }] : [], model: "claude-opus-5-5[1m]", permissionMode: "auto",
      apiKeySource: "none", claude_code_version: "2.1.285" });
    const id = `msg_${randomUUID()}`;
    print({ type: "assistant", message: { model: "claude-opus-5-5", id, type: "message", role: "assistant", content: [{ type: "thinking", thinking: "" }] }, session_id: session });
    print({ type: "assistant", message: { model: "claude-opus-5-5", id, type: "message", role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name: call.tools ? "mcp__ticket__report" : "Write", input: { state: "ready" } }],
      usage: { input_tokens: 4358, cache_creation_input_tokens: 34327, cache_read_input_tokens: 0, output_tokens: 4 } }, session_id: session });
    const { text, reported } = await work(call, turns);
    print({ type: "user", message: { role: "user", content: [{ tool_use_id: "toolu_1", type: "tool_result", content: [{ type: "text", text: reported }] }] }, session_id: session });
    print({ type: "assistant", message: { model: "claude-opus-5-5", id: `msg_${randomUUID()}`, type: "message", role: "assistant", content: [{ type: "text", text }] }, session_id: session });
    print({ type: "result", subtype: "success", is_error: false, num_turns: 2, result: text, session_id: session, total_cost_usd: 0.2212404,
      usage: { input_tokens: 4360, cache_creation_input_tokens: 38831, cache_read_input_tokens: 34327, output_tokens: 139, output_tokens_details: { thinking_tokens: 58 } },
      modelUsage: { "claude-opus-5-5[1m]": { inputTokens: 4360, outputTokens: 139, cacheReadInputTokens: 34327, cacheCreationInputTokens: 38831, costUSD: 0.2212404 } },
      permission_denials: [], terminal_reason: "completed" });
    return;
  }
  if (kind === "kimi") {
    print({ role: "meta", type: "system.version", version: "2.1.1" });
    const { text, reported } = await work(call, turns);
    print({ role: "assistant", content: "I'll report through the ticket tools.",
      tool_calls: [{ type: "function", id: "tool_wTsI9OxZbL2r", function: { name: call.tools ? "mcp__ticket__report" : "Write", arguments: "{\"state\":\"ready\"}" } }] });
    print({ role: "tool", tool_call_id: "tool_wTsI9OxZbL2r", content: reported || "Wrote harness.txt" });
    print({ role: "assistant", content: text });
    kimiSessionFiles(call);
    print({ role: "meta", type: "session.resume_hint", session_id: session, command: `kimi -r ${session}`, content: `To resume this session: kimi -r ${session}` });
    return;
  }
  if (kind === "opencode") {
    const event = (type: string, part: Record<string, unknown>) => print({ type, timestamp: Date.now(), sessionID: session, part: { ...part, sessionID: session } });
    event("step_start", { id: "prt_1", messageID: "msg_1", type: "step-start", snapshot: "fe8a5305" });
    const { text, reported } = await work(call, turns);
    event("tool_use", { type: "tool", tool: call.tools ? "ticket_report" : "write", callID: "call_1", state: { status: "completed", input: { state: "ready" }, output: reported || "Wrote file successfully." },
      id: "prt_2", messageID: "msg_1" });
    event("step_finish", { id: "prt_3", reason: "tool-calls", messageID: "msg_1", type: "step-finish",
      tokens: { total: 23204, input: 23131, output: 73, reasoning: 0, cache: { write: 0, read: 0 } }, cost: 0.00325878 });
    event("step_start", { id: "prt_4", messageID: "msg_2", type: "step-start", snapshot: "c382f66f" });
    event("text", { id: "prt_5", messageID: "msg_2", type: "text", text, time: { start: Date.now(), end: Date.now() } });
    event("step_finish", { id: "prt_6", reason: "stop", messageID: "msg_2", type: "step-finish",
      tokens: { total: 23297, input: 255, output: 2, reasoning: 0, cache: { write: 0, read: 23040 } }, cost: 0.000100772 });
    return;
  }
  // Codex records each turn's model in its session file, under the local date the session started.
  if (process.env.CODEX_HOME) {
    const day = new Date(Number.parseInt(session.replace(/-/g, "").slice(0, 12), 16));
    const directory = join(process.env.CODEX_HOME, "sessions", String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, `rollout-2026-11-06T09-10-00-${session}.jsonl`), `${JSON.stringify({ type: "turn_context", payload: { cwd: call.cwd, model: "gpt-6.1-sol" } })}\n`);
  }
  print({ type: "thread.started", thread_id: session });
  print({ type: "item.completed", item: { id: "item_0", type: "error", message: "Codex is ignoring 1 unrecognized configuration setting." } });
  print({ type: "turn.started" });
  print({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "I'll report through the ticket tools.\n" } });
  print({ type: "item.started", item: { id: "item_2", type: "mcp_tool_call", server: "ticket", tool: "report", arguments: { state: "ready" }, result: null, error: null, status: "in_progress" } });
  const { text, reported } = await work(call, turns);
  print({ type: "item.completed", item: { id: "item_2", type: "mcp_tool_call", server: "ticket", tool: "report", arguments: { state: "ready" },
    result: { content: [{ type: "text", text: reported }], structured_content: null }, error: null, status: "completed" } });
  print({ type: "item.completed", item: { id: "item_3", type: "agent_message", text } });
  print({ type: "turn.completed", usage: { input_tokens: 146600, cached_input_tokens: 96885, cache_write_input_tokens: 0, output_tokens: 139, reasoning_output_tokens: 12 } });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    process.stderr.write(`fake harness: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
