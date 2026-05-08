import type { TaskOutputRef } from "../storage/task-output-store.js";
import { writeTaskOutput } from "../storage/task-output-store.js";
import type { ToolContentReplacementRecord, ToolContentReplacementScopeKind, ToolContentReplacementStore } from "../storage/tool-content-replacement-store.js";

export const TOOL_RESULT_REPLACEMENT_TAG = "<persisted-output>";
export const TOOL_RESULT_CLEARED_MESSAGE = "[Old tool result content cleared]";

export type ToolResultBudgetItem = {
  id: string;
  action: string;
  summary: string;
  status?: string;
  content?: string;
  outputRef?: string;
  data?: unknown;
};

export type ContentReplacementState = {
  scopeKind: ToolContentReplacementScopeKind;
  scopeId: string;
  sessionId: string;
  seenIds: Set<string>;
  replacements: Map<string, PersistedReplacement>;
};

export type PersistedReplacement = {
  content: string;
  originalBytes: number;
  outputRef?: TaskOutputRef | Record<string, unknown>;
};

export type ToolResultBudgetOptions = {
  sessionId: string;
  taskIdPrefix?: string;
  state: ContentReplacementState;
  store?: ToolContentReplacementStore;
  maxFreshBytes?: number;
  maxTotalBytes?: number;
  previewBytes?: number;
};

type ReplacementCandidate = {
  item: ToolResultBudgetItem;
  index: number;
  content: string;
  bytes: number;
};

const DEFAULT_MAX_FRESH_BYTES = 8_000;
const DEFAULT_MAX_TOTAL_BYTES = 24_000;
const DEFAULT_PREVIEW_BYTES = 2_000;

export function createContentReplacementState(input: {
  sessionId: string;
  scopeKind?: ToolContentReplacementScopeKind;
  scopeId?: string;
  records?: ToolContentReplacementRecord[];
}): ContentReplacementState {
  const scopeKind = input.scopeKind ?? "session";
  const scopeId = input.scopeId ?? input.sessionId;
  const state: ContentReplacementState = {
    scopeKind,
    scopeId,
    sessionId: input.sessionId,
    seenIds: new Set(),
    replacements: new Map()
  };
  for (const record of input.records ?? []) {
    state.seenIds.add(record.tool_result_id);
    state.replacements.set(record.tool_result_id, {
      content: record.replacement_content,
      originalBytes: record.original_bytes,
      outputRef: record.output_ref
    });
  }
  return state;
}

export function cloneContentReplacementState(
  state: ContentReplacementState,
  input: { sessionId?: string; scopeKind?: ToolContentReplacementScopeKind; scopeId?: string } = {}
): ContentReplacementState {
  return {
    scopeKind: input.scopeKind ?? state.scopeKind,
    scopeId: input.scopeId ?? state.scopeId,
    sessionId: input.sessionId ?? state.sessionId,
    seenIds: new Set(state.seenIds),
    replacements: new Map([...state.replacements.entries()].map(([key, value]) => [key, { ...value }]))
  };
}

export async function applyToolResultBudget<T extends ToolResultBudgetItem>(
  items: T[],
  options: ToolResultBudgetOptions
): Promise<T[]> {
  if (items.length === 0) {
    return items;
  }
  const maxFreshBytes = options.maxFreshBytes ?? DEFAULT_MAX_FRESH_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const previewBytes = options.previewBytes ?? DEFAULT_PREVIEW_BYTES;
  const next = items.map((item): T => {
    const replacement = options.state.replacements.get(item.id);
    if (!replacement) {
      return item;
    }
    return applyReplacement(item, replacement);
  });

  const fresh = next
    .map((item, index): ReplacementCandidate | undefined => {
      if (options.state.seenIds.has(item.id)) {
        return undefined;
      }
      const content = item.content ?? "";
      const bytes = Buffer.byteLength(content, "utf8");
      if (!content) {
        return undefined;
      }
      return { item, index, content, bytes };
    })
    .filter((item): item is ReplacementCandidate => item !== undefined);

  let totalBytes = next.reduce((sum, item) => sum + Buffer.byteLength(item.content ?? "", "utf8"), 0);
  const selected = new Set<ReplacementCandidate>();
  for (const candidate of [...fresh].sort((a, b) => b.bytes - a.bytes)) {
    if (candidate.bytes > maxFreshBytes || totalBytes > maxTotalBytes) {
      selected.add(candidate);
      totalBytes -= candidate.bytes;
    }
  }

  for (const candidate of fresh) {
    if (!selected.has(candidate)) {
      options.state.seenIds.add(candidate.item.id);
      continue;
    }
    const replacement = await persistReplacement(candidate, {
      sessionId: options.sessionId,
      taskIdPrefix: options.taskIdPrefix,
      state: options.state,
      store: options.store,
      previewBytes
    });
    options.state.seenIds.add(candidate.item.id);
    options.state.replacements.set(candidate.item.id, replacement);
    next[candidate.index] = applyReplacement(candidate.item, replacement) as T;
  }

  return next;
}

