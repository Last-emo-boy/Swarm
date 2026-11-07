/**
 * Agent harnesses a ticket's worker, or a subagent Swarm delegates to, can run on instead of Swarm's own coding loop. A kind
 * drives one CLI headless, one process per turn in a directory: how to start a turn (a ticket's with Swarm's ticket tools
 * as an MCP server), resume the session on the next turn, read the JSON events it prints, keep a turn read-only, and tell
 * that it is installed and signed in. A profile names a kind with its command, model, arguments and environment; settings
 * change the built-in profiles and add others, and keys come only from the environment. The flags and event formats are
 * those of Claude Code 2.1.285, Codex CLI 0.163.0, Kimi Code 2.1.1 and OpenCode 1.18.21.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { z } from "zod/v4";
import { executable } from "./setup.js";

const exec = promisify(execFile);
const CHECK_TIMEOUT_MS = 30_000;
/** How long a stopped turn's process may take to exit before it is killed. */
const STOP_GRACE_MS = 10_000;
const TAIL_CHARS = 4000;

/**
 * Swarm's permission modes for a turn, which each kind maps to its own sandbox, approval and tool flags: a ticket's worker
 * runs full-auto or yolo, and a delegated subagent whose agent spec only reads runs read-only.
 */
export type HarnessPermission = "full-auto" | "yolo" | "read-only";

/** Swarm's ticket tools as a stdio MCP server: the program, its arguments and the variables it needs. */
export interface ToolsServer { command: string; args: string[]; env: Record<string, string> }

/** One turn as a kind turns it into arguments; the prompt goes on standard input unless the kind takes it as an argument. */
export interface TurnRequest {
  /** The ticket's directory or the delegating session's workspace, where the harness works. */
  directory: string;
  /** Swarm's instructions: a ticket's worker instructions, or a delegated subagent's role and output contract. */
  instructions: string;
  /** The harness session to resume; a new session starts without one. */
  session?: string;
  /** Swarm's ticket tools, for a ticket's worker; a delegated subagent runs without them. */
  tools?: ToolsServer;
  permission: HarnessPermission;
  /** Commands the worker may not run. */
  blockedCommands: readonly string[];
  /** Names of the variables the harness runs with, which the ticket tools' server inherits as it would under Swarm. */
  variables: readonly string[];
  model?: string;
  /** The profile's own arguments, such as a Codex configuration profile. */
  extra: readonly string[];
  /** The turn's prompt, for a kind that takes it as an argument. */
  prompt?: string;
  /** A private directory, outside the work directory, for the files only this turn reads; removed when the turn ends. */
  scratch?: string;
  /** The profile's own variables and key values, for a kind whose user settings would otherwise override them. */
  own?: Readonly<Record<string, string>>;
}

/** What a kind wrote for a turn besides its arguments: variables to set for it, and how to put things back afterwards. */
export interface Prepared { env?: Record<string, string>; undo?(): void }

/** What a kind reads once a turn's process exited, to fill in what its events did not say. */
export interface SettleContext { command: string; env: NodeJS.ProcessEnv; directory: string; started: number }

/** Tokens one turn used, as the harness reports them, with its own estimate of the cost when it gives one. */
export interface HarnessUsage {
  /** Input tokens as the harness's API counts them: without cached tokens for Claude, with them for Codex. */
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens?: number;
  costUsd?: number;
  /** Summed from the turn's messages because the turn ended before the harness reported its total, which counts more output. */
  partial?: boolean;
}

/** What a turn's events said so far. */
export interface TurnEvents {
  session?: string;
  /** The harness's last message: its final words when the turn completed. */
  text: string;
  model?: string;
  usage?: HarnessUsage;
  /** The harness said the turn completed. */
  done: boolean;
  /** Why the turn failed, or the last error the harness reported. */
  error?: string;
  /** Model messages and tool calls, against the turn's budget. */
  steps: number;
  toolCalls: number;
  /** How the ticket tools' server is, when the harness says it did not connect. */
  toolsDown?: string;
  /** The last model message's id: a message comes in several events, and counts as one step. */
  message?: string;
  /** Each model message's usage by id, as its latest event gave it, for a turn stopped before the harness reports its total. */
  messages?: Record<string, HarnessUsage>;
  /** The API protocol of the model the turn used, when the harness names its provider, as OpenCode does. */
  protocol?: UsageProtocol;
}

type Event = Record<string, unknown>;

/** API protocols as Swarm's provider usage records name them. */
export type UsageProtocol = "anthropic-messages" | "openai-responses" | "openai-chat-completions";

export interface HarnessKind {
  /** The harness's name for people, such as "Claude Code". */
  label: string;
  /** Its program name on PATH. */
  program: string;
  /** The API protocol its usage counts follow, unless a turn's events name another. */
  protocol: UsageProtocol;
  /** Its input token counts include the cached tokens, as Codex's do; the others count cached tokens apart. */
  cachedInInput?: boolean;
  /** How it names one of the ticket tools' server's tools to the model, such as `mcp__ticket__report`. */
  tool(name: string): string;
  /** It takes the prompt as an argument (TurnRequest.prompt) instead of on standard input. */
  promptArgument?: boolean;
  args(request: TurnRequest): string[];
  /** Writes what a turn reads besides its arguments, in its scratch directory or where the harness looks for it. */
  prepare?(request: TurnRequest, env: NodeJS.ProcessEnv): Prepared;
  /** Reads one JSON event of a turn into what the turn said. */
  read(event: Event, turn: TurnEvents): void;
  /** The arguments of its sign-in status command, how to read the answer, and the arguments that sign in. */
  signedIn: { args: string[]; check(code: number, stdout: string, env: NodeJS.ProcessEnv): boolean; login: string };
  /** Variables it must not inherit: those an enclosing session of the same harness sets for its own tools. */
  unset: readonly string[];
  /** Whether a resumed turn failed because the harness no longer has the session. */
  lost(output: string): boolean;
  /** Why a turn failed, from what it wrote to standard error, where its events give only a generic error. */
  detail?(stderr: string): string | undefined;
  /** What a read-only turn enforces on this harness and what it does not; a kind without it cannot run one. */
  readOnly?: string;
  /** Its arguments that set permissions, a sandbox or tools: Swarm cannot keep a profile that passes one read-only. */
  permissionFlags: readonly string[];
  /** Fills in what its events do not say, once the turn's process exited. */
  settle?(turn: TurnEvents, context: SettleContext): void | Promise<void>;
}

