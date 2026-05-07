import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";

export type WorkflowDefinition = {
  path: string;
  config: Record<string, unknown>;
  prompt_template: string;
};

export type WorkflowLoadResult =
  | { ok: true; workflow: WorkflowDefinition }
  | { ok: false; error: WorkflowError };

export type WorkflowError = {
  code:
    | "missing_workflow_file"
    | "workflow_parse_error"
    | "workflow_front_matter_not_a_map"
    | "template_render_error";
  message: string;
  path: string;
};

export type WorkflowRuntimeConfig = {
  work_source: {
    kind?: string;
    path?: string;
    active_states: string[];
    terminal_states: string[];
  };
  polling: {
    interval_ms: number;
  };
  workspace: {
    root: string;
  };
  agent: {
    max_concurrent_agents: number;
    max_retry_backoff_ms: number;
  };
  hooks: {
    after_create?: string;
    before_run?: string;
    after_run?: string;
    before_remove?: string;
    timeout_ms: number;
  };
  cleanup: {
    retention: {
      min_age_ms: number;
      keep_latest: number;
      preserve_artifacts: boolean;
    };
  };
};

const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"];
const DEFAULT_TERMINAL_STATES = ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"];

export function loadWorkflow(path = resolve(process.cwd(), "WORKFLOW.md")): WorkflowLoadResult {
  const fullPath = resolve(path);
  if (!existsSync(fullPath)) {
    return {
      ok: false,
      error: { code: "missing_workflow_file", message: `Workflow file not found: ${fullPath}`, path: fullPath }
    };
  }
  try {
    const raw = readFileSync(fullPath, "utf8");
    const parsed = parseWorkflow(raw);
    return {
      ok: true,
      workflow: {
        path: fullPath,
        config: parsed.config,
        prompt_template: parsed.prompt_template
      }
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error instanceof WorkflowParseError ? error.code : "workflow_parse_error",
        message: error instanceof Error ? error.message : String(error),
        path: fullPath
      }
    };
  }
}

export function normalizeWorkflowConfig(workflow: WorkflowDefinition): WorkflowRuntimeConfig {
  const workSource = sourceConfig(workflow.config);
  const polling = objectValue(workflow.config.polling);
  const workspace = objectValue(workflow.config.workspace);
  const agent = objectValue(workflow.config.agent);
  const hooks = objectValue(workflow.config.hooks);
  const cleanup = objectValue(workflow.config.cleanup);
  const retention = objectValue(cleanup.retention);
  return {
    work_source: {
      kind: stringValue(workSource.kind) ?? "local",
      path: stringValue(workSource.path),
      active_states: stringArrayValue(workSource.active_states) ?? DEFAULT_ACTIVE_STATES,
      terminal_states: stringArrayValue(workSource.terminal_states) ?? DEFAULT_TERMINAL_STATES
    },
    polling: {
      interval_ms: positiveIntValue(polling.interval_ms, 30_000)
    },
    workspace: {
      root: expandPath(stringValue(workspace.root) ?? resolve(tmpdir(), "symphony_workspaces"))
    },
    agent: {
      max_concurrent_agents: positiveIntValue(agent.max_concurrent_agents, 10),
      max_retry_backoff_ms: positiveIntValue(agent.max_retry_backoff_ms, 300_000)
    },
    hooks: {
      after_create: rawStringValue(hooks.after_create),
      before_run: rawStringValue(hooks.before_run),
      after_run: rawStringValue(hooks.after_run),
      before_remove: rawStringValue(hooks.before_remove),
      timeout_ms: positiveIntValue(hooks.timeout_ms, 60_000)
    },
    cleanup: {
      retention: {
        min_age_ms: nonNegativeIntValue(retention.min_age_ms, 0),
        keep_latest: nonNegativeIntValue(retention.keep_latest, 0),
        preserve_artifacts: booleanValue(retention.preserve_artifacts, false)
      }
    }
  };
}

export function renderWorkflowPrompt(input: {
  workflow: WorkflowDefinition;
  issue: Record<string, unknown>;
  attempt?: number | null;
}): string {
  const template = input.workflow.prompt_template.trim() || "You are working on a local Symphony work item.";
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, expression: string) => {
    const path = expression.trim();
    const value = path === "attempt"
      ? input.attempt ?? null
      : getPath({ issue: input.issue, item: input.issue, work_item: input.issue, attempt: input.attempt ?? null }, path);
    if (value === undefined) {
      throw new WorkflowParseError("template_render_error", `Unknown workflow template variable: ${path}`);
    }
    if (value === null) {
      return "";
    }
    if (typeof value === "object") {
      return JSON.stringify(value);
    }
    return String(value);
  });
}

function parseWorkflow(raw: string): { config: Record<string, unknown>; prompt_template: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { config: {}, prompt_template: normalized.trim() };
  }
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) {
    throw new WorkflowParseError("workflow_parse_error", "Unclosed YAML front matter.");
  }
  const frontMatter = normalized.slice(4, end).trim();
  const body = normalized.slice(end + "\n---".length).trim();
  const config = parseSimpleYaml(frontMatter);
  if (!isRecord(config)) {
    throw new WorkflowParseError("workflow_front_matter_not_a_map", "Workflow front matter must be a map.");
  }
  return { config, prompt_template: body };
}

