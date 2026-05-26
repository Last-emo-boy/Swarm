import type { SwarmRuntime } from "../runtime/runtime.js";
import { summarizeMcpCatalog, summarizeSkillCatalog } from "../extensions/catalog-summary.js";
import { buildCapabilityDirectory } from "../extensions/capability-directory.js";
import { buildCapabilityParticipantSnapshot } from "../extensions/capability-participants.js";
import { mcpSettingsSnapshot } from "../extensions/mcp-report.js";
import { skillSettingsSnapshot } from "../extensions/skill-report.js";
import { policyFromActor, type AgentAutonomyPolicy } from "../runtime/agent-autonomy-policy.js";
import { auditLegacyDirectPaths } from "../runtime/legacy-direct-path-audit.js";
import { liveControlFromCounts, liveControlFromSessionStatus } from "../runtime/live-control-status.js";
import { buildProtocolReplay, type ProtocolReplayBlackboard, type ProtocolReplaySquad } from "../runtime/protocol-replay.js";
import { buildSessionWorkBoard, buildWorkspaceWorkBoard } from "../runtime/work-board.js";
import type { AgentActorKind, AgentActorRecord, AgentMailboxProjection } from "../storage/agent-actor-store.js";
import type { AgentMemoryProjection } from "../storage/agent-memory-store.js";

type ExtensionSnapshot = {
  mcp: {
    settings: ReturnType<typeof mcpSettingsSnapshot>;
    summary: ReturnType<typeof summarizeMcpCatalog>;
    servers: ReturnType<SwarmRuntime["listMcpServers"]>;
  };
  skills: {
    settings: ReturnType<typeof skillSettingsSnapshot>;
    summary: ReturnType<typeof summarizeSkillCatalog>;
    skills: ReturnType<SwarmRuntime["listSkills"]>;
  };
  capability_participants: ReturnType<typeof buildCapabilityParticipantSnapshot>;
  capability_directory: ReturnType<typeof buildCapabilityDirectory>;
};

type SwarmProtocolActorProjection = {
  actor_id: string;
  kind: AgentActorKind;
  name: string;
  role: string;
  status: string;
  heartbeat_state: string;
  capabilities: string[];
  current_task_id?: string;
  current_worker_id?: string;
  current_session_id?: string;
  current_ownership?: Record<string, unknown>;
  last_heartbeat_at?: string;
  updated_at: string;
  mailbox: AgentMailboxProjection;
  memory: Pick<AgentMemoryProjection, "health" | "entries" | "last_learned_at" | "last_compacted_at" | "last_source_envelope_id" | "cache_stable_summary_hash" | "frozen" | "cleared_at">;
  autonomy_policy: {
    attached: boolean;
    level: AgentAutonomyPolicy["level"] | "legacy";
    allowed_envelope_types: number;
    denied_envelope_types: number;
    capability_leases: number;
    active_capability_leases: number;
    revoked_capability_leases: number;
  };
};

type SwarmProtocolSnapshot = {
  schema_version: "swarm.protocol_projection.v1";
  session_id?: string;
  actors: SwarmProtocolActorProjection[];
  mailbox: {
    pending: number;
    delivered: number;
    acked: number;
    failed: number;
    recent_messages: ReturnType<SwarmRuntime["agentActorStore"]["listMailboxMessages"]>;
  };
  legacy_direct_path_audit: ReturnType<typeof auditLegacyDirectPaths>;
  blackboard: ProtocolReplayBlackboard;
  squads: ProtocolReplaySquad[];
  summary: {
    actors: number;
    active_actors: number;
    squads: number;
    active_squads: number;
    by_kind: Record<string, number>;
    mailbox_pending: number;
    mailbox_failed: number;
    blackboard_decisions: number;
    blackboard_unresolved_proposals: number;
    agent_memory_ready: number;
    agent_memory_frozen: number;
    autonomy_policy_attached: number;
    legacy_compatibility_actors: number;
    legacy_audit_status: ReturnType<typeof auditLegacyDirectPaths>["status"];
    legacy_direct_path_exceptions: number;
  };
};