const str = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const num = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
const obj = (value: unknown): Event => value && typeof value === "object" && !Array.isArray(value) ? value as Event : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/** A string as TOML, for `codex -c key=value`: JSON's escapes are TOML's, and TOML also escapes DEL. */
const tomlString = (text: string): string => JSON.stringify(text).replace(/\u007f/g, "\\u007f");
const toml = (value: string | number | boolean | readonly string[]): string =>
  typeof value === "string" ? tomlString(value) : Array.isArray(value) ? `[${value.map(tomlString).join(",")}]` : String(value);
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Claude's usage counts: input without the cached tokens, which are counted apart. */
const claudeUsage = (usage: Event): HarnessUsage => ({
  inputTokens: num(usage.input_tokens), outputTokens: num(usage.output_tokens),
  cachedInputTokens: num(usage.cache_read_input_tokens), cacheCreationInputTokens: num(usage.cache_creation_input_tokens),
  reasoningOutputTokens: num(obj(usage.output_tokens_details).thinking_tokens)
});

/**
 * Claude Code's `attribution` setting with every part empty: no Co-Authored-By trailer in commits, no "Generated with"
 * line in pull requests and no session link (2.1.285 marks the older `includeCoAuthoredBy` deprecated). Given with
 * `--settings` it overrides the user's, project and local settings; only a managed policy is above it.
 */
const NO_ATTRIBUTION = { attribution: { commit: "", pr: "", sessionUrl: false } };
/** The settings file a turn of a profile with its own variables passes, in the turn's scratch directory. */
const CLAUDE_SETTINGS = "claude-settings.json";
/** Claude Code's built-in tools and permission rules for a read-only turn: reading, searching and git's read-only commands. */
const CLAUDE_READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "Bash"];
const CLAUDE_READ_ONLY_RULES = ["Read", "Grep", "Glob",
  ...["status", "diff", "log", "show"].flatMap((command) => [`Bash(git ${command})`, `Bash(git ${command} *)`])];

/** The ticket tools for a harness that names an MCP server's tools as `mcp__<server>__<tool>`. */
const mcpTool = (name: string): string => `mcp__ticket__${name}`;

/**
 * Claude Code: `claude -p` with stream-json events, the ticket tools from `--mcp-config` and only those
 * (`--strict-mcp-config`), allowed without asking, and no attribution in what it commits. full-auto is its auto mode,
 * whose classifier blocks risky actions, and yolo skips its permission checks; nothing can answer a prompt, so whatever
 * would ask is denied. Its `--settings` comes after the profile's arguments, so a profile cannot turn attribution back on;
 * a profile's own variables go in them too (a file in the turn's scratch directory, as they hold its keys), because the
 * user's settings, such as an `ANTHROPIC_BASE_URL` for a relay, would otherwise override the environment.
 */
const CLAUDE: HarnessKind = {
  label: "Claude Code",
  program: "claude",
  protocol: "anthropic-messages",
  tool: mcpTool,
  args: (request) => {
    const readOnly = request.permission === "read-only";
    const own = Object.keys(request.own ?? {}).length > 0 && request.scratch;
    return [
      "-p", "--output-format", "stream-json", "--verbose",
      ...request.extra,
      "--settings", own ? join(request.scratch!, CLAUDE_SETTINGS) : JSON.stringify(NO_ATTRIBUTION),
      ...(request.session ? ["--resume", request.session] : []),
      ...(request.model ? ["--model", request.model] : []),
      "--append-system-prompt", request.instructions,
      ...(request.tools ? ["--mcp-config", JSON.stringify({ mcpServers: { ticket: { type: "stdio", ...request.tools } } })] : []),
      "--strict-mcp-config",
      ...(readOnly ? ["--tools", CLAUDE_READ_ONLY_TOOLS.join(",")] : []),
      ...(readOnly || request.tools ? ["--allowedTools", ...(readOnly ? CLAUDE_READ_ONLY_RULES : []), ...(request.tools ? ["mcp__ticket"] : [])] : []),
      ...(request.blockedCommands.length ? ["--disallowedTools", ...request.blockedCommands.flatMap((name) => [`Bash(${name})`, `Bash(${name} *)`])] : []),
      ...(readOnly ? ["--permission-mode", "dontAsk"] : request.permission === "yolo" ? ["--dangerously-skip-permissions"] : ["--permission-mode", "auto"]),
      "--permission-prompts", "none"
    ];
  },
  prepare(request) {
    if (!request.scratch || !Object.keys(request.own ?? {}).length) return {};
    writeFileSync(join(request.scratch, CLAUDE_SETTINGS), JSON.stringify({ ...NO_ATTRIBUTION, env: request.own }), { mode: 0o600 });
    return {};
  },
  read(event, turn) {
    const type = event.type;
    if (type === "system" && event.subtype === "init") {
      turn.session = str(event.session_id) ?? turn.session;
      turn.model = str(event.model) ?? turn.model;
      const server = list(event.mcp_servers).map(obj).find((item) => item.name === "ticket");
      if (server && server.status !== "connected") turn.toolsDown = String(server.status ?? "missing");
      return;
    }
    if (type === "system" && event.subtype === "api_retry") {
      turn.error = `API error ${String(event.error_status ?? "")} ${String(event.error ?? "")}`.trim();
      return;
    }
    if (type === "assistant") {
      // Each content block of a message comes as its own event with the message's id.
      const message = obj(event.message);
      const id = str(message.id);
      if (!id || id !== turn.message) turn.steps += 1;
      turn.message = id;
      if (id && message.usage) (turn.messages ??= {})[id] = claudeUsage(obj(message.usage));
      for (const block of list(message.content).map(obj)) {
        if (block.type === "tool_use") turn.toolCalls += 1;
        if (block.type === "text" && str(block.text)?.trim()) turn.text = String(block.text);
      }
      return;
    }
    if (type !== "result") return;
    turn.session = str(event.session_id) ?? turn.session;
    turn.usage = { ...claudeUsage(obj(event.usage)), ...(typeof event.total_cost_usd === "number" ? { costUsd: event.total_cost_usd } : {}) };
    // The model of the turn is the one that used the most output tokens, when it delegated to others.
    const models = Object.entries(obj(event.modelUsage)).sort(([, a], [, b]) => num(obj(b).outputTokens) - num(obj(a).outputTokens));
    if (models[0]) turn.model = models[0][0];
    const words = str(event.result) ?? "";
    if (event.is_error === true || event.subtype !== "success") {
      turn.error = [words, ...list(event.errors).map(String)].filter((item) => item.trim()).join("; ") || String(event.subtype ?? "error");
      return;
    }
    turn.text = words || turn.text;
    turn.done = true;
  },
  signedIn: {
    args: ["auth", "status", "--json"],
    check: (code, stdout) => {
      try {
        const status = JSON.parse(stdout) as { loggedIn?: unknown; apiProvider?: unknown };
        return status.loggedIn === true || (typeof status.apiProvider === "string" && status.apiProvider !== "firstParty");
      } catch { return code === 0; }
    },
    login: "auth login"
  },
  // A Claude Code session, such as the desktop app, gives its tools its own session and the provider it manages; a
  // harness started under it would take them and not find the account it signs in with.
  unset: ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_HOST_SESSION_ID", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "CLAUDE_CODE_HOST_AUTH_ENV_VAR", "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
    "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_SIMPLE"],
  lost: (output) => output.includes("No conversation found with session ID"),
  readOnly: "Claude Code runs in its dontAsk mode with only Read, Grep, Glob and git's status, diff, log and show allowed: it cannot edit files, run other commands or reach MCP servers.",
  permissionFlags: ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--permission-mode", "--tools",
    "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools", "--mcp-config", "--settings", "--add-dir"],
  settle(turn) {
    const messages = Object.values(turn.messages ?? {});
    if (turn.usage || !messages.length) return;
    const sum = (field: "inputTokens" | "outputTokens" | "cachedInputTokens" | "cacheCreationInputTokens" | "reasoningOutputTokens") =>
      messages.reduce((total, usage) => total + (usage[field] ?? 0), 0);
    turn.usage = { inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), cachedInputTokens: sum("cachedInputTokens"),
      cacheCreationInputTokens: sum("cacheCreationInputTokens"), reasoningOutputTokens: sum("reasoningOutputTokens"), partial: true };
  }
};

