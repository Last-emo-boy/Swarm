import type { PermissionMode } from "../config/settings.js";
import type { SwarmSurfaceProjection } from "./swarm-surface.js";
import type { RunBoardSurfaceView } from "./run-board/run-board-types.js";
import { redactSensitive } from "../runtime/recovery.js";

export type CollaborationOverlayTarget = "topology" | "ownership" | "negotiation" | "blackboard" | "approval" | "policy";
export type CollaborationShortcutAction = "open" | "ownership" | "negotiation" | "blackboard" | "reassign";
export type CollaborationActionResult = "opened" | "queued" | "denied" | "noop";

export type TopologyStripModel = {
  squadsActive: number;
  ownershipBlocked: number;
  conflictsOpen: number;
  approvalsPending: number;
  negotiationsOpen: number;
  policyMode: string;
  sandboxMode?: string;
  evidence: string[];
  targets: Array<{
    id: CollaborationOverlayTarget;
    label: string;
    value: number | string;
    status: "ok" | "attention" | "blocked" | "muted";
    evidence?: string;
  }>;
};

export type CollaborationCockpitView = {
  enabled: boolean;
  topology?: TopologyStripModel;
  overlays: CollaborationOverlayView[];
  reassign?: ReassignIntentView;
};

export type CollaborationOverlayView = {
  target: CollaborationOverlayTarget;
  title: string;
  emptyLabel: string;
  rows: CollaborationOverlayRow[];
  actions: string[];
};

export type CollaborationOverlayRow = {
  id: string;
  label: string;
  status: string;
  tone: "ok" | "attention" | "blocked" | "muted";
  evidence?: string;
  detail: string[];
  actionHint?: string;
  priority: number;
};

export type ReassignIntentView = {
  targetId?: string;
  source: "ownership" | "attention" | "none";
  reason: string;
  risk: "low" | "medium" | "high";
  policy: "queued" | "approval-required" | "denied" | "no-target";
  summary: string;
};

export type CollaborationTelemetryEvent = {
  event: "tui.topology.open" | "tui.collab.shortcut" | "tui.decision_trail.expand" | "tui.reassign.intent";
  overlay?: CollaborationOverlayTarget;
  action?: string;
  target?: string;
  source?: string;
  result?: string;
  durationMs: number;
};

export function collaborationShortcutActionForInput(input: {
  character?: string;
  key: { ctrl?: boolean; meta?: boolean; return?: boolean; escape?: boolean };
  enabled: boolean;
  inputIsEmpty: boolean;
}): CollaborationShortcutAction | undefined {
  if (!input.enabled || !input.inputIsEmpty || input.key.ctrl || input.key.meta) {
    return undefined;
  }
  if (input.key.return || input.key.escape) {
    return undefined;
  }
  const normalized = input.character?.toLowerCase();
  if (normalized === "o") return "open";
  if (normalized === "n") return "negotiation";
  if (normalized === "b") return "blackboard";
  if (normalized === "r") return "reassign";
  return undefined;
}

export function isCollaborationCockpitEnabled(input: string | undefined = process.env.SWARM_TUI_EXPERIMENTAL_COLLAB): boolean {
  return input !== "0" && input?.toLowerCase() !== "false" && input?.toLowerCase() !== "off";
}

export function buildCollaborationCockpitView(input: {
  enabled?: boolean;
  swarmSurface?: SwarmSurfaceProjection;
  runBoard?: RunBoardSurfaceView;
  approvalsPending?: number;
  policyMode?: PermissionMode | string;
  sandboxMode?: string;
}): CollaborationCockpitView {
  const enabled = input.enabled ?? isCollaborationCockpitEnabled();
  if (!enabled) {
    return { enabled: false, overlays: [] };
  }
  const topology = buildTopologyStripModel(input);
  const overlays = buildCollaborationOverlayViews(input);
  return {
    enabled: true,
    topology,
    overlays,
    reassign: buildReassignIntentView(input)
  };
}

