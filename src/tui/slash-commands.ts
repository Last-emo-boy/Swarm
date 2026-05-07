export type SlashCommandGroup = "Core" | "Tools" | "Kernel" | "Agents" | "Symphony" | "Config";

export type SlashCommandSpec = {
  name: string;
  group: SlashCommandGroup;
  usage: string;
  description: string;
  aliases?: string[];
};

export type ParsedSlashCommand = {
  command: string;
  args: string[];
  rawArgs: string;
  argSpans: SlashCommandTokenSpan[];
  source: string;
};

export type SlashCommandTokenSpan = {
  value: string;
  start: number;
  end: number;
};

export type CommandOutputPreviewRecord = {
  task_id: string;
  action: string;
  summary: string;
  content?: string;
  status?: string;
  outputRef?: string;
  attempt?: number;
  recoverySuggestion?: string;
};

export const slashCommandGroups: SlashCommandGroup[] = ["Core", "Tools", "Kernel", "Agents", "Symphony", "Config"];

export const slashCommands: SlashCommandSpec[] = [
  { name: "help", group: "Core", usage: "/help", description: "Show grouped slash command help." },
  { name: "doctor", group: "Core", usage: "/doctor [workflow_path]", description: "Diagnose model setup, permissions, Kernel stores, and Symphony preflight." },
  { name: "mode", group: "Core", usage: "/mode [auto|fast|swarm|chat]", description: "Show or change the execution route mode." },
  { name: "why", group: "Core", usage: "/why", description: "Explain recent route, delegation, review, and verification decisions." },
  { name: "self-review", group: "Core", usage: "/self-review", description: "Inspect recent local Swarm failures and recommendations." },
  { name: "improve-self", group: "Core", usage: "/improve-self", description: "Ask Swarm to improve its own implementation." },
  { name: "evals", group: "Core", usage: "/evals", description: "Run local product regression evals." },
  { name: "prd", group: "Core", usage: "/prd", description: "Show the local PRD." },
  { name: "interrupt", group: "Core", usage: "/interrupt <message>", description: "Interrupt active work and ask Swarm to reassess." },
  { name: "onboard", group: "Core", usage: "/onboard", description: "Open provider/model onboarding." },
  { name: "read", group: "Tools", usage: "/read <path> [start:end]", description: "Read a file from the workspace." },
  { name: "grep", group: "Tools", usage: "/grep <pattern> [root]", description: "Search workspace text." },
  { name: "glob", group: "Tools", usage: "/glob <pattern> [root]", description: "Find files by glob." },
  { name: "shell", group: "Tools", usage: "/shell <command>", description: "Run a shell command with policy approval when required." },
  { name: "web", group: "Tools", usage: "/web <query> [allow:domain] [block:domain]", description: "Search the web through the configured provider/search path." },
  { name: "diff", group: "Tools", usage: "/diff", description: "Show the current git diff." },
  { name: "output", group: "Tools", usage: "/output [task_id]", description: "Show recent tool output or the full output for one task." },
  { name: "kernel", group: "Kernel", usage: "/kernel [workflow_path]", description: "Show the unified Swarm, Work Kernel, and Symphony status view.", aliases: ["status"] },
  { name: "status", group: "Kernel", usage: "/status", description: "Alias for the current Kernel status view.", aliases: ["kernel"] },
  { name: "changes", group: "Kernel", usage: "/changes [session_id]", description: "Show recorded workspace changes." },
  { name: "blackboard", group: "Kernel", usage: "/blackboard [session_id] [tag:<tag>|type:<type>|key:<prefix>|agent:<id>|task:<id>]", description: "Query blackboard facts." },
  { name: "session", group: "Kernel", usage: "/session [session_id|new]", description: "Inspect sessions or start a fresh TUI chat state." },
  { name: "resume", group: "Kernel", usage: "/resume [session_id] [message]", description: "Resume the recent local coding-loop session or a stored planned session.", aliases: ["continue"] },
  { name: "continue", group: "Kernel", usage: "/continue [message]", description: "Continue the most recent local coding-loop session.", aliases: ["resume"] },
  { name: "replay", group: "Kernel", usage: "/replay <session_id>", description: "Replay a persisted session snapshot." },
  { name: "fork", group: "Kernel", usage: "/fork <session_id> [message]", description: "Create a new session from a previous session." },
  { name: "trace", group: "Kernel", usage: "/trace <session_id>", description: "Show persisted envelopes for a session." },
  { name: "span", group: "Kernel", usage: "/span <trace_id|span_id>", description: "Find trace envelopes and audit rows by trace/span id." },
  { name: "attempts", group: "Kernel", usage: "/attempts [session_id]", description: "Inspect run attempts and failure/recovery metadata." },
  { name: "leases", group: "Kernel", usage: "/leases [session_id|lease_id]", description: "Inspect workspace leases and write boundaries." },
  { name: "tasks", group: "Kernel", usage: "/tasks [session_id]", description: "List persisted task graph tasks." },
  { name: "graph", group: "Kernel", usage: "/graph [session_id]", description: "Inspect the task graph." },
  { name: "task", group: "Kernel", usage: "/task <task_id> [session_id]", description: "Inspect one task's attempts, trace, audit, and usage." },
  { name: "approvals", group: "Kernel", usage: "/approvals [session_id]", description: "List approval records." },
  { name: "approval", group: "Kernel", usage: "/approval <approval_id>", description: "Inspect one approval." },
  { name: "audit", group: "Kernel", usage: "/audit [session_id]", description: "List audit records." },
  { name: "budget", group: "Kernel", usage: "/budget [session_id]", description: "Inspect policy budget and usage." },
  { name: "usage", group: "Kernel", usage: "/usage [session_id]", description: "Inspect usage counters." },
  { name: "agents", group: "Agents", usage: "/agents", description: "List available local agent specs." },
  { name: "agent", group: "Agents", usage: "/agent <agent_spec_id>", description: "Show one agent spec." },
  { name: "workers", group: "Agents", usage: "/workers", description: "List local worker agents." },
  { name: "worker", group: "Agents", usage: "/worker <worker_id>", description: "Inspect one worker." },
  { name: "stop-worker", group: "Agents", usage: "/stop-worker <worker_id>", description: "Request a worker stop." },
  { name: "continue-agent", group: "Agents", usage: "/continue-agent <worker_id> <message>", description: "Continue an existing worker." },
  { name: "handoffs", group: "Agents", usage: "/handoffs", description: "List handoff sessions." },
  { name: "handoff", group: "Agents", usage: "/handoff <handoff_id>", description: "Inspect one handoff." },
  { name: "takeback", group: "Agents", usage: "/takeback <handoff_id>", description: "Take back an active handoff." },
  { name: "work-items", group: "Symphony", usage: "/work-items [workflow_path]", description: "Inspect local active and terminal Symphony work items." },
  { name: "symphony", group: "Symphony", usage: "/symphony [workflow_path]", description: "Inspect Symphony scheduler/session status." },
  { name: "symphony-tick", group: "Symphony", usage: "/symphony-tick [workflow_path] [--max-turns N]", description: "Dispatch one local Symphony scheduler tick." },
  { name: "symphony-run-once", group: "Symphony", usage: "/symphony-run-once [workflow_path] [--max-turns N]", description: "Dispatch and execute one Symphony tick." },
  { name: "symphony-daemon", group: "Symphony", usage: "/symphony-daemon [daemon_id]", description: "Inspect TUI-managed Symphony daemons." },
  { name: "symphony-start", group: "Symphony", usage: "/symphony-start [workflow_path] [--execute] [--max-ticks N] [--max-turns N]", description: "Start a local Symphony polling loop in the TUI runtime." },
  { name: "symphony-stop", group: "Symphony", usage: "/symphony-stop [daemon_id|all] [--cancel-running]", description: "Stop local TUI-managed Symphony daemon loops." },
  { name: "symphony-cleanup", group: "Symphony", usage: "/symphony-cleanup [workflow_path] [--execute]", description: "Dry-run or execute terminal workspace cleanup." },
  { name: "provider", group: "Config", usage: "/provider [id]", description: "Show or change the default provider." },
  { name: "model", group: "Config", usage: "/model [planner|worker|aggregator] [provider/model]", description: "Show or update selected models." },
  { name: "models", group: "Config", usage: "/models [provider]", description: "List configured models." },
  { name: "refresh-models", group: "Config", usage: "/refresh-models [provider]", description: "Refresh provider model discovery." },
  { name: "permissions", group: "Config", usage: "/permissions", description: "Inspect permission settings." },
  { name: "permission-mode", group: "Config", usage: "/permission-mode [ask|auto-edit|full-auto|yolo]", description: "Show or change the permission mode." },
  { name: "capabilities", group: "Config", usage: "/capabilities [kind|provider|query]", description: "List registered local, slash, agent, skill, MCP, and plugin capabilities." },
  { name: "skills", group: "Config", usage: "/skills", description: "List discovered agent skills and diagnostics." },
  { name: "skill", group: "Config", usage: "/skill <name>", description: "Activate one trusted skill for the current session." },
  { name: "mcp", group: "Config", usage: "/mcp [server_id]", description: "Inspect configured MCP server states." },
  { name: "mcp-refresh", group: "Config", usage: "/mcp-refresh <server_id>", description: "Reconnect one configured MCP stdio server and refresh its tool catalog." }
];

