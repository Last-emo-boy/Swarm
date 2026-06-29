import { randomUUID } from "node:crypto";
import type {
  AgentAddress,
  BlackboardClaimStatus,
  BlackboardCollaborationKind,
  BlackboardCollaborationMetadata,
  BlackboardDecisionStatus,
  BlackboardEntry,
  BlackboardEventRecord,
  BlackboardSubscriptionFilter,
  BlackboardSubscriptionRecord
} from "../protocol/types.js";
import type { SwarmDatabase } from "./database.js";

export type BlackboardQuery = {
  type?: BlackboardEntry["type"];
  tag?: string;
  keyPrefix?: string;
  taskId?: string;
  agentId?: string;
  claimKey?: string;
  proposalId?: string;
  kind?: BlackboardCollaborationKind;
  decisionStatus?: BlackboardDecisionStatus;
  ownerAgentId?: string;
  sourceEnvelopeId?: string;
};

type BlackboardCausality = {
  source_envelope_id?: string;
  correlation_id?: string;
  reply_to?: string;
  metadata?: Record<string, unknown>;
};

export class BlackboardStore {
  constructor(private readonly database: SwarmDatabase) {}

  write(input: {
    swarm_id: string;
    session_id: string;
    task_id?: string;
    key: string;
    value: unknown;
    type: BlackboardEntry["type"];
    created_by: AgentAddress;
    visibility?: BlackboardEntry["visibility"];
    tags?: string[];
    metadata?: BlackboardCollaborationMetadata;
  }): BlackboardEntry {
    const now = new Date().toISOString();
    const metadata = normalizeMetadata(input.metadata, "write", input.created_by);
    const entry: BlackboardEntry = {
      entry_id: `bb_${randomUUID()}`,
      swarm_id: input.swarm_id,
      session_id: input.session_id,
      task_id: input.task_id,
      key: input.key,
      value: input.value,
      type: input.type,
      created_by: input.created_by,
      created_at: now,
      visibility: input.visibility ?? "team",
      version: 1,
      tags: uniqueStrings(input.tags ?? []),
      metadata
    };

    this.database.db
      .prepare(
        `INSERT INTO blackboard_entries (
          entry_id, session_id, swarm_id, task_id, key, type, value_json, created_by_json,
          visibility, version, tags_json, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.entry_id,
        entry.session_id,
        entry.swarm_id,
        entry.task_id ?? null,
        entry.key,
        entry.type,
        JSON.stringify(entry.value),
        JSON.stringify(entry.created_by),
        entry.visibility,
        entry.version,
        JSON.stringify(entry.tags ?? []),
        JSON.stringify(entry.metadata ?? {}),
        entry.created_at,
        entry.updated_at ?? null
      );

    this.recordEvent({
      swarm_id: entry.swarm_id,
      session_id: entry.session_id,
      task_id: entry.task_id,
      key: entry.key,
      kind: entry.metadata?.kind ?? "write",
      actor: entry.created_by,
      source_envelope_id: entry.metadata?.source_envelope_id,
      correlation_id: entry.metadata?.correlation_id,
      metadata: {
        entry_id: entry.entry_id,
        version: entry.version,
        tags: entry.tags ?? [],
        ...(entry.metadata ?? {})
      }
    });

    return entry;
  }

  update(input: {
    session_id: string;
    entry_id?: string;
    key?: string;
    expected_version?: number;
    value: unknown;
    tags?: string[];
    metadata?: BlackboardCollaborationMetadata;
    updated_by?: AgentAddress;
  }): BlackboardEntry {
    const existing = input.entry_id
      ? this.getByEntryId(input.session_id, input.entry_id)
      : input.key
        ? this.getLatestByKey(input.session_id, input.key)
        : undefined;
    if (!existing) {
      throw new Error("Blackboard update target not found.");
    }
    if (input.expected_version !== undefined && input.expected_version !== existing.version) {
      throw new Error(`Blackboard version conflict for ${existing.key}: expected ${input.expected_version}, found ${existing.version}`);
    }
    const actor = input.updated_by ?? existing.created_by;
    const metadata = mergeMetadata(existing.metadata, input.metadata, "update", actor);
    const next: BlackboardEntry = {
      ...existing,
      value: input.value,
      version: existing.version + 1,
      tags: input.tags ? uniqueStrings(input.tags) : existing.tags,
      metadata,
      updated_at: new Date().toISOString()
    };
    this.database.db
      .prepare(
        `UPDATE blackboard_entries
         SET value_json = ?, version = ?, tags_json = ?, metadata_json = ?, updated_at = ?
         WHERE entry_id = ?`
      )
      .run(
        JSON.stringify(next.value),
        next.version,
        JSON.stringify(next.tags ?? []),
        JSON.stringify(next.metadata ?? {}),
        next.updated_at ?? null,
        next.entry_id
      );
    this.recordEvent({
      swarm_id: next.swarm_id,
      session_id: next.session_id,
      task_id: next.task_id,
      key: next.key,
      kind: input.metadata?.kind ?? "update",
      actor,
      source_envelope_id: input.metadata?.source_envelope_id,
      correlation_id: input.metadata?.correlation_id,
      metadata: {
        entry_id: next.entry_id,
        previous_version: existing.version,
        version: next.version,
        ...(input.metadata ?? {})
      }
    });
    return next;
  }

  lock(input: {
    session_id: string;
    key: string;
    holder: AgentAddress;
    ttl_ms?: number;
    swarm_id?: string;
    task_id?: string;
    metadata?: BlackboardCollaborationMetadata;
  }): BlackboardEventRecord {
    const now = new Date();
    const expires = input.ttl_ms ? new Date(now.getTime() + input.ttl_ms).toISOString() : null;
    const existing = this.database.db
      .prepare("SELECT key, expires_at FROM blackboard_locks WHERE session_id = ? AND key = ?")
      .get(input.session_id, input.key) as { key: string; expires_at?: string | null } | undefined;
    if (existing?.expires_at && new Date(existing.expires_at).getTime() < now.getTime()) {
      this.unlock({
        session_id: input.session_id,
        key: input.key,
        swarm_id: input.swarm_id,
        task_id: input.task_id,
        holder: input.holder,
        metadata: {
          kind: "unlock",
          released_at: now.toISOString(),
          conflict_reason: "Expired lock was released before acquiring a new lock.",
          ...causalityOnly(input.metadata)
        }
      });
    } else if (existing) {
      throw new Error(`Blackboard key is locked: ${input.key}`);
    }
    this.database.db
      .prepare("INSERT INTO blackboard_locks (key, session_id, holder_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(input.key, input.session_id, JSON.stringify(input.holder), now.toISOString(), expires);
    const metadata = normalizeMetadata({
      ...input.metadata,
      kind: "lock",
      expires_at: expires ?? input.metadata?.expires_at
    }, "lock", input.holder);
    return this.recordEvent({
      swarm_id: input.swarm_id ?? `swarm_${input.session_id}`,
      session_id: input.session_id,
      task_id: input.task_id,
      key: input.key,
      kind: "lock",
      actor: input.holder,
      source_envelope_id: metadata.source_envelope_id,
      correlation_id: metadata.correlation_id,
      metadata
    });
  }

  unlock(input: {
    session_id: string;
    key: string;
    holder?: AgentAddress;
    swarm_id?: string;
    task_id?: string;
    metadata?: BlackboardCollaborationMetadata;
  }): BlackboardEventRecord {
    const existing = this.database.db
      .prepare("SELECT holder_json FROM blackboard_locks WHERE session_id = ? AND key = ?")
      .get(input.session_id, input.key) as { holder_json?: string | null } | undefined;
    const actor = input.holder ?? (existing?.holder_json ? parseJsonField<AgentAddress>(existing.holder_json, {}) : {});
    this.database.db
      .prepare("DELETE FROM blackboard_locks WHERE session_id = ? AND key = ?")
      .run(input.session_id, input.key);
    const metadata = normalizeMetadata({
      ...input.metadata,
      kind: "unlock",
      released_at: input.metadata?.released_at ?? new Date().toISOString()
    }, "unlock", actor);
    return this.recordEvent({
      swarm_id: input.swarm_id ?? `swarm_${input.session_id}`,
      session_id: input.session_id,
      task_id: input.task_id,
      key: input.key,
      kind: "unlock",
      actor,
      source_envelope_id: metadata.source_envelope_id,
      correlation_id: metadata.correlation_id,
      metadata
    });
  }

  claim(input: {
    swarm_id: string;
    session_id: string;
    task_id?: string;
    claim_key: string;
    owner: AgentAddress;
    value?: unknown;
    scope?: string[];
    ttl_ms?: number;
    expires_at?: string;
    tags?: string[];
    metadata?: BlackboardCollaborationMetadata;
  }): { status: "claimed" | "conflict"; entry: BlackboardEntry; conflict?: BlackboardEntry } {
    const ownerId = input.owner.agent_id ?? input.owner.role ?? "unknown";
    const active = this.getActiveClaim(input.session_id, input.claim_key);
    const activeOwner = active?.metadata?.owner_agent_id ?? active?.created_by.agent_id;
    if (active && activeOwner && activeOwner !== ownerId) {
      const reason = `Blackboard claim ${input.claim_key} is already owned by ${activeOwner}.`;
      const conflict = this.write({
        swarm_id: input.swarm_id,
        session_id: input.session_id,
        task_id: input.task_id,
        key: `claim/${input.claim_key}/conflict/${randomUUID()}`,
        type: "critique",
        value: {
          claim_key: input.claim_key,
          requested_owner: ownerId,
          current_owner: activeOwner,
          reason
        },
        created_by: input.owner,
        tags: uniqueStrings([...(input.tags ?? []), "blackboard", "claim", "conflict"]),
        metadata: {
          ...input.metadata,
          kind: "claim_conflict",
          claim_key: input.claim_key,
          claim_status: "conflict",
          owner_agent_id: ownerId,
          conflict_with_entry_id: active.entry_id,
          conflict_reason: reason
        }
      });
      return { status: "conflict", entry: conflict, conflict };
    }

    const expiresAt = input.expires_at ?? (input.ttl_ms ? new Date(Date.now() + input.ttl_ms).toISOString() : undefined);
    const entry = this.write({
      swarm_id: input.swarm_id,
      session_id: input.session_id,
      task_id: input.task_id,
      key: `claim/${input.claim_key}`,
      type: "decision",
      value: input.value ?? {
        claim_key: input.claim_key,
        owner_agent_id: ownerId,
        status: "claimed",
        scope: input.scope ?? []
      },
      created_by: input.owner,
      tags: uniqueStrings([...(input.tags ?? []), "blackboard", "claim"]),
      metadata: {
        ...input.metadata,
        kind: "claim",
        claim_key: input.claim_key,
        claim_status: "claimed",
        owner_agent_id: ownerId,
        expires_at: expiresAt
      }
    });
    return { status: "claimed", entry };
  }

  releaseClaim(input: {
    swarm_id: string;
    session_id: string;
    task_id?: string;
    claim_key: string;
    owner: AgentAddress;
    reason?: string;
    status?: Extract<BlackboardClaimStatus, "released" | "expired">;
    tags?: string[];
    metadata?: BlackboardCollaborationMetadata;
  }): BlackboardEntry {
    const ownerId = input.owner.agent_id ?? input.owner.role ?? "unknown";
    return this.write({
      swarm_id: input.swarm_id,
      session_id: input.session_id,
      task_id: input.task_id,
      key: `claim/${input.claim_key}/release`,
      type: "decision",
      value: {
        claim_key: input.claim_key,
        owner_agent_id: ownerId,
        status: input.status ?? "released",
        reason: input.reason
      },
      created_by: input.owner,
      tags: uniqueStrings([...(input.tags ?? []), "blackboard", "claim", input.status ?? "released"]),
      metadata: {
        ...input.metadata,
        kind: "claim_release",
        claim_key: input.claim_key,
        claim_status: input.status ?? "released",
        owner_agent_id: ownerId,
        released_at: new Date().toISOString()
      }
    });
  }

  expireClaims(sessionId: string, options: { now?: string; swarm_id?: string } = {}): BlackboardEntry[] {
    const now = options.now ?? new Date().toISOString();
    const claimKeys = uniqueStrings(this.query(sessionId, { kind: "claim" }).map((entry) => entry.metadata?.claim_key).filter((item): item is string => Boolean(item)));
    const expired: BlackboardEntry[] = [];
    for (const claimKey of claimKeys) {
      const active = this.getActiveClaim(sessionId, claimKey, { now });
      if (active) {
        continue;
      }
      const latest = this.latestClaimEntry(sessionId, claimKey);
      if (!latest || latest.metadata?.claim_status !== "claimed" || !isExpiredIso(latest.metadata.expires_at, now)) {
        continue;
      }
      expired.push(this.releaseClaim({
        swarm_id: options.swarm_id ?? latest.swarm_id,
        session_id: sessionId,
        task_id: latest.task_id,
        claim_key: claimKey,
        owner: latest.created_by,
        reason: `Claim expired at ${latest.metadata.expires_at}.`,
        status: "expired",
        metadata: {
          source_envelope_id: latest.metadata.source_envelope_id,
          correlation_id: latest.metadata.correlation_id
        }
      }));
    }
    return expired;
  }

  getActiveClaim(sessionId: string, claimKey: string, options: { now?: string } = {}): BlackboardEntry | undefined {
    const now = options.now ?? new Date().toISOString();
    const entries = this.query(sessionId, { claimKey }).reverse();
    for (const entry of entries) {
      const status = entry.metadata?.claim_status;
      if (status === "released" || status === "expired") {
        return undefined;
      }
      if (status === "conflict") {
        continue;
      }
      if (status === "claimed") {
        return isExpiredIso(entry.metadata?.expires_at, now) ? undefined : entry;
      }
    }
    return undefined;
  }

  propose(input: {
    swarm_id: string;
    session_id: string;
    task_id?: string;
    proposal_id?: string;
    proposer: AgentAddress;
    value: unknown;
    target_key?: string;
    claim_key?: string;
    tags?: string[];
    metadata?: BlackboardCollaborationMetadata;
  }): BlackboardEntry {
    const proposalId = input.proposal_id ?? `proposal_${randomUUID()}`;
    return this.write({
      swarm_id: input.swarm_id,
      session_id: input.session_id,
      task_id: input.task_id,
      key: `proposal/${proposalId}`,
      type: "plan",
      value: input.value,
      created_by: input.proposer,
      tags: uniqueStrings([...(input.tags ?? []), "blackboard", "proposal"]),
      metadata: {
        ...input.metadata,
        kind: "proposal",
        proposal_id: proposalId,
        claim_key: input.claim_key,
        target_key: input.target_key,
        decision_status: "proposed",
        owner_agent_id: input.proposer.agent_id
      }
    });
  }

  reviewProposal(input: {
    swarm_id: string;
    session_id: string;
    task_id?: string;
    proposal_id: string;
    reviewer: AgentAddress;
    verdict: "approve" | "reject" | "needs_revision";
    value?: unknown;
    tags?: string[];
    metadata?: BlackboardCollaborationMetadata;
  }): BlackboardEntry {
    const reviewId = input.metadata?.review_id ? String(input.metadata.review_id) : `review_${randomUUID()}`;
    return this.write({
      swarm_id: input.swarm_id,
      session_id: input.session_id,
      task_id: input.task_id,
      key: `proposal/${input.proposal_id}/review/${reviewId}`,
      type: "critique",
      value: input.value ?? {
        proposal_id: input.proposal_id,
        verdict: input.verdict
      },
      created_by: input.reviewer,
      tags: uniqueStrings([...(input.tags ?? []), "blackboard", "proposal", "review", input.verdict]),
      metadata: {
        ...input.metadata,
        kind: "review",
        proposal_id: input.proposal_id,
        review_id: reviewId,
        decision_status: "reviewed",
        owner_agent_id: input.reviewer.agent_id
      }
    });
  }

  decideProposal(input: {
    swarm_id: string;
    session_id: string;
    task_id?: string;
    proposal_id: string;
    decider: AgentAddress;
    status: Extract<BlackboardDecisionStatus, "accepted" | "rejected" | "superseded">;
    value?: unknown;
    tags?: string[];
    metadata?: BlackboardCollaborationMetadata;
  }): BlackboardEntry {
    const decisionId = input.metadata?.decision_id ? String(input.metadata.decision_id) : `decision_${randomUUID()}`;
    return this.write({
      swarm_id: input.swarm_id,
      session_id: input.session_id,
      task_id: input.task_id,
      key: `proposal/${input.proposal_id}/decision/${decisionId}`,
      type: "decision",
      value: input.value ?? {
        proposal_id: input.proposal_id,
        status: input.status
      },
      created_by: input.decider,
      tags: uniqueStrings([...(input.tags ?? []), "blackboard", "proposal", "decision", input.status]),
      metadata: {
        ...input.metadata,
        kind: "decision",
        proposal_id: input.proposal_id,
        decision_id: decisionId,
        decision_status: input.status,
        owner_agent_id: input.decider.agent_id
      }
    });
  }

  recordResult(input: {
    swarm_id: string;
    session_id: string;
    task_id?: string;
    result_id?: string;
    actor: AgentAddress;
    value: unknown;
    proposal_id?: string;
    claim_key?: string;
    tags?: string[];
    metadata?: BlackboardCollaborationMetadata;
  }): BlackboardEntry {
    const resultId = input.result_id ?? `result_${randomUUID()}`;
    return this.write({
      swarm_id: input.swarm_id,
      session_id: input.session_id,
      task_id: input.task_id,
      key: `result/${resultId}`,
      type: "result",
      value: input.value,
      created_by: input.actor,
      tags: uniqueStrings([...(input.tags ?? []), "blackboard", "result"]),
      metadata: {
        ...input.metadata,
        kind: "result",
        result_id: resultId,
        proposal_id: input.proposal_id,
        claim_key: input.claim_key,
        owner_agent_id: input.actor.agent_id
      }
    });
  }

  subscribe(input: {
    session_id: string;
    subscriber: AgentAddress;
    filter: BlackboardSubscriptionFilter;
    ttl_ms?: number;
    expires_at?: string;
    source_envelope_id?: string;
    correlation_id?: string;
  }): BlackboardSubscriptionRecord {
    const now = new Date().toISOString();
    const expiresAt = input.expires_at ?? (input.ttl_ms ? new Date(Date.now() + input.ttl_ms).toISOString() : undefined);
    const record: BlackboardSubscriptionRecord = {
      subscription_id: `bb_sub_${randomUUID()}`,
      session_id: input.session_id,
      subscriber: input.subscriber,
      filter: input.filter,
      source_envelope_id: input.source_envelope_id,
      correlation_id: input.correlation_id,
      created_at: now,
      expires_at: expiresAt
    };
    this.database.db
      .prepare(
        `INSERT INTO blackboard_subscriptions (
          subscription_id, session_id, subscriber_json, filter_json,
          source_envelope_id, correlation_id, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.subscription_id,
        record.session_id,
        JSON.stringify(record.subscriber),
        JSON.stringify(record.filter),
        record.source_envelope_id ?? null,
        record.correlation_id ?? null,
        record.created_at,
        record.expires_at ?? null
      );
    this.recordEvent({
      swarm_id: `swarm_${record.session_id}`,
      session_id: record.session_id,
      key: `subscription/${record.subscription_id}`,
      kind: "subscription",
      actor: record.subscriber,
      source_envelope_id: record.source_envelope_id,
      correlation_id: record.correlation_id,
      metadata: {
        subscription_id: record.subscription_id,
        filter: record.filter,
        expires_at: record.expires_at
      }
    });
    return record;
  }

  listSubscriptions(sessionId: string, options: { includeExpired?: boolean; now?: string } = {}): BlackboardSubscriptionRecord[] {
    const rows = this.database.db
      .prepare("SELECT * FROM blackboard_subscriptions WHERE session_id = ? ORDER BY created_at ASC")
      .all(sessionId) as BlackboardSubscriptionRow[];
    const now = options.now ?? new Date().toISOString();
    return rows
      .map(fromSubscriptionRow)
      .filter((record) => options.includeExpired || !isExpiredIso(record.expires_at, now));
  }

  getSubscription(subscriptionId: string): BlackboardSubscriptionRecord | undefined {
    const row = this.database.db
      .prepare("SELECT * FROM blackboard_subscriptions WHERE subscription_id = ?")
      .get(subscriptionId) as BlackboardSubscriptionRow | undefined;
    return row ? fromSubscriptionRow(row) : undefined;
  }

  entriesForSubscription(subscriptionId: string, options: { limit?: number; now?: string } = {}): BlackboardEntry[] {
    const subscription = this.getSubscription(subscriptionId);
    if (!subscription || isExpiredIso(subscription.expires_at, options.now ?? new Date().toISOString())) {
      return [];
    }
    const entries = this.query(subscription.session_id, subscription.filter);
    const limit = options.limit && options.limit > 0 ? options.limit : entries.length;
    return entries.slice(Math.max(0, entries.length - limit));
  }

  list(sessionId: string): BlackboardEntry[] {
    const rows = this.database.db
      // Tie-break equal millisecond timestamps by insertion order (rowid) so
      // list()/query()/getActiveClaim() are deterministic when several entries
      // are written in the same millisecond (e.g. expire-then-reclaim flows).
      .prepare("SELECT * FROM blackboard_entries WHERE session_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(sessionId) as BlackboardRow[];
    return rows.map(fromRow);
  }

  listRecent(limit = 50): BlackboardEntry[] {
    const rows = this.database.db
      .prepare("SELECT * FROM blackboard_entries ORDER BY created_at DESC LIMIT ?")
      .all(limit) as BlackboardRow[];
    return rows.map(fromRow);
  }

  listForTasks(sessionId: string, taskIds: string[]): BlackboardEntry[] {
    if (taskIds.length === 0) {
      return [];
    }

    const allEntries = this.list(sessionId);
    return allEntries.filter((entry) => entry.task_id && taskIds.includes(entry.task_id));
  }

  read(sessionId: string, input: { entryId?: string; key?: string; limit?: number; subscriptionId?: string }): BlackboardEntry[] {
    if (input.subscriptionId) {
      return this.entriesForSubscription(input.subscriptionId, { limit: input.limit });
    }
    if (input.entryId) {
      const entry = this.getByEntryId(sessionId, input.entryId);
      return entry ? [entry] : [];
    }
    if (input.key) {
      const entries = this.list(sessionId).filter((entry) => entry.key === input.key);
      const limit = input.limit && input.limit > 0 ? input.limit : entries.length;
      return entries.slice(Math.max(0, entries.length - limit));
    }
    const limit = input.limit && input.limit > 0 ? input.limit : 50;
    return this.list(sessionId).slice(-limit);
  }

  query(sessionId: string, input: BlackboardQuery = {}): BlackboardEntry[] {
    return this.list(sessionId).filter((entry) => {
      if (input.type && entry.type !== input.type) return false;
      if (input.taskId && entry.task_id !== input.taskId) return false;
      if (input.keyPrefix && !entry.key.startsWith(input.keyPrefix)) return false;
      if (input.tag && !(entry.tags ?? []).includes(input.tag)) return false;
      if (input.agentId && entry.created_by.agent_id !== input.agentId) return false;
      if (input.claimKey && entry.metadata?.claim_key !== input.claimKey) return false;
      if (input.proposalId && entry.metadata?.proposal_id !== input.proposalId) return false;
      if (input.kind && entry.metadata?.kind !== input.kind) return false;
      if (input.decisionStatus && entry.metadata?.decision_status !== input.decisionStatus) return false;
      if (input.ownerAgentId && entry.metadata?.owner_agent_id !== input.ownerAgentId) return false;
      if (input.sourceEnvelopeId && !(entry.metadata?.source_envelope_ids ?? [entry.metadata?.source_envelope_id]).includes(input.sourceEnvelopeId)) return false;
      return true;
    });
  }

  listEvents(sessionId: string, input: { kind?: BlackboardCollaborationKind; key?: string; sourceEnvelopeId?: string } = {}): BlackboardEventRecord[] {
    const rows = this.database.db
      .prepare("SELECT * FROM blackboard_events WHERE session_id = ? ORDER BY created_at ASC")
      .all(sessionId) as BlackboardEventRow[];
    return rows.map(fromEventRow).filter((event) => {
      if (input.kind && event.kind !== input.kind) return false;
      if (input.key && event.key !== input.key) return false;
      if (input.sourceEnvelopeId && event.source_envelope_id !== input.sourceEnvelopeId) return false;
      return true;
    });
  }

  private getByEntryId(sessionId: string, entryId: string): BlackboardEntry | undefined {
    return this.list(sessionId).find((entry) => entry.entry_id === entryId);
  }

  private getLatestByKey(sessionId: string, key: string): BlackboardEntry | undefined {
    return [...this.list(sessionId)].reverse().find((entry) => entry.key === key);
  }

  private latestClaimEntry(sessionId: string, claimKey: string): BlackboardEntry | undefined {
    return this.query(sessionId, { claimKey }).at(-1);
  }

  private recordEvent(input: {
    swarm_id: string;
    session_id: string;
    task_id?: string;
    key: string;
    kind: BlackboardCollaborationKind;
    actor: AgentAddress;
    source_envelope_id?: string;
    correlation_id?: string;
    metadata?: Record<string, unknown>;
  }): BlackboardEventRecord {
    const record: BlackboardEventRecord = {
      event_id: `bb_event_${randomUUID()}`,
      swarm_id: input.swarm_id,
      session_id: input.session_id,
      task_id: input.task_id,
      key: input.key,
      kind: input.kind,
      actor: input.actor,
      source_envelope_id: input.source_envelope_id,
      correlation_id: input.correlation_id,
      metadata: input.metadata ?? {},
      created_at: new Date().toISOString()
    };
    this.database.db
      .prepare(
        `INSERT INTO blackboard_events (
          event_id, swarm_id, session_id, task_id, key, kind, actor_json,
          source_envelope_id, correlation_id, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.event_id,
        record.swarm_id,
        record.session_id,
        record.task_id ?? null,
        record.key,
        record.kind,
        JSON.stringify(record.actor),
        record.source_envelope_id ?? null,
        record.correlation_id ?? null,
        JSON.stringify(record.metadata),
        record.created_at
      );
    return record;
  }
}

type BlackboardRow = {
  entry_id: string;
  session_id: string;
  swarm_id: string;
  task_id?: string | null;
  key: string;
  type: BlackboardEntry["type"];
  value_json: string;
  created_by_json: string;
  visibility: BlackboardEntry["visibility"];
  version: number;
  tags_json?: string | null;
  metadata_json?: string | null;
  created_at: string;
  updated_at?: string | null;
};

type BlackboardEventRow = {
  event_id: string;
  swarm_id: string;
  session_id: string;
  task_id?: string | null;
  key: string;
  kind: BlackboardCollaborationKind;
  actor_json: string;
  source_envelope_id?: string | null;
  correlation_id?: string | null;
  metadata_json: string;
  created_at: string;
};

type BlackboardSubscriptionRow = {
  subscription_id: string;
  session_id: string;
  subscriber_json: string;
  filter_json: string;
  source_envelope_id?: string | null;
  correlation_id?: string | null;
  created_at: string;
  expires_at?: string | null;
};

function fromRow(row: BlackboardRow): BlackboardEntry {
  return {
    entry_id: row.entry_id,
    session_id: row.session_id,
    swarm_id: row.swarm_id,
    task_id: row.task_id ?? undefined,
    key: row.key,
    type: row.type,
    value: parseJsonField(row.value_json, undefined),
    created_by: parseJsonField<AgentAddress>(row.created_by_json, {}),
    visibility: row.visibility,
    version: row.version,
    tags: parseJsonField<string[]>(row.tags_json, []),
    metadata: parseJsonField<BlackboardCollaborationMetadata | undefined>(row.metadata_json, undefined),
    created_at: row.created_at,
    updated_at: row.updated_at ?? undefined
  };
}

function fromEventRow(row: BlackboardEventRow): BlackboardEventRecord {
  return {
    event_id: row.event_id,
    swarm_id: row.swarm_id,
    session_id: row.session_id,
    task_id: row.task_id ?? undefined,
    key: row.key,
    kind: row.kind,
    actor: parseJsonField<AgentAddress>(row.actor_json, {}),
    source_envelope_id: row.source_envelope_id ?? undefined,
    correlation_id: row.correlation_id ?? undefined,
    metadata: parseJsonField<Record<string, unknown>>(row.metadata_json, {}),
    created_at: row.created_at
  };
}

function fromSubscriptionRow(row: BlackboardSubscriptionRow): BlackboardSubscriptionRecord {
  return {
    subscription_id: row.subscription_id,
    session_id: row.session_id,
    subscriber: parseJsonField<AgentAddress>(row.subscriber_json, {}),
    filter: parseJsonField<BlackboardSubscriptionFilter>(row.filter_json, {}),
    source_envelope_id: row.source_envelope_id ?? undefined,
    correlation_id: row.correlation_id ?? undefined,
    created_at: row.created_at,
    expires_at: row.expires_at ?? undefined
  };
}

function normalizeMetadata(
  metadata: BlackboardCollaborationMetadata | undefined,
  fallbackKind: BlackboardCollaborationKind,
  actor: AgentAddress
): BlackboardCollaborationMetadata {
  const next: BlackboardCollaborationMetadata = {
    kind: fallbackKind,
    ...metadata
  };
  next.kind = next.kind ?? fallbackKind;
  next.source_agent_id = next.source_agent_id ?? actor.agent_id;
  if (next.source_envelope_id) {
    next.source_envelope_ids = uniqueStrings([...(next.source_envelope_ids ?? []), next.source_envelope_id]);
  }
  return next;
}

function mergeMetadata(
  existing: BlackboardCollaborationMetadata | undefined,
  incoming: BlackboardCollaborationMetadata | undefined,
  fallbackKind: BlackboardCollaborationKind,
  actor: AgentAddress
): BlackboardCollaborationMetadata {
  const next = normalizeMetadata({
    ...(existing ?? {}),
    ...(incoming ?? {}),
    source_envelope_ids: uniqueStrings([
      ...(existing?.source_envelope_ids ?? []),
      ...(incoming?.source_envelope_ids ?? []),
      ...(existing?.source_envelope_id ? [existing.source_envelope_id] : []),
      ...(incoming?.source_envelope_id ? [incoming.source_envelope_id] : [])
    ])
  }, fallbackKind, actor);
  next.kind = incoming?.kind ?? fallbackKind;
  return next;
}

function causalityOnly(metadata: BlackboardCollaborationMetadata | undefined): BlackboardCausality {
  return {
    source_envelope_id: metadata?.source_envelope_id,
    correlation_id: metadata?.correlation_id,
    reply_to: metadata?.reply_to
  };
}

function isExpiredIso(expiresAt: string | undefined, now: string): boolean {
  if (!expiresAt) {
    return false;
  }
  const expiresMs = Date.parse(expiresAt);
  const nowMs = Date.parse(now);
  return Number.isFinite(expiresMs) && Number.isFinite(nowMs) && expiresMs <= nowMs;
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
  return [...new Set(values.map((item) => item?.trim()).filter((item): item is string => Boolean(item)))];
}