function parseSimpleYaml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; value: Record<string, unknown> }> = [{ indent: -1, value: root }];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) {
      continue;
    }
    const indent = rawLine.match(/^ */)?.[0].length ?? 0;
    const line = rawLine.trim();
    const match = line.match(/^([^:]+):(.*)$/);
    if (!match) {
      throw new WorkflowParseError("workflow_parse_error", `Unsupported front matter line ${index + 1}: ${line}`);
    }
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].value;
    const key = match[1].trim();
    const rest = match[2].trim();
    if (!key) {
      throw new WorkflowParseError("workflow_parse_error", `Empty key on front matter line ${index + 1}.`);
    }
    if (rest === "|" || rest === ">") {
      const block = parseBlockScalar(lines, index + 1, indent, rest);
      parent[key] = block.value;
      index = block.nextIndex - 1;
      continue;
    }
    if (!rest) {
      const next = findNextSignificantLine(lines, index + 1);
      if (next && next.indent > indent && next.line.startsWith("- ")) {
        const list = parseBlockList(lines, index + 1, next.indent);
        parent[key] = list.value;
        index = list.nextIndex - 1;
        continue;
      }
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, value: child });
    } else {
      parent[key] = parseScalarOrInlineList(rest);
    }
  }
  return root;
}

function parseBlockList(lines: string[], startIndex: number, listIndent: number): { value: unknown[]; nextIndex: number } {
  const value: unknown[] = [];
  let index = startIndex;
  for (; index < lines.length; index += 1) {
    const rawLine = lines[index];
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) {
      continue;
    }
    const indent = rawLine.match(/^ */)?.[0].length ?? 0;
    const line = rawLine.trim();
    if (indent !== listIndent || !line.startsWith("- ")) {
      break;
    }
    value.push(parseScalarOrInlineList(line.slice(2).trim()));
  }
  return { value, nextIndex: index };
}

function parseBlockScalar(
  lines: string[],
  startIndex: number,
  parentIndent: number,
  style: "|" | ">"
): { value: string; nextIndex: number } {
  const rawBlock: string[] = [];
  let index = startIndex;
  for (; index < lines.length; index += 1) {
    const rawLine = lines[index];
    if (!rawLine.trim()) {
      rawBlock.push("");
      continue;
    }
    const indent = rawLine.match(/^ */)?.[0].length ?? 0;
    if (indent <= parentIndent) {
      break;
    }
    rawBlock.push(rawLine);
  }
  const stripIndent = rawBlock.reduce<number | undefined>((current, line) => {
    if (!line.trim()) {
      return current;
    }
    const indent = line.match(/^ */)?.[0].length ?? 0;
    return current === undefined ? indent : Math.min(current, indent);
  }, undefined) ?? parentIndent + 2;
  const stripped = rawBlock.map((line) => line.startsWith(" ".repeat(stripIndent)) ? line.slice(stripIndent) : line);
  const literal = stripped.join("\n").replace(/\n+$/, "");
  return {
    value: style === ">" ? literal.replace(/\n+/g, " ").trim() : literal,
    nextIndex: index
  };
}

function findNextSignificantLine(lines: string[], startIndex: number): { indent: number; line: string } | undefined {
  for (let index = startIndex; index < lines.length; index += 1) {
    const rawLine = lines[index];
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) {
      continue;
    }
    return {
      indent: rawLine.match(/^ */)?.[0].length ?? 0,
      line: rawLine.trim()
    };
  }
  return undefined;
}

function parseScalarOrInlineList(value: string): unknown {
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) {
      return [];
    }
    return inner.split(",").map((item) => parseScalar(item.trim()));
  }
  return parseScalar(value);
}

function parseScalar(value: string): unknown {
  const unquoted = stripQuotes(value);
  if (unquoted === "true") return true;
  if (unquoted === "false") return false;
  if (unquoted === "null") return null;
  if (/^-?\d+$/.test(unquoted)) return Number(unquoted);
  return unquoted;
}

function stripQuotes(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function getPath(root: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (!isRecord(value)) {
      return undefined;
    }
    return value[key];
  }, root);
}

function objectValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function sourceConfig(config: Record<string, unknown>): Record<string, unknown> {
  return objectValue(config.work_source);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? expandEnv(value.trim()) : undefined;
}

function rawStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : undefined;
}

function positiveIntValue(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function nonNegativeIntValue(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function expandPath(path: string): string {
  const expanded = expandEnv(path);
  if (expanded === "~") {
    return homedir();
  }
  if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    return resolve(homedir(), expanded.slice(2));
  }
  return resolve(expanded);
}

function expandEnv(value: string): string {
  return value.replace(/\$([A-Z0-9_]+)/gi, (_match, name: string) => process.env[name] ?? "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class WorkflowParseError extends Error {
  constructor(readonly code: WorkflowError["code"], message: string) {
    super(message);
  }
}