/**
 * Codex: `codex exec --json`, the ticket tools as `mcp_servers.ticket` approved to run without asking, and Swarm's
 * instructions as its developer instructions. Its workspace-write sandbox keeps the workspace's own git metadata
 * read-only, so a worker in it cannot commit unless someone approves each commit: live trials ended blocked with approvals
 * off, and with `--approve-for-me` when the provider did not serve Codex's reviewer or the model did not ask it. A ticket's
 * work is commits, so full-auto runs without that sandbox and with approvals off, as Swarm's own worker runs as the OS
 * user; yolo bypasses approvals and the sandbox outright, and read-only is its read-only sandbox.
 */
const CODEX: HarnessKind = {
  label: "Codex",
  program: "codex",
  protocol: "openai-responses",
  cachedInInput: true,
  tool: mcpTool,
  args: (request) => {
    const config = (key: string, value: string | number | boolean | readonly string[]) => ["-c", `${key}=${toml(value)}`];
    const server = "mcp_servers.ticket";
    const tools = request.tools;
    const env = Object.entries(tools?.env ?? {}).filter(([name]) => VARIABLE.test(name));
    return [
      "exec", ...request.extra, "--json", "--skip-git-repo-check", "-C", request.directory,
      ...(request.model ? ["-m", request.model] : []),
      ...(request.permission === "yolo" ? ["--dangerously-bypass-approvals-and-sandbox"]
        : ["-s", request.permission === "read-only" ? "read-only" : "danger-full-access", ...config("approval_policy", "never")]),
      ...config("developer_instructions", request.instructions),
      ...(tools ? [
        ...config(`${server}.command`, tools.command),
        ...config(`${server}.args`, tools.args),
        ...env.flatMap(([name, value]) => config(`${server}.env.${name}`, value)),
        ...config(`${server}.env_vars`, request.variables.filter((name) => VARIABLE.test(name) && !(name in tools.env))),
        ...config(`${server}.default_tools_approval_mode`, "approve"),
        ...config(`${server}.startup_timeout_sec`, 60),
        ...config(`${server}.tool_timeout_sec`, 120)
      ] : []),
      ...(request.session ? ["resume", request.session] : []),
      "-"
    ];
  },
  read(event, turn) {
    const type = event.type;
    if (type === "thread.started") { turn.session = str(event.thread_id) ?? turn.session; return; }
    if (type === "turn.completed") {
      const usage = obj(event.usage);
      turn.usage = {
        inputTokens: num(usage.input_tokens), outputTokens: num(usage.output_tokens),
        cachedInputTokens: num(usage.cached_input_tokens), cacheCreationInputTokens: num(usage.cache_write_input_tokens),
        reasoningOutputTokens: num(usage.reasoning_output_tokens)
      };
      turn.done = true;
      return;
    }
    if (type === "turn.failed") { turn.error = str(obj(event.error).message) ?? "The turn failed"; return; }
    // A top-level error is how Codex reports a retry as well as a failure; the turn's end says which it was.
    if (type === "error") { turn.error = str(event.message) ?? turn.error; return; }
    if (type !== "item.completed") return;
    // Items of type "error" are warnings, such as about the configuration; the turn goes on.
    const item = obj(event.item);
    if (item.type === "agent_message") {
      turn.steps += 1;
      if (str(item.text)?.trim()) turn.text = String(item.text);
    } else if (item.type !== "reasoning" && item.type !== "error" && item.type !== "todo_list") {
      turn.toolCalls += 1;
    }
  },
  signedIn: { args: ["login", "status"], check: (code) => code === 0, login: "login" },
  unset: ["CODEX_THREAD_ID", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED"],
  lost: (output) => output.includes("no rollout found for thread id"),
  readOnly: "Codex runs in its read-only sandbox with approvals off: its commands cannot write files, but MCP servers from your Codex configuration run outside the sandbox.",
  permissionFlags: ["-s", "--sandbox", "--full-auto", "--dangerously-bypass-approvals-and-sandbox", "--yolo", "-a", "--ask-for-approval", "--add-dir"],
  settle(turn, { env }) {
    if (!turn.model && turn.session) turn.model = codexModel(env.CODEX_HOME || join(homedir(), ".codex"), turn.session);
  }
};

/**
 * The model of a Codex session, which its events do not name: its session file records it with each turn. The file is
 * under the local date the session started, which a thread id (a version 7 UUID) carries in its first 48 bits.
 */
function codexModel(home: string, thread: string): string | undefined {
  const started = Number.parseInt(thread.replace(/-/g, "").slice(0, 12), 16);
  if (!Number.isFinite(started)) return undefined;
  for (const offset of [0, -1, 1]) {
    const day = new Date(started + offset * 86_400_000);
    const directory = join(home, "sessions", String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
    try {
      const file = readdirSync(directory).find((name) => name.startsWith("rollout-") && name.endsWith(`${thread}.jsonl`));
      if (!file) continue;
      const contexts = readFileSync(join(directory, file), "utf8").split("\n").filter((line) => line.startsWith("{") && line.includes("\"turn_context\""))
        .map((line) => JSON.parse(line) as { type?: unknown; payload?: { model?: unknown } }).filter((entry) => entry.type === "turn_context");
      const model = contexts.at(-1)?.payload?.model;
      return typeof model === "string" ? model : undefined;
    } catch { /* No session directory for that day, or a file being written; the model stays unknown. */ }
  }
  return undefined;
}

const kimiHome = (env: NodeJS.ProcessEnv): string => env.KIMI_CODE_HOME || join(homedir(), ".kimi-code");
/** Kimi Code's tools for a read-only session: reading, searching and the web, without edits, commands or subagents. */
const KIMI_READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "ReadMediaFile", "TodoList", "WebSearch", "FetchURL"];
/** The agent file a new Kimi Code session starts with, in the turn's scratch directory. */
const KIMI_AGENT = "kimi-agent.md";

/**
 * Kimi Code's agent file for a new session: Kimi's own system prompt (`${base_prompt}`, which Kimi fills in) followed by
 * Swarm's instructions, and for a read-only session only the reading tools.
 */
const kimiAgent = (request: TurnRequest): string => [
  "---",
  "name: swarm",
  "description: Swarm's worker for this session",
  ...(request.permission === "read-only" ? [`tools: ${[...KIMI_READ_ONLY_TOOLS, ...(request.tools ? ["mcp__ticket__*"] : [])].join(", ")}`] : []),
  "---",
  "${base_prompt}",
  "",
  request.instructions,
  ""
].join("\n");

/**
 * Adds the ticket tools to the project-level `.kimi-code/mcp.json` in `directory`, keeping what is there, and returns how
 * to put the file back as it was.
 */
function addKimiTools(directory: string, tools: ToolsServer): () => void {
  const folder = join(directory, ".kimi-code");
  const file = join(folder, "mcp.json");
  const hadFolder = existsSync(folder);
  let before: string | undefined;
  try { before = readFileSync(file, "utf8"); } catch { before = undefined; }
  let config: Event = {};
  if (before?.trim()) {
    try { config = obj(JSON.parse(before)); } catch {
      throw new HarnessSetupError(`${file} is not valid JSON, so Swarm cannot add the ticket tools to it for Kimi Code: fix or remove it, then retry the ticket.`);
    }
  }
  mkdirSync(folder, { recursive: true });
  const servers = { ...obj(config.mcpServers), ticket: { command: tools.command, args: tools.args, env: tools.env, toolTimeoutMs: 120_000 } };
  writeFileSync(file, `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`);
  return () => {
    if (before !== undefined) { writeFileSync(file, before); return; }
    rmSync(file, { force: true });
    if (!hadFolder) try { rmdirSync(folder); } catch { /* Kimi left something else there. */ }
  };
}

/** Whether Kimi Code has a model it can call: a provider with a key, or a Kimi account whose token file holds a token. */
function kimiSignedIn(code: number, stdout: string, env: NodeJS.ProcessEnv): boolean {
  if (env.KIMI_MODEL_NAME && env.KIMI_MODEL_API_KEY) return true;
  if (code !== 0) return false;
  let providers: Event;
  try { providers = obj(obj(JSON.parse(stdout)).providers); } catch { return false; }
  return Object.values(providers).map(obj).some((provider) => {
    if (str(provider.apiKey) || Object.values(obj(provider.env)).some((value) => typeof value === "string" && value)) return true;
    const variable = str(provider.apiKeyEnv);
    if (variable && env[variable]) return true;
    const key = str(obj(provider.oauth).key);
    if (!key) return false;
    try {
      const token = obj(JSON.parse(readFileSync(join(kimiHome(env), "credentials", `${basename(key.replace(/^oauth\//, ""))}.json`), "utf8")));
      return !!(str(token.access_token) || str(token.refresh_token));
    } catch { return false; }
  });
}

/** The Kimi Code session a turn ran in: the one it named, else the newest one started in its directory during the turn. */
function kimiSession(home: string, directory: string, started: number, id?: string): { id: string; dir: string } | undefined {
  let lines: string[];
  try { lines = readFileSync(join(home, "session_index.jsonl"), "utf8").split("\n"); } catch { return undefined; }
  let cwd = directory;
  try { cwd = realpathSync(directory); } catch { /* A directory that is gone matches no session. */ }
  const entries = lines.flatMap((line) => {
    try {
      const entry = obj(JSON.parse(line));
      return str(entry.sessionId) && str(entry.sessionDir) ? [{ id: String(entry.sessionId), dir: String(entry.sessionDir), workDir: str(entry.workDir) }] : [];
    } catch { return []; }
  }).reverse();
  if (id) return entries.find((entry) => entry.id === id);
  const created = (dir: string): number => {
    try { return num(obj(JSON.parse(readFileSync(join(dir, "state.json"), "utf8"))).createdAt); } catch { return 0; }
  };
  return entries.find((entry) => entry.workDir === cwd && created(entry.dir) >= started - 1000);
}

/** A Kimi Code session's token counts since `started`, from each agent's `usage.record` entries, and the main agent's model. */
function kimiUsage(dir: string, started: number): { usage: HarnessUsage; model?: string } | undefined {
  let agents: string[];
  try { agents = readdirSync(join(dir, "agents")); } catch { return undefined; }
  const usage: HarnessUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0 };
  let model: string | undefined;
  let found = false;
  for (const agent of agents) {
    let text: string;
    try { text = readFileSync(join(dir, "agents", agent, "wire.jsonl"), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.includes("\"usage.record\"")) continue;
      let record: Event;
      try { record = obj(JSON.parse(line)); } catch { continue; }
      if (record.type !== "usage.record" || num(record.time) < started) continue;
      const counts = obj(record.usage);
      usage.inputTokens += num(counts.inputOther);
      usage.outputTokens += num(counts.output);
      usage.cachedInputTokens += num(counts.inputCacheRead);
      usage.cacheCreationInputTokens += num(counts.inputCacheCreation);
      found = true;
      if (agent === "main") model = str(record.model) ?? model;
    }
  }
  return found ? { usage, ...(model ? { model } : {}) } : undefined;
}

