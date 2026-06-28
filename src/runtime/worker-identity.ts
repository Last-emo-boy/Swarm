import type { AgentInvocationRequest, AgentSpec, AgentSpawnDecision, AgentTaskPacket } from "./agent-specs.js";
import { makeWorkerIdentity } from "../storage/worker-state-store.js";
import { isAgentInvocationMode } from "./run-options.js";

export function normalizeAgentSpawnDecision(
  parsed: Record<string, unknown>,
  request: AgentInvocationRequest,
  specs: AgentSpec[]
): AgentSpawnDecision {
  const parsedSpecId = typeof parsed.agent_spec_id === "string" ? parsed.agent_spec_id.trim() : "";
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  const preferredSpecId = request.preferred_agent_spec_id && byId.has(request.preferred_agent_spec_id)
    ? request.preferred_agent_spec_id
    : "";
  let agentSpecId = byId.has(parsedSpecId)
    ? parsedSpecId
    : preferredSpecId || "researcher";
  const selectedSpec = byId.get(agentSpecId);
  let policyAdjustment: string | undefined;
  if (
    selectedSpec?.write_policy === "scoped_write" &&
    !request.file_scope?.length &&
    request.capability !== "code.edit" &&
    request.capability !== "code.implement" &&
    request.capability !== "bug.fix"
  ) {
    policyAdjustment = `Policy adjusted ${agentSpecId} to researcher because scoped_write requires a file_scope for this capability.`;
    agentSpecId = "researcher";
  }
  if (!byId.has(agentSpecId)) {
    agentSpecId = byId.has("researcher") ? "researcher" : specs[0]?.id ?? "researcher";
  }

  const parsedMode = typeof parsed.invocation_mode === "string" ? parsed.invocation_mode.trim() : "";
  const invocationMode = isAgentInvocationMode(parsedMode)
    ? parsedMode
    : request.preferred_mode ?? "call_subagent";

  const confidence = typeof parsed.confidence === "number"
    ? Math.max(0, Math.min(1, parsed.confidence))
    : 0.5;
  const reason = typeof parsed.reason === "string" && parsed.reason.trim()
    ? parsed.reason.trim().slice(0, 800)
    : "Main Swarm selected an internal agent based on the delegated task packet.";
  const normalizedIdentity = normalizeWorkerIdentityFields(parsed, agentSpecId, request, reason);
  return {
    agent_spec_id: agentSpecId,
    invocation_mode: invocationMode,
    reason: policyAdjustment ? `${policyAdjustment} ${reason}` : reason,
    confidence,
    display_name: normalizedIdentity.display_name,
    role_title: normalizedIdentity.role_title,
    persona_brief: normalizedIdentity.persona_brief
  };
}

export function withWorkerIdentityFallback(
  decision: AgentSpawnDecision,
  workerId: string,
  request: AgentInvocationRequest,
  spec: AgentSpec
): AgentSpawnDecision {
  const fallback = makeWorkerIdentity({
    worker_id: workerId,
    agent_spec_id: spec.id,
    capability: request.capability
  });
  return {
    ...decision,
    display_name: sanitizeWorkerIdentityText(decision.display_name, 16) || fallback.display_name,
    role_title: sanitizeWorkerIdentityText(decision.role_title, 32) || fallback.role_title,
    persona_brief: sanitizeWorkerPersona(decision.persona_brief) || `Operate as ${fallback.role_title}; follow the selected ${spec.id} tool and write policy.`
  };
}

export function stripEphemeralAgentDecision(decision: AgentSpawnDecision): AgentSpawnDecision {
  const { persona_brief: _personaBrief, ...durableDecision } = decision;
  return durableDecision;
}

export function stripEphemeralAgentPersona(taskPacket: AgentTaskPacket): AgentTaskPacket {
  const { persona_brief: _personaBrief, ...durableTaskPacket } = taskPacket;
  return durableTaskPacket;
}

export function normalizeWorkerIdentityFields(
  parsed: Record<string, unknown>,
  agentSpecId: string,
  request: AgentInvocationRequest,
  reason: string
): Pick<AgentSpawnDecision, "display_name" | "role_title" | "persona_brief"> {
  const fallback = makeWorkerIdentity({
    worker_id: `${request.parent_session_id}:${request.task}:${reason}`,
    agent_spec_id: agentSpecId,
    capability: request.capability
  });
  const displayName = sanitizeWorkerIdentityText(parsed.display_name, 16) || fallback.display_name;
  const roleTitle = sanitizeWorkerIdentityText(parsed.role_title, 32) || fallback.role_title;
  const personaBrief = sanitizeWorkerPersona(parsed.persona_brief) ||
    `Operate as ${roleTitle}; follow the selected ${agentSpecId} tool and write policy.`;
  return {
    display_name: displayName,
    role_title: roleTitle,
    persona_brief: personaBrief
  };
}

export function sanitizeWorkerIdentityText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const cleaned = value
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[\\/|]+/g, " ")
    .replace(/["'`]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
  return cleaned.length >= 2 ? cleaned : undefined;
}

export function sanitizeWorkerPersona(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const cleaned = value
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280)
    .trim();
  return cleaned.length >= 12 ? cleaned : undefined;
}
