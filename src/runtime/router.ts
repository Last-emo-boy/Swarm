import { EventEmitter } from "node:events";
import { createEnvelope } from "../protocol/envelope.js";
import type { AgentAddress, AgentCard, AgentStatus, BlackboardEntry, SwarmEnvelope, SwarmTask } from "../protocol/types.js";
import { ArtifactStore } from "../storage/artifact-store.js";
import { BlackboardStore } from "../storage/blackboard-store.js";
import { TaskStateStore } from "../storage/task-state-store.js";
import { TraceStore } from "../storage/trace-store.js";
import { RuntimeEvents } from "./events.js";
import { AgentRegistry, type RegisteredAgent } from "./registry.js";

type RequestOptions = {
  expect: SwarmEnvelope["type"][];
  timeout_ms: number;
};

export class EnvelopeRouter extends EventEmitter {
  private readonly processedKeys = new Map<string, string>(); // idempotency_key → envelope_id
  private readonly pendingBids = new Map<string, BidSubmission[]>();
  private readonly pendingConsensus = new Map<string, ConsensusVote[]>();

  constructor(
    private readonly registry: AgentRegistry,
    private readonly traceStore: TraceStore,
    private readonly events: RuntimeEvents,
    private readonly blackboard?: BlackboardStore,
    private readonly artifacts?: ArtifactStore,
    private readonly taskStates?: TaskStateStore
  ) {
    super();
  }

  async dispatch(envelope: SwarmEnvelope): Promise<void> {
    if (envelope.type === "swarm.init" || envelope.type === "swarm.join" || envelope.type === "swarm.leave" || envelope.type === "swarm.heartbeat" || envelope.type === "swarm.shutdown") {
      this.handleSwarmLifecycle(envelope);
      return;
    }

    if (envelope.type === "agent.register") {
      this.handleAgentRegister(envelope);
      return;
    }

    if (envelope.type === "agent.update_status") {
      this.handleAgentUpdateStatus(envelope);
      return;
    }

    if (envelope.type === "agent.capability_query") {
      this.handleCapabilityQuery(envelope);
      return;
    }

    if (envelope.type === "blackboard.write") {
      this.handleBlackboardWrite(envelope);
      return;
    }

    if (envelope.type === "blackboard.read") {
      this.handleBlackboardRead(envelope);
      return;
    }

    if (envelope.type === "blackboard.update") {
      this.handleBlackboardUpdate(envelope);
      return;
    }

    if (envelope.type === "blackboard.lock") {
      this.handleBlackboardLock(envelope);
      return;
    }

    if (envelope.type === "blackboard.unlock") {
      this.handleBlackboardUnlock(envelope);
      return;
    }

    if (envelope.type === "bid.submit") {
      this.handleBidSubmit(envelope);
      return;
    }

    if (envelope.type === "consensus.vote") {
      this.handleConsensusVote(envelope);
      return;
    }

    if (envelope.type === "task.create") {
      this.handleTaskCreate(envelope);
      return;
    }

    if (envelope.type === "task.cancel") {
      this.handleTaskCancel(envelope);
      return;
    }

    if (envelope.type === "artifact.create") {
      this.handleArtifactCreate(envelope);
      return;
    }

    if (envelope.type === "artifact.update") {
      this.handleArtifactUpdate(envelope);
      return;
    }

    if (envelope.idempotency_key) {
      const existing = this.processedKeys.get(envelope.idempotency_key);
      if (existing) {
        this.events.emitEvent({ type: "log", level: "info", message: `Skipping duplicate envelope ${envelope.type} (idempotent, matched ${existing})` });
        return;
      }
    }

    this.record(envelope);
    const targets = this.resolveTargets(envelope);
    if (targets.length === 0) {
      throw new Error(`No route for envelope ${envelope.type} to ${JSON.stringify(envelope.to)}`);
    }

    if (envelope.type === "bid.request") {
      this.pendingBids.set(correlationKey(envelope), []);
    }
    if (envelope.type === "consensus.request") {
      this.pendingConsensus.set(correlationKey(envelope), []);
    }

    for (const target of targets) {
      target.process?.send(envelope);
      this.registry.incrementLoad(target.card.agent_id);
    }
    if (envelope.routing?.require_ack) {
      this.receive(this.ackReply(envelope, "router.dispatch.ack", {
        delivered: targets.map((target) => target.card.agent_id),
        mode: envelope.routing?.mode ?? "direct"
      }));
    }
  }