/**
 * Kimi Code: `kimi --prompt <prompt> --output-format stream-json`, which runs in Kimi's own auto permission mode (Never
 * Ask) and prints one JSON line per assistant message (its text and tool calls), tool result and notice; the session id
 * comes in the closing `session.resume_hint` notice, which only a completed turn prints. It has no flag for an MCP server
 * or extra instructions: a new session starts with an agent file in the turn's scratch directory (kimiAgent), and a resumed
 * one keeps the agent it started with. A ticket's turn adds the ticket tools to the project-level `.kimi-code/mcp.json` of
 * its directory and puts the file back afterwards, and trusts the directory for that process (`KIMI_CODE_TRUST_WORKSPACE`),
 * without which a headless run skips project-level servers. Token counts are not in its events but in the session's wire
 * files. Blocked commands are not passed on: Kimi's command rules live only in its own config.toml.
 */
const KIMI: HarnessKind = {
  label: "Kimi Code",
  program: "kimi",
  protocol: "openai-chat-completions",
  tool: mcpTool,
  promptArgument: true,
  args: (request) => [
    "--prompt", request.prompt ?? "", "--output-format", "stream-json",
    ...request.extra,
    ...(request.session ? ["--session", request.session] : request.scratch ? ["--agent-file", join(request.scratch, KIMI_AGENT)] : []),
    ...(request.model ? ["--model", request.model] : [])
  ],
  prepare(request) {
    if (!request.session && request.scratch) writeFileSync(join(request.scratch, KIMI_AGENT), kimiAgent(request), { mode: 0o600 });
    if (!request.tools) return {};
    return { env: { KIMI_CODE_TRUST_WORKSPACE: "1" }, undo: addKimiTools(request.directory, request.tools) };
  },
  read(event, turn) {
    if (event.role === "assistant") {
      turn.steps += 1;
      turn.toolCalls += list(event.tool_calls).length;
      if (str(event.content)?.trim()) turn.text = String(event.content);
      return;
    }
    if (event.role !== "meta") return;
    if (event.type === "session.resume_hint") {
      turn.session = str(event.session_id) ?? turn.session;
      turn.done = true;
    } else if (event.type === "turn.step.retrying") {
      turn.error = [str(event.error_name), str(event.error_message)].filter(Boolean).join(": ") || "A model request failed";
    }
  },
  signedIn: { args: ["provider", "list", "--json"], check: kimiSignedIn, login: "login" },
  unset: [],
  lost: (output) => /Session "[^"]*" not found/.test(output),
  detail: (stderr) => [...stderr.matchAll(/failed to run prompt: (.+)/g)].at(-1)?.[1]?.trim(),
  readOnly: "Kimi Code's session starts with an agent that has only Read, Grep, Glob, ReadMediaFile, TodoList, WebSearch and FetchURL: it cannot edit files, run commands or start subagents.",
  permissionFlags: ["--yolo", "-y", "--yes", "--auto", "--auto-approve", "--plan", "--agent", "--agent-file", "--add-dir"],
  settle(turn, { env, directory, started }) {
    const session = kimiSession(kimiHome(env), directory, started, turn.session);
    if (!session) return;
    turn.session ??= session.id;
    const counted = kimiUsage(session.dir, started);
    if (!counted) return;
    turn.usage = counted.usage;
    turn.model ??= counted.model;
  }
};

