export type CommandSemanticResult = {
  isError: boolean;
  message?: string;
};

type CommandSemantic = (exitCode: number) => CommandSemanticResult;

const DEFAULT_SEMANTIC: CommandSemantic = (exitCode) => ({
  isError: exitCode !== 0,
  message: exitCode !== 0 ? `Command failed with exit code ${exitCode}` : undefined
});

const GREP_SEMANTIC: CommandSemantic = (exitCode) => ({
  isError: exitCode >= 2,
  message: exitCode === 1 ? "No matches found" : undefined
});

const POSIX_COMMAND_SEMANTICS = new Map<string, CommandSemantic>([
  ["grep", GREP_SEMANTIC],
  ["rg", GREP_SEMANTIC],
  ["find", (exitCode) => ({
    isError: exitCode >= 2,
    message: exitCode === 1 ? "Some directories were inaccessible" : undefined
  })],
  ["diff", (exitCode) => ({
    isError: exitCode >= 2,
    message: exitCode === 1 ? "Files differ" : undefined
  })],
  ["test", (exitCode) => ({
    isError: exitCode >= 2,
    message: exitCode === 1 ? "Condition is false" : undefined
  })],
  ["[", (exitCode) => ({
    isError: exitCode >= 2,
    message: exitCode === 1 ? "Condition is false" : undefined
  })]
]);

const POWERSHELL_COMMAND_SEMANTICS = new Map<string, CommandSemantic>([
  ["grep", GREP_SEMANTIC],
  ["rg", GREP_SEMANTIC],
  ["findstr", GREP_SEMANTIC],
  ["robocopy", (exitCode) => ({
    isError: exitCode >= 8,
    message: exitCode === 0
      ? "No files copied (already in sync)"
      : exitCode >= 1 && exitCode < 8
        ? exitCode & 1
          ? "Files copied successfully"
          : "Robocopy completed (no errors)"
        : undefined
  })]
]);

export function isDestructiveCommand(command: string): boolean {
  return commandRiskScanCandidates(command).some((candidate) => isDestructiveCommandCandidate(candidate));
}

export function isReadOnlyShellCommand(command: string): boolean {
  return isReadOnlySegmentedCommand(command, isReadOnlyShellSegment);
}

export function isReadOnlyPowerShellCommand(command: string): boolean {
  return isReadOnlySegmentedCommand(command, isReadOnlyPowerShellSegment);
}

export function interpretCommandResult(
  shellKind: "shell" | "powershell",
  command: string,
  exitCode: number
): CommandSemanticResult {
  const commandName = shellKind === "powershell"
    ? extractPowerShellBaseCommand(command)
    : extractPosixBaseCommand(command);
  const semantics = shellKind === "powershell" ? POWERSHELL_COMMAND_SEMANTICS : POSIX_COMMAND_SEMANTICS;
  return (semantics.get(commandName) ?? DEFAULT_SEMANTIC)(exitCode);
}

function isReadOnlySegmentedCommand(command: string, isReadOnlySegment: (segment: string) => boolean): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }
  if (/[<>]/.test(trimmed) || /(?:^|\s)-(?:encodedcommand|ec)\b/i.test(trimmed) || /\b(?:invoke-expression|iex)\b/i.test(trimmed)) {
    return false;
  }
  const segments = splitCommandSegments(trimmed);
  return segments.length > 0 && segments.every(isReadOnlySegment);
}