export function buildTopologyStripModel(input: {
  swarmSurface?: SwarmSurfaceProjection;
  runBoard?: RunBoardSurfaceView;
  approvalsPending?: number;
  policyMode?: PermissionMode | string;
  sandboxMode?: string;
}): TopologyStripModel {
  const surface = input.swarmSurface;
  const runBoard = input.runBoard;
  const stuckOrBlockedWorkers = runBoard?.workers.filter((worker) => worker.status === "blocked" || worker.status === "stuck").length ?? 0;
  const unresolvedAttention = runBoard?.attention.filter((item) => !item.resolvedAt).length ?? 0;
  const ownershipBlocked = Math.max(
    stuckOrBlockedWorkers,
    surface?.ownership.filter((item) => item.severity !== "info" || /blocked|waiting|conflict|stale|timeout/iu.test(item.status)).length ?? 0
  );
  const conflictsOpen = surface?.summary.conflicts ?? 0;
  const squadsActive = surface?.squads.filter((squad) => squad.status !== "done" && squad.status !== "left").length ?? surface?.summary.squads ?? 0;
  const negotiationsOpen = surface?.negotiations.filter((item) => item.status !== "done" && item.status !== "closed").length ?? 0;
  const approvalsPending = Math.max(input.approvalsPending ?? 0, runBoard?.attention.filter((item) => item.kind === "approval" && !item.resolvedAt).length ?? 0);
  const policyMode = input.policyMode ?? "unknown";
  const evidence = [
    surface ? `Swarm projection: participants ${surface.summary.participants}, squads ${surface.summary.squads}, ownership ${surface.summary.ownership_items}` : undefined,
    runBoard ? `Run Board: workers ${runBoard.workers.length}, attention ${unresolvedAttention}` : undefined,
    approvalsPending ? `Approvals pending: ${approvalsPending}` : undefined,
    `Policy: ${policyMode}${input.sandboxMode ? `, sandbox ${input.sandboxMode}` : ""}`
  ].filter((item): item is string => Boolean(item));
  return {
    squadsActive,
    ownershipBlocked,
    conflictsOpen,
    approvalsPending,
    negotiationsOpen,
    policyMode: String(policyMode),
    sandboxMode: input.sandboxMode,
    evidence,
    targets: [
      {
        id: "topology",
        label: "SQ",
        value: squadsActive,
        status: squadsActive > 0 ? "ok" : "muted",
        evidence: surface ? `${surface.summary.squads} squads from swarm projection` : undefined
      },
      {
        id: "ownership",
        label: "OW",
        value: ownershipBlocked,
        status: ownershipBlocked > 0 ? "blocked" : "ok",
        evidence: ownershipBlocked > 0 ? `${ownershipBlocked} blocked ownership/work items` : "No blocked ownership"
      },
      {
        id: "negotiation",
        label: "NG",
        value: negotiationsOpen,
        status: negotiationsOpen > 0 ? "attention" : "muted",
        evidence: negotiationsOpen > 0 ? `${negotiationsOpen} open negotiation threads` : undefined
      },
      {
        id: "blackboard",
        label: "CF",
        value: conflictsOpen,
        status: conflictsOpen > 0 ? "attention" : "ok",
        evidence: conflictsOpen > 0 ? `${conflictsOpen} open conflicts` : "No open conflicts"
      },
      {
        id: "approval",
        label: "AP",
        value: approvalsPending,
        status: approvalsPending > 0 ? "attention" : "ok",
        evidence: approvalsPending > 0 ? `${approvalsPending} approvals waiting` : "No pending approvals"
      },
      {
        id: "policy",
        label: "POL",
        value: policyToken(String(policyMode)),
        status: "muted",
        evidence: `Policy mode ${policyMode}`
      }
    ]
  };
}