/** The agent and instructions file OpenCode turns run with, the latter in the turn's scratch directory. */
const OPENCODE_AGENT = "swarm";
const OPENCODE_INSTRUCTIONS = "opencode-instructions.md";
const GIT_READ_COMMANDS = Object.fromEntries(["status", "diff", "log", "show"].flatMap((command) => [[`git ${command}`, "allow"], [`git ${command} *`, "allow"]]));
/** OpenCode's permissions for a read-only turn: its reading and searching tools, the web, and git's read-only commands. */
const OPENCODE_READ_ONLY = {
  "*": "deny", read: "allow", glob: "allow", grep: "allow", list: "allow", lsp: "allow", todoread: "allow", todowrite: "allow",
  webfetch: "allow", websearch: "allow", bash: { "*": "deny", ...GIT_READ_COMMANDS }
};
/** The API protocol of an OpenCode provider, as its id names it. */
const providerProtocol = (provider: string): UsageProtocol =>
  provider === "anthropic" ? "anthropic-messages" : provider === "openai" ? "openai-responses" : "openai-chat-completions";
const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");

/**
 * OpenCode: `opencode run --format json` with the prompt on standard input. Swarm's part of its configuration comes in
 * `OPENCODE_CONFIG_CONTENT`, which OpenCode merges above the user's and the project's config for that process: the ticket
 * tools as the local MCP server `ticket` (whose tools it names `ticket_<tool>`), Swarm's instructions as an instructions
 * file in the turn's scratch directory, and an agent `swarm` with the turn's permissions, which every turn names (a resumed
 * session would otherwise go on with OpenCode's default agent). full-auto and yolo allow everything but the blocked
 * commands, with `--auto` for whatever would still ask; read-only allows reading, searching and git's read-only commands,
 * and without `--auto` OpenCode rejects whatever would ask. Its error events say only "Unexpected server error", so turns
 * print its error log on standard error, which holds the cause. Its events name no model: settle reads it from
 * `opencode export`.
 */
const OPENCODE: HarnessKind = {
  label: "OpenCode",
  program: "opencode",
  protocol: "openai-chat-completions",
  tool: (name) => `ticket_${name}`,
  args: (request) => [
    "run", "--format", "json", ...request.extra, "--print-logs", "--log-level", "ERROR", "--agent", OPENCODE_AGENT,
    ...(request.session ? ["--session", request.session] : []),
    ...(request.model ? ["--model", request.model] : []),
    ...(request.permission === "read-only" ? [] : ["--auto"])
  ],
  prepare(request, env) {
    let own: Event = {};
    try { own = obj(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}")); } catch { /* Not JSON: OpenCode would refuse it too, and Swarm's replaces it. */ }
    const instructions = join(request.scratch!, OPENCODE_INSTRUCTIONS);
    writeFileSync(instructions, request.instructions, { mode: 0o600 });
    const blocked = Object.fromEntries(request.blockedCommands.flatMap((name) => [[name, "deny"], [`${name} *`, "deny"]]));
    const permission = request.permission === "read-only" ? OPENCODE_READ_ONLY : { "*": "allow", question: "deny", bash: { "*": "allow", ...blocked } };
    const config = {
      ...own,
      ...(request.tools ? { mcp: { ...obj(own.mcp), ticket: { type: "local", command: [request.tools.command, ...request.tools.args],
        environment: request.tools.env, enabled: true, timeout: 120_000 } } } : {}),
      instructions: [...list(own.instructions), instructions],
      agent: { ...obj(own.agent), [OPENCODE_AGENT]: { mode: "primary", description: "Swarm's worker for this session", permission } }
    };
    return { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) } };
  },
  read(event, turn) {
    turn.session = str(event.sessionID) ?? turn.session;
    const part = obj(event.part);
    if (event.type === "step_start") { turn.steps += 1; return; }
    if (event.type === "tool_use") { turn.toolCalls += 1; return; }
    if (event.type === "text") {
      if (str(part.text)?.trim()) turn.text = String(part.text);
      return;
    }
    if (event.type === "step_finish") {
      // Each model call reports its own tokens and cost; a step that called tools is followed by another.
      const tokens = obj(part.tokens);
      const cache = obj(tokens.cache);
      const usage = turn.usage ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0, costUsd: 0 };
      usage.inputTokens += num(tokens.input);
      usage.outputTokens += num(tokens.output);
      usage.cachedInputTokens += num(cache.read);
      usage.cacheCreationInputTokens += num(cache.write);
      usage.reasoningOutputTokens = (usage.reasoningOutputTokens ?? 0) + num(tokens.reasoning);
      usage.costUsd = (usage.costUsd ?? 0) + num(part.cost);
      turn.usage = usage;
      turn.done = part.reason !== "tool-calls";
      return;
    }
    if (event.type === "error") {
      const error = obj(event.error);
      turn.error = str(obj(error.data).message) ?? str(error.name) ?? "OpenCode reported an error";
      turn.done = false;
    }
  },
  signedIn: {
    args: ["auth", "list"],
    check: (code, stdout) => code === 0 && /\b[1-9]\d* (credentials?|environment variables?)\b/.test(stripAnsi(stdout)),
    login: "auth login"
  },
  unset: [],
  lost: (output) => output.includes("Session not found"),
  detail: (stderr) => [...stderr.matchAll(/level=ERROR .*?\berror="((?:[^"\\]|\\.)*)"/g)].at(-1)?.[1]?.replace(/\\(.)/g, "$1"),
  readOnly: "OpenCode's agent allows only reading, searching, the web and git's status, diff, log and show: edits, other commands, subagents and MCP tools are denied, and it rejects whatever would ask.",
  permissionFlags: ["--auto", "--yolo", "--dangerously-skip-permissions", "--agent"],
  async settle(turn, { command, env }) {
    if (turn.model || !turn.session) return;
    try {
      const { stdout } = await exec(command, ["export", turn.session], { env, timeout: CHECK_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
      const messages = list(obj(JSON.parse(stdout)).messages).map((message) => obj(obj(message).info));
      const last = [...messages].reverse().find((info) => info.role === "assistant" && str(info.modelID));
      if (!last) return;
      const provider = str(last.providerID) ?? "";
      turn.model = provider ? `${provider}/${String(last.modelID)}` : String(last.modelID);
      turn.protocol = providerProtocol(provider);
    } catch { /* The session's model stays unknown; its usage is still recorded. */ }
  }
};

/** The kinds of harness Swarm drives; a profile names one. */
export const HARNESS_KINDS = { claude: CLAUDE, codex: CODEX, kimi: KIMI, opencode: OPENCODE } satisfies Record<string, HarnessKind>;
export type HarnessKindId = keyof typeof HARNESS_KINDS;
const KIND_IDS = Object.keys(HARNESS_KINDS) as [HarnessKindId, ...HarnessKindId[]];

/**
 * Variables that hold credentials, such as ANTHROPIC_AUTH_TOKEN or OPENAI_API_KEY: a profile reads them from the
 * environment through `keys`, never from its settings. MAX_THINKING_TOKENS and the like are settings.
 */
const SECRET = /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)(_|$)/i;
export const HarnessIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "A harness id: lowercase letters, digits and dashes");
const VariableSchema = z.string().regex(VARIABLE, "An environment variable name");
/**
 * A harness profile: its kind (the built-in profiles named after a kind are their own), the command (a name on PATH or an
 * absolute path), a model, arguments added to every turn, variables set for it, and `keys`: variables it gets from other
 * variables of the host's environment, such as `{ "ANTHROPIC_AUTH_TOKEN": "ZHIPU_API_KEY" }`.
 */