  receive(envelope: SwarmEnvelope): void {
    this.record(envelope);

    const fromAgent = envelope.from.agent_id;
    if (fromAgent && ["task.result", "task.fail", "review.result", "error"].includes(envelope.type)) {
      this.registry.decrementLoad(fromAgent);
    }

    this.emit("incoming", envelope);
  }

  async request<T = unknown>(envelope: SwarmEnvelope, options: RequestOptions): Promise<SwarmEnvelope<T>> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off("incoming", onIncoming);
        reject(new Error(`Timed out waiting for ${options.expect.join(", ")} for ${envelope.task_id ?? envelope.id}`));
      }, options.timeout_ms);

      const onIncoming = (incoming: SwarmEnvelope<T>) => {
        const matchesCorrelation =
          incoming.reply_to === envelope.id ||
          incoming.correlation_id === envelope.id ||
          (envelope.correlation_id !== undefined && incoming.correlation_id === envelope.correlation_id);
        const matchesTask = envelope.task_id
          ? incoming.task_id === envelope.task_id && matchesCorrelation
          : matchesCorrelation;
        const matchesType = options.expect.includes(incoming.type);
        const addressedToRequester =
          incoming.to && !Array.isArray(incoming.to) && incoming.to.agent_id === envelope.from.agent_id;

        if (matchesTask && matchesType && addressedToRequester) {
          clearTimeout(timeout);
          this.off("incoming", onIncoming);
          resolve(incoming);
        }
      };

      this.on("incoming", onIncoming);
      this.dispatch(envelope).catch((error: unknown) => {
        clearTimeout(timeout);
        this.off("incoming", onIncoming);
        reject(error);
      });
    });
  }

  private record(envelope: SwarmEnvelope): void {
    if (envelope.idempotency_key) {
      this.processedKeys.set(envelope.idempotency_key, envelope.id);
    }
    this.traceStore.append(envelope);
    this.events.emitEvent({ type: "envelope", envelope });
  }

  private resolveTargets(envelope: SwarmEnvelope): RegisteredAgent[] {
    const mode = envelope.routing?.mode;
    const addresses = Array.isArray(envelope.to) ? envelope.to : [envelope.to];
    const targets: RegisteredAgent[] = [];

    for (const address of addresses) {
      if (address.agent_id) {
        const target = this.registry.get(address.agent_id);
        if (target) {
          targets.push(target);
        }
        continue;
      }

      if (address.capability) {
        const candidates = this.registry.queryByCapability(address.capability);
        const selected = mode === "broadcast" || mode === "all"
          ? candidates
          : candidates.slice(0, 1);
        for (const target of selected) {
          targets.push(target);
        }
        continue;
      }

      if (address.role) {
        const candidates = this.registry.queryByRole(address.role);
        const selected = mode === "broadcast" || mode === "all"
          ? candidates
          : candidates.slice(0, 1);
        for (const target of selected) {
          targets.push(target);
        }
      }
    }

    if (mode === "broadcast" && targets.length === 0) {
      return dedupeTargets(this.registry.listRegistered().filter((target) => target.card.status !== "offline"));
    }
    return dedupeTargets(targets);
  }

  private handleSwarmLifecycle(envelope: SwarmEnvelope): void {
    this.record(envelope);
    this.receive(this.ackReply(envelope, `${envelope.type}.ack`, {
      status: envelope.type,
      swarm_id: envelope.swarm_id,
      session_id: envelope.session_id
    }));
  }

  private handleAgentRegister(envelope: SwarmEnvelope): void {
    this.record(envelope);
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    const card = agentCardField(payload.card ?? payload.agent ?? payload);
    if (!card) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", "agent.register requires an AgentCard payload."));
      return;
    }
    this.registry.register(card);
    this.receive(this.ackReply(envelope, "agent.register.ack", { agent: card }));
  }

  private handleAgentUpdateStatus(envelope: SwarmEnvelope): void {
    this.record(envelope);
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    const agentId = stringField(payload.agent_id ?? payload.agentId) ?? envelope.from.agent_id;
    const status = agentStatusField(payload.status);
    if (!agentId || !status) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", "agent.update_status requires agent_id and a valid status."));
      return;
    }
    this.registry.updateStatus(agentId, status);
    this.receive(this.ackReply(envelope, "agent.update_status.ack", { agent_id: agentId, status }));
  }

  private handleCapabilityQuery(envelope: SwarmEnvelope): void {
    this.record(envelope);
    const payload = envelope.payload as { capability?: string };
    const targetCapability = !Array.isArray(envelope.to) ? envelope.to.capability : undefined;
    const capability = payload.capability ?? targetCapability;
    const candidates = capability ? this.registry.queryByCapability(capability).map((item) => item.card) : this.registry.list();
    const response: SwarmEnvelope = {
      ...envelope,
      id: `env_capability_response_${Date.now()}`,
      type: "agent.capability_response",
      intent: "agent.capability_response",
      from: { agent_id: "router", role: "router" },
      to: envelope.from,
      reply_to: envelope.id,
      correlation_id: envelope.correlation_id ?? envelope.id,
      trace: envelope.trace
        ? {
            trace_id: envelope.trace.trace_id,
            span_id: `span_capability_response_${Date.now()}`,
            parent_span_id: envelope.trace.span_id
          }
        : undefined,
      payload: { capability, candidates },
      created_at: new Date().toISOString()
    };
    this.receive(response);
  }

  private handleBlackboardWrite(envelope: SwarmEnvelope): void {
    this.record(envelope);
    if (!this.blackboard) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", "Blackboard store is not configured for this router."));
      return;
    }
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    const key = stringField(payload.key);
    const entryType = blackboardEntryType(payload.type ?? payload.entryType ?? payload.entry_type);
    if (!key || !entryType) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", "blackboard.write requires payload.key and a valid payload.type."));
      return;
    }

    try {
      const entry = this.blackboard.write({
        swarm_id: stringField(payload.swarm_id) ?? envelope.swarm_id,
        session_id: stringField(payload.session_id) ?? envelope.session_id,
        task_id: stringField(payload.task_id) ?? envelope.task_id,
        key,
        type: entryType,
        value: "value" in payload ? payload.value : payload.content,
        created_by: agentAddressField(payload.created_by) ?? envelope.from,
        visibility: blackboardVisibility(payload.visibility),
        tags: stringArrayField(payload.tags)
      });
      this.events.emitEvent({ type: "blackboard", entry });
      this.receive(this.ackReply(envelope, "blackboard.write.ack", { entry }));
    } catch (error) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", error instanceof Error ? error.message : String(error)));
    }
  }

  private handleBlackboardRead(envelope: SwarmEnvelope): void {
    this.record(envelope);
    if (!this.blackboard) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", "Blackboard store is not configured for this router."));
      return;
    }
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    const sessionId = stringField(payload.session_id) ?? envelope.session_id;
    const limit = positiveIntegerField(payload.limit);
    try {
      const entries = this.applyBlackboardLimit(this.selectBlackboardEntries(sessionId, payload), limit);
      this.receive(this.ackReply(envelope, "blackboard.read.ack", { entries }));
    } catch (error) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", error instanceof Error ? error.message : String(error)));
    }
  }

  private handleBlackboardUpdate(envelope: SwarmEnvelope): void {
    this.record(envelope);
    if (!this.blackboard) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", "Blackboard store is not configured for this router."));
      return;
    }
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    const sessionId = stringField(payload.session_id) ?? envelope.session_id;
    const entryId = stringField(payload.entry_id ?? payload.entryId);
    const key = stringField(payload.key);
    if (!entryId && !key) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", "blackboard.update requires payload.entry_id or payload.key."));
      return;
    }
    try {
      const entry = this.blackboard.update({
        session_id: sessionId,
        entry_id: entryId,
        key,
        expected_version: positiveIntegerField(payload.expected_version ?? payload.expectedVersion),
        value: "value" in payload ? payload.value : payload.content,
        tags: stringArrayField(payload.tags)
      });
      this.events.emitEvent({ type: "blackboard", entry });
      this.receive(this.ackReply(envelope, "blackboard.update.ack", { entry }));
    } catch (error) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", error instanceof Error ? error.message : String(error)));
    }
  }

  private handleBlackboardLock(envelope: SwarmEnvelope): void {
    this.record(envelope);
    if (!this.blackboard) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", "Blackboard store is not configured for this router."));
      return;
    }
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    const key = stringField(payload.key);
    if (!key) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", "blackboard.lock requires payload.key."));
      return;
    }
    try {
      this.blackboard.lock({
        session_id: stringField(payload.session_id) ?? envelope.session_id,
        key,
        holder: agentAddressField(payload.holder) ?? envelope.from,
        ttl_ms: positiveIntegerField(payload.ttl_ms ?? payload.ttlMs)
      });
      this.receive(this.ackReply(envelope, "blackboard.lock.ack", { key, locked: true }));
    } catch (error) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", error instanceof Error ? error.message : String(error)));
    }
  }

  private handleBlackboardUnlock(envelope: SwarmEnvelope): void {
    this.record(envelope);
    if (!this.blackboard) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", "Blackboard store is not configured for this router."));
      return;
    }
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    const key = stringField(payload.key);
    if (!key) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", "blackboard.unlock requires payload.key."));
      return;
    }
    try {
      this.blackboard.unlock({
        session_id: stringField(payload.session_id) ?? envelope.session_id,
        key
      });
      this.receive(this.ackReply(envelope, "blackboard.unlock.ack", { key, unlocked: true }));
    } catch (error) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", error instanceof Error ? error.message : String(error)));
    }
  }

  private handleBidSubmit(envelope: SwarmEnvelope): void {
    this.record(envelope);
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    const key = correlationKey(envelope);
    const bids = this.pendingBids.get(key) ?? [];
    const bid: BidSubmission = {
      from: envelope.from,
      task_id: stringField(payload.task_id ?? payload.taskId) ?? envelope.task_id,
      confidence: numberField(payload.confidence),
      estimated_time_ms: positiveIntegerField(payload.estimated_time_ms ?? payload.estimatedTimeMs),
      estimated_cost: numberField(payload.estimated_cost ?? payload.estimatedCost),
      reason: stringField(payload.reason)
    };
    bids.push(bid);
    this.pendingBids.set(key, bids);
    this.receive(this.ackReply(envelope, "bid.submit.ack", { bid, bids }));
  }

  private handleConsensusVote(envelope: SwarmEnvelope): void {
    this.record(envelope);
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    const key = correlationKey(envelope);
    const votes = this.pendingConsensus.get(key) ?? [];
    const vote: ConsensusVote = {
      from: envelope.from,
      vote: stringField(payload.vote) ?? String(payload.decision ?? payload.verdict ?? ""),
      confidence: numberField(payload.confidence),
      reason: stringField(payload.reason)
    };
    votes.push(vote);
    this.pendingConsensus.set(key, votes);
    const result = consensusResult(votes, stringField(payload.mode));
    this.receive(this.ackReply(envelope, "consensus.vote.ack", { vote, votes, result }));
    if (result.decision) {
      this.receive(createEnvelope({
        swarm_id: envelope.swarm_id,
        session_id: envelope.session_id,
        task_id: envelope.task_id,
        attempt: envelope.attempt,
        from: { agent_id: "router", role: "router" },
        to: envelope.to,
        type: "consensus.result",
        intent: "consensus.result",
        payload: result,
        correlation_id: envelope.correlation_id ?? envelope.id,
        reply_to: envelope.id
      }));
    }
  }

  private handleTaskCreate(envelope: SwarmEnvelope): void {
    this.record(envelope);
    if (!this.taskStates) {
      this.receive(this.ackReply(envelope, "task.create.ack", { recorded: true, persisted: false }));
      return;
    }
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    const task = swarmTaskField(payload.task ?? payload);
    if (!task) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", "task.create requires a valid task payload."));
      return;
    }
    const snapshot = this.taskStates.upsert({
      session_id: envelope.session_id,
      swarm_id: envelope.swarm_id,
      task,
      status: task.status
    });
    this.receive(this.ackReply(envelope, "task.create.ack", { task: snapshot }));
  }

  private handleTaskCancel(envelope: SwarmEnvelope): void {
    this.record(envelope);
    if (!this.taskStates) {
      this.receive(this.ackReply(envelope, "task.cancel.ack", { recorded: true, persisted: false }));
      return;
    }
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    const taskId = stringField(payload.task_id ?? payload.taskId) ?? envelope.task_id;
    if (!taskId) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", "task.cancel requires task_id."));
      return;
    }
    const task = swarmTaskField({ ...payload, task_id: taskId, status: "cancelled" });
    if (!task) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", "task.cancel requires enough task fields to persist cancellation."));
      return;
    }
    const snapshot = this.taskStates.upsert({
      session_id: envelope.session_id,
      swarm_id: envelope.swarm_id,
      task,
      status: "cancelled"
    });
    this.receive(this.ackReply(envelope, "task.cancel.ack", { task: snapshot }));
  }

  private handleArtifactCreate(envelope: SwarmEnvelope): void {
    this.record(envelope);
    if (!this.artifacts) {
      this.receive(this.ackReply(envelope, "artifact.create.ack", { recorded: true, persisted: false }));
      return;
    }
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    const path = stringField(payload.path);
    const type = stringField(payload.type);
    if (!path || !type) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", "artifact.create requires path and type."));
      return;
    }
    try {
      const artifact = this.artifacts.create({
        artifact_id: stringField(payload.artifact_id ?? payload.artifactId),
        session_id: stringField(payload.session_id) ?? envelope.session_id,
        path,
        type,
        summary: stringField(payload.summary)
      });
      this.receive(this.ackReply(envelope, "artifact.create.ack", { artifact }));
    } catch (error) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", error instanceof Error ? error.message : String(error)));
    }
  }

  private handleArtifactUpdate(envelope: SwarmEnvelope): void {
    this.record(envelope);
    if (!this.artifacts) {
      this.receive(this.ackReply(envelope, "artifact.update.ack", { recorded: true, persisted: false }));
      return;
    }
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    const artifactId = stringField(payload.artifact_id ?? payload.artifactId);
    if (!artifactId) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", "artifact.update requires artifact_id."));
      return;
    }
    try {
      const artifact = this.artifacts.update({
        artifact_id: artifactId,
        path: stringField(payload.path),
        type: stringField(payload.type),
        summary: stringField(payload.summary)
      });
      this.receive(this.ackReply(envelope, "artifact.update.ack", { artifact }));
    } catch (error) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", error instanceof Error ? error.message : String(error)));
    }
  }

  private selectBlackboardEntries(sessionId: string, payload: Record<string, unknown>): BlackboardEntry[] {
    const entryId = stringField(payload.entry_id ?? payload.entryId);
    const key = stringField(payload.key);
    if (entryId || key) {
      return this.blackboard?.read(sessionId, { entryId, key, limit: positiveIntegerField(payload.limit) }) ?? [];
    }
    return this.blackboard?.query(sessionId, {
      type: blackboardEntryType(payload.type ?? payload.entryType ?? payload.entry_type),
      tag: stringField(payload.tag),
      keyPrefix: stringField(payload.key_prefix ?? payload.keyPrefix),
      taskId: stringField(payload.task_id ?? payload.taskId),
      agentId: stringField(payload.agent_id ?? payload.agentId)
    }) ?? [];
  }

  private applyBlackboardLimit(entries: BlackboardEntry[], limit: number | undefined): BlackboardEntry[] {
    if (!limit || limit <= 0) {
      return entries;
    }
    return entries.slice(Math.max(0, entries.length - limit));
  }

  private ackReply<T>(envelope: SwarmEnvelope, intent: string, payload: T): SwarmEnvelope<T> {
    return createEnvelope({
      swarm_id: envelope.swarm_id,
      session_id: envelope.session_id,
      task_id: envelope.task_id,
      attempt: envelope.attempt,
      from: { agent_id: "router", role: "router" },
      to: envelope.from,
      type: "ack",
      intent,
      payload,
      correlation_id: envelope.correlation_id ?? envelope.id,
      reply_to: envelope.id,
      trace: envelope.trace
        ? {
            trace_id: envelope.trace.trace_id,
            span_id: `span_${Date.now()}`,
            parent_span_id: envelope.trace.span_id
          }
        : undefined
    });
  }

  private errorReply(envelope: SwarmEnvelope, errorCode: string, message: string): SwarmEnvelope {
    return createEnvelope({
      swarm_id: envelope.swarm_id,
      session_id: envelope.session_id,
      task_id: envelope.task_id,
      attempt: envelope.attempt,
      from: { agent_id: "router", role: "router" },
      to: envelope.from,
      type: "error",
      intent: "router.error",
      payload: {
        error_code: errorCode,
        message,
        retryable: false,
        failed_task_id: envelope.task_id,
        recovery_suggestion: "Fix the envelope payload and retry the semantic blackboard operation."
      },
      correlation_id: envelope.correlation_id ?? envelope.id,
      reply_to: envelope.id
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayField(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return undefined;
}

function positiveIntegerField(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function numberField(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function blackboardEntryType(value: unknown): BlackboardEntry["type"] | undefined {
  return value === "plan" ||
    value === "observation" ||
    value === "evidence" ||
    value === "result" ||
    value === "critique" ||
    value === "decision" ||
    value === "artifact"
    ? value
    : undefined;
}

function blackboardVisibility(value: unknown): BlackboardEntry["visibility"] | undefined {
  return value === "private" || value === "team" || value === "public" ? value : undefined;
}

function agentAddressField(value: unknown): AgentAddress | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const address: AgentAddress = {
    agent_id: stringField(value.agent_id ?? value.agentId),
    role: stringField(value.role),
    capability: stringField(value.capability)
  };
  return address.agent_id || address.role || address.capability ? address : undefined;
}

function agentStatusField(value: unknown): AgentStatus | undefined {
  return value === "idle" || value === "busy" || value === "offline" || value === "degraded" ? value : undefined;
}

function agentCardField(value: unknown): AgentCard | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const agentId = stringField(value.agent_id ?? value.agentId);
  const name = stringField(value.name) ?? agentId;
  const role = stringField(value.role);
  const capabilities = stringArrayField(value.capabilities) ?? [];
  const status = agentStatusField(value.status) ?? "idle";
  if (!agentId || !name || !role) {
    return undefined;
  }
  const load = isRecord(value.load) ? value.load : {};
  const reliability = isRecord(value.reliability) ? value.reliability : {};
  return {
    agent_id: agentId,
    name,
    role,
    capabilities,
    status,
    load: {
      running_tasks: positiveIntegerField(load.running_tasks ?? load.runningTasks) ?? 0,
      max_tasks: positiveIntegerField(load.max_tasks ?? load.maxTasks) ?? 1
    },
    reliability: {
      success_rate: numberField(reliability.success_rate ?? reliability.successRate) ?? 0.5,
      avg_latency_ms: positiveIntegerField(reliability.avg_latency_ms ?? reliability.avgLatencyMs) ?? 0
    },
    metadata: isRecord(value.metadata) ? value.metadata : undefined
  };
}

function swarmTaskField(value: unknown): SwarmTask | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const taskId = stringField(value.task_id ?? value.taskId);
  const title = stringField(value.title) ?? taskId;
  const description = stringField(value.description) ?? title;
  const objective = stringField(value.objective) ?? description;
  const type = swarmTaskTypeField(value.type);
  const status = swarmTaskStatusField(value.status) ?? "created";
  if (!taskId || !title || !description || !objective || !type) {
    return undefined;
  }
  const expectedOutput = isRecord(value.expected_output ?? value.expectedOutput)
    ? value.expected_output ?? value.expectedOutput
    : {};
  return {
    task_id: taskId,
    parent_task_id: stringField(value.parent_task_id ?? value.parentTaskId),
    title,
    description,
    objective,
    type,
    status,
    required_capabilities: stringArrayField(value.required_capabilities ?? value.requiredCapabilities) ?? [],
    inputs: isRecord(value.inputs) ? value.inputs : {},
    expected_output: {
      format: expectedOutputFormatField(isRecord(expectedOutput) ? expectedOutput.format : undefined),
      schema: isRecord(expectedOutput) && isRecord(expectedOutput.schema) ? expectedOutput.schema : undefined
    },
    dependencies: stringArrayField(value.dependencies),
    assigned_to: agentAddressField(value.assigned_to ?? value.assignedTo),
    risk_class: value.risk_class === "r0" || value.risk_class === "r1" || value.risk_class === "r2" || value.risk_class === "r3" || value.risk_class === "r4" ? value.risk_class : undefined,
    deadline_at: stringField(value.deadline_at ?? value.deadlineAt),
    constraints: stringArrayField(value.constraints),
    acceptance_criteria: stringArrayField(value.acceptance_criteria ?? value.acceptanceCriteria)
  };
}

function swarmTaskTypeField(value: unknown): SwarmTask["type"] | undefined {
  return value === "research" ||
    value === "coding" ||
    value === "analysis" ||
    value === "review" ||
    value === "tool_call" ||
    value === "planning" ||
    value === "aggregation"
    ? value
    : undefined;
}

function swarmTaskStatusField(value: unknown): SwarmTask["status"] | undefined {
  return value === "created" ||
    value === "pending" ||
    value === "assigned" ||
    value === "running" ||
    value === "blocked" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
    ? value
    : undefined;
}

function expectedOutputFormatField(value: unknown): SwarmTask["expected_output"]["format"] {
  return value === "text" || value === "json" || value === "markdown" || value === "artifact" || value === "patch"
    ? value
    : "markdown";
}

function dedupeTargets(targets: RegisteredAgent[]): RegisteredAgent[] {
  const seen = new Set<string>();
  const result: RegisteredAgent[] = [];
  for (const target of targets) {
    if (seen.has(target.card.agent_id)) {
      continue;
    }
    seen.add(target.card.agent_id);
    result.push(target);
  }
  return result;
}

function correlationKey(envelope: SwarmEnvelope): string {
  return envelope.correlation_id ?? envelope.reply_to ?? envelope.task_id ?? envelope.id;
}

type BidSubmission = {
  from: AgentAddress;
  task_id?: string;
  confidence?: number;
  estimated_time_ms?: number;
  estimated_cost?: number;
  reason?: string;
};

type ConsensusVote = {
  from: AgentAddress;
  vote: string;
  confidence?: number;
  reason?: string;
};

function consensusResult(votes: ConsensusVote[], mode = "majority_vote"): {
  mode: string;
  decision?: "approve" | "reject";
  approvals: number;
  rejections: number;
  abstentions: number;
} {
  const approvals = votes.filter((vote) => isApproveVote(vote.vote)).length;
  const rejections = votes.filter((vote) => isRejectVote(vote.vote)).length;
  const abstentions = Math.max(0, votes.length - approvals - rejections);
  const decision = mode === "unanimous"
    ? approvals > 0 && rejections === 0 && abstentions === 0
      ? "approve"
      : rejections > 0
        ? "reject"
        : undefined
    : approvals > rejections
      ? "approve"
      : rejections > approvals
        ? "reject"
        : undefined;
  return { mode, decision, approvals, rejections, abstentions };
}

function isApproveVote(value: string): boolean {
  return ["approve", "approved", "yes", "accept", "pass"].includes(value.trim().toLowerCase());
}

function isRejectVote(value: string): boolean {
  return ["reject", "rejected", "no", "deny", "fail"].includes(value.trim().toLowerCase());
}