function policyToken(value: string): string {
  if (value === "workspace-write") return "WW";
  if (value === "read-only") return "RO";
  if (value === "auto") return "AUTO";
  if (value === "approval" || value === "ask") return "ASK";
  if (value === "yolo") return "YOLO";
  return value.length > 10 ? value.slice(0, 10) : value;
}

export function selectCollaborationOverlay(view: CollaborationCockpitView, target: CollaborationOverlayTarget | undefined): CollaborationOverlayView | undefined {
  if (!target || target === "approval" || target === "policy" || target === "topology") {
    return undefined;
  }
  return view.overlays.find((overlay) => overlay.target === target);
}

export function buildCollaborationOverlayViews(input: {
  swarmSurface?: SwarmSurfaceProjection;
  runBoard?: RunBoardSurfaceView;
}): CollaborationOverlayView[] {
  return [
    buildOwnershipOverlay(input),
    buildNegotiationOverlay(input),
    buildBlackboardOverlay(input)
  ];
}

function buildOwnershipOverlay(input: {
  swarmSurface?: SwarmSurfaceProjection;
  runBoard?: RunBoardSurfaceView;
}): CollaborationOverlayView {
  const surfaceRows = input.swarmSurface?.ownership.map((item) => ({
    id: `${item.kind}:${item.id}`,
    label: `${productOwnershipKind(item.kind)} ${item.id}`,
    status: productStatus(item.status, item.severity),
    tone: item.severity === "error" ? "blocked" as const : item.severity === "warning" ? "attention" as const : "ok" as const,
    evidence: [
      item.owner ? `owner ${item.owner}` : undefined,
      item.waiting_for ? `waiting ${item.waiting_for}` : undefined,
      item.policy ? `policy ${item.policy}` : undefined
    ].filter((part): part is string => Boolean(part)).join(", ") || item.summary,
    detail: [
      `Ownership ${item.id}`,
      `kind=${productOwnershipKind(item.kind)}`,
      `status=${item.status}`,
      item.owner ? `owner=${item.owner}` : undefined,
      item.waiting_for ? `waiting=${item.waiting_for}` : undefined,
      item.policy ? `policy=${item.policy}` : undefined,
      item.correlation_id ? `trace=${item.correlation_id}` : undefined,
      item.envelope_id ? `evidence=${item.envelope_id}` : undefined,
      item.summary
    ].filter((line): line is string => Boolean(line)),
    actionHint: "Enter details · t take over · a/r reassign",
    priority: ownershipPriority(item.severity, item.status)
  })) ?? [];
  const runBoardRows = input.runBoard?.workers
    .filter((worker) => worker.status === "blocked" || worker.status === "stuck" || worker.waitingOn)
    .map((worker) => ({
      id: `worker:${worker.id}`,
      label: `${worker.label}`,
      status: worker.status,
      tone: worker.status === "blocked" || worker.status === "stuck" ? "blocked" as const : "attention" as const,
      evidence: worker.waitingOn ? `waiting ${worker.waitingOn}` : worker.lastEvidence ?? worker.currentAction,
      detail: [
        `${worker.label} ${worker.status}`,
        `action=${worker.currentAction}`,
        worker.waitingOn ? `waiting=${worker.waitingOn}` : undefined,
        worker.lastEvidence ? `evidence=${worker.lastEvidence}` : undefined
      ].filter((line): line is string => Boolean(line)),
      actionHint: "Enter details · r reassign",
      priority: worker.status === "blocked" || worker.status === "stuck" ? 0 : 2
    })) ?? [];
  return {
    target: "ownership",
    title: "Ownership",
    emptyLabel: "No blocked ownership.",
    rows: [...surfaceRows, ...runBoardRows].sort(compareOverlayRows).slice(0, 12),
    actions: ["Enter detail", "t take over intent", "r reassign intent", "Esc close"]
  };
}