export const HarnessProfileSchema = z.object({
  kind: z.enum(KIND_IDS).optional(),
  command: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  args: z.array(z.string()).default([]),
  env: z.record(VariableSchema, z.string()).refine((env) => !Object.keys(env).some((name) => SECRET.test(name)),
    "Credentials are read from the environment: map them in `keys` instead of writing them here").default({}),
  keys: z.record(VariableSchema, VariableSchema).default({})
}).strict();
export type HarnessProfile = z.infer<typeof HarnessProfileSchema>;
type KindedProfile = HarnessProfile & { kind: HarnessKindId };

/**
 * Built-in profiles for other models behind Claude Code, through their providers' Anthropic-compatible endpoints, with the
 * variables those providers' Claude Code guides set: Zhipu's GLM Coding Plan (docs.bigmodel.cn, coding-plan/tool/claude;
 * Z.ai's international endpoint is https://api.z.ai/api/anthropic) and DeepSeek's API
 * (api-docs.deepseek.com, quick_start/agent_integrations/claude_code), as of November 2026. Their keys come from
 * ZHIPU_API_KEY and DEEPSEEK_API_KEY, the names OpenCode's providers for them read too.
 */
const MODEL_PROFILES: Record<string, KindedProfile> = {
  "claude-glm": {
    kind: "claude", model: "glm-5.3[1m]", args: [], keys: { ANTHROPIC_AUTH_TOKEN: "ZHIPU_API_KEY" },
    env: {
      ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3[1m]", ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.3[1m]", ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.3-flash[1m]",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", API_TIMEOUT_MS: "3000000"
    }
  },
  "claude-deepseek": {
    kind: "claude", model: "deepseek-flash[1m]", args: [], keys: { ANTHROPIC_AUTH_TOKEN: "DEEPSEEK_API_KEY" },
    env: {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_MODEL: "deepseek-flash[1m]",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-flash[1m]", ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-flash[1m]", ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-flash",
      CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-flash", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "786432"
    }
  }
};

/**
 * The profiles there are, each with its kind: one per kind and the built-in model profiles, as settings change them, and
 * those settings add. Settings for a kind's profile replace it; settings for a model profile add to its variables and keys
 * and replace what else they set.
 */
export function harnessProfiles(configured: Readonly<Record<string, HarnessProfile>>): Record<string, KindedProfile> {
  const profiles: Record<string, KindedProfile> = {};
  for (const id of KIND_IDS) {
    const own = configured[id];
    profiles[id] = own ? { ...own, kind: own.kind ?? id } : { args: [], env: {}, keys: {}, kind: id };
  }
  for (const [id, builtIn] of Object.entries(MODEL_PROFILES)) {
    const own = configured[id];
    profiles[id] = own ? {
      ...builtIn, ...own, kind: own.kind ?? builtIn.kind, args: own.args.length ? own.args : builtIn.args,
      env: { ...builtIn.env, ...own.env }, keys: { ...builtIn.keys, ...own.keys }
    } : builtIn;
  }
  for (const [id, profile] of Object.entries(configured)) if (profile.kind && !(id in profiles)) profiles[id] = { ...profile, kind: profile.kind };
  return profiles;
}

/** Why a harness setting cannot be used, or undefined: an unknown default, or an added profile without a kind. */
export function harnessSettingsProblem(harness: string | null, configured: Readonly<Record<string, HarnessProfile>>): string | undefined {
  const untyped = Object.entries(configured).find(([id, profile]) => !(id in HARNESS_KINDS) && !(id in MODEL_PROFILES) && !profile.kind);
  if (untyped) return `executor.harnesses.${untyped[0]} needs a kind: ${KIND_IDS.join(", ")}`;
  if (harness && !(harness in harnessProfiles(configured))) return `executor.harness names no harness profile: ${harness}`;
  return undefined;
}

/** The harness profile ids people can choose. */
export const harnessIds = (configured: Readonly<Record<string, HarnessProfile>>): string[] => Object.keys(harnessProfiles(configured));

/** A harness that cannot run here, with what to do about it. */
export class HarnessSetupError extends Error {}
/** A resumed turn found that the harness no longer has its session, such as after its files were removed. */
export class SessionLost extends Error {}