export function parseSlashCommandLine(commandLine: string): ParsedSlashCommand | undefined {
  const slashIndex = commandLine.search(/\S/);
  if (slashIndex < 0 || commandLine[slashIndex] !== "/") {
    return undefined;
  }
  const tokens = tokenizeSlashCommand(commandLine, slashIndex + 1);
  const commandToken = tokens[0];
  if (!commandToken?.value) {
    return undefined;
  }
  const argSpans = tokens.slice(1);
  return {
    command: commandToken.value,
    args: argSpans.map((token) => token.value),
    rawArgs: commandLine.slice(commandToken.end).trim(),
    argSpans,
    source: commandLine
  };
}

export function rawSlashArgsAfter(parsed: ParsedSlashCommand, consumedArgs: number): string {
  if (consumedArgs <= 0) {
    return parsed.rawArgs;
  }
  const nextArg = parsed.argSpans[consumedArgs];
  return nextArg ? parsed.source.slice(nextArg.start).trim() : "";
}

export function renderSlashHelp(): string {
  return slashCommandGroups
    .map((group) => {
      const commands = slashCommands.filter((command) => command.group === group);
      return [
        group,
        ...commands.map((command) => `  ${command.usage} - ${command.description}`)
      ].join("\n");
    })
    .join("\n\n");
}

