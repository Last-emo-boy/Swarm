export const SYMPHONY_ACTION_SCHEMA_VERSION = "symphony.action.v1";

export type SymphonyActionName = "pause" | "resume" | "cancel" | "retry" | "tick" | "run-once";

export type SymphonyActionPolicyVerdict = "allowed" | "requires_confirmation" | "denied" | "risk";

export type SymphonyActionRiskLevel = "low" | "medium" | "high";

export type SymphonyActionPolicySummary = {
  policy_verdict: SymphonyActionPolicyVerdict;
  risk_level: SymphonyActionRiskLevel;
  scope: string[];
  denied_reason?: string;
  rollback_plan?: string;
  not_rollbackable?: string;
  audit_id: string;
};

export type SymphonyActionLifecycleStatus =
  | "requested"
  | "accepted"
  | "applied"
  | "rejected"
  | "not_supported"
  | "timed_out"
  | "rolled_back";

export type SymphonyActionReplayStep = {
  status: SymphonyActionLifecycleStatus;
  at: string;
  message?: string;
};

export type SymphonyActionFact = {
  schema_version: typeof SYMPHONY_ACTION_SCHEMA_VERSION;
  action_id: string;
  correlation_id: string;
  gateway_envelope_id?: string;
  action: SymphonyActionName;
  status: SymphonyActionLifecycleStatus;
  policy_verdict?: SymphonyActionPolicyVerdict;
  risk_level?: SymphonyActionRiskLevel;
  scope?: string[];
  denied_reason?: string;
  rollback_plan?: string;
  not_rollbackable?: string;
  audit_id?: string;
  target: {
    session_id?: string;
    work_item_key?: string;
  };
  actor: {
    kind: "gateway" | "cli" | "tui" | "system";
    id: string;
  };
  reason?: string;
  message?: string;
  recovery?: string;
  error_code?: string;
  previous_status?: string;
  next_status?: string;
  live_stop_requested?: boolean;
  attempt_id?: string;
  replay: SymphonyActionReplayStep[];
};

type SymphonyActionFactLike = Omit<SymphonyActionFact, "schema_version"> & {
  schema_version?: typeof SYMPHONY_ACTION_SCHEMA_VERSION;
};

export function createSymphonyActionFact(input: Omit<SymphonyActionFact, "schema_version">): SymphonyActionFact {
  return stripUndefined({
    schema_version: SYMPHONY_ACTION_SCHEMA_VERSION,
    ...input,
    ...summarizeSymphonyActionPolicy(input),
    replay: input.replay
  });
}

function symphonyActionFactFromUnknown(value: unknown): SymphonyActionFact | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const direct = parseSymphonyActionFact(value);
  if (direct) {
    return direct;
  }
  return parseSymphonyActionFact(value.action_fact);
}

export function formatSymphonyActionStatus(fact: SymphonyActionFact): string {
  const policy = summarizeSymphonyActionPolicy(fact);
  return [
    `action=${fact.action}`,
    `status=${fact.status}`,
    `policy_verdict=${policy.policy_verdict}`,
    `risk_level=${policy.risk_level}`,
    `audit_id=${policy.audit_id}`,
    `action_id=${fact.action_id}`,
    `correlation_id=${fact.correlation_id}`,
    fact.gateway_envelope_id ? `gateway_envelope_id=${fact.gateway_envelope_id}` : undefined,
    fact.target.session_id ? `session=${fact.target.session_id}` : undefined,
    fact.target.work_item_key ? `target=${fact.target.work_item_key}` : undefined,
    policy.scope.length ? `scope=${policy.scope.join(",")}` : undefined,
    fact.previous_status ? `previous=${fact.previous_status}` : undefined,
    fact.next_status ? `next=${fact.next_status}` : undefined,
    fact.error_code ? `error=${fact.error_code}` : undefined,
    policy.denied_reason ? `denied_reason=${policy.denied_reason}` : undefined,
    policy.rollback_plan ? `rollback_plan=${policy.rollback_plan}` : undefined,
    policy.not_rollbackable ? `not_rollbackable=${policy.not_rollbackable}` : undefined,
    fact.reason ? `reason=${fact.reason}` : undefined,
    fact.recovery ? `recovery=${fact.recovery}` : undefined
  ].filter((line): line is string => Boolean(line)).join(" ");
}

export function latestSymphonyActionFact(values: unknown[]): SymphonyActionFact | undefined {
  return values
    .map(symphonyActionFactFromUnknown)
    .filter((item): item is SymphonyActionFact => Boolean(item))
    .sort((left, right) => latestReplayAt(right).localeCompare(latestReplayAt(left)))[0];
}