/** A harness profile resolved on this machine: its kind, command, model and arguments, and the environment its turns run in. */
export interface Harness {
  id: string;
  kind: HarnessKind;
  command: string;
  model?: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  /** The profile's own variables and key values, which a kind can pass again where the harness's settings would override them. */
  own: Readonly<Record<string, string>>;
}

/**
 * Resolves a harness profile here: its command on PATH or as configured, and its environment: the host's, without the
 * variables the kind must not inherit, with the profile's variables and keys. `where` names the settings file for hints.
 * @throws HarnessSetupError when the profile is unknown, its command is missing or a key is not set.
 */
export function resolveHarness(id: string, configured: Readonly<Record<string, HarnessProfile>>, where: string,
  base: NodeJS.ProcessEnv = process.env): Harness {
  const profile = harnessProfiles(configured)[id];
  if (!profile) {
    throw new HarnessSetupError(`No harness "${id}" on ${hostname()}: the profiles here are ${harnessIds(configured).join(", ")}; add one under executor.harnesses in ${where}.`);
  }
  const kind = HARNESS_KINDS[profile.kind];
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of kind.unset) delete env[name];
  const own: Record<string, string> = { ...profile.env };
  for (const [name, source] of Object.entries(profile.keys)) {
    const value = base[source];
    if (!value) throw new HarnessSetupError(`The ${kind.label} profile "${id}" reads ${name} from ${source}, which is not set where Swarm runs on ${hostname()}.`);
    own[name] = value;
  }
  Object.assign(env, own);
  let command: string;
  try {
    command = executable(profile.command ?? kind.program, env.PATH ?? "");
  } catch {
    const named = profile.command ? `${profile.command} is not an executable file` : `no \`${kind.program}\` on PATH`;
    throw new HarnessSetupError(`${kind.label} is not installed on ${hostname()}: ${named}. Install it, or set executor.harnesses.${id}.command in ${where} to its full path, then retry the ticket.`);
  }
  return { id, kind, command, ...(profile.model ? { model: profile.model } : {}), args: profile.args, env, own };
}

/** Runs a harness's sign-in status command: whether it ran, and whether it says someone is signed in. */
async function signInStatus(harness: Harness): Promise<{ failure?: string; signedIn: boolean }> {
  const { kind, command } = harness;
  const { code, stdout, failure } = await exec(command, kind.signedIn.args, { env: harness.env, timeout: CHECK_TIMEOUT_MS, maxBuffer: 1024 * 1024 })
    .then((result) => ({ code: 0, stdout: result.stdout, failure: undefined as string | undefined }), (error: { code?: unknown; stdout?: string; killed?: boolean; message?: string }) => ({
      code: typeof error.code === "number" ? error.code : -1, stdout: error.stdout ?? "",
      failure: typeof error.code === "number" ? undefined : error.killed ? `did not answer within ${CHECK_TIMEOUT_MS / 1000} s` : error.message ?? String(error)
    }));
  return failure ? { failure, signedIn: false } : { signedIn: kind.signedIn.check(code, stdout, harness.env) };
}

/** Checks that a harness runs and is signed in. @throws HarnessSetupError with what to do. */
export async function checkHarness(harness: Harness): Promise<void> {
  const { kind, command } = harness;
  const { failure, signedIn } = await signInStatus(harness);
  if (failure) throw new HarnessSetupError(`${kind.label} does not run on ${hostname()}: \`${command} ${kind.signedIn.args.join(" ")}\` ${failure}.`);
  if (!signedIn) {
    throw new HarnessSetupError(`${kind.label} is not signed in on ${hostname()}: run \`${command} ${kind.signedIn.login}\` in a terminal as this user, then retry the ticket.`);
  }
}

/**
 * Why a harness cannot run a read-only turn, or undefined: its kind has no read-only mode, or the profile's own arguments
 * set its permissions, sandbox or tools, which would override Swarm's.
 */
export function readOnlyProblem(harness: Pick<Harness, "id" | "kind" | "args">): string | undefined {
  const { id, kind, args } = harness;
  if (!kind.readOnly) return `${kind.label} has no read-only mode Swarm can start it in.`;
  const flag = args.find((arg) => kind.permissionFlags.some((name) => arg === name || arg.startsWith(`${name}=`)));
  if (flag) return `the profile "${id}" passes ${flag} in its args, which sets ${kind.label}'s permissions itself, so Swarm cannot keep it read-only.`;
  return undefined;
}

/** A harness profile as this machine has it, for `swarm harness`: what it runs and whether it can. */
export interface HarnessStatus {
  id: string;
  kind: HarnessKindId;
  label: string;
  /** The command it runs, resolved on PATH when it is installed. */
  command: string;
  model?: string;
  installed: boolean;
  /** Whether someone is signed in, when that was checked. */
  signedIn?: boolean;
  /** The variables its keys come from, and whether each is set: names only. */
  keys: { name: string; from: string; present: boolean }[];
  /** What stops it from running here, with what to do. */
  problem?: string;
}

/** A profile's status here; `signIn` also runs its sign-in status command. Never reads out a key's value. */
export async function harnessStatus(id: string, configured: Readonly<Record<string, HarnessProfile>>, where: string,
  options: { signIn?: boolean; base?: NodeJS.ProcessEnv } = {}): Promise<HarnessStatus> {
  const base = options.base ?? process.env;
  const profile = harnessProfiles(configured)[id];
  if (!profile) throw new HarnessSetupError(`No harness "${id}": the profiles here are ${harnessIds(configured).join(", ")}; add one under executor.harnesses in ${where}.`);
  const kind = HARNESS_KINDS[profile.kind];
  const keys = Object.entries(profile.keys).map(([name, from]) => ({ name, from, present: !!base[from] }));
  const status: HarnessStatus = { id, kind: profile.kind, label: kind.label, command: profile.command ?? kind.program,
    ...(profile.model ? { model: profile.model } : {}), installed: false, keys };
  try {
    status.command = executable(profile.command ?? kind.program, { ...base, ...profile.env }.PATH ?? "");
    status.installed = true;
  } catch {
    status.problem = `${kind.label} is not installed: ${profile.command ? `${profile.command} is not an executable file` : `no \`${kind.program}\` on PATH`}.`;
    return status;
  }
  let harness: Harness;
  try {
    harness = resolveHarness(id, configured, where, base);
  } catch (error) {
    if (!(error instanceof HarnessSetupError)) throw error;
    status.problem = error.message;
    return status;
  }
  if (!options.signIn) return status;
  const { failure, signedIn } = await signInStatus(harness);
  status.signedIn = signedIn;
  if (failure) status.problem = `\`${harness.command} ${kind.signedIn.args.join(" ")}\` ${failure}.`;
  else if (!signedIn) status.problem = `not signed in: run \`${harness.command} ${kind.signedIn.login}\` in a terminal as this user.`;
  return status;
}

