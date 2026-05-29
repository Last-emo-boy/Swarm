import type { BlackboardEntry } from "../protocol/types.js";
import type { WorkBoard } from "../runtime/work-board.js";
import type { SwarmRuntime } from "../runtime/runtime.js";
import type { AgentActorRecord, AgentMailboxMessage, AgentMailboxProjection } from "../storage/agent-actor-store.js";
import type { AgentMemoryProjection } from "../storage/agent-memory-store.js";
import type { HandoffSessionRecord } from "../storage/handoff-store.js";
import { displayWidth, sliceByDisplayWidth } from "./display-width.js";

export type SwarmSurfaceMode = "summary" | "agent" | "mailbox" | "ownership";

export type SwarmSurfaceActor = AgentActorRecord & {
  mailbox: AgentMailboxProjection;
  inbox: AgentMailboxMessage[];
  outbox: AgentMailboxMessage[];
  memory: Pick<AgentMemoryProjection, "health" | "entries" | "last_learned_at" | "last_compacted_at" | "last_source_envelope_id" | "cache_stable_summary_hash" | "frozen" | "cleared_at">;
};

export type SwarmOwnershipItem = {
  kind: "actor_task" | "handoff" | "blackboard_claim" | "blackboard_decision";
  id: string;
  owner?: string;
  session_id?: string;
  task_id?: string;
  status: string;
  severity: "info" | "warning" | "error";
  summary: string;
  policy?: string;
  waiting_for?: string;
  envelope_id?: string;
  correlation_id?: string;
};

export type SwarmConflictItem = {
  kind: "heartbeat" | "handoff" | "blackboard";
  id: string;
  owner?: string;
  session_id?: string;
  severity: "warning" | "error";
  summary: string;
  envelope_id?: string;
};

export type SwarmNegotiationItem = {
  negotiation_id: string;
  action?: string;
  status: string;
  from?: string;
  to?: string;
  session_id: string;
  task_id?: string;
  summary: string;
  envelope_id?: string;
};

export type SwarmSquadMemberItem = {
  agent_id: string;
  role?: string;
  status: "active" | "left" | "unknown";
  capabilities: string[];
};

export type SwarmSquadItem = {
  squad_id: string;
  action?: string;
  status: string;
  leader?: string;
  members: SwarmSquadMemberItem[];
  session_id: string;
  task_id?: string;
  summary: string;
  envelope_id?: string;
};

export type SwarmSurfaceProjection = {
  generated_at: string;
  actors: SwarmSurfaceActor[];
  ownership: SwarmOwnershipItem[];
  conflicts: SwarmConflictItem[];
  negotiations: SwarmNegotiationItem[];
  squads: SwarmSquadItem[];
  handoffs: HandoffSessionRecord[];
  blackboard: BlackboardEntry[];
  work_board?: WorkBoard;
  summary: {
    participants: number;
    active_participants: number;
    stale_participants: number;
    inbox_pending: number;
    outbox_pending: number;
    ownership_items: number;
    conflicts: number;
    negotiations: number;
    squads: number;
  };
};

export function buildSwarmSurfaceProjection(input: {
  runtime: Pick<SwarmRuntime, "agentActorStore" | "agentMemoryStore" | "listHandoffsForWorkspace" | "listRecentBlackboardForWorkspace">;
  workBoard?: WorkBoard;
  now?: string;
  limit?: number;
}): SwarmSurfaceProjection {
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 30)));
  const now = input.now ?? new Date().toISOString();
  const actors = input.runtime.agentActorStore.list({ now }).slice(0, limit).map((actor) => ({
    ...actor,
    mailbox: input.runtime.agentActorStore.mailbox(actor.actor_id),
    inbox: input.runtime.agentActorStore.listMailboxMessages(actor.actor_id, "inbox", { limit: 8 }),
    outbox: input.runtime.agentActorStore.listMailboxMessages(actor.actor_id, "outbox", { limit: 8 }),
    memory: projectSurfaceActorMemory(input.runtime.agentMemoryStore.project(actor.actor_id))
  }));
  const handoffs = input.runtime.listHandoffsForWorkspace(limit);
  const blackboard = input.runtime.listRecentBlackboardForWorkspace(limit);
  const ownership = [
    ...actors.flatMap(actorOwnershipItem),
    ...handoffs.map(handoffOwnershipItem),
    ...blackboard.flatMap(blackboardOwnershipItems)
  ];
  const negotiations = summarizeNegotiations(blackboard);
  const squads = summarizeSquads(blackboard);
  const conflicts = [
    ...actors.filter((actor) => actor.heartbeat_state === "stale" || actor.heartbeat_state === "offline" || actor.heartbeat_state === "blocked").map(actorConflictItem),
    ...handoffs.filter((handoff) => handoff.protocol_status === "conflict" || handoff.protocol_status === "timeout" || handoff.protocol_status === "stale").map(handoffConflictItem),
    ...blackboard.filter((entry) => entry.metadata?.kind === "claim_conflict" || entry.metadata?.claim_status === "conflict").map(blackboardConflictItem)
  ];
  return {
    generated_at: now,
    actors,
    ownership,
    conflicts,
    negotiations,
    squads,
    handoffs,
    blackboard,
    work_board: input.workBoard,
    summary: {
      participants: actors.length,
      active_participants: actors.filter((actor) => actor.status === "busy" || actor.status === "idle").length,
      stale_participants: actors.filter((actor) => actor.heartbeat_state === "stale" || actor.heartbeat_state === "offline" || actor.heartbeat_state === "blocked").length,
      inbox_pending: actors.reduce((sum, actor) => sum + actor.mailbox.inbox_pending + actor.mailbox.inbox_failed, 0),
      outbox_pending: actors.reduce((sum, actor) => sum + actor.mailbox.outbox_pending + actor.mailbox.outbox_failed, 0),
      ownership_items: ownership.length,
      conflicts: conflicts.length,
      negotiations: negotiations.length,
      squads: squads.length
    }
  };
}