function isReadOnlyShellSegment(segment: string): boolean {
  const normalized = stripLeadingCommandDecorators(segment);
  const command = extractTokenCommand(normalized);
  if (!command) {
    return false;
  }
  const allowed = new Set([
    "awk",
    "cat",
    "cut",
    "diff",
    "du",
    "echo",
    "find",
    "git",
    "grep",
    "head",
    "ls",
    "pwd",
    "rg",
    "sed",
    "sort",
    "stat",
    "tail",
    "test",
    "tr",
    "wc",
    "which"
  ]);
  if (!allowed.has(command)) {
    return false;
  }
  if (command === "git") {
    return isReadOnlyGitCommand(normalized);
  }
  if (command === "sed" && /(?:^|\s)-i(?:\b|['"]|$)/i.test(normalized)) {
    return false;
  }
  return !/(?:^|\s)(?:--in-place|-o|--output|-exec|-delete)\b/i.test(normalized);
}

function isReadOnlyGitCommand(command: string): boolean {
  const tokens = tokenizeCommand(command);
  const subcommand = tokens[1]?.toLowerCase();
  if (!subcommand) {
    return false;
  }
  if (["status", "diff", "log", "show", "rev-parse", "ls-files"].includes(subcommand)) {
    return true;
  }
  if (subcommand !== "branch") {
    return false;
  }
  const branchArgs = tokens.slice(2);
  return branchArgs.length === 0 || branchArgs.every((arg) => arg === "--list" || arg === "-l");
}

function isReadOnlyPowerShellSegment(segment: string): boolean {
  const normalized = stripLeadingCommandDecorators(segment);
  const command = extractTokenCommand(normalized);
  if (!command) {
    return false;
  }
  const allowed = new Set([
    "%",
    "?",
    "compare-object",
    "convertfrom-json",
    "convertto-json",
    "findstr",
    "format-list",
    "format-table",
    "get-childitem",
    "get-content",
    "get-date",
    "get-item",
    "get-location",
    "get-process",
    "get-service",
    "measure-object",
    "rg",
    "select-object",
    "select-string",
    "sort-object",
    "test-path",
    "where-object",
    "write-output"
  ]);
  if (!allowed.has(command)) {
    return false;
  }
  return !/(?:^|\s)(?:-outfile|-filepath|-append|-force|-confirm|-whatif)\b/i.test(normalized);
}

function isDestructiveCommandCandidate(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }
  return [
    /(?:^|[;&|]\s*)(?:sudo\s+)?rm\b/i,
    /(?:^|[;&|]\s*)(?:sudo\s+)?unlink\b/i,
    /(?:^|[;&|]\s*)(?:del|erase|rmdir|rd)\b/i,
    /(?:^|[;&|]\s*)remove-item\b/i,
    /(?:^|[;&|]\s*)(?:invoke-expression|iex)\b/i,
    /(?:^|\s)-(?:encodedcommand|ec)\b/i,
    /\b(?:invoke-webrequest|iwr|invoke-restmethod|irm)\b[\s\S]*(?:\|\s*(?:invoke-expression|iex)\b|[;&]\s*(?:invoke-expression|iex)\b)/i,
    /(?:^|[;&|]\s*)(?:set-content|add-content|out-file|new-item|set-item|remove-item)\b[\s\S]*(?:\$profile|microsoft\.powershell_profile\.ps1)/i,
    /(?:^|[;&|]\s*)(?:set-itemproperty|new-itemproperty|remove-itemproperty|new-service|set-service|stop-service|remove-service)\b/i,
    /(?:^|[;&|]\s*)format(?:\.com)?(?:\s|$)/i,
    /(?:^|[;&|]\s*)diskpart\b/i,
    /(?:^|[;&|]\s*)git\s+reset\s+--hard\b/i
  ].some((pattern) => pattern.test(trimmed));
}

function commandRiskScanCandidates(command: string): string[] {
  const pending = [command];
  const seen = new Set<string>();
  const candidates: string[] = [];
  while (pending.length > 0) {
    const raw = pending.pop();
    if (!raw) {
      continue;
    }
    const current = stripOuterQuotes(raw.trim());
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);
    candidates.push(current);
    const withoutSudo = unwrapLeadingSudo(current);
    if (withoutSudo) {
      pending.push(withoutSudo);
    }
    const unwrapped = unwrapShellLauncher(current);
    if (unwrapped) {
      pending.push(unwrapped);
    }
  }
  return candidates;
}