export function summarizeSymphonyActionPolicy(fact: SymphonyActionFactLike): SymphonyActionPolicySummary {
  const policyVerdict = normalizePolicyVerdict(fact.policy_verdict) ?? policyVerdictForStatus(fact.status);
  const riskLevel = normalizeRiskLevel(fact.risk_level) ?? riskLevelForPolicyVerdict(policyVerdict);
  const scope = normalizeScope(fact.scope) ?? defaultSymphonyActionScope(fact);
  const deniedReason = stringValue(fact.denied_reason) ?? (policyVerdict === "denied" ? deniedReasonForSymphonyActionFact(fact) : undefined);
  const rollbackPlan = policyVerdict === "denied"
    ? undefined
    : stringValue(fact.rollback_plan) ?? rollbackPlanForSymphonyActionFact(fact, policyVerdict);
  const notRollbackable = stringValue(fact.not_rollbackable) ?? (
    policyVerdict === "denied"
      ? deniedReason ?? notRollbackableReasonForSymphonyActionFact(fact, policyVerdict)
      : rollbackPlan
        ? undefined
        : notRollbackableReasonForSymphonyActionFact(fact, policyVerdict)
  );
  return stripUndefined({
    policy_verdict: policyVerdict,
    risk_level: riskLevel,
    scope,
    denied_reason: deniedReason,
    rollback_plan: rollbackPlan,
    not_rollbackable: notRollbackable,
    audit_id: stringValue(fact.audit_id) ?? `audit_${fact.action_id}`
  });
}

function parseSymphonyActionFact(value: unknown): SymphonyActionFact | undefined {
  if (!isRecord(value) || value.schema_version !== SYMPHONY_ACTION_SCHEMA_VERSION) {
    return undefined;
  }
  if (
    typeof value.action_id !== "string" ||
    typeof value.correlation_id !== "string" ||
    !isSymphonyActionName(value.action) ||
    !isLifecycleStatus(value.status) ||
    !isRecord(value.target) ||
    !isRecord(value.actor) ||
    !Array.isArray(value.replay)
  ) {
    return undefined;
  }
  const replay = value.replay.filter(isReplayStep);
  if (replay.length === 0) {
    return undefined;
  }
  const fact: SymphonyActionFact = stripUndefined({
    schema_version: SYMPHONY_ACTION_SCHEMA_VERSION,
    action_id: value.action_id,
    correlation_id: value.correlation_id,
    gateway_envelope_id: stringValue(value.gateway_envelope_id ?? value.gatewayEnvelopeId),
    action: value.action,
    status: value.status,
    policy_verdict: normalizePolicyVerdict(value.policy_verdict),
    risk_level: normalizeRiskLevel(value.risk_level),
    scope: normalizeScope(value.scope),
    denied_reason: stringValue(value.denied_reason),
    rollback_plan: stringValue(value.rollback_plan),
    not_rollbackable: stringValue(value.not_rollbackable),
    audit_id: stringValue(value.audit_id),
    target: stripUndefined({
      session_id: stringValue(value.target.session_id),
      work_item_key: stringValue(value.target.work_item_key)
    }),
    actor: {
      kind: isActorKind(value.actor.kind) ? value.actor.kind : "system",
      id: stringValue(value.actor.id) ?? "unknown"
    },
    reason: stringValue(value.reason),
    message: stringValue(value.message),
    recovery: stringValue(value.recovery),
    error_code: stringValue(value.error_code),
    previous_status: stringValue(value.previous_status),
    next_status: stringValue(value.next_status),
    live_stop_requested: booleanValue(value.live_stop_requested),
    attempt_id: stringValue(value.attempt_id),
    replay
  });
  return stripUndefined({
    ...fact,
    ...summarizeSymphonyActionPolicy(fact)
  });
}

function latestReplayAt(fact: SymphonyActionFact): string {
  return fact.replay.at(-1)?.at ?? "";
}

function policyVerdictForStatus(status: SymphonyActionLifecycleStatus): SymphonyActionPolicyVerdict {
  if (status === "requested" || status === "accepted") {
    return "requires_confirmation";
  }
  if (status === "applied") {
    return "allowed";
  }
  if (status === "rejected" || status === "not_supported") {
    return "denied";
  }
  return "risk";
}

