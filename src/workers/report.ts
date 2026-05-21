import { resolveSessionSelector } from "../sessions/report.js";
import { buildSessionSnapshot } from "../server/session-view.js";
import type { SwarmRuntime } from "../runtime/runtime.js";
import type { WorkerRecord } from "../storage/worker-state-store.js";

export type WorkerSelectorResolution = {
  workerId?: string;
  error?: string;
};

export type WorkerCliReport = {
  detail: string;
  data: Record<string, unknown>;
};

export function buildWorkerListReport(
  runtime: SwarmRuntime,
  options: {
    limit?: number;
    sessionSelector?: string;
  } = {}
): WorkerCliReport {
  const limit = normalizeLimit(options.limit, 20);
  const scope = resolveSessionScope(runtime, options.sessionSelector);
  if (scope.error) {
    throw new Error(scope.error);
  }
  const workers = listScopedWorkers(runtime, scope.sessionId, limit);
  const contracts = workers.map((worker) => runtime.getWorkerContract(worker.worker_id)).filter(Boolean);
  const lines: string[] = [
    "Swarm Workers",
    `workspace=${runtime.getWorkspacePath()}`,
    `session=${scope.sessionId ?? "(workspace)"}`,
    `summary total=${workers.length} running=${workers.filter((worker) => worker.status === "running").length} pending=${workers.filter((worker) => worker.status === "pending").length} resumable=${workers.filter((worker) => worker.status === "completed" || worker.status === "failed" || worker.status === "stopped").length}`,
    ""
  ];
  if (workers.length === 0) {
    lines.push(scope.sessionId
      ? "No workers found for this session family."
      : "No workers found for this workspace.");
  } else {
    for (const worker of workers) {
      const contract = runtime.getWorkerContract(worker.worker_id);
      lines.push(`${worker.updated_at} [${worker.status}] ${worker.worker_id} ${truncateText(worker.objective, 96)}`);
      lines.push([
        `  parent=${worker.parent_session_id}`,
        `agent=${worker.agent_spec_id ?? worker.capability}`,
        worker.invocation_mode ? `mode=${worker.invocation_mode}` : undefined,
        contract?.write_policy ? `write=${contract.write_policy}` : undefined,
        contract?.file_scope?.length ? `scope=${contract.file_scope.join(",")}` : undefined,
        worker.handoff_id ? `handoff=${worker.handoff_id}` : undefined
      ].filter(Boolean).join(" "));
    }
  }
  return {
    detail: lines.join("\n"),
    data: {
      session_id: scope.sessionId,
      summary: {
        total: workers.length,
        running: workers.filter((worker) => worker.status === "running").length,
        pending: workers.filter((worker) => worker.status === "pending").length,
        resumable: workers.filter((worker) => worker.status === "completed" || worker.status === "failed" || worker.status === "stopped").length
      },
      workers,
      worker_contracts: contracts
    }
  };
}

export function buildWorkerDetailReport(
  runtime: SwarmRuntime,
  selector?: string,
  options: {
    sessionSelector?: string;
  } = {}
): WorkerCliReport {
  const resolution = resolveWorkerSelector(runtime, selector, options);
  if (!resolution.workerId) {
    throw new Error(resolution.error ?? `Unknown worker: ${selector ?? "(missing)"}`);
  }
  const worker = runtime.workerStateStore.get(resolution.workerId);
  if (!worker) {
    throw new Error(`Unknown worker: ${resolution.workerId}`);
  }
  const contract = runtime.getWorkerContract(worker.worker_id);
  const workerSession = worker.worker_session_id && runtime.sessionStore.get(worker.worker_session_id)
    ? buildSessionSnapshot(runtime, worker.worker_session_id)
    : undefined;
  return {
    detail: [
      "Swarm Worker",
      `worker=${worker.worker_id} status=${worker.status} updated=${worker.updated_at}`,
      `parent_session=${worker.parent_session_id} worker_session=${worker.worker_session_id ?? "(none)"} handoff=${worker.handoff_id ?? "(none)"}`,
      `agent=${worker.agent_spec_id ?? "(none)"} capability=${worker.capability} mode=${worker.invocation_mode ?? "(none)"}`,
      `write_policy=${contract?.write_policy ?? "(none)"} scope=${contract?.file_scope?.join(",") ?? "(none)"}`,
      worker.last_result ? `last_result=${truncateText(worker.last_result, 160)}` : "last_result=(none)"
    ].join("\n"),
    data: {
      worker,
      worker_contract: contract,
      worker_session: workerSession
    }
  };
}

