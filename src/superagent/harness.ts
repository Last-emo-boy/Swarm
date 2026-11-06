/**
 * Agent harnesses a ticket's worker can run on instead of Swarm's own coding loop. A kind drives one CLI headless, one
 * process per turn in the ticket's directory: how to start a turn with Swarm's ticket tools as an MCP server, resume the
 * session on the next turn, read the JSON events it prints, and tell that it is installed and signed in. A profile names a
 * kind with its command, model, arguments and environment; settings change the built-in profiles and add others, and keys
 * come only from the environment. The flags are those of Claude Code 2.1.285 and Codex CLI 0.163.0.
 */
import { execFile, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { z } from "zod/v4";
import { executable } from "./setup.js";

const exec = promisify(execFile);
const CHECK_TIMEOUT_MS = 30_000;
/** How long a stopped turn's process may take to exit before it is killed. */
const STOP_GRACE_MS = 10_000;
const TAIL_CHARS = 4000;

/** Swarm's permission modes for workers, which each kind maps to its own sandbox and approval flags. */
export type HarnessPermission = "full-auto" | "yolo";

/** Swarm's ticket tools as a stdio MCP server: the program, its arguments and the variables it needs. */
export interface ToolsServer { command: string; args: string[]; env: Record<string, string> }

/** One turn as a kind turns it into arguments; the prompt itself goes on standard input. */
export interface TurnRequest {
  /** The ticket's directory, where the harness works. */
  directory: string;
  /** Swarm's instructions for a ticket's worker. */
  instructions: string;
  /** The harness session to resume; a new session starts without one. */
  session?: string;
  tools: ToolsServer;
  permission: HarnessPermission;
  /** Commands the worker may not run. */
  blockedCommands: readonly string[];
  /** Names of the variables the harness runs with, which the ticket tools' server inherits as it would under Swarm. */
  variables: readonly string[];
  model?: string;
  /** The profile's own arguments, such as a Codex configuration profile. */
  extra: readonly string[];
}

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
}

type Event = Record<string, unknown>;

