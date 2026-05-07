import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { WorkItem } from "../protocol/types.js";
import type { WorkflowRuntimeConfig } from "./workflow.js";
import { workItemKey, workItemSourceId, workItemSourceKind } from "./work-item.js";

export type LocalWorkRecord = {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  priority?: number | null;
  state: string;
  url?: string | null;
  labels?: string[];
  blocked_by?: Array<{ id?: string | null; identifier?: string | null; state?: string | null }>;
  created_at?: string | null;
  updated_at?: string | null;
  metadata?: Record<string, unknown>;
};

export type WorkSource = {
  kind: string;
  fetchCandidateItems(): Promise<WorkItem[]>;
  refreshItems(items: WorkItem[]): Promise<Map<string, WorkItem | undefined>>;
  listTerminalItems(): Promise<WorkItem[]>;
};

export class FakeWorkSource implements WorkSource {
  readonly kind = "fake";

  constructor(
    private readonly records: LocalWorkRecord[],
    private readonly states: WorkSourceStates = defaultWorkSourceStates()
  ) {}

  async fetchCandidateItems(): Promise<WorkItem[]> {
    return this.readItems().filter((item) => isActiveWorkSourceItem(item, this.states));
  }

  async refreshItems(items: WorkItem[]): Promise<Map<string, WorkItem | undefined>> {
    return refreshFromItems(items, this.readItems());
  }

  async listTerminalItems(): Promise<WorkItem[]> {
    return this.readItems().filter((item) => isTerminalWorkSourceItem(item, this.states));
  }

  private readItems(): WorkItem[] {
    return this.records.map((record) => normalizeRecordToWorkItem(record, "fake"));
  }
}

export class LocalWorkSource implements WorkSource {
  readonly kind = "local";

  constructor(
    private readonly path: string,
    private readonly states: WorkSourceStates = defaultWorkSourceStates()
  ) {}

  async fetchCandidateItems(): Promise<WorkItem[]> {
    return this.readItems().filter((item) => isActiveWorkSourceItem(item, this.states));
  }

  async refreshItems(items: WorkItem[]): Promise<Map<string, WorkItem | undefined>> {
    return refreshFromItems(items, this.readItems());
  }

  async listTerminalItems(): Promise<WorkItem[]> {
    return this.readItems().filter((item) => isTerminalWorkSourceItem(item, this.states));
  }

  private readItems(): WorkItem[] {
    const fullPath = resolve(this.path);
    if (!existsSync(fullPath)) {
      return [];
    }
    const raw = readFileSync(fullPath, "utf8");
    const items = parseLocalWorkItems(raw, fullPath);
    return items.map((item) => normalizeRecordToWorkItem(item, "local"));
  }
}

export function createWorkSourceFromConfig(config: WorkflowRuntimeConfig, input: { records?: LocalWorkRecord[] } = {}): WorkSource {
  const states = {
    active: config.work_source.active_states,
    terminal: config.work_source.terminal_states
  };
  if (input.records?.length) {
    return new FakeWorkSource(input.records, states);
  }
  if (config.work_source.kind === "fake") {
    return new FakeWorkSource([defaultFakeWorkItem()], states);
  }
  return new LocalWorkSource(config.work_source.path ?? resolve(process.cwd(), "WORK_ITEMS.md"), states);
}

export function normalizeRecordToWorkItem(record: LocalWorkRecord, sourceKind = "fake"): WorkItem {
  return {
    source: "symphony",
    source_id: record.id,
    human_id: record.identifier,
    title: record.title,
    description: record.description ?? undefined,
    labels: (record.labels ?? []).map((label) => label.toLowerCase()),
    priority: typeof record.priority === "number" ? record.priority : null,
    state: record.state,
    url: record.url ?? undefined,
    metadata: {
      work_source_kind: sourceKind,
      blocked_by: record.blocked_by ?? [],
      created_at: record.created_at,
      updated_at: record.updated_at,
      ...(record.metadata ?? {})
    }
  };
}

function parseLocalWorkItems(raw: string, path: string): LocalWorkRecord[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  if (path.endsWith(".json")) {
    const parsed = JSON.parse(trimmed) as unknown;
    return normalizeLocalArray(Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.items) ? parsed.items : []);
  }
  if (path.endsWith(".jsonl")) {
    return normalizeLocalArray(trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown));
  }
  return parseMarkdownWorkItems(raw, path);
}