export function resolveWorkerSelector(
  runtime: SwarmRuntime,
  query?: string,
  options: {
    sessionSelector?: string;
  } = {}
): WorkerSelectorResolution {
  const scope = resolveSessionScope(runtime, options.sessionSelector);
  if (scope.error) {
    return { error: scope.error };
  }
  const trimmed = query?.trim();
  const workers = listScopedWorkers(runtime, scope.sessionId, 100);
  if (!trimmed || trimmed.toLowerCase() === "latest") {
    return workers[0]
      ? { workerId: workers[0].worker_id }
      : { error: scope.sessionId ? "No workers found for this session family." : "No workers found for this workspace." };
  }
  const exact = workers.find((worker) => worker.worker_id === trimmed);
  if (exact) {
    return { workerId: exact.worker_id };
  }
  return resolveWorkerMatch(workers, trimmed);
}

function resolveSessionScope(
  runtime: SwarmRuntime,
  sessionSelector?: string
): {
  sessionId?: string;
  error?: string;
} {
  const normalized = sessionSelector?.trim();
  if (!normalized) {
    return {};
  }
  return resolveSessionSelector(runtime, normalized);
}

function listScopedWorkers(runtime: SwarmRuntime, sessionId?: string, limit = 20): WorkerRecord[] {
  const resolvedLimit = normalizeLimit(limit, 20);
  if (!sessionId) {
    return runtime.listRecentWorkersForWorkspace(resolvedLimit);
  }
  const sessionIds = new Set(runtime.listSessionFamilySessionIds(sessionId, Math.max(resolvedLimit * 8, resolvedLimit)));
  return runtime.listRecentWorkersForWorkspace(Math.max(resolvedLimit * 8, resolvedLimit))
    .filter((worker) => sessionIds.has(worker.parent_session_id))
    .slice(0, resolvedLimit);
}

function resolveWorkerMatch(workers: WorkerRecord[], query: string): WorkerSelectorResolution {
  const normalized = query.toLowerCase();
  const prefixMatches = workers.filter((worker) => worker.worker_id.toLowerCase().startsWith(normalized));
  if (prefixMatches.length === 1) {
    return { workerId: prefixMatches[0].worker_id };
  }
  if (prefixMatches.length > 1) {
    return { error: `Ambiguous worker selector: ${query}. Matches: ${prefixMatches.slice(0, 6).map((worker) => worker.worker_id).join(", ")}` };
  }
  const fuzzyMatches = workers.filter((worker) =>
    worker.worker_id.toLowerCase().includes(normalized)
    || worker.objective.toLowerCase().includes(normalized)
    || worker.display_name.toLowerCase().includes(normalized)
  );
  if (fuzzyMatches.length === 1) {
    return { workerId: fuzzyMatches[0].worker_id };
  }
  if (fuzzyMatches.length > 1) {
    return { error: `Ambiguous worker selector: ${query}. Matches: ${fuzzyMatches.slice(0, 6).map((worker) => worker.worker_id).join(", ")}` };
  }
  return { error: `Unknown worker: ${query}` };
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.floor(value as number)
    : fallback;
}

function truncateText(value: string, limit: number): string {
  return value.length > limit
    ? `${value.slice(0, Math.max(0, limit - 1))}...`
    : value;
}