export interface HarnessKind {
  /** The harness's name for people, such as "Claude Code". */
  label: string;
  /** Its program name on PATH. */
  program: string;
  /** The API protocol its usage counts follow, as Swarm's provider usage records name it. */
  protocol: "anthropic-messages" | "openai-responses";
  args(request: TurnRequest): string[];
  /** Reads one JSON event of a turn into what the turn said. */
  read(event: Event, turn: TurnEvents): void;
  /** The arguments of its sign-in status command, how to read the answer, and the arguments that sign in. */
  signedIn: { args: string[]; check(code: number, stdout: string): boolean; login: string };
  /** Variables it must not inherit: those an enclosing session of the same harness sets for its own tools. */
  unset: readonly string[];
  /** Whether a resumed turn failed because the harness no longer has the session. */
  lost(output: string): boolean;
  /** Fills in what its events do not say, once the turn's process exited. */
  settle?(turn: TurnEvents, env: NodeJS.ProcessEnv): void;
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
 * Claude Code: `claude -p` with stream-json events, the ticket tools from `--mcp-config` and only those
 * (`--strict-mcp-config`), allowed without asking. full-auto is its auto mode, whose classifier blocks risky actions, and
 * yolo skips its permission checks; nothing can answer a prompt, so whatever would ask is denied.
 */
const CLAUDE: HarnessKind = {
  label: "Claude Code",
  program: "claude",
  protocol: "anthropic-messages",
  args: (request) => [
    "-p", "--output-format", "stream-json", "--verbose",
    ...request.extra,
    ...(request.session ? ["--resume", request.session] : []),
    ...(request.model ? ["--model", request.model] : []),
    "--append-system-prompt", request.instructions,
    "--mcp-config", JSON.stringify({ mcpServers: { ticket: { type: "stdio", ...request.tools } } }),
    "--strict-mcp-config",
    "--allowedTools", "mcp__ticket",
    ...(request.blockedCommands.length ? ["--disallowedTools", ...request.blockedCommands.flatMap((name) => [`Bash(${name})`, `Bash(${name} *)`])] : []),
    ...(request.permission === "yolo" ? ["--dangerously-skip-permissions"] : ["--permission-mode", "auto"]),
    "--permission-prompts", "none"
  ],
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
 * user; yolo bypasses approvals and the sandbox outright.
 */
const CODEX: HarnessKind = {
  label: "Codex",
  program: "codex",
  protocol: "openai-responses",
  args: (request) => {
    const config = (key: string, value: string | number | boolean | readonly string[]) => ["-c", `${key}=${toml(value)}`];
    const server = "mcp_servers.ticket";
    const env = Object.entries(request.tools.env).filter(([name]) => VARIABLE.test(name));
    return [
      "exec", ...request.extra, "--json", "--skip-git-repo-check", "-C", request.directory,
      ...(request.model ? ["-m", request.model] : []),
      ...(request.permission === "yolo" ? ["--dangerously-bypass-approvals-and-sandbox"]
        : ["-s", "danger-full-access", ...config("approval_policy", "never")]),
      ...config("developer_instructions", request.instructions),
      ...config(`${server}.command`, request.tools.command),
      ...config(`${server}.args`, request.tools.args),
      ...env.flatMap(([name, value]) => config(`${server}.env.${name}`, value)),
      ...config(`${server}.env_vars`, request.variables.filter((name) => VARIABLE.test(name) && !(name in request.tools.env))),
      ...config(`${server}.default_tools_approval_mode`, "approve"),
      ...config(`${server}.startup_timeout_sec`, 60),
      ...config(`${server}.tool_timeout_sec`, 120),
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
  settle(turn, env) {
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

/** The kinds of harness Swarm drives; a profile names one. */
export const HARNESS_KINDS = { claude: CLAUDE, codex: CODEX } satisfies Record<string, HarnessKind>;
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
 * A harness profile: its kind (the built-in profiles `claude` and `codex` are their own), the command (a name on PATH or
 * an absolute path), a model, arguments added to every turn, variables set for it, and `keys`: variables it gets from
 * other variables of the host's environment, such as `{ "ANTHROPIC_AUTH_TOKEN": "GLM_API_KEY" }`.
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

/** The profiles there are: the built-in ones as settings change them, and those settings add, each with its kind. */
export function harnessProfiles(configured: Readonly<Record<string, HarnessProfile>>): Record<string, HarnessProfile & { kind: HarnessKindId }> {
  const profiles: Record<string, HarnessProfile & { kind: HarnessKindId }> = {};
  for (const id of KIND_IDS) {
    const own = configured[id];
    profiles[id] = own ? { ...own, kind: own.kind ?? id } : { args: [], env: {}, keys: {}, kind: id };
  }
  for (const [id, profile] of Object.entries(configured)) if (profile.kind && !(id in profiles)) profiles[id] = { ...profile, kind: profile.kind };
  return profiles;
}

/** Why a harness setting cannot be used, or undefined: an unknown default, or an added profile without a kind. */
export function harnessSettingsProblem(harness: string | null, configured: Readonly<Record<string, HarnessProfile>>): string | undefined {
  const untyped = Object.entries(configured).find(([id, profile]) => !(id in HARNESS_KINDS) && !profile.kind);
  if (untyped) return `executor.harnesses.${untyped[0]} needs a kind: ${KIND_IDS.join(" or ")}`;
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
  Object.assign(env, profile.env);
  for (const [name, source] of Object.entries(profile.keys)) {
    const value = base[source];
    if (!value) throw new HarnessSetupError(`The ${kind.label} profile "${id}" reads ${name} from ${source}, which is not set where the ticket host runs on ${hostname()}.`);
    env[name] = value;
  }
  let command: string;
  try {
    command = executable(profile.command ?? kind.program, env.PATH ?? "");
  } catch {
    const named = profile.command ? `${profile.command} is not an executable file` : `no \`${kind.program}\` on PATH`;
    throw new HarnessSetupError(`${kind.label} is not installed on ${hostname()}: ${named}. Install it, or set executor.harnesses.${id}.command in ${where} to its full path, then retry the ticket.`);
  }
  return { id, kind, command, ...(profile.model ? { model: profile.model } : {}), args: profile.args, env };
}

/** Checks that a harness runs and is signed in. @throws HarnessSetupError with what to do. */
export async function checkHarness(harness: Harness): Promise<void> {
  const { kind, command } = harness;
  const { code, stdout, failure } = await exec(command, kind.signedIn.args, { env: harness.env, timeout: CHECK_TIMEOUT_MS, maxBuffer: 1024 * 1024 })
    .then((result) => ({ code: 0, stdout: result.stdout, failure: undefined as string | undefined }), (error: { code?: unknown; stdout?: string; killed?: boolean; message?: string }) => ({
      code: typeof error.code === "number" ? error.code : -1, stdout: error.stdout ?? "",
      failure: typeof error.code === "number" ? undefined : error.killed ? `did not answer within ${CHECK_TIMEOUT_MS / 1000} s` : error.message ?? String(error)
    }));
  if (failure) throw new HarnessSetupError(`${kind.label} does not run on ${hostname()}: \`${command} ${kind.signedIn.args.join(" ")}\` ${failure}.`);
  if (!kind.signedIn.check(code, stdout)) {
    throw new HarnessSetupError(`${kind.label} is not signed in on ${hostname()}: run \`${command} ${kind.signedIn.login}\` in a terminal as this user, then retry the ticket.`);
  }
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
 * Runs one turn of a harness: the prompt on standard input, the events read as they come. A turn that goes past its
 * limits, or whose signal aborts, is stopped: SIGTERM, then SIGKILL after a grace period.
 */
export async function runTurn(harness: Harness, request: Omit<TurnRequest, "model" | "extra">, prompt: string, limits: TurnLimits,
  signal?: AbortSignal): Promise<TurnOutcome> {
  const started = Date.now();
  const turn: TurnEvents = { text: "", done: false, steps: 0, toolCalls: 0 };
  const child = spawn(harness.command, harness.kind.args({ ...request, ...(harness.model ? { model: harness.model } : {}), extra: harness.args }),
    { cwd: request.directory, env: harness.env, stdio: ["pipe", "pipe", "pipe"] });
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
  child.stdin.end(prompt);
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-TAIL_CHARS); });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let event: unknown;
    try { event = JSON.parse(line); } catch { return; }
    if (!event || typeof event !== "object") return;
    harness.kind.read(event as Event, turn);
    if (!over && (turn.steps > limits.steps || turn.toolCalls > limits.toolCalls)) {
      over = `The turn ran out of budget after ${turn.steps} model messages and ${turn.toolCalls} tool calls (at most ${limits.steps} and ${limits.toolCalls}).`;
      stop();
    }
  });
  const { code, error } = await exited;
  if (killer) clearTimeout(killer);
  signal?.removeEventListener("abort", abort);
  harness.kind.settle?.(turn, harness.env);
  const completed = turn.done && !over && !stopped && code === 0;
  const tail = stderr.trim().split("\n").slice(-5).join("\n");
  const why = over ?? (stopped ? "The turn was stopped." : undefined) ?? (completed ? undefined
    : turn.error ?? error ?? (tail || (code === null ? "The harness was killed." : `The harness exited with code ${code} before it finished the turn.`)));
  return {
    ...turn, ...(why ? { error: why } : {}), status: completed ? "completed" : "failed",
    lost: !!request.session && !completed && harness.kind.lost(`${turn.error ?? ""}\n${stderr}`),
    durationMs: Date.now() - started, stderr
  };
}