export function commandCandidatesForInput(value: string, cursor: number): SlashCommandSpec[] {
  const token = slashCommandToken(value, cursor);
  if (!token) {
    return [];
  }
  const query = token.name.toLowerCase();
  return slashCommands
    .map((command) => ({ command, score: slashCommandScore(command, query) }))
    .filter((item) => item.score < 100)
    .sort((a, b) => a.score - b.score || a.command.name.localeCompare(b.command.name))
    .map((item) => item.command);
}

export function completeSlashCommand(value: string, cursor: number): { value: string; cursor: number } | undefined {
  const token = slashCommandToken(value, cursor);
  if (!token) {
    return undefined;
  }
  const matches = commandCandidatesForInput(value, cursor);
  if (matches.length === 0) {
    return undefined;
  }
  const bestScore = slashCommandScore(matches[0], token.name.toLowerCase());
  const bestMatches = matches.filter((command) => slashCommandScore(command, token.name.toLowerCase()) === bestScore);
  const names = bestMatches.map((command) => command.name);
  const query = token.name;
  const completion = bestMatches.length === 1 ? names[0] : commonPrefix(names);
  if (!completion || completion.length <= query.length) {
    return undefined;
  }
  const replacement = `/${completion}${bestMatches.length === 1 ? " " : ""}`;
  const next = value.slice(0, token.start) + replacement + value.slice(token.end);
  return { value: next, cursor: token.start + replacement.length };
}

export function acceptSlashCommandCandidate(
  value: string,
  cursor: number,
  candidate: SlashCommandSpec | undefined
): { value: string; cursor: number } | undefined {
  const token = slashCommandToken(value, cursor);
  if (!token || !candidate) {
    return undefined;
  }
  const replacement = `/${candidate.name} `;
  const next = value.slice(0, token.start) + replacement + value.slice(token.end).replace(/^\s*/, "");
  return { value: next, cursor: token.start + replacement.length };
}

export function slashCommandCompletionKey(value: string, cursor: number): string | undefined {
  const token = slashCommandToken(value, cursor);
  return token ? value.slice(token.start, token.end) : undefined;
}

