export type LegacyDirectPathArea = "task" | "handoff" | "blackboard" | "symphony" | "gateway";

export type LegacyDirectPathException = {
  id: string;
  area: LegacyDirectPathArea;
  source: string;
  direct_path: string;
  protocol_adapter: string;
  migration_task: string;
  owner: string;
  status: "adapter" | "exception" | "remove";
  rationale: string;
};

export type LegacyDirectPathWriteCause = "source_envelope_id" | "protocol_adapter" | "legacy_exception" | "none";

export type LegacyDirectPathCriticalWrite = {
  id: string;
  area: LegacyDirectPathArea;
  source: string;
  symbol: string;
  cause: LegacyDirectPathWriteCause;
  exception_id?: string;
  rationale: string;
};

export type LegacyDirectPathAuditIssue = {
  severity: "error" | "warning";
  area: LegacyDirectPathArea;
  code: string;
  message: string;
};

export type LegacyDirectPathAudit = {
  schema_version: "swarm.legacy_direct_path_audit.v1";
  status: "pass" | "fail";
  summary: {
    exceptions: number;
    adapters: number;
    removals: number;
    critical_writes: number;
    envelope_caused_writes: number;
    adapter_caused_writes: number;
    errors: number;
    warnings: number;
  };
  exceptions: LegacyDirectPathException[];
  critical_writes: LegacyDirectPathCriticalWrite[];
  issues: LegacyDirectPathAuditIssue[];
};

export const REQUIRED_LEGACY_DIRECT_PATH_AREAS: LegacyDirectPathArea[] = ["task", "handoff", "blackboard", "symphony", "gateway"];

export const DEFAULT_LEGACY_DIRECT_PATH_EXCEPTIONS: LegacyDirectPathException[] = [
  {
    id: "legacy-worker-state-projection",
    area: "task",
    source: "src/runtime/runtime.ts",
    direct_path: "WorkerStateStore remains the compatibility projection for existing workers CLI and result-card surfaces.",
    protocol_adapter: "local_worker_actor_adapter envelopes plus protocol replay audit",
    migration_task: "CAND-PROD-059-TASK-004",
    owner: "main_swarm",
    status: "adapter",
    rationale: "Worker records stay readable while task market migration moves assignment to bid/claim/accept envelopes."
  },
  {
    id: "legacy-handoff-store-projection",
    area: "handoff",
    source: "src/storage/handoff-store.ts",
    direct_path: "HandoffStore remains the compatibility projection for handoff CLI/Gateway views.",
    protocol_adapter: "local_handoff_ownership_protocol envelopes plus replay handoff reconstruction",
    migration_task: "CAND-PROD-059-TASK-006",
    owner: "main_swarm",
    status: "adapter",
    rationale: "Handoff rows keep the old product surface while ownership-transfer envelopes become the source of truth."
  },
  {
    id: "legacy-blackboard-tool-writes",
    area: "blackboard",
    source: "src/storage/blackboard-store.ts",
    direct_path: "Runtime and tools can still write Blackboard entries directly for compatibility.",
    protocol_adapter: "router-backed blackboard envelopes and source_envelope_id/event metadata",
    migration_task: "CAND-PROD-059-TASK-007",
    owner: "blackboard",
    status: "exception",
    rationale: "Blackboard collaboration semantics are migrating incrementally to claim/proposal/decision envelopes."
  },
  {
    id: "legacy-symphony-claim-store",
    area: "symphony",
    source: "src/symphony/scheduler.ts",
    direct_path: "Symphony scheduler still writes WorkSession and claim state directly.",
    protocol_adapter: "symphony.scheduler participant actor with task.create/task.assign/task.result envelopes",
    migration_task: "CAND-PROD-059-TASK-009",
    owner: "symphony.scheduler",
    status: "exception",
    rationale: "Existing Symphony CLI remains stable while participant fusion moves scheduler actions onto mailbox flow."
  },
  {
    id: "legacy-gateway-control-routes",
    area: "gateway",
    source: "src/server/gateway.ts",
    direct_path: "Gateway live control routes still bridge HTTP requests into runtime control helpers.",
    protocol_adapter: "gateway.control participant envelopes with idempotent request_id handling",
    migration_task: "CAND-PROD-059-TASK-010",
    owner: "gateway.control",
    status: "exception",
    rationale: "Gateway API compatibility is preserved while reply/interrupt/approval become durable protocol events."
  }
];