export function buildSessionSnapshot(
  runtime: SwarmRuntime,
  sessionId: string,
  options: {
    approvals?: Record<string, unknown>;
  } = {}
): Record<string, unknown> {
  const row = runtime.sessionStore.get(sessionId);
  if (!row) {
    throw new Error(`Unknown session: ${sessionId}`);
  }
  const workSnapshot = runtime.getWorkSnapshot(sessionId);
  const workBoard = buildSessionWorkBoard(runtime, sessionId);
  const approvalSummary = options.approvals ? approvalSummaryFromView(options.approvals) : undefined;
  const extensionSnapshot = buildExtensionSnapshot(runtime);
  const swarmProtocol = buildSwarmProtocolSnapshot(runtime, sessionId);
  return {
    ...row,
    policy: parseJson(row.policy_json),
    participants: parseJson(row.participants_json),
    plan: row.plan_json ? parseJson(row.plan_json) : undefined,
    live_control: liveControlFromSessionStatus({
      status: row.status,
      source: "gateway.session",
      pendingApprovals: approvalSummary?.actionable_pending,
      blocked: workSnapshot.task_contracts.summary.blocked,
      failed: workSnapshot.task_contracts.summary.failed,
      summary: `gateway.session ${row.session_id}: ${row.status}`
    }),
    graph: runtime.getTaskGraph(sessionId),
    usage_summary: runtime.usageStore.summarize(sessionId),
    work_board: workBoard,
    work_snapshot: workSnapshot,
    task_contracts: workSnapshot.task_contracts,
    work_contracts: workSnapshot.work_contracts,
    swarm_protocol: swarmProtocol,
    extensions: extensionSnapshot,
    mcp_servers: extensionSnapshot.mcp.servers,
    skills: extensionSnapshot.skills.skills
  };
}

export function buildWorkspaceSnapshot(
  runtime: SwarmRuntime,
  options: {
    limit?: number;
    approvals?: Record<string, unknown>;
  } = {}
): Record<string, unknown> {
  const limit = normalizeLimit(options.limit, 20);
  const sessions = runtime.listRecentSessionsForWorkspace(limit);
  const workContracts = runtime.getWorkspaceContractSnapshot(limit);
  const approvals = options.approvals ?? buildPersistedApprovalOverview(runtime, limit);
  const approvalSummary = approvalSummaryFromView(approvals);
  const activeLiveTarget = runtime.getActiveLiveTarget() ?? null;
  const workBoard = buildWorkspaceWorkBoard(runtime, { limit });
  const activeSessions = sessions.filter((session) => isActiveSessionStatus(session.status)).length;
  const failedSessions = sessions.filter((session) => session.status === "failed" || session.status === "cancelled").length;
  const completedSessions = sessions.filter((session) => session.status === "completed").length;
  const extensionSnapshot = buildExtensionSnapshot(runtime);
  const swarmProtocol = buildSwarmProtocolSnapshot(runtime);
  return {
    workspace_path: runtime.getWorkspacePath(),
    active_live_target: activeLiveTarget,
    live_control: liveControlFromCounts({
      source: "gateway.workspace",
      total: sessions.length,
      running: activeSessions,
      completed: completedSessions,
      failed: failedSessions,
      pendingApprovals: approvalSummary.actionable_pending,
      summary: `gateway.workspace sessions=${sessions.length} active=${activeSessions} approvals=${approvalSummary.actionable_pending}`
    }),
    sessions,
    approvals,
    work_board: workBoard,
    work_contracts: workContracts,
    swarm_protocol: swarmProtocol,
    extensions: extensionSnapshot,
    mcp_servers: extensionSnapshot.mcp.servers,
    skills: extensionSnapshot.skills.skills,
    summary: {
      sessions: sessions.length,
      active_sessions: activeSessions,
      active_live_session_id: activeLiveTarget?.session_id,
      actionable_pending_approvals: approvalSummary.actionable_pending,
      persisted_pending_approvals: approvalSummary.persisted_pending,
      work_board_blocked: workBoard.summary.blocked,
      work_board_failed: workBoard.summary.failed,
      work_board_resumable: workBoard.summary.resumable,
      total_workers: workContracts.active_workers.length + workContracts.resumable_workers.length,
      active_handoffs: workContracts.active_handoffs.length,
      swarm_protocol_actors: swarmProtocol.summary.actors,
      swarm_protocol_pending_mailbox: swarmProtocol.summary.mailbox_pending,
      swarm_protocol_legacy_exceptions: swarmProtocol.summary.legacy_direct_path_exceptions,
      mcp_servers: extensionSnapshot.mcp.servers.length,
      skills: extensionSnapshot.skills.skills.length
    }
  };
}