function parseMarkdownWorkItems(raw: string, path: string): LocalWorkRecord[] {
  const items: LocalWorkRecord[] = [];
  let index = 0;
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+\[( |x|X)\]\s+(.+)$/);
    if (!match) {
      continue;
    }
    index += 1;
    const checked = match[1].toLowerCase() === "x";
    const text = match[2].trim();
    const idMatch = text.match(/^([A-Z][A-Z0-9_-]*-\d+)\s*[:-]\s*(.+)$/);
    const identifier = idMatch?.[1] ?? `LOCAL-${index}`;
    const title = idMatch?.[2] ?? text;
    items.push({
      id: `${path}:${identifier}`,
      identifier,
      title,
      state: checked ? "Done" : "Todo",
      labels: ["local"],
      metadata: {
        local_path: path,
        line_index: index
      }
    });
  }
  return items;
}

function normalizeLocalArray(values: unknown[]): LocalWorkRecord[] {
  return values
    .map((value, index) => normalizeLocalRecord(value, index))
    .filter((item): item is LocalWorkRecord => Boolean(item));
}

function normalizeLocalRecord(value: unknown, index: number): LocalWorkRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const title = typeof value.title === "string" && value.title.trim() ? value.title.trim() : undefined;
  if (!title) {
    return undefined;
  }
  const identifier = typeof value.identifier === "string" && value.identifier.trim()
    ? value.identifier.trim()
    : typeof value.human_id === "string" && value.human_id.trim()
      ? value.human_id.trim()
      : `LOCAL-${index + 1}`;
  return {
    id: typeof value.id === "string" && value.id.trim() ? value.id.trim() : identifier,
    identifier,
    title,
    description: typeof value.description === "string" ? value.description : null,
    priority: typeof value.priority === "number" ? value.priority : null,
    state: typeof value.state === "string" && value.state.trim() ? value.state.trim() : "Todo",
    url: typeof value.url === "string" ? value.url : null,
    labels: Array.isArray(value.labels) ? value.labels.map(String) : ["local"],
    blocked_by: Array.isArray(value.blocked_by) ? value.blocked_by as LocalWorkRecord["blocked_by"] : [],
    created_at: typeof value.created_at === "string" ? value.created_at : null,
    updated_at: typeof value.updated_at === "string" ? value.updated_at : null,
    metadata: isRecord(value.metadata) ? value.metadata : {}
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function defaultFakeWorkItem(): LocalWorkRecord {
  return {
    id: "fake-work-item-1",
    identifier: "FAKE-1",
    title: "Preview Symphony work ingress",
    description: "This fake work item exercises the Work Kernel entrypoint without a local source file.",
    priority: 3,
    state: "Todo",
    labels: ["symphony", "preview"],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

type WorkSourceStates = {
  active: string[];
  terminal: string[];
};

function defaultWorkSourceStates(): WorkSourceStates {
  return {
    active: ["Todo", "In Progress"],
    terminal: ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]
  };
}

function refreshFromItems(requested: WorkItem[], current: WorkItem[]): Map<string, WorkItem | undefined> {
  const refreshed = new Map<string, WorkItem | undefined>();
  for (const item of requested) {
    refreshed.set(workSourceIdentity(item), findMatchingItem(item, current));
  }
  return refreshed;
}

export function workSourceIdentity(item: WorkItem): string {
  return workItemKey(item);
}

function findMatchingItem(item: WorkItem, candidates: WorkItem[]): WorkItem | undefined {
  const identity = workSourceIdentity(item);
  const sourceId = workItemSourceId(item);
  const humanId = item.human_id;
  return candidates.find((candidate) => workSourceIdentity(candidate) === identity) ??
    candidates.find((candidate) => sourceId && workItemSourceKind(candidate) === workItemSourceKind(item) && workItemSourceId(candidate) === sourceId) ??
    candidates.find((candidate) => humanId && candidate.human_id === humanId);
}

export function isActiveWorkSourceItem(item: WorkItem, states: WorkSourceStates): boolean {
  if (!item.state) {
    return true;
  }
  if (isTerminalWorkSourceItem(item, states)) {
    return false;
  }
  const state = item.state.toLowerCase();
  return states.active.some((active) => active.toLowerCase() === state);
}

export function isTerminalWorkSourceItem(item: WorkItem, states: WorkSourceStates): boolean {
  if (!item.state) {
    return false;
  }
  const state = item.state.toLowerCase();
  return states.terminal.some((terminal) => terminal.toLowerCase() === state);
}
