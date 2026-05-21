import { resolve } from "node:path";
import type { LocalToolContext, ToolAction, ToolResult } from "./types.js";

export type ShellCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; maxOutputBytes: number }
) => Promise<ShellCommandResult | undefined>;

export type ShellCommandResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  error?: string;
};

export type GrepMatch = {
  path: string;
  line: number;
  text: string;
  before?: string[];
  after?: string[];
};

export type GrepDisplayPath = (path: string, workspace: string) => string;
export type GrepPathDenied = (path: string, context: LocalToolContext) => boolean;

export const GREP_FALLBACK_MAX_FILES = 2_000;
export const GREP_FALLBACK_MAX_DEPTH = 10;

export async function grepLocalFilesWithRipgrep(input: {
  root: string;
  action: Extract<ToolAction, { type: "file.grep" }>;
  context: LocalToolContext;
  maxMatches: number;
  contextLines: number;
  runCommand: ShellCommandRunner;
  displayPath: GrepDisplayPath;
  isPathDenied: GrepPathDenied;
}): Promise<ToolResult | undefined> {
  const result = await runRipgrep({
    root: input.root,
    pattern: input.action.pattern,
    include: input.action.include,
    maxMatches: input.maxMatches,
    contextLines: input.contextLines,
    workspace: input.context.workspace,
    runCommand: input.runCommand
  });
  if (!result) {
    return undefined;
  }
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    return undefined;
  }
  const matches = parseRipgrepJson({
    stdout: result.stdout,
    context: input.context,
    maxMatches: input.maxMatches,
    displayPath: input.displayPath,
    isPathDenied: input.isPathDenied
  });
  if (matches === undefined) {
    return undefined;
  }
  return {
    action: input.action.type,
    status: "success",
    summary: `found ${matches.length} matches for ${input.action.pattern}`,
    data: matches,
    metadata: {
      root: input.displayPath(input.root, input.context.workspace),
      requestedRoot: input.action.root || ".",
      engine: "ripgrep",
      truncated: result.truncated
    }
  };
}

async function runRipgrep(input: {
  root: string;
  pattern: string;
  include?: string;
  maxMatches: number;
  contextLines: number;
  workspace: string;
  runCommand: ShellCommandRunner;
}): Promise<ShellCommandResult | undefined> {
  const args = [
    "--json",
    "--line-number",
    "--color",
    "never",
    "--max-count",
    String(input.maxMatches),
    ...(input.contextLines > 0 ? ["--context", String(input.contextLines)] : []),
    ...(input.include ? ["--glob", input.include] : []),
    "--",
    input.pattern,
    input.root
  ];
  return input.runCommand("rg", args, {
    cwd: input.workspace,
    timeoutMs: 30_000,
    maxOutputBytes: 1_000_000
  });
}

export function parseRipgrepJson(input: {
  stdout: string;
  context: LocalToolContext;
  maxMatches: number;
  displayPath: GrepDisplayPath;
  isPathDenied: GrepPathDenied;
}): GrepMatch[] | undefined {
  const matches: GrepMatch[] = [];
  let active: GrepMatch | undefined;
  try {
    for (const line of input.stdout.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      const event = JSON.parse(line) as {
        type?: string;
        data?: {
          path?: { text?: string };
          line_number?: number;
          lines?: { text?: string };
        };
      };
      if (event.type === "match") {
        const path = event.data?.path?.text;
        const lineNumber = event.data?.line_number;
        const text = event.data?.lines?.text;
        if (!path || typeof lineNumber !== "number" || typeof text !== "string") {
          continue;
        }
        const absolutePath = resolve(input.context.workspace, path);
        if (input.isPathDenied(absolutePath, input.context)) {
          active = undefined;
          continue;
        }
        active = {
          path: input.displayPath(absolutePath, input.context.workspace),
          line: lineNumber,
          text: stripLineEnding(text)
        };
        matches.push(active);
        if (matches.length >= input.maxMatches) {
          break;
        }
        continue;
      }
      if (event.type === "context" && active) {
        const lineNumber = event.data?.line_number;
        const text = event.data?.lines?.text;
        if (typeof lineNumber !== "number" || typeof text !== "string") {
          continue;
        }
        if (lineNumber < active.line) {
          active.before = [...(active.before ?? []), stripLineEnding(text)];
        } else if (lineNumber > active.line) {
          active.after = [...(active.after ?? []), stripLineEnding(text)];
        }
      }
    }
    return matches;
  } catch {
    return undefined;
  }
}

function stripLineEnding(value: string): string {
  return value.replace(/\r?\n$/, "");
}
