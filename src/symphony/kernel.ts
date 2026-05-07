import { randomUUID } from "node:crypto";
import type { SwarmPolicy, SwarmSession, WorkItem } from "../protocol/types.js";
import { workItemLabel, workItemSourceId } from "./work-item.js";

export function createSymphonyWorkSession(input: {
  item: WorkItem;
  maxAgents: number;
  timeoutMs: number;
  status?: SwarmSession["status"];
}): SwarmSession {
  const now = new Date().toISOString();
  const sessionId = `sym_${randomUUID()}`;
  return {
    swarm_id: `swarm_${sessionId}`,
    session_id: sessionId,
    user_request_id: workItemSourceId(input.item) || sessionId,
    source: input.item,
    objective: `${input.item.human_id ? `${input.item.human_id}: ` : ""}${input.item.title}`,
    status: input.status ?? "created",
    coordinator: { agent_id: "symphony", role: "scheduler" },
    participants: [],
    created_at: now,
    updated_at: now,
    policy: createSymphonyPolicy(input.maxAgents, input.timeoutMs)
  };
}

export function createSymphonyPolicy(maxAgents: number, timeoutMs: number): SwarmPolicy {
  return {
    max_agents: maxAgents,
    max_parallel_tasks: Math.max(1, Math.min(maxAgents, 3)),
    timeout_ms: timeoutMs,
    retry: {
      max_attempts: 1,
      backoff_ms: 10_000
    },
    require_review: true,
    consensus: "reviewer_approval",
    approval_mode: "on-request",
    network_access: "deny",
    allow_domains: [],
    human_approval_for: ["tool.shell.exec", "tool.file.write", "tool.file.edit", "package.install", "agent.delegate"],
    safety: {
      require_human_approval_for: ["tool.shell.exec", "tool.file.write", "tool.file.edit", "package.install", "agent.delegate"],
      forbidden_capabilities: ["credential.exfiltrate"],
      sandbox_required: false
    },
    memory: {
      allow_read: true,
      allow_write: true,
      retention: "session"
    },
    budget: {
      max_agents: maxAgents,
      max_tool_calls: 50
    }
  };
}

export function workItemToTemplateIssue(item: WorkItem): Record<string, unknown> {
  return {
    id: workItemSourceId(item),
    source_id: workItemSourceId(item),
    identifier: workItemLabel(item),
    title: item.title,
    description: item.description ?? null,
    priority: item.priority ?? null,
    state: item.state ?? "",
    url: item.url ?? null,
    labels: item.labels,
    blocked_by: item.metadata.blocked_by ?? [],
    created_at: item.metadata.created_at ?? null,
    updated_at: item.metadata.updated_at ?? null
  };
}