export const DEFAULT_LEGACY_DIRECT_PATH_CRITICAL_WRITES: LegacyDirectPathCriticalWrite[] = [
  {
    id: "worker-state-compat-projection",
    area: "task",
    source: "src/storage/worker-state-store.ts",
    symbol: "WorkerStateStore",
    cause: "protocol_adapter",
    exception_id: "legacy-worker-state-projection",
    rationale: "WorkerStateStore remains a compatibility projection while task ownership moves to envelopes."
  },
  {
    id: "handoff-store-compat-projection",
    area: "handoff",
    source: "src/storage/handoff-store.ts",
    symbol: "HandoffStore.create/finish/takeBack",
    cause: "protocol_adapter",
    exception_id: "legacy-handoff-store-projection",
    rationale: "HandoffStore remains readable while request/accept/return/take_back envelopes become the causal path."
  },
  {
    id: "blackboard-source-envelope-writes",
    area: "blackboard",
    source: "src/storage/blackboard-store.ts",
    symbol: "BlackboardStore.write/update/claim/proposal/decision",
    cause: "source_envelope_id",
    exception_id: "legacy-blackboard-tool-writes",
    rationale: "Blackboard collaboration writes carry source envelope metadata when routed through the v2 adapter."
  },
  {
    id: "symphony-scheduler-participant-projection",
    area: "symphony",
    source: "src/symphony/scheduler.ts",
    symbol: "SymphonyScheduler.dispatchItem",
    cause: "protocol_adapter",
    exception_id: "legacy-symphony-claim-store",
    rationale: "Symphony scheduler writes are bridged through symphony.scheduler participant envelopes during migration."
  },
  {
    id: "gateway-control-participant-projection",
    area: "gateway",
    source: "src/server/gateway.ts",
    symbol: "gateway live control routes",
    cause: "protocol_adapter",
    exception_id: "legacy-gateway-control-routes",
    rationale: "Gateway routes preserve HTTP compatibility while emitting correlated gateway.control envelopes."
  }
];

export function auditLegacyDirectPaths(
  exceptions: LegacyDirectPathException[] = DEFAULT_LEGACY_DIRECT_PATH_EXCEPTIONS,
  requiredAreas: LegacyDirectPathArea[] = REQUIRED_LEGACY_DIRECT_PATH_AREAS,
  criticalWrites: LegacyDirectPathCriticalWrite[] = DEFAULT_LEGACY_DIRECT_PATH_CRITICAL_WRITES
): LegacyDirectPathAudit {
  const issues: LegacyDirectPathAuditIssue[] = [];
  const exceptionIds = new Set(exceptions.map((entry) => entry.id));
  for (const area of requiredAreas) {
    if (!exceptions.some((entry) => entry.area === area)) {
      issues.push({
        severity: "error",
        area,
        code: "missing_legacy_direct_path_policy",
        message: `No explicit legacy direct-path adapter or exception is registered for ${area}.`
      });
    }
  }
  for (const write of criticalWrites) {
    if (!write.source.trim() || !write.symbol.trim() || !write.rationale.trim()) {
      issues.push({
        severity: "error",
        area: write.area,
        code: "incomplete_critical_direct_write",
        message: `${write.id} must include source, symbol, and rationale.`
      });
    }
    if (write.cause === "none") {
      issues.push({
        severity: "error",
        area: write.area,
        code: "critical_direct_write_without_protocol_cause",
        message: `${write.id} must declare source_envelope_id metadata or a registered legacy adapter/exception.`
      });
    }
    if (write.cause !== "source_envelope_id" && !write.exception_id) {
      issues.push({
        severity: "error",
        area: write.area,
        code: "critical_direct_write_missing_exception",
        message: `${write.id} uses ${write.cause} but does not name a registered exception.`
      });
    }
    if (write.exception_id && !exceptionIds.has(write.exception_id)) {
      issues.push({
        severity: "error",
        area: write.area,
        code: "critical_direct_write_unregistered_exception",
        message: `${write.id} references unknown exception ${write.exception_id}.`
      });
    }
  }
  for (const entry of exceptions) {
    if (!entry.protocol_adapter.trim() || !entry.migration_task.trim() || !entry.source.trim()) {
      issues.push({
        severity: "error",
        area: entry.area,
        code: "incomplete_legacy_direct_path_exception",
        message: `${entry.id} must include source, protocol_adapter, and migration_task.`
      });
    }
    if (entry.status === "exception") {
      issues.push({
        severity: "warning",
        area: entry.area,
        code: "legacy_exception_remaining",
        message: `${entry.id} remains a direct-path exception until ${entry.migration_task}.`
      });
    }
  }
  const errors = issues.filter((issue) => issue.severity === "error").length;
  return {
    schema_version: "swarm.legacy_direct_path_audit.v1",
    status: errors > 0 ? "fail" : "pass",
    summary: {
      exceptions: exceptions.length,
      adapters: exceptions.filter((entry) => entry.status === "adapter").length,
      removals: exceptions.filter((entry) => entry.status === "remove").length,
      critical_writes: criticalWrites.length,
      envelope_caused_writes: criticalWrites.filter((entry) => entry.cause === "source_envelope_id").length,
      adapter_caused_writes: criticalWrites.filter((entry) => entry.cause === "protocol_adapter" || entry.cause === "legacy_exception").length,
      errors,
      warnings: issues.length - errors
    },
    exceptions,
    critical_writes: criticalWrites,
    issues
  };
}