function buildNegotiationOverlay(input: { swarmSurface?: SwarmSurfaceProjection }): CollaborationOverlayView {
  const rows = input.swarmSurface?.negotiations.map((item) => ({
    id: item.negotiation_id,
    label: `Thread ${item.negotiation_id}`,
    status: item.status,
    tone: negotiationTone(item.status),
    evidence: [
      item.action ? `action ${item.action}` : undefined,
      item.from ? `from ${item.from}` : undefined,
      item.to ? `to ${item.to}` : undefined
    ].filter((part): part is string => Boolean(part)).join(", ") || item.summary,
    detail: [
      `Negotiation ${item.negotiation_id}`,
      `status=${item.status}`,
      item.action ? `action=${item.action}` : undefined,
      item.from ? `from=${item.from}` : undefined,
      item.to ? `to=${item.to}` : undefined,
      item.task_id ? `task=${item.task_id}` : undefined,
      item.envelope_id ? `evidence=${item.envelope_id}` : undefined,
      item.summary
    ].filter((line): line is string => Boolean(line)),
    actionHint: "Enter thread · c resolve proposal intent",
    priority: negotiationPriority(item.status)
  })).sort(compareOverlayRows).slice(0, 12) ?? [];
  return {
    target: "negotiation",
    title: "Negotiations",
    emptyLabel: "No open negotiation threads.",
    rows,
    actions: ["Enter thread", "c resolve intent", "Esc close"]
  };
}

function buildBlackboardOverlay(input: { swarmSurface?: SwarmSurfaceProjection }): CollaborationOverlayView {
  const rows = input.swarmSurface?.blackboard.map((entry, index) => {
    const label = productBlackboardLabel(entry.type, entry.tags ?? []);
    const important = entry.metadata?.kind === "claim_conflict" || entry.metadata?.claim_status === "conflict" || entry.type === "decision";
    return {
      id: entry.key,
      label: `${label} ${entry.key}`,
      status: entry.type,
      tone: important ? "attention" as const : "muted" as const,
      evidence: (entry.tags ?? []).slice(0, 3).join(", ") || entry.created_by?.agent_id,
      detail: [
        `Blackboard ${label}`,
        `key=${entry.key}`,
        `type=${entry.type}`,
        entry.tags?.length ? `tags=${entry.tags.join(",")}` : undefined,
      entry.created_by.agent_id ? `by=${entry.created_by.agent_id}` : undefined,
        entry.updated_at ? `updated=${entry.updated_at}` : undefined
      ].filter((line): line is string => Boolean(line)),
      actionHint: "Enter detail · y copy id",
      priority: important ? 0 : index + 5
    };
  }).sort(compareOverlayRows).slice(0, 12) ?? [];
  return {
    target: "blackboard",
    title: "Blackboard Timeline",
    emptyLabel: "No recent collaboration facts.",
    rows,
    actions: ["/ filter", "Enter detail", "y copy id", "Esc close"]
  };
}

