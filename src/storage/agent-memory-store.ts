import { createHash, randomUUID } from "node:crypto";
import type { SwarmDatabase } from "./database.js";

export type AgentMemoryKind =
  | "profile"
  | "task_experience"
  | "learned_constraint"
  | "failure_pattern"
  | "trusted_tool";

export type AgentMemoryRetentionPolicy = "session" | "long_term" | "ephemeral";
export type AgentMemoryHealth = "empty" | "active" | "frozen" | "cleared";

export type AgentMemoryEntry = {
  memory_id: string;
  actor_id: string;
  session_id?: string;
  task_id?: string;
  kind: AgentMemoryKind;
  content: string;
  summary: string;
  tags: string[];
  trusted_tools: string[];
  source_envelope_id: string;
  correlation_id?: string;
  retention_policy: AgentMemoryRetentionPolicy;
  pinned: boolean;
  frozen: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type AgentMemoryState = {
  actor_id: string;
  profile_summary: string;
  cache_stable_summary: string;
  cache_stable_summary_hash: string;
  frozen: boolean;
  cleared_at?: string;
  last_learned_at?: string;
  last_compacted_at?: string;
  last_source_envelope_id?: string;
  updated_at: string;
  metadata: Record<string, unknown>;
};

export type AgentMemoryProjection = AgentMemoryState & {
  health: AgentMemoryHealth;
  entries: number;
  recent_tasks: string[];
  learned_constraints: string[];
  failure_patterns: string[];
  trusted_tools: string[];
};

type AgentMemoryEntryRow = Omit<AgentMemoryEntry, "tags" | "trusted_tools" | "pinned" | "frozen" | "metadata"> & {
  tags_json: string;
  trusted_tools_json: string;
  pinned: number;
  frozen: number;
  metadata_json: string;
};

type AgentMemoryStateRow = Omit<AgentMemoryState, "frozen" | "metadata" | "last_source_envelope_id"> & {
  frozen: number;
  metadata_json: string;
};

const SUMMARY_LIMIT = 320;
const CACHE_STABLE_SECTION_LIMIT = 6;

export class AgentMemoryStore {
  constructor(private readonly database: SwarmDatabase) {}

  append(input: {
    actor_id: string;
    kind: AgentMemoryKind;
    content: string;
    source_envelope_id: string;
    session_id?: string;
    task_id?: string;
    summary?: string;
    tags?: string[];
    trusted_tools?: string[];
    correlation_id?: string;
    retention_policy: AgentMemoryRetentionPolicy;
    pinned?: boolean;
    metadata?: Record<string, unknown>;
    created_at?: string;
  }): AgentMemoryEntry {
    const actorId = requiredNonEmpty(input.actor_id, "actor_id");
    const sourceEnvelopeId = requiredSourceEnvelopeId(input.source_envelope_id);
    const content = requiredNonEmpty(input.content, "content");
    if (!actorId) {
      throw new Error("Agent memory write requires actor_id.");
    }
    const retentionPolicy = validateRetentionPolicy(input.retention_policy);
    const existingState = this.getState(actorId);
    if (existingState?.frozen) {
      throw new Error(`Agent memory for ${actorId} is frozen.`);
    }
    const now = input.created_at ?? new Date().toISOString();
    const entry: AgentMemoryEntry = {
      memory_id: `mem_${randomUUID()}`,
      actor_id: actorId,
      session_id: trimOptional(input.session_id),
      task_id: trimOptional(input.task_id),
      kind: input.kind,
      content,
      summary: singleLine(input.summary ?? content, SUMMARY_LIMIT),
      tags: uniqueStrings(input.tags ?? []),
      trusted_tools: uniqueStrings(input.trusted_tools ?? []),
      source_envelope_id: sourceEnvelopeId,
      correlation_id: trimOptional(input.correlation_id),
      retention_policy: retentionPolicy,
      pinned: input.pinned ?? false,
      frozen: false,
      metadata: input.metadata ?? {},
      created_at: now
    };
    this.database.db
      .prepare(
        `INSERT INTO agent_memory_entries (
          memory_id, actor_id, session_id, task_id, kind, content, summary, tags_json,
          trusted_tools_json, source_envelope_id, correlation_id, retention_policy,
          pinned, frozen, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.memory_id,
        entry.actor_id,
        entry.session_id ?? null,
        entry.task_id ?? null,
        entry.kind,
        entry.content,
        entry.summary,
        JSON.stringify(entry.tags),
        JSON.stringify(entry.trusted_tools),
        entry.source_envelope_id,
        entry.correlation_id ?? null,
        entry.retention_policy,
        entry.pinned ? 1 : 0,
        entry.frozen ? 1 : 0,
        JSON.stringify(entry.metadata),
        entry.created_at
      );
    this.compact(actorId, { now, source_envelope_id: sourceEnvelopeId });
    return entry;
  }

  list(actorId: string, options: { limit?: number; includeCleared?: boolean } = {}): AgentMemoryEntry[] {
    const limit = Math.max(1, Math.min(1_000, Math.floor(options.limit ?? 200)));
    const state = this.getState(actorId);
    const rows = this.database.db
      .prepare("SELECT * FROM agent_memory_entries WHERE actor_id = ? ORDER BY created_at DESC, memory_id DESC LIMIT ?")
      .all(actorId, limit) as AgentMemoryEntryRow[];
    const entries = rows.map(entryFromRow).reverse();
    if (options.includeCleared || !state?.cleared_at) {
      return entries;
    }
    return entries.filter((entry) => entry.created_at > state.cleared_at!);
  }

  getState(actorId: string): AgentMemoryState | undefined {
    const row = this.database.db
      .prepare("SELECT * FROM agent_memory_state WHERE actor_id = ?")
      .get(actorId) as AgentMemoryStateRow | undefined;
    return row ? stateFromRow(row) : undefined;
  }

  project(actorId: string): AgentMemoryProjection {
    const state = this.getState(actorId) ?? emptyState(actorId);
    const entries = this.list(actorId, { limit: 200 });
    const projection: AgentMemoryProjection = {
      ...state,
      health: state.frozen ? "frozen" : state.cleared_at && entries.length === 0 ? "cleared" : entries.length > 0 ? "active" : "empty",
      entries: entries.length,
      recent_tasks: entries.filter((entry) => entry.kind === "task_experience").slice(-CACHE_STABLE_SECTION_LIMIT).map((entry) => entry.summary),
      learned_constraints: entries.filter((entry) => entry.kind === "learned_constraint").slice(-CACHE_STABLE_SECTION_LIMIT).map((entry) => entry.summary),
      failure_patterns: entries.filter((entry) => entry.kind === "failure_pattern").slice(-CACHE_STABLE_SECTION_LIMIT).map((entry) => entry.summary),
      trusted_tools: uniqueStrings(entries.flatMap((entry) => entry.trusted_tools))
    };
    return projection;
  }

  renderForPrompt(actorId: string): string {
    const memory = this.project(actorId);
    if (memory.health === "empty" || memory.health === "cleared") {
      return "";
    }
    return [
      "Agent memory summary:",
      `actor_id=${memory.actor_id}`,
      `health=${memory.health}`,
      `cache_stable_summary_hash=${memory.cache_stable_summary_hash}`,
      memory.profile_summary ? `profile=${memory.profile_summary}` : undefined,
      memory.cache_stable_summary ? `cache_stable_summary:\n${memory.cache_stable_summary}` : undefined,
      memory.last_learned_at ? `last_learned_at=${memory.last_learned_at}` : undefined,
      memory.last_compacted_at ? `last_compacted_at=${memory.last_compacted_at}` : undefined,
      memory.trusted_tools.length ? `trusted_tools=${memory.trusted_tools.join(",")}` : undefined
    ].filter(Boolean).join("\n");
  }

  compact(actorId: string, options: { now?: string; source_envelope_id: string }): AgentMemoryState {
    const sourceEnvelopeId = requiredSourceEnvelopeId(options.source_envelope_id);
    const now = options.now ?? new Date().toISOString();
    const previous = this.getState(actorId);
    const entries = this.list(actorId, { limit: 500 });
    const activeEntries = previous?.cleared_at
      ? entries.filter((entry) => entry.created_at > previous.cleared_at!)
      : entries;
    const profile = latestSummary(activeEntries, "profile") ?? previous?.profile_summary ?? "";
    const cacheStableSummary = buildCacheStableSummary(activeEntries, profile);
    const state: AgentMemoryState = {
      actor_id: actorId,
      profile_summary: profile,
      cache_stable_summary: cacheStableSummary,
      cache_stable_summary_hash: stableHash(cacheStableSummary),
      frozen: previous?.frozen ?? false,
      cleared_at: previous?.cleared_at,
      last_learned_at: activeEntries.at(-1)?.created_at ?? previous?.last_learned_at,
      last_compacted_at: now,
      last_source_envelope_id: sourceEnvelopeId,
      updated_at: now,
      metadata: {
        ...(previous?.metadata ?? {}),
        entry_count: activeEntries.length,
        source_envelope_id: sourceEnvelopeId,
        retention: "summary_only_no_raw_prompt"
      }
    };
    this.writeState(state);
    return state;
  }

  freeze(actorId: string, input: { frozen?: boolean; now?: string; source_envelope_id: string; metadata?: Record<string, unknown> }): AgentMemoryState {
    const sourceEnvelopeId = requiredSourceEnvelopeId(input.source_envelope_id);
    const now = input.now ?? new Date().toISOString();
    const state = this.getState(actorId) ?? emptyState(actorId, now);
    const next: AgentMemoryState = {
      ...state,
      frozen: input.frozen ?? true,
      last_source_envelope_id: sourceEnvelopeId,
      updated_at: now,
      metadata: { ...state.metadata, ...(input.metadata ?? {}), source_envelope_id: sourceEnvelopeId }
    };
    this.writeState(next);
    return next;
  }

  clear(actorId: string, input: { now?: string; source_envelope_id: string; metadata?: Record<string, unknown> }): AgentMemoryState {
    const sourceEnvelopeId = requiredSourceEnvelopeId(input.source_envelope_id);
    const now = input.now ?? new Date().toISOString();
    const state = this.getState(actorId) ?? emptyState(actorId, now);
    const next: AgentMemoryState = {
      actor_id: actorId,
      profile_summary: "",
      cache_stable_summary: "",
      cache_stable_summary_hash: stableHash(""),
      frozen: state.frozen,
      cleared_at: now,
      last_learned_at: undefined,
      last_compacted_at: now,
      last_source_envelope_id: sourceEnvelopeId,
      updated_at: now,
      metadata: {
        ...state.metadata,
        ...(input.metadata ?? {}),
        cleared: true,
        source_envelope_id: sourceEnvelopeId,
        retention: "summary_only_no_raw_prompt"
      }
    };
    this.writeState(next);
    return next;
  }

  private writeState(state: AgentMemoryState): void {
    this.database.db
      .prepare(
        `INSERT INTO agent_memory_state (
          actor_id, profile_summary, cache_stable_summary, cache_stable_summary_hash,
          frozen, cleared_at, last_learned_at, last_compacted_at, updated_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(actor_id) DO UPDATE SET
          profile_summary = excluded.profile_summary,
          cache_stable_summary = excluded.cache_stable_summary,
          cache_stable_summary_hash = excluded.cache_stable_summary_hash,
          frozen = excluded.frozen,
          cleared_at = excluded.cleared_at,
          last_learned_at = excluded.last_learned_at,
          last_compacted_at = excluded.last_compacted_at,
          updated_at = excluded.updated_at,
          metadata_json = excluded.metadata_json`
      )
      .run(
        state.actor_id,
        state.profile_summary,
        state.cache_stable_summary,
        state.cache_stable_summary_hash,
        state.frozen ? 1 : 0,
        state.cleared_at ?? null,
        state.last_learned_at ?? null,
        state.last_compacted_at ?? null,
        state.updated_at,
        JSON.stringify(state.metadata)
      );
  }
}

function buildCacheStableSummary(entries: AgentMemoryEntry[], profile: string): string {
  const sections = [
    profile ? `Profile:\n- ${profile}` : undefined,
    renderEntrySection("Recent task experience", entries, "task_experience"),
    renderEntrySection("Learned constraints", entries, "learned_constraint"),
    renderEntrySection("Failure patterns", entries, "failure_pattern"),
    renderTrustedTools(entries)
  ].filter(Boolean);
  return sections.join("\n");
}

function renderEntrySection(title: string, entries: AgentMemoryEntry[], kind: AgentMemoryKind): string | undefined {
  const lines = entries
    .filter((entry) => entry.kind === kind)
    .slice(-CACHE_STABLE_SECTION_LIMIT)
    .map((entry) => `- ${entry.summary}`);
  return lines.length ? `${title}:\n${lines.join("\n")}` : undefined;
}

function renderTrustedTools(entries: AgentMemoryEntry[]): string | undefined {
  const tools = uniqueStrings(entries.flatMap((entry) => entry.trusted_tools)).slice(0, 16);
  return tools.length ? `Trusted tools:\n- ${tools.join("\n- ")}` : undefined;
}

function latestSummary(entries: AgentMemoryEntry[], kind: AgentMemoryKind): string | undefined {
  return [...entries].reverse().find((entry) => entry.kind === kind)?.summary;
}

function entryFromRow(row: AgentMemoryEntryRow): AgentMemoryEntry {
  return {
    memory_id: row.memory_id,
    actor_id: row.actor_id,
    session_id: row.session_id ?? undefined,
    task_id: row.task_id ?? undefined,
    kind: row.kind,
    content: row.content,
    summary: row.summary,
    tags: parseJsonField<string[]>(row.tags_json, []),
    trusted_tools: parseJsonField<string[]>(row.trusted_tools_json, []),
    source_envelope_id: row.source_envelope_id,
    correlation_id: row.correlation_id ?? undefined,
    retention_policy: row.retention_policy,
    pinned: row.pinned === 1,
    frozen: row.frozen === 1,
    metadata: parseJsonField<Record<string, unknown>>(row.metadata_json, {}),
    created_at: row.created_at
  };
}

function stateFromRow(row: AgentMemoryStateRow): AgentMemoryState {
  const metadata = parseJsonField<Record<string, unknown>>(row.metadata_json, {});
  return {
    actor_id: row.actor_id,
    profile_summary: row.profile_summary,
    cache_stable_summary: row.cache_stable_summary,
    cache_stable_summary_hash: row.cache_stable_summary_hash,
    frozen: row.frozen === 1,
    cleared_at: row.cleared_at ?? undefined,
    last_learned_at: row.last_learned_at ?? undefined,
    last_compacted_at: row.last_compacted_at ?? undefined,
    last_source_envelope_id: typeof metadata.source_envelope_id === "string" ? metadata.source_envelope_id : undefined,
    updated_at: row.updated_at,
    metadata
  };
}

function emptyState(actorId: string, now = new Date().toISOString()): AgentMemoryState {
  return {
    actor_id: actorId,
    profile_summary: "",
    cache_stable_summary: "",
    cache_stable_summary_hash: stableHash(""),
    frozen: false,
    updated_at: now,
    metadata: {}
  };
}

function stableHash(text: string): string {
  return `amx:${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
}

function singleLine(content: string, maxChars: number): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}...` : normalized;
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function requiredSourceEnvelopeId(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error("Agent memory write requires source_envelope_id.");
  }
  return trimmed;
}

function requiredNonEmpty(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`Agent memory write requires ${label}.`);
  }
  return trimmed;
}

function validateRetentionPolicy(value: AgentMemoryRetentionPolicy | undefined): AgentMemoryRetentionPolicy {
  if (value === "session" || value === "long_term" || value === "ephemeral") {
    return value;
  }
  throw new Error("Agent memory write requires retention_policy.");
}

function parseJsonField<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))].sort();
}
