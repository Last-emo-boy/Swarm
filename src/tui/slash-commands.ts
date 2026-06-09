export type SlashCommandGroup = "Core" | "Tools" | "Kernel" | "Agents" | "Automation" | "Symphony" | "Config";

export type SlashCommandSpec = {
  name: string;
  group: SlashCommandGroup;
  usage: string;
  description: string;
  aliases?: string[];
  completionPriority?: number;
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

const slashCommandGroups: SlashCommandGroup[] = ["Core", "Tools", "Kernel", "Agents", "Automation", "Config"];

export const slashCommands: SlashCommandSpec[] = [
  { name: "help", group: "Core", usage: "/help", description: "Show grouped slash command help.", completionPriority: 90 },
  { name: "doctor", group: "Core", usage: "/doctor [workspace]", description: "Check setup, permissions, saved work, and automation readiness.", completionPriority: 20 },
  { name: "mode", group: "Core", usage: "/mode [auto|fast|swarm|chat]", description: "Show or change the execution route mode.", completionPriority: 40 },
  { name: "review", group: "Core", usage: "/review [focus]", description: "Run a result-first Codebase Deep Review for a focused area.", aliases: ["rev"], completionPriority: 42 },
  { name: "density", group: "Core", usage: "/density [auto|compact|default|comfortable]", description: "Tune TUI information density without changing focus behavior.", completionPriority: 43 },
  { name: "view", group: "Core", usage: "/view [chat|plan|activity|output|sessions|workers|trace|board]", description: "Switch the TUI surface without exposing pane controls by default.", completionPriority: 45 },
  { name: "plan", group: "Core", usage: "/plan [objective]", description: "Enter planning mode or show the current implementation plan.", completionPriority: 47 },
  { name: "approve", group: "Core", usage: "/approve [approval] [message]", description: "Approve the current plan or one pending approval.", completionPriority: 48 },
  { name: "why", group: "Core", usage: "/why", description: "Explain recent route, delegation, review, and verification decisions." },
  { name: "work", group: "Core", usage: "/work <board|sessions|attempts|output|files|checks|workers>", description: "Review work details without opening Debug." },
  { name: "debug", group: "Core", usage: "/debug <latest|timeline|trace|blackboard|audit|usage|cache|events>", description: "Open advanced runtime diagnostics." },
  { name: "ext", group: "Core", usage: "/ext <capabilities|skills|plugins|mcp>", description: "Inspect extension capabilities, skills, plugins, or MCP." },
  { name: "self-review", group: "Core", usage: "/self-review", description: "Inspect recent local Swarm failures and recommendations." },
  { name: "improve-self", group: "Core", usage: "/improve-self", description: "Ask Swarm to improve its own implementation." },
  { name: "evals", group: "Core", usage: "/evals [--release-gate|--cache-lab|--tui-replay]", description: "Run local product regression evals, cache lab, TUI replay, or the offline parity release gate." },
  { name: "prd", group: "Core", usage: "/prd", description: "Show the local PRD." },
  { name: "reply", group: "Core", usage: "/reply <message>", description: "Guide the active team while it is running." },
  { name: "interrupt", group: "Core", usage: "/interrupt <message>", description: "Pause or redirect active work at the next safe boundary." },
  { name: "onboard", group: "Core", usage: "/onboard", description: "Open provider/model onboarding.", completionPriority: 85 },
  { name: "read", group: "Tools", usage: "/read <path> [start:end]", description: "Read a file from the workspace.", completionPriority: 80 },
  { name: "grep", group: "Tools", usage: "/grep <pattern> [root]", description: "Search workspace text.", completionPriority: 90 },
  { name: "glob", group: "Tools", usage: "/glob <pattern> [root]", description: "Find files by glob." },
  { name: "shell", group: "Tools", usage: "/shell <command>", description: "Run a shell command with policy approval when required.", completionPriority: 100 },
  { name: "web", group: "Tools", usage: "/web <query> [allow:domain] [block:domain]", description: "Search the web through the configured provider/search path." },
  { name: "diff", group: "Tools", usage: "/diff", description: "Review current changes." },
  { name: "output", group: "Tools", usage: "/output [task]", description: "Review recent output or the full output for one task.", completionPriority: 50 },
  { name: "kernel", group: "Kernel", usage: "/kernel [workspace]", description: "Review the full local status view.", aliases: ["status"], completionPriority: 30 },
  { name: "status", group: "Kernel", usage: "/status", description: "Alias for the full local status view.", aliases: ["kernel"], completionPriority: 80 },
  { name: "changes", group: "Kernel", usage: "/changes [saved_work]", description: "Review workspace changes." },
  { name: "blackboard", group: "Kernel", usage: "/blackboard [saved_work] [tag:<tag>|type:<type>|key:<prefix>|agent:<id>|task:<id>]", description: "Query shared facts." },
  { name: "session", group: "Kernel", usage: "/session [saved_work|new]", description: "Review saved work or start a fresh chat state.", completionPriority: 60 },
  { name: "memory", group: "Kernel", usage: "/memory [saved_work]", description: "Review what Swarm remembers before continuing.", completionPriority: 65 },
  { name: "resume", group: "Kernel", usage: "/resume [saved_work] [note]", description: "Continue earlier work with a quick freshness check.", aliases: ["continue"], completionPriority: 70 },
  { name: "continue", group: "Kernel", usage: "/continue [note]", description: "Continue the most recent work with a quick freshness check.", aliases: ["resume"], completionPriority: 75 },
  { name: "checkpoint", group: "Kernel", usage: "/checkpoint <list|create|revert> [name|id]", description: "Review, create, or undo local checkpoints." },
  { name: "revert", group: "Kernel", usage: "/revert last|<checkpoint>", description: "Undo to the latest or named checkpoint." },
  { name: "replay", group: "Kernel", usage: "/replay <saved_work>", description: "Replay saved work detail." },
  { name: "fork", group: "Kernel", usage: "/fork <saved_work> [message]", description: "Start from earlier work." },
  { name: "trace", group: "Kernel", usage: "/trace <saved_work>", description: "Review saved event detail for earlier work." },
  { name: "span", group: "Kernel", usage: "/span <trace|span>", description: "Find saved detail by trace or span." },
  { name: "attempts", group: "Kernel", usage: "/attempts [saved_work]", description: "Review recent attempts and recovery notes.", completionPriority: 55 },
  { name: "leases", group: "Kernel", usage: "/leases [saved_work|lease]", description: "Inspect workspace leases and write boundaries." },
  { name: "tasks", group: "Kernel", usage: "/tasks [saved_work]", description: "Review planned work items." },
  { name: "graph", group: "Kernel", usage: "/graph [saved_work]", description: "Review work dependencies." },
  { name: "task", group: "Kernel", usage: "/task <task> [saved_work]", description: "Review one work item." },
  { name: "approvals", group: "Kernel", usage: "/approvals [saved_work]", description: "List approval records." },
  { name: "approval", group: "Kernel", usage: "/approval <approval>", description: "Inspect one approval.", completionPriority: 60 },
  { name: "audit", group: "Kernel", usage: "/audit [saved_work]", description: "List audit records." },
  { name: "budget", group: "Kernel", usage: "/budget [saved_work]", description: "Inspect policy budget and usage." },
  { name: "usage", group: "Kernel", usage: "/usage [saved_work]", description: "Inspect usage counters." },
  { name: "swarm", group: "Agents", usage: "/swarm [summary|ownership|mailbox <agent>|agent <agent>]", description: "Show Swarm participants, workspace claims, mailbox, and conflicts.", completionPriority: 35 },
  { name: "ownership", group: "Agents", usage: "/ownership", description: "Inspect task, handoff, and board workspace claims." },
  { name: "mailbox", group: "Agents", usage: "/mailbox <agent>", description: "Inspect one agent mailbox." },
  { name: "agents", group: "Agents", usage: "/agents", description: "List available local agent specs." },
  { name: "agent", group: "Agents", usage: "/agent <agent>", description: "Inspect one agent." },
  { name: "workers", group: "Agents", usage: "/workers", description: "Review team activity." },
  { name: "worker", group: "Agents", usage: "/worker <member>", description: "Review one team member." },
  { name: "stop-worker", group: "Agents", usage: "/stop-worker <member>", description: "Request a worker stop." },
  { name: "continue-agent", group: "Agents", usage: "/continue-agent <member> <message>", description: "Continue an existing worker." },
  { name: "handoffs", group: "Agents", usage: "/handoffs", description: "List handoff sessions." },
  { name: "handoff", group: "Agents", usage: "/handoff <handoff>", description: "Inspect one handoff." },
  { name: "takeback", group: "Agents", usage: "/takeback <handoff>", description: "Take back an active handoff." },
  { name: "work-items", group: "Automation", usage: "/work-items [workspace]", description: "Inspect local active and finished automation work items." },
  { name: "symphony", group: "Automation", usage: "/symphony [workspace]", description: "Inspect automation scheduler status." },
  { name: "symphony-tick", group: "Automation", usage: "/symphony-tick [workspace] [--max-turns N]", description: "Dispatch one local automation tick." },
  { name: "symphony-run-once", group: "Automation", usage: "/symphony-run-once [workspace] [--max-turns N]", description: "Dispatch and execute one automation tick." },
  { name: "symphony-daemon", group: "Automation", usage: "/symphony-daemon [daemon]", description: "Inspect TUI-managed automation loops." },
  { name: "symphony-start", group: "Automation", usage: "/symphony-start [workspace] [--execute] [--max-ticks N] [--max-turns N]", description: "Start a local automation polling loop." },
  { name: "symphony-stop", group: "Automation", usage: "/symphony-stop [daemon|all] [--cancel-running]", description: "Stop local automation loops." },
  { name: "symphony-cleanup", group: "Automation", usage: "/symphony-cleanup [workspace] [--execute]", description: "Preview or clean terminal automation workspaces." },
  { name: "provider", group: "Config", usage: "/provider [id]", description: "Show or change the default provider." },
  { name: "model", group: "Config", usage: "/model [planner|worker|aggregator] [provider/model]", description: "Show or update selected models.", completionPriority: 50 },
  { name: "models", group: "Config", usage: "/models [provider]", description: "List configured models." },
  { name: "refresh-models", group: "Config", usage: "/refresh-models [provider]", description: "Refresh provider model discovery." },
  { name: "permissions", group: "Config", usage: "/permissions", description: "Inspect permission mode, sandbox, rules, read roots, and recent approvals." },
  { name: "add-dir", group: "Config", usage: "/add-dir <directory>", description: "Add a persistent read-only directory to tool permissions." },
  { name: "remove-dir", group: "Config", usage: "/remove-dir <directory>", description: "Remove a persistent additional read directory." },
  { name: "permission-mode", group: "Config", usage: "/permission-mode [ask|auto-edit|full-auto|yolo]", description: "Show or change the permission mode." },
  { name: "sandbox", group: "Config", usage: "/sandbox [workspace-write|read-only]", description: "Inspect or change the TUI sandbox mode, scope, and write gates." },
  { name: "capabilities", group: "Config", usage: "/capabilities [kind|provider|query|all]", description: "Review available capabilities." },
  { name: "capability-enable", group: "Config", usage: "/capability-enable <capability>", description: "Remove a capability from the disabled capability list." },
  { name: "capability-disable", group: "Config", usage: "/capability-disable <capability>", description: "Add a capability to the disabled capability list." },
  { name: "capability-show", group: "Config", usage: "/capability-show <capability>", description: "Allow a capability to be visible to the model again." },
  { name: "capability-hide", group: "Config", usage: "/capability-hide <capability>", description: "Hide a capability from the model without disabling user visibility." },
  { name: "plugins", group: "Config", usage: "/plugins [plugin|all]", description: "Review extension plugins." },
  { name: "commands", group: "Config", usage: "/commands [all]", description: "Review custom commands." },
  { name: "plugin-install", group: "Config", usage: "/plugin-install <path>", description: "Add a local plugin root." },
  { name: "plugin-update", group: "Config", usage: "/plugin-update", description: "Refresh plugins." },
  { name: "plugin-remove-root", group: "Config", usage: "/plugin-remove-root <path>", description: "Remove a local plugin root." },
  { name: "plugin-enable", group: "Config", usage: "/plugin-enable <plugin>", description: "Remove a plugin from the disabled plugin list." },
  { name: "plugin-disable", group: "Config", usage: "/plugin-disable <plugin>", description: "Add a plugin to the disabled plugin list." },
  { name: "skills", group: "Config", usage: "/skills [all]", description: "Review available skills." },
  { name: "skill", group: "Config", usage: "/skill <name>", description: "Activate one trusted skill for the current session." },
  { name: "mcp", group: "Config", usage: "/mcp [server|all]", description: "Review MCP servers." },
  { name: "mcp-refresh", group: "Config", usage: "/mcp-refresh <server>", description: "Refresh one MCP server." },
  { name: "mcp-resources", group: "Config", usage: "/mcp-resources <server>", description: "List exposed MCP resources for one server." },
  { name: "mcp-read", group: "Config", usage: "/mcp-read <server> <uri>", description: "Read one MCP resource." },
  { name: "mcp-prompts", group: "Config", usage: "/mcp-prompts <server>", description: "List exposed MCP prompts for one server." },
  { name: "mcp-prompt", group: "Config", usage: "/mcp-prompt <server> <name> [key=value...]", description: "Render one MCP prompt." }
];

const BASIC_SLASH_COMMAND_NAMES = new Set([
  "help",
  "review",
  "plan",
  "approve",
  "onboard",
  "continue"
]);

const SLASH_HELP_NAMESPACES: Record<string, { title: string; names: string[] }> = {
  main: {
    title: "Main commands",
    names: [...BASIC_SLASH_COMMAND_NAMES]
  },
  work: {
    title: "Work commands",
    names: ["work", "session", "attempts", "output", "changes", "tasks", "graph", "task", "workers", "worker", "checkpoint", "revert"]
  },
  swarm: {
    title: "Swarm commands",
    names: ["swarm", "agent", "mailbox", "ownership", "agents", "workers", "worker", "handoffs", "handoff", "takeback"]
  },
  debug: {
    title: "Debug commands",
    names: ["debug", "trace", "blackboard", "audit", "usage", "budget", "approvals", "approval", "leases", "span"]
  },
  ext: {
    title: "Extension commands",
    names: ["ext", "capabilities", "commands", "skills", "skill", "plugins", "mcp", "mcp-refresh", "mcp-resources", "mcp-read", "mcp-prompts", "mcp-prompt"]
  },
  symphony: {
    title: "Automation commands",
    names: ["symphony", "symphony-tick", "symphony-run-once", "symphony-start", "symphony-stop", "symphony-cleanup", "symphony-daemon", "work-items"]
  }
};

const SLASH_NAMESPACE_SUBCOMMANDS: Record<string, SlashCommandSpec[]> = {
  work: [
    { name: "board", group: "Kernel", usage: "/work board [saved_work] [active|blocked|failed|resumable|changed-files|checks]", description: "Review the work board.", completionPriority: 5 },
    { name: "sessions", group: "Kernel", usage: "/work sessions", description: "Review recent work.", completionPriority: 10 },
    { name: "attempts", group: "Kernel", usage: "/work attempts", description: "Review recent attempts.", completionPriority: 20 },
    { name: "output", group: "Tools", usage: "/work output", description: "Review recent output.", completionPriority: 30 },
    { name: "files", group: "Kernel", usage: "/work files", description: "Review changed files.", completionPriority: 40 },
    { name: "checks", group: "Kernel", usage: "/work checks", description: "Review verification results.", completionPriority: 50 },
    { name: "workers", group: "Agents", usage: "/work workers", description: "Review team activity.", completionPriority: 60 }
  ],
  debug: [
    { name: "trace", group: "Kernel", usage: "/debug trace", description: "Review saved event detail.", completionPriority: 10 },
    { name: "blackboard", group: "Kernel", usage: "/debug blackboard", description: "Query shared facts.", completionPriority: 20 },
    { name: "audit", group: "Kernel", usage: "/debug audit", description: "List audit records.", completionPriority: 30 },
    { name: "usage", group: "Kernel", usage: "/debug usage", description: "Inspect usage counters.", completionPriority: 40 },
    { name: "cache", group: "Kernel", usage: "/debug cache", description: "Inspect prompt cache status.", completionPriority: 50 },
    { name: "timeline", group: "Kernel", usage: "/debug timeline [actor:<id>|task:<id>|correlation:<id>|category:<kind>]", description: "Review detailed activity by actor, task, or category.", completionPriority: 15 },
    { name: "events", group: "Kernel", usage: "/debug events", description: "Show recent runtime events.", completionPriority: 60 },
    { name: "latest", group: "Kernel", usage: "/debug latest", description: "Review the latest issue and supporting detail.", completionPriority: 5 }
  ],
  ext: [
    { name: "capabilities", group: "Config", usage: "/ext capabilities", description: "Summarize capabilities.", completionPriority: 10 },
    { name: "commands", group: "Config", usage: "/ext commands", description: "Summarize custom commands.", completionPriority: 20 },
    { name: "skills", group: "Config", usage: "/ext skills", description: "Summarize skills.", completionPriority: 30 },
    { name: "plugins", group: "Config", usage: "/ext plugins", description: "Summarize plugins.", completionPriority: 40 },
    { name: "mcp", group: "Config", usage: "/ext mcp", description: "Summarize MCP servers.", completionPriority: 50 }
  ],
  symphony: [
    { name: "status", group: "Automation", usage: "/symphony status", description: "Show automation status.", completionPriority: 10 },
    { name: "tick", group: "Automation", usage: "/symphony tick", description: "Dispatch one scheduler tick.", completionPriority: 20 },
    { name: "run-once", group: "Automation", usage: "/symphony run-once", description: "Dispatch and execute one tick.", completionPriority: 30 },
    { name: "start", group: "Automation", usage: "/symphony start", description: "Start TUI-managed polling.", completionPriority: 40 },
    { name: "stop", group: "Automation", usage: "/symphony stop", description: "Stop polling.", completionPriority: 50 },
    { name: "cleanup", group: "Automation", usage: "/symphony cleanup", description: "Clean terminal automation workspaces.", completionPriority: 60 }
  ]
};

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

export function renderSlashHelp(options: { includeAdvanced?: boolean; namespace?: string } = {}): string {
  const includeAdvanced = options.includeAdvanced ?? false;
  const namespace = options.namespace?.toLowerCase();
  if (!includeAdvanced && (!namespace || namespace === "main")) {
    return renderMainSlashHelp();
  }
  if (namespace && SLASH_HELP_NAMESPACES[namespace]) {
    const help = SLASH_HELP_NAMESPACES[namespace];
    const commands = help.names
      .map((name) => slashCommands.find((command) => command.name === name))
      .filter((command): command is SlashCommandSpec => command !== undefined);
    const subcommands = SLASH_NAMESPACE_SUBCOMMANDS[namespace] ?? [];
    return [
      help.title,
      ...commands.map((command) => `  ${command.usage} - ${command.description}`),
      ...subcommands.map((command) => `  ${command.usage} - ${command.description}`)
    ].join("\n");
  }
  return slashCommandGroups
    .map((group) => {
      const commands = slashCommands.filter((command) =>
        command.group === group && (includeAdvanced || BASIC_SLASH_COMMAND_NAMES.has(command.name))
      );
      if (!commands.length) {
        return "";
      }
      return [
        slashCommandGroupLabel(group),
        ...commands.map((command) => `  ${command.usage} - ${command.description}`)
      ].join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

function slashCommandGroupLabel(group: SlashCommandGroup): string {
  return group === "Kernel" ? "Work" : group === "Symphony" ? "Automation" : group;
}

function renderMainSlashHelp(): string {
  return [
    "Start",
    "  /review [area] - Review code and risks.",
    "  /plan [task] - Plan the next change.",
    "  /approve [id] - Approve pending work.",
    "  /continue [note] - Continue latest work.",
    "  /onboard - Set up model access.",
    "",
    "More: /help all."
  ].join("\n");
}

export function commandCandidatesForInput(
  value: string,
  cursor: number,
  options: { includeAdvanced?: boolean; extraCommands?: SlashCommandSpec[] } = {}
): SlashCommandSpec[] {
  const token = slashCommandToken(value, cursor);
  if (!token) {
    return [];
  }
  const query = token.name.toLowerCase();
  if (token.namespace) {
    const commands = SLASH_NAMESPACE_SUBCOMMANDS[token.namespace] ?? [];
    return commands
      .map((command) => ({ command, score: slashCommandScore(command, query) }))
      .filter((item) => item.score < 100)
      .sort((a, b) => a.score - b.score || a.command.name.localeCompare(b.command.name))
      .map((item) => item.command);
  }
  const baseCommands = options.includeAdvanced
    ? slashCommands
    : slashCommands.filter((command) => BASIC_SLASH_COMMAND_NAMES.has(command.name));
  const commands = mergeSlashCommands(baseCommands, options.extraCommands ?? []);
  return commands
    .map((command) => ({ command, score: slashCommandScore(command, query) }))
    .filter((item) => item.score < 100)
    .sort((a, b) => a.score - b.score || a.command.name.localeCompare(b.command.name))
    .map((item) => item.command);
}

export function completeSlashCommand(
  value: string,
  cursor: number,
  options: { includeAdvanced?: boolean; extraCommands?: SlashCommandSpec[] } = {}
): { value: string; cursor: number } | undefined {
  const token = slashCommandToken(value, cursor);
  if (!token) {
    return undefined;
  }
  const matches = commandCandidatesForInput(value, cursor, options);
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
  const replacement = token.namespace
    ? `${completion}${bestMatches.length === 1 ? " " : ""}`
    : `/${completion}${bestMatches.length === 1 ? " " : ""}`;
  const next = value.slice(0, token.start) + replacement + value.slice(token.end);
  return { value: next, cursor: token.start + replacement.length };
}

function mergeSlashCommands(primary: SlashCommandSpec[], extra: SlashCommandSpec[]): SlashCommandSpec[] {
  const commands: SlashCommandSpec[] = [];
  const seen = new Set<string>();
  for (const command of [...primary, ...extra]) {
    const name = command.name.trim();
    if (!name) {
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    commands.push(command);
  }
  return commands;
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
  const replacement = token.namespace ? `${candidate.name} ` : `/${candidate.name} `;
  const next = value.slice(0, token.start) + replacement + value.slice(token.end).replace(/^\s*/, "");
  return { value: next, cursor: token.start + replacement.length };
}

export function slashCommandCompletionKey(value: string, cursor: number): string | undefined {
  const token = slashCommandToken(value, cursor);
  if (!token) {
    return undefined;
  }
  return token.namespace
    ? `${token.namespace}:${value.slice(token.start, token.end)}`
    : value.slice(token.start, token.end);
}

function slashCommandToken(value: string, cursor: number): { start: number; end: number; name: string; namespace?: string } | undefined {
  const safeCursor = Math.max(0, Math.min(value.length, cursor));
  const namespaceToken = slashNamespaceToken(value, safeCursor);
  if (namespaceToken) {
    return namespaceToken;
  }
  const slashStart = slashCommandStart(value, safeCursor);
  if (slashStart === undefined) {
    return undefined;
  }
  let commandEnd = slashStart;
  while (commandEnd < value.length && !/\s/.test(value[commandEnd])) {
    commandEnd += 1;
  }
  if (safeCursor > commandEnd) {
    const namespace = value.slice(slashStart + 1, commandEnd).toLowerCase();
    if (!SLASH_NAMESPACE_SUBCOMMANDS[namespace]) {
      return undefined;
    }
    let start = commandEnd;
    while (start < value.length && /\s/.test(value[start])) {
      start += 1;
    }
    let subEnd = start;
    while (subEnd < value.length && !/\s/.test(value[subEnd])) {
      subEnd += 1;
    }
    if (safeCursor < start || safeCursor > subEnd) {
      return undefined;
    }
    return { start, end: subEnd, name: value.slice(start, subEnd), namespace };
  }
  return { start: slashStart, end: commandEnd, name: value.slice(slashStart + 1, commandEnd) };
}

function slashNamespaceToken(value: string, cursor: number): { start: number; end: number; name: string; namespace: string } | undefined {
  const prefix = value.slice(0, cursor);
  const match = /(?:^|\s)\/([^\s]+)\s+([^\s]*)$/.exec(prefix);
  if (!match) {
    return undefined;
  }
  const namespace = match[1]?.toLowerCase();
  if (!namespace || !SLASH_NAMESPACE_SUBCOMMANDS[namespace]) {
    return undefined;
  }
  const name = match[2] ?? "";
  const start = cursor - name.length;
  return { start, end: cursor, name, namespace };
}

function slashCommandStart(value: string, cursor: number): number | undefined {
  let start = Math.max(0, Math.min(value.length, cursor));
  while (start > 0 && !/\s/.test(value[start - 1])) {
    start -= 1;
  }
  return value[start] === "/" ? start : undefined;
}

function slashCommandScore(command: SlashCommandSpec, query: string): number {
  if (!query) {
    return command.completionPriority ?? (command.group === "Core" ? 200 : command.group === "Kernel" ? 300 : 400);
  }
  const name = command.name.toLowerCase();
  const aliases = (command.aliases ?? []).map((item) => item.toLowerCase());
  if (name === query) {
    return 0;
  }
  if (aliases.includes(query)) {
    return 2;
  }
  if (name.startsWith(query)) {
    return 5;
  }
  if (aliases.some((item) => item.startsWith(query))) {
    return 8;
  }
  if (name.includes(query)) {
    return 20;
  }
  if (aliases.some((item) => item.includes(query))) {
    return 25;
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
  const preview = commandOutputPreview(result.content, 4, 420);
  return [
    `${result.action} ${result.status ?? "unknown"}: ${result.summary}`,
    result.recoverySuggestion ? `Next: ${result.recoverySuggestion}` : undefined,
    result.outputRef ? `Saved: ${result.outputRef}` : undefined,
    preview ? indentPreview(preview, "  ") : undefined
  ].filter(Boolean).join("\n");
}