async function persistReplacement(
  candidate: ReplacementCandidate,
  options: Pick<ToolResultBudgetOptions, "sessionId" | "taskIdPrefix" | "state" | "store" | "previewBytes">
): Promise<PersistedReplacement> {
  const taskId = `${options.taskIdPrefix ?? "tool_result"}.${sanitizePathPart(candidate.item.id)}`;
  const ref = await writeTaskOutput({
    sessionId: options.sessionId,
    taskId,
    attempt: 0,
    content: candidate.content
  });
  const content = buildReplacementMessage({
    action: candidate.item.action,
    summary: candidate.item.summary,
    status: candidate.item.status,
    originalBytes: ref.bytes,
    originalLines: ref.lines,
    path: ref.path,
    preview: truncateTextBytes(candidate.content, options.previewBytes ?? DEFAULT_PREVIEW_BYTES)
  });
  const replacement: PersistedReplacement = {
    content,
    originalBytes: candidate.bytes,
    outputRef: ref
  };
  options.store?.upsert({
    session_id: options.state.sessionId,
    scope_kind: options.state.scopeKind,
    scope_id: options.state.scopeId,
    tool_result_id: candidate.item.id,
    action: candidate.item.action,
    original_bytes: candidate.bytes,
    replacement_content: content,
    output_ref: ref
  });
  return replacement;
}

function applyReplacement<T extends ToolResultBudgetItem>(item: T, replacement: PersistedReplacement): T {
  const outputRefPath = outputRefToPath(replacement.outputRef) ?? item.outputRef;
  return {
    ...item,
    content: replacement.content,
    outputRef: outputRefPath,
    data: compactDataWithOutputRef(item.data, replacement.outputRef ?? outputRefPath)
  };
}

function buildReplacementMessage(input: {
  action: string;
  summary: string;
  status?: string;
  originalBytes: number;
  originalLines: number;
  path: string;
  preview: string;
}): string {
  return [
    TOOL_RESULT_REPLACEMENT_TAG,
    `${input.action}: ${input.summary}`,
    input.status ? `Status: ${input.status}` : undefined,
    `Full output: ${input.path}`,
    `Original output: ${input.originalBytes} bytes, ${input.originalLines} lines`,
    input.preview ? `Preview:\n${input.preview}` : TOOL_RESULT_CLEARED_MESSAGE,
    `</${TOOL_RESULT_REPLACEMENT_TAG.slice(1)}`
  ].filter(Boolean).join("\n");
}

function compactDataWithOutputRef(data: unknown, outputRef: unknown): unknown {
  const refPath = outputRefToPath(outputRef);
  if (isRecord(data)) {
    const compacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if ((key === "content" || key === "stdout" || key === "stderr" || key === "text") && typeof value === "string") {
        compacted[`${key}_cleared`] = true;
        compacted[`${key}_preview`] = truncateTextBytes(value, 500);
        continue;
      }
      compacted[key] = value;
    }
    if (outputRef !== undefined) {
      compacted.outputRef = outputRef;
    }
    return compacted;
  }
  return refPath ? { outputRef } : data;
}

function outputRefToPath(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  return isRecord(value) && typeof value.path === "string" ? value.path : undefined;
}

function truncateTextBytes(content: string, maxBytes: number): string {
  const buffer = Buffer.from(content, "utf8");
  if (buffer.length <= maxBytes) {
    return content;
  }
  const headBytes = Math.floor(maxBytes * 0.7);
  const tailBytes = Math.max(0, maxBytes - headBytes);
  return [
    buffer.subarray(0, headBytes).toString("utf8").trimEnd(),
    "",
    `[... ${Math.max(0, buffer.length - maxBytes)} bytes omitted from persisted tool result ...]`,
    "",
    buffer.subarray(Math.max(headBytes, buffer.length - tailBytes)).toString("utf8").trimStart()
  ].join("\n");
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 120) || "tool_result";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
