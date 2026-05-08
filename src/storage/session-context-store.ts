import { randomUUID } from "node:crypto";
import type { SwarmDatabase } from "./database.js";

export type SessionContextKind =
  | "objective"
  | "user"
  | "assistant"
  | "loop_activity"
  | "tool_result"
  | "worker"
  | "workspace_change"
  | "final"
  | "summary";

export type SessionContextEntry = {
  entry_id: string;
  session_id: string;
  kind: SessionContextKind;
  role: "user" | "assistant" | "system" | "tool" | "worker";
  content: string;
  tokens: number;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type SessionCompaction = {
  compaction_id: string;
  session_id: string;
  summary: string;
  from_entry_id?: string;
  to_entry_id?: string;
  pre_tokens: number;
  post_tokens: number;
  kept_entries: string[];
  strategy: string;
  created_at: string;
};

export type SessionContextBudget = {
  maxTokens: number;
  keepRecentEntries: number;
  summaryMaxTokens: number;
};

type SessionContextEntryRow = Omit<SessionContextEntry, "metadata"> & {
  metadata_json: string;
};

type SessionCompactionRow = Omit<SessionCompaction, "kept_entries"> & {
  kept_entries_json: string;
};

const DEFAULT_CONTEXT_BUDGET: SessionContextBudget = {
  maxTokens: 12_000,
  keepRecentEntries: 12,
  summaryMaxTokens: 2_000
};

export class SessionContextStore {
  constructor(private readonly database: SwarmDatabase) {}

  append(input: {
    session_id: string;
    kind: SessionContextKind;
    role: SessionContextEntry["role"];
    content: string;
    metadata?: Record<string, unknown>;
    entry_id?: string;
    created_at?: string;
  }): SessionContextEntry {
    const content = input.content.trim();
    const entry: SessionContextEntry = {
      entry_id: input.entry_id ?? `ctx_${randomUUID()}`,
      session_id: input.session_id,
      kind: input.kind,
      role: input.role,
      content,
      tokens: estimateTokens(content),
      metadata: input.metadata ?? {},
      created_at: input.created_at ?? new Date().toISOString()
    };
    this.database.db
      .prepare(
        `INSERT INTO session_context_entries (
          entry_id, session_id, kind, role, content, tokens, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.entry_id,
        entry.session_id,
        entry.kind,
        entry.role,
        entry.content,
        entry.tokens,
        JSON.stringify(entry.metadata),
        entry.created_at
      );
    return entry;
  }

  list(sessionId: string, limit = 500): SessionContextEntry[] {
    const rows = this.database.db
      .prepare("SELECT * FROM session_context_entries WHERE session_id = ? ORDER BY created_at ASC LIMIT ?")
      .all(sessionId, limit) as SessionContextEntryRow[];
    return rows.map(entryFromRow);
  }

  listRecent(sessionId: string, limit = 50): SessionContextEntry[] {
    const rows = this.database.db
      .prepare("SELECT * FROM session_context_entries WHERE session_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(sessionId, limit) as SessionContextEntryRow[];
    return rows.map(entryFromRow).reverse();
  }

  latestCompaction(sessionId: string): SessionCompaction | undefined {
    const row = this.database.db
      .prepare("SELECT * FROM session_compactions WHERE session_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(sessionId) as SessionCompactionRow | undefined;
    return row ? compactionFromRow(row) : undefined;
  }

  listCompactions(sessionId: string, limit = 20): SessionCompaction[] {
    const rows = this.database.db
      .prepare("SELECT * FROM session_compactions WHERE session_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(sessionId, limit) as SessionCompactionRow[];
    return rows.map(compactionFromRow);
  }

  compact(sessionId: string, budget: Partial<SessionContextBudget> = {}): SessionCompaction | undefined {
    const resolved = { ...DEFAULT_CONTEXT_BUDGET, ...budget };
    const entries = this.list(sessionId, 2_000);
    if (entries.length === 0) {
      return undefined;
    }
    const totalTokens = entries.reduce((sum, entry) => sum + entry.tokens, 0);
    if (totalTokens <= resolved.maxTokens) {
      return this.latestCompaction(sessionId);
    }

    const recent = entries.slice(-resolved.keepRecentEntries);
    const recentIds = new Set(recent.map((entry) => entry.entry_id));
    const compactedPrefix = entries.filter((entry) => !recentIds.has(entry.entry_id));
    if (compactedPrefix.length === 0) {
      return this.latestCompaction(sessionId);
    }

    const previous = this.latestCompaction(sessionId);
    const toEntryId = compactedPrefix.at(-1)?.entry_id;
    if (previous?.to_entry_id && previous.to_entry_id === toEntryId) {
      return previous;
    }
    const summary = buildExtractiveSummary(compactedPrefix, previous?.summary, resolved.summaryMaxTokens);
    const compaction: SessionCompaction = {
      compaction_id: `compact_${randomUUID()}`,
      session_id: sessionId,
      summary,
      from_entry_id: compactedPrefix[0]?.entry_id,
      to_entry_id: toEntryId,
      pre_tokens: totalTokens,
      post_tokens: estimateTokens(summary) + recent.reduce((sum, entry) => sum + entry.tokens, 0),
      kept_entries: recent.map((entry) => entry.entry_id),
      strategy: "extractive_summary_keep_recent_tail",
      created_at: new Date().toISOString()
    };
    this.database.db
      .prepare(
        `INSERT INTO session_compactions (
          compaction_id, session_id, summary, from_entry_id, to_entry_id, pre_tokens,
          post_tokens, kept_entries_json, strategy, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        compaction.compaction_id,
        compaction.session_id,
        compaction.summary,
        compaction.from_entry_id ?? null,
        compaction.to_entry_id ?? null,
        compaction.pre_tokens,
        compaction.post_tokens,
        JSON.stringify(compaction.kept_entries),
        compaction.strategy,
        compaction.created_at
      );
    return compaction;
  }

  renderForSession(sessionId: string, budget: Partial<SessionContextBudget> = {}): string {
    const resolved = { ...DEFAULT_CONTEXT_BUDGET, ...budget };
    const compaction = this.compact(sessionId, resolved);
    const allEntries = this.list(sessionId, 2_000);
    if (allEntries.length === 0 && !compaction) {
      return "";
    }

    const compactedThrough = compaction?.to_entry_id;
    const startIndex = compactedThrough
      ? allEntries.findIndex((entry) => entry.entry_id === compactedThrough) + 1
      : 0;
    const recent = allEntries
      .slice(Math.max(0, startIndex))
      .slice(-resolved.keepRecentEntries);

    const sections = [
      compaction
        ? [
            "Compacted session memory",
            `Strategy: ${compaction.strategy}`,
            compaction.summary
          ].join("\n")
        : undefined,
      recent.length
        ? [
            "Recent session tail",
            ...recent.map((entry) => formatContextEntry(entry))
          ].join("\n\n")
        : undefined
    ].filter(Boolean);
    return sections.join("\n\n");
  }
}

function buildExtractiveSummary(entries: SessionContextEntry[], previousSummary: string | undefined, maxTokens: number): string {
  const importantFiles = new Set<string>();
  const tests = new Set<string>();
  const workers: string[] = [];
  const issues: string[] = [];
  const decisions: string[] = [];
  const tail = entries.slice(-20);
  for (const entry of entries) {
    collectPathCandidates(entry.content, importantFiles);
    collectPathCandidates(JSON.stringify(entry.metadata), importantFiles);
    if (entry.kind === "workspace_change") {
      collectPathCandidates(entry.content, importantFiles);
    }
    if (entry.kind === "worker" && workers.length < 12) {
      workers.push(singleLine(entry.content, 240));
    }
    if ((entry.kind === "tool_result" || entry.kind === "loop_activity") && /failed|error|denied|blocked/i.test(entry.content) && issues.length < 12) {
      issues.push(singleLine(entry.content, 260));
    }
    if ((entry.kind === "summary" || entry.kind === "final") && decisions.length < 8) {
      decisions.push(singleLine(entry.content, 260));
    }
    if (/test|verify|check|lint|build/i.test(entry.content) && tests.size < 16) {
      tests.add(singleLine(entry.content, 220));
    }
  }
  const lines = [
    previousSummary ? `Previous compacted summary:\n${previousSummary}` : undefined,
    "Compacted WorkSession memory:",
    decisions.length ? `Decisions and outcomes:\n${decisions.map((item) => `- ${item}`).join("\n")}` : undefined,
    importantFiles.size ? `Files and paths seen:\n${[...importantFiles].slice(0, 30).map((item) => `- ${item}`).join("\n")}` : undefined,
    tests.size ? `Verification and test signals:\n${[...tests].slice(0, 16).map((item) => `- ${item}`).join("\n")}` : undefined,
    workers.length ? `Worker activity:\n${workers.map((item) => `- ${item}`).join("\n")}` : undefined,
    issues.length ? `Open issues and failures:\n${issues.map((item) => `- ${item}`).join("\n")}` : undefined,
    "Recent compacted tail:",
    ...tail.map((entry) => `- ${entry.created_at} ${entry.kind}/${entry.role}: ${singleLine(entry.content, 500)}`)
  ].filter(Boolean);
  return truncateToTokens(lines.join("\n"), maxTokens);
}

function collectPathCandidates(content: string, target: Set<string>): void {
  const matches = content.match(/[A-Za-z]:\\[^\s"',)]+|(?:\.{1,2}\/)?[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+(?:\.[A-Za-z0-9]{1,10})?/g) ?? [];
  for (const match of matches) {
    const normalized = match.replace(/\\+/g, "\\").replace(/[.,;:]+$/, "");
    const lower = normalized.replace(/\\/g, "/").toLowerCase();
    if (
      lower.includes("node_modules/") ||
      lower.includes(".git/") ||
      lower.includes(".swarm/") ||
      lower.includes("dist/") ||
      normalized.length > 240
    ) {
      continue;
    }
    target.add(normalized);
  }
}

function formatContextEntry(entry: SessionContextEntry): string {
  const metadata = Object.entries(entry.metadata)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .slice(0, 6)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
  return [
    `[${entry.created_at}] ${entry.kind}/${entry.role}${metadata ? ` ${metadata}` : ""}`,
    entry.content
  ].join("\n");
}

function estimateTokens(content: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(content, "utf8") / 4));
}

function truncateToTokens(content: string, maxTokens: number): string {
  const maxBytes = Math.max(256, maxTokens * 4);
  const buffer = Buffer.from(content, "utf8");
  if (buffer.length <= maxBytes) {
    return content;
  }
  return `${buffer.subarray(0, Math.max(0, maxBytes - 80)).toString("utf8").trimEnd()}\n\n[... session memory truncated; inspect Work Kernel session context for older details ...]`;
}

function singleLine(content: string, maxChars: number): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}...` : normalized;
}

function entryFromRow(row: SessionContextEntryRow): SessionContextEntry {
  return {
    ...row,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>
  };
}

function compactionFromRow(row: SessionCompactionRow): SessionCompaction {
  return {
    ...row,
    from_entry_id: row.from_entry_id ?? undefined,
    to_entry_id: row.to_entry_id ?? undefined,
    kept_entries: JSON.parse(row.kept_entries_json) as string[]
  };
}