export function formatSwarmSurface(
  surface: SwarmSurfaceProjection,
  options: {
    mode?: SwarmSurfaceMode;
    actorId?: string;
    limit?: number;
  } = {}
): string {
  const mode = options.mode ?? "summary";
  const limit = Math.max(1, Math.min(80, Math.floor(options.limit ?? 12)));
  const actor = options.actorId ? surface.actors.find((item) => item.actor_id === options.actorId) : undefined;
  if ((mode === "agent" || mode === "mailbox") && options.actorId && !actor) {
    return [
      "Shared Board",
      summaryLine(surface),
      "",
      `${mode === "agent" ? "Agent" : "Mailbox"} ${options.actorId}`,
      "(not found)"
    ].join("\n");
  }
  return [
    "Shared Board",
    summaryLine(surface),
    surface.work_board ? `work_board sessions=${surface.work_board.summary.sessions} workers=${surface.work_board.summary.workers} claims=${surface.work_board.summary.claims} blocked=${surface.work_board.summary.blocked} failed=${surface.work_board.summary.failed}` : undefined,
    "",
    ...(mode === "ownership"
      ? ownershipSection(surface, limit)
      : mode === "agent"
        ? agentSection(actor, surface, limit)
        : mode === "mailbox"
          ? mailboxSection(actor, limit)
          : summarySections(surface, limit))
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function formatSwarmTopologySummary(surface: SwarmSurfaceProjection): string {
  return summaryLine(surface);
}

export function formatSwarmWorkbench(
  surface: SwarmSurfaceProjection,
  options: {
    mode?: SwarmSurfaceMode;
    actorId?: string;
    columns?: number;
    rows?: number;
    limit?: number;
  } = {}
): string {
  const columns = Math.max(40, Math.min(200, Math.floor(options.columns ?? 120)));
  const rows = Math.max(8, Math.min(200, Math.floor(options.rows ?? 40)));
  const limit = Math.max(1, Math.min(80, Math.floor(options.limit ?? (columns < 100 ? 5 : 10))));
  const mode = options.mode ?? "summary";
  const actor = options.actorId ? surface.actors.find((item) => item.actor_id === options.actorId) : undefined;
  const body = mode === "mailbox"
    ? workbenchMailboxSection(actor, options.actorId, limit)
    : mode === "agent"
      ? workbenchAgentSection(actor, options.actorId, surface, limit)
      : mode === "ownership"
        ? workbenchOwnershipSection(surface, limit)
        : workbenchSummarySection(surface, limit);
  const lines = [
    "Shared Board",
    summaryLine(surface),
    surface.work_board ? `Work Board sessions=${surface.work_board.summary.sessions} active=${surface.work_board.summary.active_sessions} workers=${surface.work_board.summary.workers} claims=${surface.work_board.summary.claims} blocked=${surface.work_board.summary.blocked} failed=${surface.work_board.summary.failed}` : undefined,
    "",
    ...body,
    "",
    "Evidence",
    "source=swarm.protocol_projection.v1 actors=agentActorStore mailbox=agentActorStore claims=work-board/handoff/board"
  ].filter((line): line is string => line !== undefined);
  return lines
    .slice(0, rows)
    .map((line) => truncateDisplayLine(line, columns))
    .join("\n");
}

function summaryLine(surface: SwarmSurfaceProjection): string {
  return `participants=${surface.summary.participants} active=${surface.summary.active_participants} inactive=${surface.summary.stale_participants} inbox=${surface.summary.inbox_pending} outbox=${surface.summary.outbox_pending} Workspace Claims=${surface.summary.ownership_items} negotiations=${surface.summary.negotiations} squads=${surface.summary.squads} warnings=${surface.summary.conflicts}`;
}

function summarySections(surface: SwarmSurfaceProjection, limit: number): string[] {
  return [
    "Participants",
    ...(surface.actors.length ? surface.actors.slice(0, limit).map(formatActorLine) : ["(none)"]),
    "",
    ...ownershipSection(surface, Math.min(limit, 8)),
    "",
    "Negotiations",
    ...(surface.negotiations.length ? surface.negotiations.slice(0, limit).map(formatNegotiationLine) : ["(none)"]),
    "",
    "Squads",
    ...(surface.squads.length ? surface.squads.slice(0, limit).map(formatSquadLine) : ["(none)"]),
    "",
    "Warnings",
    ...(surface.conflicts.length ? surface.conflicts.slice(0, limit).map(formatConflictLine) : ["(none)"])
  ];
}

function workbenchSummarySection(surface: SwarmSurfaceProjection, limit: number): string[] {
  return [
    "Topology",
    ...(surface.actors.length ? surface.actors.slice(0, limit).map(formatActorLine) : ["(none)"]),
    "",
    "Mailbox",
    ...(surface.actors.length
      ? surface.actors.slice(0, limit).map((actor) => `${actor.actor_id} inbox=${actor.mailbox.inbox_total}/${actor.mailbox.inbox_pending + actor.mailbox.inbox_failed} outbox=${actor.mailbox.outbox_total}/${actor.mailbox.outbox_pending + actor.mailbox.outbox_failed}`)
      : ["(none)"]),
    "",
    ...workbenchOwnershipSection(surface, Math.min(limit, 6)),
    "",
    "Negotiations",
    ...(surface.negotiations.length
      ? surface.negotiations.slice(0, Math.min(limit, 6)).map(formatNegotiationLine)
      : ["(none)"]),
    "",
    "Squads",
    ...(surface.squads.length
      ? surface.squads.slice(0, Math.min(limit, 6)).map(formatSquadLine)
      : ["(none)"]),
    "",
    "Board",
    ...(surface.blackboard.length
      ? surface.blackboard.slice(0, Math.min(limit, 6)).map(formatBlackboardLine)
      : ["(none)"]),
    "",
    "Warnings",
    ...(surface.conflicts.length ? surface.conflicts.slice(0, limit).map(formatConflictLine) : ["(none)"])
  ];
}

function workbenchAgentSection(
  actor: SwarmSurfaceActor | undefined,
  actorId: string | undefined,
  surface: SwarmSurfaceProjection,
  limit: number
): string[] {
  if (!actor) {
    return [
      `Agent ${actorId ?? "(missing)"}`,
      "(not found)"
    ];
  }
  return [
    `Agent ${actor.actor_id}`,
    formatActorLine(actor),
    formatActorMemoryDetailLine(actor),
    `capabilities=${actor.capabilities.length ? actor.capabilities.join(",") : "-"}`,
    `current_task=${actor.current_task_id ?? "-"} current_worker=${actor.current_worker_id ?? "-"} session=${actor.current_session_id ?? "-"}`,
    actor.current_ownership ? `claims=${JSON.stringify(actor.current_ownership)}` : undefined,
    "",
    ...workbenchOwnershipSection({
      ...surface,
      ownership: surface.ownership.filter((item) => item.owner === actor.actor_id || item.id === actor.current_task_id || item.task_id === actor.current_task_id)
    }, limit),
    "",
    ...workbenchMailboxSection(actor, actor.actor_id, limit)
  ].filter((line): line is string => line !== undefined);
}

function workbenchMailboxSection(actor: SwarmSurfaceActor | undefined, actorId: string | undefined, limit: number): string[] {
  if (!actor) {
    return [
      `Mailbox ${actorId ?? "(missing)"}`,
      "(not found)"
    ];
  }
  return [
    `Mailbox ${actor.actor_id}`,
    `inbox total=${actor.mailbox.inbox_total} pending=${actor.mailbox.inbox_pending} delivered=${actor.mailbox.inbox_delivered} acked=${actor.mailbox.inbox_acked} failed=${actor.mailbox.inbox_failed}`,
    `outbox total=${actor.mailbox.outbox_total} pending=${actor.mailbox.outbox_pending} delivered=${actor.mailbox.outbox_delivered} acked=${actor.mailbox.outbox_acked} failed=${actor.mailbox.outbox_failed}`,
    "",
    "Inbox",
    ...(actor.inbox.length ? actor.inbox.slice(0, limit).map(formatMailboxMessageLine) : ["(none)"]),
    "",
    "Outbox",
    ...(actor.outbox.length ? actor.outbox.slice(0, limit).map(formatMailboxMessageLine) : ["(none)"])
  ];
}

function workbenchOwnershipSection(surface: SwarmSurfaceProjection, limit: number): string[] {
  return [
    "Workspace Claims",
    ...(surface.ownership.length ? surface.ownership.slice(0, limit).map(formatOwnershipLine) : ["(none)"])
  ];
}

function agentSection(actor: SwarmSurfaceActor | undefined, surface: SwarmSurfaceProjection, limit: number): string[] {
  if (!actor) {
    return ["Agent", "(not found)"];
  }
  const ownership = surface.ownership.filter((item) => item.owner === actor.actor_id || item.id === actor.current_task_id || item.task_id === actor.current_task_id);
  return [
    `Agent ${actor.actor_id}`,
    formatActorLine(actor),
    formatActorMemoryDetailLine(actor),
    `capabilities=${actor.capabilities.length ? actor.capabilities.join(",") : "-"}`,
    `current_task=${actor.current_task_id ?? "-"} current_worker=${actor.current_worker_id ?? "-"} session=${actor.current_session_id ?? "-"}`,
    actor.current_ownership ? `claims=${JSON.stringify(actor.current_ownership)}` : undefined,
    "",
    "Workspace Claims",
    ...(ownership.length ? ownership.slice(0, limit).map(formatOwnershipLine) : ["(none)"]),
    "",
    ...mailboxSection(actor, limit)
  ].filter((line): line is string => line !== undefined);
}

function mailboxSection(actor: SwarmSurfaceActor | undefined, limit: number): string[] {
  if (!actor) {
    return ["Mailbox", "(not found)"];
  }
  return [
    `Mailbox ${actor.actor_id}`,
    `inbox total=${actor.mailbox.inbox_total} pending=${actor.mailbox.inbox_pending} delivered=${actor.mailbox.inbox_delivered} acked=${actor.mailbox.inbox_acked} failed=${actor.mailbox.inbox_failed}`,
    `outbox total=${actor.mailbox.outbox_total} pending=${actor.mailbox.outbox_pending} delivered=${actor.mailbox.outbox_delivered} acked=${actor.mailbox.outbox_acked} failed=${actor.mailbox.outbox_failed}`,
    "",
    "Inbox",
    ...(actor.inbox.length ? actor.inbox.slice(0, limit).map(formatMailboxMessageLine) : ["(none)"]),
    "",
    "Outbox",
    ...(actor.outbox.length ? actor.outbox.slice(0, limit).map(formatMailboxMessageLine) : ["(none)"])
  ];
}

function ownershipSection(surface: SwarmSurfaceProjection, limit: number): string[] {
  return [
    "Workspace Claims",
    ...(surface.ownership.length ? surface.ownership.slice(0, limit).map(formatOwnershipLine) : ["(none)"])
  ];
}

function actorOwnershipItem(actor: SwarmSurfaceActor): SwarmOwnershipItem[] {
  if (!actor.current_task_id && !actor.current_worker_id && !actor.current_session_id) {
    return [];
  }
  return [{
    kind: "actor_task",
    id: actor.current_task_id ?? actor.current_worker_id ?? actor.actor_id,
    owner: actor.actor_id,
    session_id: actor.current_session_id,
    task_id: actor.current_task_id,
    status: actor.status,
    severity: actor.heartbeat_state === "fresh" ? "info" : actor.heartbeat_state === "blocked" ? "warning" : "error",
    summary: `actor ${actor.actor_id} owns ${actor.current_task_id ?? actor.current_worker_id ?? "current work"}`
  }];
}

function handoffOwnershipItem(handoff: HandoffSessionRecord): SwarmOwnershipItem {
  const severity = handoff.protocol_status === "conflict" || handoff.protocol_status === "timeout" || handoff.protocol_status === "stale"
    ? "warning"
    : handoff.status === "failed"
      ? "error"
      : "info";
  return {
    kind: "handoff",
    id: handoff.handoff_id,
    owner: handoff.owner_agent_id ?? `worker:${handoff.worker_id}`,
    session_id: handoff.parent_session_id,
    task_id: handoff.handoff_id,
    status: handoff.protocol_status ?? handoff.status,
    severity,
    summary: `handoff ${handoff.handoff_id} owner=${handoff.owner_agent_id ?? `worker:${handoff.worker_id}`} target=${handoff.target_agent_spec_id}`,
    envelope_id: handoff.last_envelope_id ?? handoff.take_back_envelope_id ?? handoff.return_envelope_id ?? handoff.accept_envelope_id ?? handoff.request_envelope_id
  };
}

function blackboardOwnershipItems(entry: BlackboardEntry): SwarmOwnershipItem[] {
  const metadata = entry.metadata;
  if (!metadata?.kind) {
    return [];
  }
  if (metadata.kind === "claim" || metadata.kind === "claim_release" || metadata.kind === "claim_conflict") {
    return [{
      kind: "blackboard_claim",
      id: metadata.claim_key ?? entry.key,
      owner: metadata.owner_agent_id ?? entry.created_by.agent_id,
      session_id: entry.session_id,
      task_id: entry.task_id,
      status: metadata.claim_status ?? metadata.kind,
      severity: metadata.claim_status === "conflict" ? "warning" : "info",
      summary: `claim ${metadata.claim_key ?? entry.key} owner=${metadata.owner_agent_id ?? entry.created_by.agent_id ?? "unknown"}`,
      envelope_id: metadata.source_envelope_id,
      correlation_id: metadata.correlation_id
    }];
  }
  if (metadata.kind === "proposal" || metadata.kind === "review" || metadata.kind === "decision" || metadata.kind === "result") {
    const policyMode = decisionPolicyMode(entry);
    const waitingFor = decisionWaitingFor(entry);
    return [{
      kind: "blackboard_decision",
      id: metadata.decision_id ?? metadata.proposal_id ?? entry.key,
      owner: metadata.owner_agent_id ?? entry.created_by.agent_id,
      session_id: entry.session_id,
      task_id: entry.task_id,
      status: metadata.decision_status ?? metadata.kind,
      severity: metadata.decision_status === "rejected" ? "warning" : "info",
      summary: [
        `${metadata.kind} ${metadata.proposal_id ?? entry.key}`,
        `owner=${metadata.owner_agent_id ?? entry.created_by.agent_id ?? "unknown"}`
      ].filter(Boolean).join(" "),
      policy: policyMode,
      waiting_for: waitingFor,
      envelope_id: metadata.source_envelope_id,
      correlation_id: metadata.correlation_id
    }];
  }
  return [];
}

function summarizeNegotiations(entries: BlackboardEntry[]): SwarmNegotiationItem[] {
  const byId = new Map<string, SwarmNegotiationItem>();
  for (const entry of entries) {
    const metadata = entry.metadata ?? {};
    const negotiationId = stringMetadata(metadata.negotiation_id) ??
      ((entry.tags ?? []).includes("negotiation") ? stringMetadata(metadata.proposal_id) ?? proposalIdFromKey(entry.key) : undefined);
    if (!negotiationId) {
      continue;
    }
    const action = stringMetadata(metadata.negotiation_action) ?? negotiationActionFromTags(entry.tags ?? []);
    const status = stringMetadata(metadata.negotiation_status) ??
      stringMetadata(metadata.decision_status) ??
      action ??
      stringMetadata(metadata.kind) ??
      "unknown";
    const item: SwarmNegotiationItem = {
      negotiation_id: negotiationId,
      action,
      status,
      from: metadata.source_agent_id ?? entry.created_by.agent_id ?? entry.created_by.role,
      to: stringMetadata(metadata.delegated_to ?? metadata.escalated_to),
      session_id: entry.session_id,
      task_id: entry.task_id,
      summary: negotiationSummary(entry, action, status),
      envelope_id: metadata.source_envelope_id
    };
    byId.set(negotiationId, item);
  }
  return [...byId.values()].sort((left, right) => left.negotiation_id.localeCompare(right.negotiation_id));
}

function negotiationSummary(entry: BlackboardEntry, action: string | undefined, status: string): string {
  const value = entry.value && typeof entry.value === "object" && !Array.isArray(entry.value)
    ? entry.value as Record<string, unknown>
    : {};
  const reason = typeof value.reason === "string" && value.reason.trim() ? ` reason=${value.reason.trim()}` : "";
  return `negotiation ${action ?? "event"} status=${status}${reason}`;
}

function negotiationActionFromTags(tags: string[]): string | undefined {
  return tags.find((tag) => ["propose", "counter", "accept", "decline", "delegate", "escalate"].includes(tag));
}

function summarizeSquads(entries: BlackboardEntry[]): SwarmSquadItem[] {
  const byId = new Map<string, SwarmSquadItem>();
  const ordered = [...entries].sort((left, right) => left.created_at.localeCompare(right.created_at) || left.entry_id.localeCompare(right.entry_id));
  for (const entry of ordered) {
    const metadata = entry.metadata ?? {};
    const squadId = stringMetadata(metadata.squad_id) ??
      ((entry.tags ?? []).includes("squad") ? squadIdFromKey(entry.key) : undefined);
    if (!squadId) {
      continue;
    }
    const value = recordValue(entry.value);
    const action = stringMetadata(metadata.squad_action) ?? squadActionFromTags(entry.tags ?? []);
    const status = stringMetadata(metadata.squad_status) ??
      stringMetadata(metadata.claim_status) ??
      stringMetadata(metadata.decision_status) ??
      action ??
      "unknown";
    const existing = byId.get(squadId);
    const item: SwarmSquadItem = existing ?? {
      squad_id: squadId,
      status,
      members: [],
      session_id: entry.session_id,
      task_id: entry.task_id,
      summary: ""
    };
    item.action = action ?? item.action;
    item.status = status;
    item.leader = actorLabelFromUnknown(value.leader ?? value.leader_agent ?? value.leaderAgent ?? value.owner ?? value.coordinator) ??
      stringMetadata(metadata.owner_agent_id) ??
      item.leader;
    item.session_id = entry.session_id;
    item.task_id = entry.task_id ?? item.task_id;
    item.envelope_id = metadata.source_envelope_id ?? item.envelope_id;
    applySquadMembers(item, value, metadata, action, entry);
    item.summary = squadSummary(item);
    byId.set(squadId, item);
  }
  return [...byId.values()].sort((left, right) => left.squad_id.localeCompare(right.squad_id));
}

function applySquadMembers(
  item: SwarmSquadItem,
  value: Record<string, unknown>,
  metadata: NonNullable<BlackboardEntry["metadata"]>,
  action: string | undefined,
  entry: BlackboardEntry
): void {
  const leader = actorLabelFromUnknown(value.leader ?? value.leader_agent ?? value.leaderAgent ?? value.owner ?? value.coordinator) ??
    stringMetadata(metadata.owner_agent_id);
  if (leader) {
    upsertSquadMemberItem(item, {
      agent_id: leader,
      role: "leader",
      status: item.status === "dissolved" ? "left" : "active",
      capabilities: stringList(value.leader_capabilities ?? value.leaderCapabilities)
    });
  }
  for (const member of squadMembersFromValue(value.members)) {
    upsertSquadMemberItem(item, member);
  }
  for (const role of recordList(value.roles ?? value.role_assignments ?? value.roleAssignments)) {
    const agentId = actorLabelFromUnknown(role.member ?? role.agent ?? role.assignee) ??
      stringMetadata(role.agent_id ?? role.agentId);
    if (!agentId) {
      continue;
    }
    upsertSquadMemberItem(item, {
      agent_id: agentId,
      role: stringMetadata(role.role ?? role.role_id ?? role.roleId),
      status: item.status === "dissolved" ? "left" : "active",
      capabilities: stringList(role.required_capabilities ?? role.requiredCapabilities ?? role.capabilities)
    });
  }
  const explicitMember = actorLabelFromUnknown(value.member ?? value.member_agent ?? value.memberAgent ?? value.actor ?? value.assignee ?? value.agent) ??
    stringMetadata(metadata.squad_member_id);
  if (explicitMember) {
    upsertSquadMemberItem(item, {
      agent_id: explicitMember,
      role: stringMetadata(value.role ?? value.role_id ?? value.roleId ?? metadata.squad_role),
      status: action === "leave" || item.status === "dissolved" ? "left" : "active",
      capabilities: stringList(value.required_capabilities ?? value.requiredCapabilities ?? value.capabilities)
    });
  }
  if (action === "dissolve" || item.status === "dissolved") {
    item.members = item.members.map((member) => ({ ...member, status: "left" }));
  } else if (action === "leave" && explicitMember) {
    item.members = item.members.map((member) => member.agent_id === explicitMember ? { ...member, status: "left" } : member);
  }
  if (item.members.length === 0 && entry.created_by.agent_id) {
    upsertSquadMemberItem(item, {
      agent_id: entry.created_by.agent_id,
      role: stringMetadata(metadata.squad_role),
      status: item.status === "dissolved" ? "left" : "unknown",
      capabilities: []
    });
  }
}

function squadMembersFromValue(value: unknown): SwarmSquadMemberItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const members: SwarmSquadMemberItem[] = [];
  for (const item of value) {
    const record = recordValue(item);
    const agentId = actorLabelFromUnknown(item) ?? stringMetadata(record.agent_id ?? record.agentId ?? record.id);
    if (!agentId) {
      continue;
    }
    members.push({
      agent_id: agentId,
      role: stringMetadata(record.role ?? record.role_id ?? record.roleId),
      status: "active",
      capabilities: stringList(record.capabilities ?? record.required_capabilities ?? record.requiredCapabilities)
    });
  }
  return members;
}

function upsertSquadMemberItem(item: SwarmSquadItem, member: SwarmSquadMemberItem): void {
  const existing = item.members.find((candidate) => candidate.agent_id === member.agent_id);
  if (existing) {
    existing.role = member.role ?? existing.role;
    existing.status = member.status;
    existing.capabilities = uniqueStrings([...existing.capabilities, ...member.capabilities]);
    return;
  }
  item.members.push({
    ...member,
    capabilities: uniqueStrings(member.capabilities)
  });
}

function squadSummary(item: SwarmSquadItem): string {
  const roles = item.members
    .filter((member) => member.status === "active")
    .map((member) => member.role ? `${member.agent_id}:${member.role}` : member.agent_id)
    .slice(0, 4)
    .join(",");
  return `squad status=${item.status} members=${item.members.length}${roles ? ` roles=${roles}` : ""}`;
}

function squadActionFromTags(tags: string[]): string | undefined {
  return tags.find((tag) => ["create", "join", "leave", "role.assign", "dissolve"].includes(tag));
}

function squadIdFromKey(key: string): string | undefined {
  const squadMatch = key.match(/^squad\/([^/]+)/u);
  if (squadMatch?.[1]) {
    return squadMatch[1];
  }
  const claimMatch = key.match(/^claim\/squad\/([^/]+)/u);
  return claimMatch?.[1];
}

function proposalIdFromKey(key: string): string | undefined {
  const match = key.match(/^proposal\/([^/]+)/u);
  return match?.[1];
}

function actorConflictItem(actor: SwarmSurfaceActor): SwarmConflictItem {
  const blockedReason = typeof actor.metadata.blocked_reason === "string" ? actor.metadata.blocked_reason : undefined;
  const reason = blockedReason ? `: ${blockedReason}` : "";
  return {
    kind: "heartbeat",
    id: actor.actor_id,
    owner: actor.actor_id,
    session_id: actor.current_session_id,
    severity: actor.heartbeat_state === "blocked" || actor.heartbeat_state === "stale" ? "warning" : "error",
    summary: actor.heartbeat_state === "offline"
      ? `worker disconnected${reason}`
      : `worker heartbeat missed${reason}`
  };
}

function handoffConflictItem(handoff: HandoffSessionRecord): SwarmConflictItem {
  return {
    kind: "handoff",
    id: handoff.handoff_id,
    owner: handoff.owner_agent_id,
    session_id: handoff.parent_session_id,
    severity: handoff.protocol_status === "conflict" ? "error" : "warning",
    summary: handoff.conflict_reason ?? `${handoff.protocol_status ?? handoff.status} handoff`,
    envelope_id: handoff.last_envelope_id
  };
}

function blackboardConflictItem(entry: BlackboardEntry): SwarmConflictItem {
  return {
    kind: "blackboard",
    id: entry.metadata?.claim_key ?? entry.key,
    owner: entry.metadata?.owner_agent_id ?? entry.created_by.agent_id,
    session_id: entry.session_id,
    severity: "warning",
    summary: entry.metadata?.conflict_reason ? String(entry.metadata.conflict_reason) : `board conflict ${entry.key}`,
    envelope_id: entry.metadata?.source_envelope_id
  };
}

function formatActorLine(actor: SwarmSurfaceActor): string {
  return [
    `${actor.actor_id} [${actor.kind}/${actor.status}/${actor.heartbeat_state}]`,
    `role=${actor.role}`,
    `in=${actor.mailbox.inbox_total}/${actor.mailbox.inbox_pending + actor.mailbox.inbox_failed}`,
    `out=${actor.mailbox.outbox_total}/${actor.mailbox.outbox_pending + actor.mailbox.outbox_failed}`,
    `memory=${actor.memory.health}`,
    actor.memory.last_learned_at ? `learned=${actor.memory.last_learned_at}` : undefined,
    actor.memory.last_compacted_at ? `compacted=${actor.memory.last_compacted_at}` : undefined,
    actor.current_task_id ? `task=${actor.current_task_id}` : undefined,
    actor.current_worker_id ? `worker=${actor.current_worker_id}` : undefined,
    actor.current_session_id ? `session=${actor.current_session_id}` : undefined
  ].filter(Boolean).join(" ");
}

function formatActorMemoryDetailLine(actor: SwarmSurfaceActor): string {
  return [
    `memory entries=${actor.memory.entries}`,
    `health=${actor.memory.health}`,
    `hash=${actor.memory.cache_stable_summary_hash}`,
    actor.memory.frozen ? "frozen=true" : undefined,
    actor.memory.cleared_at ? `cleared=${actor.memory.cleared_at}` : undefined
  ].filter(Boolean).join(" ");
}

function projectSurfaceActorMemory(memory: AgentMemoryProjection): SwarmSurfaceActor["memory"] {
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

function formatOwnershipLine(item: SwarmOwnershipItem): string {
  return [
    `${severityBadge(item.severity)} ${ownershipDisplayKind(item.kind)}:${item.id} [${item.status}]`,
    item.policy ? `policy=${item.policy}` : undefined,
    item.waiting_for ? `waiting=${item.waiting_for}` : undefined,
    item.owner ? `owner=${item.owner}` : undefined,
    item.envelope_id ? `env=${item.envelope_id}` : undefined,
    item.correlation_id ? `corr=${item.correlation_id}` : undefined,
    item.session_id ? `session=${item.session_id}` : undefined,
    item.task_id ? `task=${item.task_id}` : undefined,
    item.summary
  ].filter(Boolean).join(" ");
}

function ownershipDisplayKind(kind: SwarmOwnershipItem["kind"]): string {
  if (kind === "actor_task") return "Task";
  if (kind === "handoff") return "Handoff";
  if (kind === "blackboard_claim") return "Claim";
  if (kind === "blackboard_decision") return "Decision";
  return "Work";
}

function formatConflictLine(item: SwarmConflictItem): string {
  return [
    `${severityBadge(item.severity)} ${item.kind}:${item.id}`,
    item.owner ? `owner=${item.owner}` : undefined,
    item.session_id ? `session=${item.session_id}` : undefined,
    item.envelope_id ? `env=${item.envelope_id}` : undefined,
    item.summary
  ].filter(Boolean).join(" ");
}

function formatNegotiationLine(item: SwarmNegotiationItem): string {
  return [
    `negotiation:${item.negotiation_id} [${item.status}]`,
    item.action ? `action=${item.action}` : undefined,
    item.from ? `from=${item.from}` : undefined,
    item.to ? `to=${item.to}` : undefined,
    item.envelope_id ? `env=${item.envelope_id}` : undefined,
    item.task_id ? `task=${item.task_id}` : undefined,
    item.summary
  ].filter(Boolean).join(" ");
}

function formatSquadLine(item: SwarmSquadItem): string {
  const activeMembers = item.members.filter((member) => member.status === "active");
  const leftMembers = item.members.filter((member) => member.status === "left");
  const roles = activeMembers
    .map((member) => member.role ? `${member.agent_id}:${member.role}` : member.agent_id)
    .slice(0, 5)
    .join(",");
  return [
    `squad:${item.squad_id} [${item.status}]`,
    item.action ? `action=${item.action}` : undefined,
    item.leader ? `leader=${item.leader}` : undefined,
    `members=${activeMembers.length}/${item.members.length}`,
    leftMembers.length ? `left=${leftMembers.length}` : undefined,
    roles ? `roles=${roles}` : undefined,
    item.envelope_id ? `env=${item.envelope_id}` : undefined,
    item.task_id ? `task=${item.task_id}` : undefined,
    item.summary
  ].filter(Boolean).join(" ");
}

function formatMailboxMessageLine(message: AgentMailboxMessage): string {
  return [
    `${message.direction}:${message.type} [${message.status}]`,
    `env=${message.envelope_id}`,
    message.task_id ? `task=${message.task_id}` : undefined,
    message.from_agent_id ? `from=${message.from_agent_id}` : undefined,
    message.recipient_agent_id ? `to=${message.recipient_agent_id}` : undefined,
    message.intent,
    message.error ? `error=${message.error}` : undefined
  ].filter(Boolean).join(" ");
}

function formatBlackboardLine(entry: BlackboardEntry): string {
  const policyMode = decisionPolicyMode(entry);
  const waitingFor = decisionWaitingFor(entry);
  return [
    `${entry.type}:${entry.key}`,
    entry.metadata?.kind ? `kind=${entry.metadata.kind}` : undefined,
    entry.metadata?.decision_status ? `decision=${entry.metadata.decision_status}` : undefined,
    policyMode ? `policy=${policyMode}` : undefined,
    waitingFor ? `waiting=${waitingFor}` : undefined,
    entry.metadata?.claim_status ? `claim=${entry.metadata.claim_status}` : undefined,
    entry.created_by.agent_id ? `by=${entry.created_by.agent_id}` : undefined,
    entry.task_id ? `task=${entry.task_id}` : undefined,
    entry.metadata?.source_envelope_id ? `env=${entry.metadata.source_envelope_id}` : undefined
  ].filter(Boolean).join(" ");
}

function severityBadge(severity: "info" | "warning" | "error"): string {
  if (severity === "error") return "[ERR]";
  if (severity === "warning") return "[WARN]";
  return "[INFO]";
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function decisionPolicyMode(entry: BlackboardEntry): string | undefined {
  const value = recordValue(entry.value);
  const valuePolicy = recordValue(value.decision_policy ?? value.decisionPolicy ?? value.policy);
  return stringMetadata(entry.metadata?.decision_policy?.mode) ??
    stringMetadata(valuePolicy.mode ?? valuePolicy.decision_mode ?? valuePolicy.decisionMode);
}

function decisionWaitingFor(entry: BlackboardEntry): string | undefined {
  const value = recordValue(entry.value);
  const waitingFor = stringList(entry.metadata?.decision_waiting_for).length
    ? stringList(entry.metadata?.decision_waiting_for)
    : stringList(value.decision_waiting_for ?? value.decisionWaitingFor);
  if (waitingFor.length > 0) {
    return waitingFor.join(",");
  }
  return decisionPolicyMode(entry) ? "none" : undefined;
}

function recordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : typeof value === "string" && value.trim()
      ? [value.trim()]
      : [];
}

function actorLabelFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string") {
    return stringMetadata(value);
  }
  const record = recordValue(value);
  return stringMetadata(record.agent_id ?? record.agentId ?? record.id ?? record.role ?? record.capability);
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()))];
}

function truncateDisplayLine(value: string, columns: number): string {
  const width = Math.max(1, Math.floor(columns));
  if (displayWidth(value) <= width) {
    return value;
  }
  if (width <= 3) {
    return sliceByDisplayWidth(value, width).head;
  }
  return `${sliceByDisplayWidth(value, width - 3).head}...`;
}