function riskLevelForPolicyVerdict(verdict: SymphonyActionPolicyVerdict): SymphonyActionRiskLevel {
  if (verdict === "allowed") {
    return "low";
  }
  if (verdict === "requires_confirmation") {
    return "medium";
  }
  return "high";
}

function defaultSymphonyActionScope(fact: SymphonyActionFactLike): string[] {
  return uniqueStrings([
    fact.target.session_id ? `session:${fact.target.session_id}` : undefined,
    fact.target.work_item_key ? `work_item:${fact.target.work_item_key}` : undefined
  ]);
}

function rollbackPlanForSymphonyActionFact(fact: SymphonyActionFactLike, verdict: SymphonyActionPolicyVerdict): string | undefined {
  if (verdict === "denied") {
    return undefined;
  }
  if (fact.status === "rolled_back") {
    return fact.message ?? fact.reason ?? `Rollback restored ${fact.previous_status ?? "the prior state"}.`;
  }
  if (fact.status !== "applied") {
    return undefined;
  }
  if (fact.action === "cancel") {
    return fact.previous_status ? `Restore session status to ${fact.previous_status}.` : "Restore the session to its prior state.";
  }
  if (fact.action === "resume") {
    return fact.previous_status ? `Return the session to ${fact.previous_status}.` : "Return the session to its previous paused state.";
  }
  if (fact.action === "pause") {
    return fact.previous_status ? `Resume the session from ${fact.previous_status}.` : "Resume the session to its prior state.";
  }
  if (fact.action === "retry") {
    return fact.previous_status ? `Cancel the retry path and restore ${fact.previous_status}.` : "Cancel the retry path and restore the prior session state.";
  }
  return "Revert the operator action using the recorded audit trail.";
}

function notRollbackableReasonForSymphonyActionFact(fact: SymphonyActionFactLike, verdict: SymphonyActionPolicyVerdict): string | undefined {
  if (fact.status === "requested" || fact.status === "accepted") {
    return "The operator action is pending and has not been applied yet.";
  }
  if (fact.status === "rejected") {
    return fact.message ?? fact.reason ?? "The operator action was rejected before any reversible state change.";
  }
  if (fact.status === "not_supported") {
    return fact.message ?? fact.reason ?? "The operator action is not supported in this gateway.";
  }
  if (fact.status === "timed_out") {
    return fact.message ?? fact.reason ?? "The operator action timed out before a reversible state change completed.";
  }
  if (verdict === "denied") {
    return fact.message ?? fact.reason ?? "The operator action was denied before a reversible state change completed.";
  }
  return undefined;
}

function deniedReasonForSymphonyActionFact(fact: SymphonyActionFactLike): string | undefined {
  if (fact.status === "rejected") {
    return fact.message ?? fact.reason ?? `Target is already ${fact.previous_status ?? "terminal"}.`;
  }
  if (fact.status === "not_supported") {
    return fact.message ?? fact.reason ?? "The operator action is not supported by this gateway.";
  }
  if (fact.status === "timed_out") {
    return fact.message ?? fact.reason ?? "The operator action timed out before completion.";
  }
  return fact.message ?? fact.reason;
}

function normalizePolicyVerdict(value: unknown): SymphonyActionPolicyVerdict | undefined {
  return value === "allowed" || value === "requires_confirmation" || value === "denied" || value === "risk" ? value : undefined;
}

function normalizeRiskLevel(value: unknown): SymphonyActionRiskLevel | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function normalizeScope(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const scope = value.map(stringValue).filter((item): item is string => Boolean(item));
  return uniqueStrings(scope);
}

function isReplayStep(value: unknown): value is SymphonyActionReplayStep {
  if (!isRecord(value) || !isLifecycleStatus(value.status) || typeof value.at !== "string") {
    return false;
  }
  return value.message === undefined || typeof value.message === "string";
}

function isSymphonyActionName(value: unknown): value is SymphonyActionName {
  return value === "pause" || value === "resume" || value === "cancel" || value === "retry" || value === "tick" || value === "run-once";
}

function isLifecycleStatus(value: unknown): value is SymphonyActionLifecycleStatus {
  return value === "requested" ||
    value === "accepted" ||
    value === "applied" ||
    value === "rejected" ||
    value === "not_supported" ||
    value === "timed_out" ||
    value === "rolled_back";
}

function isActorKind(value: unknown): value is SymphonyActionFact["actor"]["kind"] {
  return value === "gateway" || value === "cli" || value === "tui" || value === "system";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefined(item)) as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      output[key] = stripUndefined(item);
    }
  }
  return output as T;
}