export function buildReassignIntentView(input: {
  swarmSurface?: SwarmSurfaceProjection;
  runBoard?: RunBoardSurfaceView;
  policyMode?: PermissionMode | string;
}): ReassignIntentView {
  const blockedOwnership = input.swarmSurface?.ownership
    .filter((item) => item.severity !== "info" || /blocked|waiting|conflict|stale|timeout/iu.test(item.status))
    .sort((left, right) => ownershipPriority(left.severity, left.status) - ownershipPriority(right.severity, right.status))[0];
  const activeAttention = input.runBoard?.attention.find((item) => !item.resolvedAt && (item.kind === "blocked" || item.kind === "slow" || item.kind === "failed"));
  const blockedWorker = input.runBoard?.workers.find((worker) => worker.status === "blocked" || worker.status === "stuck" || worker.waitingOn);
  const policyMode = String(input.policyMode ?? "unknown");
  if (blockedOwnership) {
    return {
      targetId: `${blockedOwnership.kind}:${blockedOwnership.id}`,
      source: "ownership",
      reason: blockedOwnership.summary,
      risk: blockedOwnership.severity === "error" ? "high" : "medium",
      policy: policyForIntent(policyMode),
      summary: `Reassign intent for ${blockedOwnership.id}`
    };
  }
  if (activeAttention) {
    return {
      targetId: activeAttention.subjectWorkerId ?? activeAttention.id,
      source: "attention",
      reason: activeAttention.summary,
      risk: activeAttention.severity === "failed" || activeAttention.severity === "blocking" ? "high" : "medium",
      policy: policyForIntent(policyMode),
      summary: `Reassign intent for ${activeAttention.title}`
    };
  }
  if (blockedWorker) {
    return {
      targetId: blockedWorker.id,
      source: "ownership",
      reason: blockedWorker.waitingOn ? `${blockedWorker.label} waiting on ${blockedWorker.waitingOn}` : blockedWorker.currentAction,
      risk: blockedWorker.risk === "high" ? "high" : "medium",
      policy: policyForIntent(policyMode),
      summary: `Reassign intent for ${blockedWorker.label}`
    };
  }
  return {
    source: "none",
    reason: "No blocked worker or ownership item is active.",
    risk: "low",
    policy: "no-target",
    summary: "No reassign target"
  };
}

export function buildCollaborationTelemetryEvent(input: {
  event: CollaborationTelemetryEvent["event"];
  overlay?: CollaborationOverlayTarget;
  action?: string;
  target?: string;
  source?: string;
  result?: string;
  durationMs?: number;
}): CollaborationTelemetryEvent {
  return {
    event: input.event,
    overlay: input.overlay,
    action: input.action,
    target: input.target ? redactSensitive(input.target) : undefined,
    source: input.source ? redactSensitive(input.source) : undefined,
    result: input.result ? redactSensitive(input.result) : undefined,
    durationMs: Math.max(0, Math.floor(input.durationMs ?? 0))
  };
}

function productOwnershipKind(kind: string): string {
  if (kind === "actor_task") return "Task";
  if (kind === "handoff") return "Handoff";
  if (kind === "blackboard_claim") return "Claim";
  if (kind === "blackboard_decision") return "Decision";
  return "Work";
}

function productStatus(status: string, severity: "info" | "warning" | "error"): string {
  if (severity === "error") return "blocked";
  if (severity === "warning") return status || "attention";
  return status || "ok";
}

function ownershipPriority(severity: "info" | "warning" | "error", status: string): number {
  if (severity === "error" || /blocked|conflict|failed/iu.test(status)) return 0;
  if (severity === "warning" || /waiting|stale|timeout/iu.test(status)) return 1;
  return 5;
}

function negotiationTone(status: string): CollaborationOverlayRow["tone"] {
  if (/conflict|counter|open|pending/iu.test(status)) return "attention";
  if (/failed|blocked/iu.test(status)) return "blocked";
  if (/done|closed|accepted/iu.test(status)) return "muted";
  return "ok";
}

function negotiationPriority(status: string): number {
  if (/conflict|counter/iu.test(status)) return 0;
  if (/open|pending|requested/iu.test(status)) return 1;
  if (/done|closed|accepted/iu.test(status)) return 5;
  return 2;
}

function productBlackboardLabel(type: string, tags: string[]): string {
  if (tags.includes("claim") || /claim/iu.test(type)) return "Claim";
  if (tags.includes("proposal") || /proposal/iu.test(type)) return "Proposal";
  if (type === "decision" || tags.includes("decision")) return "Decision";
  if (type === "artifact" || tags.includes("artifact")) return "Artifact";
  return "Fact";
}

function policyForIntent(policyMode: string): ReassignIntentView["policy"] {
  if (policyMode === "read-only") return "denied";
  if (policyMode === "approval" || policyMode === "ask") return "approval-required";
  return "queued";
}

function compareOverlayRows(left: CollaborationOverlayRow, right: CollaborationOverlayRow): number {
  return left.priority - right.priority || left.label.localeCompare(right.label);
}