function buildSwarmProtocolSnapshot(runtime: SwarmRuntime, sessionId?: string): SwarmProtocolSnapshot {
  const actors = runtime.agentActorStore
    .list()
    .filter((actor) => actorBelongsToProtocolView(runtime, actor, sessionId))
    .map((actor) => projectActor(runtime, actor));
  const recentMessages = actors.flatMap((actor) => [
    ...runtime.agentActorStore.listMailboxMessages(actor.actor_id, "inbox", { limit: 10 }),
    ...runtime.agentActorStore.listMailboxMessages(actor.actor_id, "outbox", { limit: 10 })
  ])
    .filter((message) => !sessionId || message.session_id === sessionId)
    .sort((left, right) => left.queued_at.localeCompare(right.queued_at))
    .slice(-50);
  const audit = auditLegacyDirectPaths();
  const mailbox = actors.reduce((summary, actor) => ({
    pending: summary.pending + actor.mailbox.inbox_pending + actor.mailbox.outbox_pending,
    delivered: summary.delivered + actor.mailbox.inbox_delivered + actor.mailbox.outbox_delivered,
    acked: summary.acked + actor.mailbox.inbox_acked + actor.mailbox.outbox_acked,
    failed: summary.failed + actor.mailbox.inbox_failed + actor.mailbox.outbox_failed
  }), { pending: 0, delivered: 0, acked: 0, failed: 0 });
  const byKind = actors.reduce<Record<string, number>>((counts, actor) => {
    counts[actor.kind] = (counts[actor.kind] ?? 0) + 1;
    return counts;
  }, {});
  const policyAttached = actors.filter((actor) => actor.autonomy_policy.attached).length;
  const protocolReplay = buildProtocolReplay({
    sessionId,
    envelopes: sessionId ? runtime.traceStore.list(sessionId) : [],
    deliveries: sessionId ? runtime.envelopeDeliveryStore.list({ sessionId }) : [],
    actors: runtime.agentActorStore.list(),
    blackboard: sessionId
      ? runtime.blackboardStore.list(sessionId)
      : runtime.listRecentBlackboardForWorkspace(200)
  });
  const blackboardReplay = protocolReplay.blackboard;
  return {
    schema_version: "swarm.protocol_projection.v1",
    session_id: sessionId,
    actors,
    mailbox: {
      ...mailbox,
      recent_messages: recentMessages
    },
    legacy_direct_path_audit: audit,
    blackboard: blackboardReplay,
    squads: protocolReplay.squads,
    summary: {
      actors: actors.length,
      active_actors: actors.filter((actor) => actor.status !== "offline").length,
      squads: protocolReplay.squads.length,
      active_squads: protocolReplay.squads.filter((squad) => squad.status === "active").length,
      by_kind: byKind,
      mailbox_pending: mailbox.pending,
      mailbox_failed: mailbox.failed,
      blackboard_decisions: blackboardReplay.decision_history.length,
      blackboard_unresolved_proposals: blackboardReplay.unresolved_proposals.length,
      agent_memory_ready: actors.filter((actor) => actor.memory.health === "active").length,
      agent_memory_frozen: actors.filter((actor) => actor.memory.frozen).length,
      autonomy_policy_attached: policyAttached,
      legacy_compatibility_actors: actors.length - policyAttached,
      legacy_audit_status: audit.status,
      legacy_direct_path_exceptions: audit.summary.exceptions
    }
  };
}

function actorBelongsToProtocolView(runtime: SwarmRuntime, actor: AgentActorRecord, sessionId?: string): boolean {
  if (!sessionId) {
    return true;
  }
  if (["main", "router", "blackboard", "symphony", "gateway"].includes(actor.kind)) {
    return true;
  }
  if (actor.current_session_id === sessionId) {
    return true;
  }
  return runtime.agentActorStore.listMailboxMessages(actor.actor_id, "inbox", { limit: 100 })
    .some((message) => message.session_id === sessionId) ||
    runtime.agentActorStore.listMailboxMessages(actor.actor_id, "outbox", { limit: 100 })
      .some((message) => message.session_id === sessionId);
}

