// Blackboard envelope/store protocol operator extracted from SwarmRuntime.
//
// These were private SwarmRuntime methods forming a self-contained group (zero
// private-field reads, zero out-of-group private calls). They are expressed as
// free functions taking a structural deps handle (BlackboardOperatorDeps) that
// SwarmRuntime satisfies via its public readonly fields; the class keeps thin
// delegation shims so its public/private method surface is unchanged.
import { randomUUID } from "node:crypto";
import { createEnvelope } from "../protocol/envelope.js";
import type { BlackboardEntry } from "../protocol/types.js";
import type {
  BlackboardListAction,
  BlackboardReadAction,
  BlackboardSearchAction,
  BlackboardToolContext,
  BlackboardWriteAction
} from "../tools/types.js";
import type { SessionStore } from "../storage/session-store.js";
import type { BlackboardStore } from "../storage/blackboard-store.js";
import type { RuntimeEvents } from "./events.js";
import type { EnvelopeRouter } from "./router.js";
import { filterBlackboardSearch } from "./blackboard-live-control.js";

export interface BlackboardOperatorDeps {
  readonly sessionStore: SessionStore;
  readonly blackboardStore: BlackboardStore;
  readonly events: RuntimeEvents;
  readonly router: EnvelopeRouter;
}

export function writeBlackboardEvidence(
  self: BlackboardOperatorDeps,
  sessionId: string,
  input: {
    key: string;
    type: BlackboardEntry["type"];
    value: unknown;
    tags: string[];
    created_by: BlackboardEntry["created_by"];
    task_id?: string;
  }
): BlackboardEntry {
  const row = self.sessionStore.get(sessionId);
  const entry = self.blackboardStore.write({
    swarm_id: row?.swarm_id ?? `swarm_${sessionId}`,
    session_id: sessionId,
    task_id: input.task_id,
    key: input.key,
    type: input.type,
    value: input.value,
    created_by: input.created_by,
    tags: input.tags
  });
  self.events.emitEvent({ type: "blackboard", entry });
  return entry;
}

export async function writeBlackboardViaEnvelope(self: BlackboardOperatorDeps, action: BlackboardWriteAction, context: BlackboardToolContext): Promise<BlackboardEntry> {
  const sessionId = action.sessionId ?? context.blackboardSessionId ?? context.sessionId;
  if (!sessionId) {
    throw new Error("BlackboardWrite requires a runtime session");
  }
  const row = self.sessionStore.get(sessionId);
  const envelope = createEnvelope({
    swarm_id: row?.swarm_id ?? `swarm_${sessionId}`,
    session_id: sessionId,
    task_id: action.taskId ?? context.taskId,
    attempt: context.attempt,
    from: context.agent ?? { agent_id: "runtime", role: "runtime" },
    to: { agent_id: "blackboard", role: "blackboard" },
    type: "blackboard.write",
    intent: "blackboard.write",
    payload: {
      key: action.key,
      type: action.entryType,
      value: action.value,
      visibility: action.visibility,
      tags: action.tags,
      task_id: action.taskId ?? context.taskId
    },
    correlation_id: `bb_write_${randomUUID()}`,
  });
  const response = await self.router.request<{ entry?: BlackboardEntry }>(envelope, { expect: ["ack"], timeout_ms: 10_000 });
  const entry = response.payload.entry;
  if (!entry) {
    throw new Error("BlackboardWrite did not return an entry");
  }
  return entry;
}

export async function readBlackboardViaEnvelope(self: BlackboardOperatorDeps, action: BlackboardReadAction, context: BlackboardToolContext): Promise<BlackboardEntry[]> {
  const sessionId = action.sessionId ?? context.blackboardSessionId ?? context.sessionId;
  if (!sessionId) {
    throw new Error("BlackboardRead requires a runtime session");
  }
  const row = self.sessionStore.get(sessionId);
  const envelope = createEnvelope({
    swarm_id: row?.swarm_id ?? `swarm_${sessionId}`,
    session_id: sessionId,
    task_id: context.taskId,
    attempt: context.attempt,
    from: context.agent ?? { agent_id: "runtime", role: "runtime" },
    to: { agent_id: "blackboard", role: "blackboard" },
    type: "blackboard.read",
    intent: "blackboard.read",
    payload: {
      entry_id: action.entryId,
      key: action.key,
      limit: action.limit
    },
    correlation_id: `bb_read_${randomUUID()}`
  });
  const response = await self.router.request<{ entries?: BlackboardEntry[] }>(envelope, { expect: ["ack"], timeout_ms: 10_000 });
  return response.payload.entries ?? [];
}

export async function searchBlackboardViaEnvelope(self: BlackboardOperatorDeps, action: BlackboardSearchAction, context: BlackboardToolContext): Promise<BlackboardEntry[]> {
  const sessionId = action.sessionId ?? context.blackboardSessionId ?? context.sessionId;
  if (!sessionId) {
    throw new Error("BlackboardSearch requires a runtime session");
  }
  const row = self.sessionStore.get(sessionId);
  const envelope = createEnvelope({
    swarm_id: row?.swarm_id ?? `swarm_${sessionId}`,
    session_id: sessionId,
    task_id: context.taskId,
    attempt: context.attempt,
    from: context.agent ?? { agent_id: "runtime", role: "runtime" },
    to: { agent_id: "blackboard", role: "blackboard" },
    type: "blackboard.read",
    intent: "blackboard.search",
    payload: {
      type: action.entryType,
      tag: action.tag,
      key_prefix: action.keyPrefix,
      task_id: action.taskId,
      agent_id: action.agentId,
      limit: action.limit
    },
    correlation_id: `bb_search_${randomUUID()}`
  });
  const response = await self.router.request<{ entries?: BlackboardEntry[] }>(envelope, { expect: ["ack"], timeout_ms: 10_000 });
  return filterBlackboardSearch(response.payload.entries ?? [], action.query);
}

export async function listBlackboardViaEnvelope(self: BlackboardOperatorDeps, action: BlackboardListAction, context: BlackboardToolContext): Promise<BlackboardEntry[]> {
  const sessionId = action.sessionId ?? context.blackboardSessionId ?? context.sessionId;
  if (!sessionId) {
    throw new Error("BlackboardList requires a runtime session");
  }
  const row = self.sessionStore.get(sessionId);
  const envelope = createEnvelope({
    swarm_id: row?.swarm_id ?? `swarm_${sessionId}`,
    session_id: sessionId,
    task_id: context.taskId,
    attempt: context.attempt,
    from: context.agent ?? { agent_id: "runtime", role: "runtime" },
    to: { agent_id: "blackboard", role: "blackboard" },
    type: "blackboard.read",
    intent: "blackboard.list",
    payload: {
      type: action.entryType,
      tag: action.tag,
      key_prefix: action.keyPrefix,
      task_id: action.taskId,
      agent_id: action.agentId,
      limit: action.limit
    },
    correlation_id: `bb_list_${randomUUID()}`
  });
  const response = await self.router.request<{ entries?: BlackboardEntry[] }>(envelope, { expect: ["ack"], timeout_ms: 10_000 });
  return response.payload.entries ?? [];
}