function slashCommandToken(value: string, cursor: number): { start: number; end: number; name: string } | undefined {
  if (!value.startsWith("/")) {
    return undefined;
  }
  const safeCursor = Math.max(0, Math.min(value.length, cursor));
  const firstWhitespace = value.search(/\s/);
  const end = firstWhitespace === -1 ? value.length : firstWhitespace;
  if (safeCursor > end) {
    return undefined;
  }
  return { start: 0, end, name: value.slice(1, end) };
}

function slashCommandScore(command: SlashCommandSpec, query: string): number {
  if (!query) {
    return command.group === "Core" ? 10 : command.group === "Kernel" ? 20 : 30;
  }
  const haystack = [command.name, ...(command.aliases ?? [])].map((item) => item.toLowerCase());
  if (haystack.includes(query)) {
    return 0;
  }
  if (haystack.some((item) => item.startsWith(query))) {
    return 5;
  }
  if (haystack.some((item) => item.includes(query))) {
    return 20;
  }
  if (command.description.toLowerCase().includes(query) || command.group.toLowerCase().includes(query)) {
    return 40;
  }
  return 100;
}

function tokenizeSlashCommand(input: string, offset: number): SlashCommandTokenSpan[] {
  const tokens: SlashCommandTokenSpan[] = [];
  let index = offset;
  while (index < input.length) {
    while (index < input.length && /\s/.test(input[index])) {
      index += 1;
    }
    if (index >= input.length) {
      break;
    }

    const start = index;
    let value = "";
    let quote: "'" | "\"" | undefined;
    while (index < input.length) {
      const character = input[index];
      if (quote) {
        if (character === quote) {
          quote = undefined;
          index += 1;
          continue;
        }
        if (character === "\\" && index + 1 < input.length) {
          const next = input[index + 1];
          if (shouldUnescapeInQuote(next, quote)) {
            value += next;
            index += 2;
            continue;
          }
        }
        value += character;
        index += 1;
        continue;
      }

      if (/\s/.test(character)) {
        break;
      }
      if (character === "\"" || character === "'") {
        quote = character;
        index += 1;
        continue;
      }
      if (character === "\\" && index + 1 < input.length) {
        const next = input[index + 1];
        if (shouldUnescapeOutsideQuote(next)) {
          value += next;
          index += 2;
          continue;
        }
      }
      value += character;
      index += 1;
    }

    if (quote) {
      throw new Error(`Unclosed ${quote === "\"" ? "double" : "single"} quote in slash command.`);
    }
    tokens.push({ value, start, end: index });
  }
  return tokens;
}

function shouldUnescapeInQuote(character: string, quote: "'" | "\""): boolean {
  return character === quote || character === "\\";
}

function shouldUnescapeOutsideQuote(character: string): boolean {
  return /\s/.test(character) || character === "\"" || character === "'" || character === "\\";
}

function commonPrefix(values: string[]): string {
  if (values.length === 0) {
    return "";
  }
  let prefix = values[0];
  for (const value of values.slice(1)) {
    while (prefix && !value.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix;
}

export function commandOutputPreview(detail: string | undefined, maxLines: number, maxChars: number): string | undefined {
  if (!detail) {
    return undefined;
  }
  const trimmed = detail.trim();
  if (!trimmed) {
    return undefined;
  }
  const lines = trimmed.split(/\r?\n/);
  const clippedLines = lines.slice(0, maxLines);
  let preview = clippedLines.join("\n");
  if (preview.length > maxChars) {
    preview = `${preview.slice(0, Math.max(0, maxChars - 18)).trimEnd()}\n... [truncated]`;
  } else if (lines.length > clippedLines.length) {
    preview = `${preview}\n... [${lines.length - clippedLines.length} lines truncated]`;
  }
  return preview;
}

export function indentPreview(value: string, prefix: string): string {
  return value.split(/\r?\n/).map((line) => `${prefix}${line}`).join("\n");
}

export function formatToolOutputPreview(result: CommandOutputPreviewRecord): string {
  const preview = commandOutputPreview(result.content, 6, 700);
  return [
    `${result.task_id}${result.attempt ? `#${result.attempt}` : ""} ${result.action} [${result.status ?? "unknown"}]: ${result.summary}`,
    result.recoverySuggestion ? `Recovery: ${result.recoverySuggestion}` : undefined,
    result.outputRef ? `Full output: ${result.outputRef}` : undefined,
    preview ? indentPreview(preview, "  ") : undefined
  ].filter(Boolean).join("\n");
}