function unwrapLeadingSudo(command: string): string | undefined {
  const tokens = tokenizeCommand(command);
  if (normalizeCommandToken(tokens[0]) !== "sudo" || tokens.length < 2) {
    return undefined;
  }
  return joinCommandTokens(tokens.slice(1));
}

function unwrapShellLauncher(command: string): string | undefined {
  const tokens = tokenizeCommand(command);
  if (tokens.length < 2) {
    return undefined;
  }
  const executable = normalizeCommandToken(tokens[0]);
  if (executable === "cmd" || executable === "cmd.exe") {
    return ["/c", "/k"].includes(normalizeCommandToken(tokens[1]))
      ? joinCommandTokens(tokens.slice(2))
      : undefined;
  }
  if (executable === "powershell" || executable === "powershell.exe" || executable === "pwsh" || executable === "pwsh.exe") {
    for (let index = 1; index < tokens.length; index += 1) {
      const option = normalizeCommandToken(tokens[index]);
      if (option === "-encodedcommand" || option === "-ec") {
        return undefined;
      }
      if (option === "-command" || option === "-c") {
        return joinCommandTokens(tokens.slice(index + 1));
      }
    }
    return undefined;
  }
  if (["bash", "sh", "zsh", "fish"].includes(executable)) {
    return /^-\w*c\w*$/i.test(tokens[1])
      ? joinCommandTokens(tokens.slice(2))
      : undefined;
  }
  if (executable === "wsl" || executable === "wsl.exe") {
    return unwrapWslLauncher(tokens);
  }
  return undefined;
}

function unwrapWslLauncher(tokens: string[]): string | undefined {
  for (let index = 1; index < tokens.length; index += 1) {
    const option = normalizeCommandToken(tokens[index]);
    if (option === "--" || option === "-e" || option === "--exec") {
      return joinCommandTokens(tokens.slice(index + 1));
    }
    if (option === "-d" || option === "--distribution" || option === "-u" || option === "--user" || option === "--cd" || option === "--shell-type") {
      index += 1;
      continue;
    }
    if (/^--(?:distribution|user|cd|shell-type)=/i.test(tokens[index])) {
      continue;
    }
    if (option.startsWith("-")) {
      continue;
    }
    return joinCommandTokens(tokens.slice(index));
  }
  return undefined;
}

function extractPosixBaseCommand(command: string): string {
  const segments = splitCommandSegments(command);
  const last = segments[segments.length - 1] ?? command;
  return extractTokenCommand(last);
}

function extractPowerShellBaseCommand(command: string): string {
  const segments = splitCommandSegments(command);
  const last = segments[segments.length - 1] ?? command;
  return extractTokenCommand(stripLeadingCommandDecorators(last));
}

function extractTokenCommand(segment: string): string {
  const token = tokenizeCommand(stripLeadingCommandDecorators(segment))[0] ?? "";
  const basename = stripOuterQuotes(token).split(/[\\/]/).pop() ?? token;
  return basename.toLowerCase().replace(/\.exe$/, "");
}

function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  for (const character of command.trim()) {
    if (quote) {
      current += character;
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      current += character;
      continue;
    }
    if (character === ";" || character === "|") {
      if (current.trim()) {
        segments.push(current.trim());
      }
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) {
    segments.push(current.trim());
  }
  return segments;
}

function stripLeadingCommandDecorators(segment: string): string {
  return segment.trim().replace(/^(?:&|\.)\s+/, "");
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  for (const character of command.trim()) {
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function joinCommandTokens(tokens: string[]): string | undefined {
  const joined = stripOuterQuotes(tokens.join(" ").trim());
  return joined || undefined;
}

function stripOuterQuotes(value: string): string {
  let current = value.trim();
  while (current.length >= 2 && ((current.startsWith("\"") && current.endsWith("\"")) || (current.startsWith("'") && current.endsWith("'")))) {
    current = current.slice(1, -1).trim();
  }
  return current;
}

function normalizeCommandToken(token: string | undefined): string {
  return stripOuterQuotes(token ?? "").toLowerCase();
}
