import { resolveSessionSelector } from "../sessions/report.js";
import type { SwarmRuntime } from "../runtime/runtime.js";
import type { HandoffSessionRecord } from "../storage/handoff-store.js";

export type HandoffSelectorResolution = {
  handoffId?: string;
  error?: string;
};

export type HandoffCliReport = {
  detail: string;
  data: Record<string, unknown>;
};

export function buildHandoffListReport(
  runtime: SwarmRuntime,
  options: {
    limit?: number;
    sessionSelector?: string;
  } = {}
): HandoffCliReport {
  const limit = normalizeLimit(options.limit, 20);
  const scope = resolveSessionScope(runtime, options.sessionSelector);
  if (scope.error) {
    throw new Error(scope.error);
  }
  const handoffs = listScopedHandoffs(runtime, scope.sessionId, limit);
  const contracts = handoffs.map((handoff) => runtime.getHandoffContract(handoff.handoff_id)).filter(Boolean);
  const lines: string[] = [
    "Swarm Handoffs",
    `workspace=${runtime.getWorkspacePath()}`,
    `session=${scope.sessionId ?? "(workspace)"}`,
    `summary total=${handoffs.length} active=${handoffs.filter((handoff) => handoff.status === "active").length} returned=${handoffs.filter((handoff) => handoff.status === "returned").length} taken_back=${handoffs.filter((handoff) => handoff.status === "taken_back").length}`,
    ""
  ];
  if (handoffs.length === 0) {
    lines.push(scope.sessionId
      ? "No handoffs found for this session family."
      : "No handoffs found for this workspace.");
  } else {
    for (const handoff of handoffs) {
      const contract = runtime.getHandoffContract(handoff.handoff_id);
      lines.push(`${handoff.updated_at} [${handoff.status}] ${handoff.handoff_id} ${truncateText(handoff.reason, 96)}`);
      lines.push([
        `  parent=${handoff.parent_session_id}`,
        `worker=${handoff.worker_id}`,
        `target=${handoff.target_agent_spec_id}`,
        contract?.write_policy ? `write=${contract.write_policy}` : undefined,
        contract?.file_scope?.length ? `scope=${contract.file_scope.join(",")}` : undefined
      ].filter(Boolean).join(" "));
    }
  }
  return {
    detail: lines.join("\n"),
    data: {
      session_id: scope.sessionId,
      summary: {
        total: handoffs.length,
        active: handoffs.filter((handoff) => handoff.status === "active").length,
        returned: handoffs.filter((handoff) => handoff.status === "returned").length,
        taken_back: handoffs.filter((handoff) => handoff.status === "taken_back").length
      },
      handoffs,
      handoff_contracts: contracts
    }
  };
}

export function buildHandoffDetailReport(
  runtime: SwarmRuntime,
  selector?: string,
  options: {
    sessionSelector?: string;
  } = {}
): HandoffCliReport {
  const resolution = resolveHandoffSelector(runtime, selector, options);
  if (!resolution.handoffId) {
    throw new Error(resolution.error ?? `Unknown handoff: ${selector ?? "(missing)"}`);
  }
  const handoff = runtime.getHandoff(resolution.handoffId);
  if (!handoff) {
    throw new Error(`Unknown handoff: ${resolution.handoffId}`);
  }
  const contract = runtime.getHandoffContract(handoff.handoff_id);
  return {
    detail: [
      "Swarm Handoff",
      `handoff=${handoff.handoff_id} status=${handoff.status} updated=${handoff.updated_at}`,
      `parent_session=${handoff.parent_session_id} worker=${handoff.worker_id}`,
      `source_agent=${handoff.source_agent} target_agent=${handoff.target_agent_spec_id}`,
      `write_policy=${contract?.write_policy ?? "(none)"} scope=${contract?.file_scope?.join(",") ?? "(none)"}`,
      handoff.result ? `result=${truncateText(handoff.result, 160)}` : "result=(none)"
    ].join("\n"),
    data: {
      handoff,
      handoff_contract: contract
    }
  };
}

export function resolveHandoffSelector(
  runtime: SwarmRuntime,
  query?: string,
  options: {
    sessionSelector?: string;
  } = {}
): HandoffSelectorResolution {
  const scope = resolveSessionScope(runtime, options.sessionSelector);
  if (scope.error) {
    return { error: scope.error };
  }
  const trimmed = query?.trim();
  const handoffs = listScopedHandoffs(runtime, scope.sessionId, 100);
  if (!trimmed || trimmed.toLowerCase() === "latest") {
    return handoffs[0]
      ? { handoffId: handoffs[0].handoff_id }
      : { error: scope.sessionId ? "No handoffs found for this session family." : "No handoffs found for this workspace." };
  }
  const exact = handoffs.find((handoff) => handoff.handoff_id === trimmed);
  if (exact) {
    return { handoffId: exact.handoff_id };
  }
  return resolveHandoffMatch(handoffs, trimmed);
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

function listScopedHandoffs(runtime: SwarmRuntime, sessionId?: string, limit = 20): HandoffSessionRecord[] {
  const resolvedLimit = normalizeLimit(limit, 20);
  if (!sessionId) {
    return runtime.listHandoffsForWorkspace(resolvedLimit);
  }
  const sessionIds = new Set(runtime.listSessionFamilySessionIds(sessionId, Math.max(resolvedLimit * 8, resolvedLimit)));
  return runtime.listHandoffsForWorkspace(Math.max(resolvedLimit * 8, resolvedLimit))
    .filter((handoff) => sessionIds.has(handoff.parent_session_id))
    .slice(0, resolvedLimit);
}

function resolveHandoffMatch(handoffs: HandoffSessionRecord[], query: string): HandoffSelectorResolution {
  const normalized = query.toLowerCase();
  const prefixMatches = handoffs.filter((handoff) => handoff.handoff_id.toLowerCase().startsWith(normalized));
  if (prefixMatches.length === 1) {
    return { handoffId: prefixMatches[0].handoff_id };
  }
  if (prefixMatches.length > 1) {
    return { error: `Ambiguous handoff selector: ${query}. Matches: ${prefixMatches.slice(0, 6).map((handoff) => handoff.handoff_id).join(", ")}` };
  }
  const fuzzyMatches = handoffs.filter((handoff) =>
    handoff.handoff_id.toLowerCase().includes(normalized)
    || handoff.reason.toLowerCase().includes(normalized)
    || handoff.target_agent_spec_id.toLowerCase().includes(normalized)
  );
  if (fuzzyMatches.length === 1) {
    return { handoffId: fuzzyMatches[0].handoff_id };
  }
  if (fuzzyMatches.length > 1) {
    return { error: `Ambiguous handoff selector: ${query}. Matches: ${fuzzyMatches.slice(0, 6).map((handoff) => handoff.handoff_id).join(", ")}` };
  }
  return { error: `Unknown handoff: ${query}` };
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