function projectActor(runtime: SwarmRuntime, actor: AgentActorRecord): SwarmProtocolActorProjection {
  return {
    actor_id: actor.actor_id,
    kind: actor.kind,
    name: actor.name,
    role: actor.role,
    status: actor.status,
    heartbeat_state: actor.heartbeat_state,
    capabilities: actor.capabilities,
    current_task_id: actor.current_task_id,
    current_worker_id: actor.current_worker_id,
    current_session_id: actor.current_session_id,
    current_ownership: actor.current_ownership,
    last_heartbeat_at: actor.last_heartbeat_at,
    updated_at: actor.updated_at,
    mailbox: runtime.agentActorStore.mailbox(actor.actor_id),
    memory: projectActorMemory(runtime.agentMemoryStore.project(actor.actor_id)),
    autonomy_policy: projectPolicy(actor)
  };
}

function projectActorMemory(memory: AgentMemoryProjection): SwarmProtocolActorProjection["memory"] {
  return {
    health: memory.health,
    entries: memory.entries,
    last_learned_at: memory.last_learned_at,
    last_compacted_at: memory.last_compacted_at,
    last_source_envelope_id: memory.last_source_envelope_id,
    cache_stable_summary_hash: memory.cache_stable_summary_hash,
    frozen: memory.frozen,
    cleared_at: memory.cleared_at
  };
}

function projectPolicy(actor: AgentActorRecord): SwarmProtocolActorProjection["autonomy_policy"] {
  const policy = policyFromActor(actor);
  if (!policy) {
    return {
      attached: false,
      level: "legacy",
      allowed_envelope_types: 0,
      denied_envelope_types: 0,
      capability_leases: 0,
      active_capability_leases: 0,
      revoked_capability_leases: 0
    };
  }
  const leases = policy.capability_leases ?? [];
  return {
    attached: true,
    level: policy.level,
    allowed_envelope_types: policy.allowed_envelope_types?.length ?? 0,
    denied_envelope_types: policy.denied_envelope_types?.length ?? 0,
    capability_leases: leases.length,
    active_capability_leases: leases.filter((lease) => lease.status !== "revoked").length,
    revoked_capability_leases: leases.filter((lease) => lease.status === "revoked").length
  };
}

function buildExtensionSnapshot(runtime: SwarmRuntime): ExtensionSnapshot {
  const mcpSettings = mcpSettingsSnapshot(runtime);
  const skillSettings = skillSettingsSnapshot(runtime);
  const mcpServers = runtime.listMcpServers();
  const skills = runtime.listSkills();
  const mcpSummary = summarizeMcpCatalog(mcpServers, mcpSettings);
  const skillSummary = summarizeSkillCatalog(skills, skillSettings);
  const capabilityParticipants = buildCapabilityParticipantSnapshot({
    mcpServers,
    mcpSummary,
    skills
  });
  return {
    mcp: {
      settings: mcpSettings,
      summary: mcpSummary,
      servers: mcpServers
    },
    skills: {
      settings: skillSettings,
      summary: skillSummary,
      skills
    },
    capability_participants: capabilityParticipants,
    capability_directory: buildCapabilityDirectory({
      actors: runtime.agentActorStore.list(),
      capabilityParticipants
    })
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function buildPersistedApprovalOverview(runtime: SwarmRuntime, limit: number): Record<string, unknown> {
  const approvals = runtime.listRecentApprovalsForWorkspace(limit);
  return {
    session_id: undefined,
    pending_requests: [],
    actionable_approval_ids: [],
    approvals,
    summary: {
      actionable_pending: 0,
      persisted_pending: approvals.filter((approval) => approval.status === "pending").length,
      approved: approvals.filter((approval) => approval.status === "approved").length,
      denied: approvals.filter((approval) => approval.status === "denied").length
    }
  };
}

function approvalSummaryFromView(view: Record<string, unknown>): {
  actionable_pending: number;
  persisted_pending: number;
  approved: number;
  denied: number;
} {
  const summary = recordValue(view.summary);
  return {
    actionable_pending: numberValue(summary?.actionable_pending),
    persisted_pending: numberValue(summary?.persisted_pending),
    approved: numberValue(summary?.approved),
    denied: numberValue(summary?.denied)
  };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.floor(value as number)
    : fallback;
}

function isActiveSessionStatus(status: string): boolean {
  return status === "created" || status === "planning" || status === "running" || status === "reviewing" || status === "aggregating";
}