/** The ability a node lists for a harness profile it can run, which work on that harness needs of its machine. */
export const harnessAbility = (id: string): string => `harness:${id}`;

/**
 * The harness abilities of this machine: one per profile that is installed and signed in here, with its keys set. A
 * profile whose check fails is not listed.
 */
export async function harnessAbilities(configured: Readonly<Record<string, HarnessProfile>>, where: string,
  base: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const statuses = await Promise.all(harnessIds(configured).map((id) =>
    harnessStatus(id, configured, where, { signIn: true, base }).catch((error: unknown) => ({ id, problem: String(error) }))));
  return statuses.flatMap((status) => status.problem ? [] : [harnessAbility(status.id)]);
}

/**
 * A turn's usage as rows of Swarm's usage records, as its provider calls write theirs: one count row and its token rows,
 * with the harness, its model and what else `context` says, such as the session, ticket and purpose.
 */
export function harnessUsageRows(harness: Pick<Harness, "id" | "kind" | "model">, outcome: TurnOutcome, context: Record<string, unknown>):
  { kind: "llm_call"; amount: number; unit: "count" | "tokens"; metadata: Record<string, unknown> }[] {
  const usage = outcome.usage;
  if (!usage) return [];
  const total = harness.kind.cachedInInput ? usage.inputTokens : usage.inputTokens + usage.cachedInputTokens + usage.cacheCreationInputTokens;
  const metadata = {
    providerId: `harness:${harness.id}`, protocol: outcome.protocol ?? harness.kind.protocol, model: outcome.model ?? harness.model ?? "unknown",
    ...context, harness: harness.id, harnessKind: harness.kind.program,
    ...(outcome.session ? { harnessSession: outcome.session } : {}), status: outcome.status, durationMs: outcome.durationMs,
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens, totalInputWithCacheTokens: total,
    uncachedInputTokens: Math.max(0, total - usage.cachedInputTokens),
    ...(usage.reasoningOutputTokens ? { reasoningOutputTokens: usage.reasoningOutputTokens } : {}),
    ...(usage.costUsd !== undefined ? { reportedCostUsd: usage.costUsd } : {}),
    ...(usage.partial ? { usagePartial: true } : {})
  };
  return [
    { kind: "llm_call", amount: 1, unit: "count", metadata: { ...metadata, event: "harness_turn" } },
    ...([["input", usage.inputTokens], ["output", usage.outputTokens], ["cached_input", usage.cachedInputTokens],
      ["cache_creation_input", usage.cacheCreationInputTokens]] as const)
      .filter(([, amount]) => amount > 0).map(([name, amount]) => ({ kind: "llm_call" as const, amount, unit: "tokens" as const, metadata: { ...metadata, token_type: name } }))
  ];
}

/** A turn's limits: model messages and tool calls, after which the turn is stopped as one that ran out of budget. */
export interface TurnLimits { steps: number; toolCalls: number }

/** How a turn ended: what its events said, whether it completed, and what it wrote to standard error. */
export interface TurnOutcome extends TurnEvents {
  status: "completed" | "failed";
  /** The turn resumed a session the harness no longer has. */
  lost: boolean;
  durationMs: number;
  stderr: string;
}

/**
 * Runs one turn of a harness: the prompt on standard input or in its arguments, the events read as they come. A kind that
 * writes files for the turn gets a private scratch directory, removed with what it wrote once the turn ends. A turn that
 * goes past its limits, or whose signal aborts, is stopped: SIGTERM, then SIGKILL after a grace period.
 */
export async function runTurn(harness: Harness, request: Omit<TurnRequest, "model" | "extra" | "prompt" | "scratch" | "own">, prompt: string,
  limits: TurnLimits, signal?: AbortSignal): Promise<TurnOutcome> {
  const started = Date.now();
  const turn: TurnEvents = { text: "", done: false, steps: 0, toolCalls: 0 };
  const { kind } = harness;
  const scratch = kind.prepare ? mkdtempSync(join(tmpdir(), "swarm-harness-")) : undefined;
  const full: TurnRequest = { ...request, ...(harness.model ? { model: harness.model } : {}), extra: harness.args, own: harness.own, prompt,
    ...(scratch ? { scratch } : {}) };
  let prepared: Prepared = {};
  try {
    try {
      prepared = kind.prepare?.(full, harness.env) ?? {};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...turn, error: message, status: "failed", lost: false, durationMs: Date.now() - started, stderr: "" };
    }
    return await runPrepared(harness, full, { ...harness.env, ...prepared.env }, limits, turn, started, signal);
  } finally {
    try { prepared.undo?.(); } finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
  }
}

async function runPrepared(harness: Harness, request: TurnRequest, env: NodeJS.ProcessEnv, limits: TurnLimits, turn: TurnEvents, started: number,
  signal?: AbortSignal): Promise<TurnOutcome> {
  const { kind } = harness;
  const child = spawn(harness.command, kind.args(request), { cwd: request.directory, env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  let over: string | undefined;
  let stopped = false;
  let killer: NodeJS.Timeout | undefined;
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    killer ??= setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
  };
  const abort = () => { stopped = true; stop(); };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const exited = new Promise<{ code: number | null; error?: string }>((resolve) => {
    child.on("error", (error) => resolve({ code: null, error: error.message }));
    child.on("close", (code) => resolve({ code }));
  });
  child.stdin.on("error", () => { /* A harness that exited before reading its prompt says why on stderr. */ });
  child.stdin.end(kind.promptArgument ? undefined : request.prompt);
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-TAIL_CHARS); });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let event: unknown;
    try { event = JSON.parse(line); } catch { return; }
    if (!event || typeof event !== "object") return;
    kind.read(event as Event, turn);
    if (!over && (turn.steps > limits.steps || turn.toolCalls > limits.toolCalls)) {
      over = `The turn ran out of budget after ${turn.steps} model messages and ${turn.toolCalls} tool calls (at most ${limits.steps} and ${limits.toolCalls}).`;
      stop();
    }
  });
  const { code, error } = await exited;
  if (killer) clearTimeout(killer);
  signal?.removeEventListener("abort", abort);
  await kind.settle?.(turn, { command: harness.command, env, directory: request.directory, started });
  const completed = turn.done && !over && !stopped && code === 0;
  const tail = stderr.trim().split("\n").slice(-5).join("\n");
  const why = over ?? (stopped ? "The turn was stopped." : undefined) ?? (completed ? undefined
    : kind.detail?.(stderr) ?? turn.error ?? error ?? (tail || (code === null ? "The harness was killed." : `The harness exited with code ${code} before it finished the turn.`)));
  return {
    ...turn, ...(why ? { error: why } : {}), status: completed ? "completed" : "failed",
    lost: !!request.session && !completed && kind.lost(`${turn.error ?? ""}\n${stderr}`),
    durationMs: Date.now() - started, stderr
  };
}
