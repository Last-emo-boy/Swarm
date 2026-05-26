import { EventEmitter } from "node:events";
import { createEnvelope } from "../protocol/envelope.js";
import type {
  AgentAddress,
  AgentCard,
  AgentStatus,
  BlackboardClaimStatus,
  BlackboardCollaborationKind,
  BlackboardCollaborationMetadata,
  BlackboardDecisionPolicy,
  BlackboardDecisionPolicyStatus,
  BlackboardDecisionStatus,
  BlackboardDecisionVote,
  BlackboardEntry,
  BlackboardSubscriptionFilter,
  BlackboardSubscriptionRecord,
  RiskClass,
  SwarmEnvelope,
  SwarmTask
} from "../protocol/types.js";
import { ArtifactStore } from "../storage/artifact-store.js";
import { BlackboardStore } from "../storage/blackboard-store.js";
import { AgentActorStore } from "../storage/agent-actor-store.js";
import { EnvelopeDeliveryStore, type EnvelopeDeliveryRecipient } from "../storage/envelope-delivery-store.js";
import { HandoffStore, type HandoffSessionRecord } from "../storage/handoff-store.js";
import { TaskStateStore } from "../storage/task-state-store.js";
import { TraceStore } from "../storage/trace-store.js";
import type { AgentTaskPacket } from "./agent-specs.js";
import { RuntimeEvents } from "./events.js";
import { AgentRegistry, type RegisteredAgent } from "./registry.js";
import { decideEnvelopeAutonomy } from "./agent-autonomy-policy.js";
import { buildActorCapabilityCard, evaluateCapabilityCandidate, type CapabilityCandidateEvaluation } from "../extensions/capability-directory.js";

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
    private readonly taskStates?: TaskStateStore,
    private readonly deliveries?: EnvelopeDeliveryStore,
    private readonly actors?: AgentActorStore,
    private readonly handoffs?: HandoffStore
  ) {
    super();
  }

  async dispatch(envelope: SwarmEnvelope): Promise<void> {
    if (envelope.idempotency_key) {
      const existing = this.processedKeys.get(envelope.idempotency_key);
      if (existing) {
        this.deliveries?.recordSuperseded(envelope, existing);
        this.events.emitEvent({ type: "log", level: "info", message: `Skipping duplicate envelope ${envelope.type} (idempotent, matched ${existing})` });
        return;
      }
    }

    this.assertAutonomyAllowed(envelope);

    if (isExpired(envelope)) {
      this.deliveries?.recordExpired(envelope);
      this.events.emitEvent({ type: "log", level: "warn", message: `Skipping expired envelope ${envelope.type} (${envelope.id})` });
      return;
    }

    if (isNegotiationEnvelope(envelope.type)) {
      const negotiation = this.projectNegotiationEnvelope(envelope);
      if (negotiation.status === "blocked") {
        this.recordRouterDelivery(envelope);
        this.record(envelope);
        this.deliveries?.markFailed(envelope.id, negotiation.reason);
        this.events.emitEvent({ type: "log", level: "warn", message: negotiation.reason });
        this.receive(this.errorReply(envelope, "NEGOTIATION_POLICY_BLOCKED", negotiation.reason));
        return;
      }
      if (negotiation.status === "invalid") {
        this.recordRouterDelivery(envelope);
        this.record(envelope);
        this.deliveries?.markFailed(envelope.id, negotiation.reason);
        this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", negotiation.reason));
        return;
      }
    }

    if (isSquadEnvelope(envelope.type)) {
      this.recordRouterDelivery(envelope);
      this.handleSquadEnvelope(envelope);
      return;
    }

    if (envelope.type === "handoff.request") {
      this.projectHandoffRequest(envelope);
    }

    if (envelope.type === "swarm.init" || envelope.type === "swarm.join" || envelope.type === "swarm.leave" || envelope.type === "swarm.heartbeat" || envelope.type === "swarm.shutdown") {
      this.recordRouterDelivery(envelope);
      this.handleSwarmLifecycle(envelope);
      return;
    }

    if (envelope.type === "agent.register") {
      this.recordRouterDelivery(envelope);
      this.handleAgentRegister(envelope);
      return;
    }

    if (envelope.type === "agent.update_status") {
      this.recordRouterDelivery(envelope);
      this.handleAgentUpdateStatus(envelope);
      return;
    }

    if (envelope.type === "agent.capability_query") {
      this.recordRouterDelivery(envelope);
      this.handleCapabilityQuery(envelope);
      return;
    }

    if (envelope.type === "user.message") {
      this.recordRouterDelivery(envelope);
      this.handleUserMessage(envelope);
      return;
    }

    if (envelope.type === "blackboard.write") {
      this.recordRouterDelivery(envelope);
      this.handleBlackboardWrite(envelope);
      return;
    }

    if (isBlackboardCollaborationEnvelope(envelope.type)) {
      this.recordRouterDelivery(envelope);
      this.handleBlackboardCollaborationEnvelope(envelope);
      return;
    }

    if (envelope.type === "blackboard.read") {
      this.recordRouterDelivery(envelope);
      this.handleBlackboardRead(envelope);
      return;
    }

    if (envelope.type === "blackboard.update") {
      this.recordRouterDelivery(envelope);
      this.handleBlackboardUpdate(envelope);
      return;
    }

    if (envelope.type === "blackboard.lock") {
      this.recordRouterDelivery(envelope);
      this.handleBlackboardLock(envelope);
      return;
    }

    if (envelope.type === "blackboard.unlock") {
      this.recordRouterDelivery(envelope);
      this.handleBlackboardUnlock(envelope);
      return;
    }

    if (envelope.type === "bid.submit") {
      this.recordRouterDelivery(envelope);
      this.handleBidSubmit(envelope);
      return;
    }

    if (envelope.type === "bid.award") {
      this.recordRouterDelivery(envelope);
      await this.handleBidAward(envelope);
      return;
    }

    if (envelope.type === "consensus.vote") {
      this.recordRouterDelivery(envelope);
      this.handleConsensusVote(envelope);
      return;
    }

    if (envelope.type === "task.create") {
      this.recordRouterDelivery(envelope);
      this.handleTaskCreate(envelope);
      return;
    }

    if (envelope.type === "task.cancel") {
      this.recordRouterDelivery(envelope);
      this.handleTaskCancel(envelope);
      return;
    }

    if (envelope.type === "artifact.create") {
      this.recordRouterDelivery(envelope);
      this.handleArtifactCreate(envelope);
      return;
    }

    if (envelope.type === "artifact.update") {
      this.recordRouterDelivery(envelope);
      this.handleArtifactUpdate(envelope);
      return;
    }

    this.record(envelope);
    const targets = this.resolveTargets(envelope);
    if (targets.length === 0) {
      const message = `No route for envelope ${envelope.type} to ${JSON.stringify(envelope.to)}`;
      this.deliveries?.recordQueued(envelope);
      this.deliveries?.markFailed(envelope.id, message);
      throw new Error(message);
    }
    const recipients = targets.map((target): EnvelopeDeliveryRecipient => ({
      agent_id: target.card.agent_id,
      role: target.card.role
    }));
    this.deliveries?.recordQueued(envelope, recipients);

    if (envelope.type === "bid.request") {
      this.pendingBids.set(correlationKey(envelope), []);
    }
    if (envelope.type === "consensus.request") {
      this.pendingConsensus.set(correlationKey(envelope), []);
    }

    for (const target of targets) {
      target.process?.send(envelope);
      const assignmentNeedsAccept = envelope.type === "task.assign" && taskAssignmentRequiresAccept(envelope);
      if (!envelope.type.startsWith("handoff.") && !assignmentNeedsAccept) {
        this.registry.incrementLoad(target.card.agent_id);
      }
      if (envelope.type === "task.assign" && envelope.task_id && !assignmentNeedsAccept) {
        this.actors?.markCurrentTask(target.card.agent_id, {
          task_id: envelope.task_id,
          session_id: envelope.session_id,
          ownership: {
            envelope_id: envelope.id,
            intent: envelope.intent,
            from: envelope.from
          }
        });
      }
    }
    this.deliveries?.markDelivered(envelope.id, recipients);
    if (envelope.routing?.require_ack) {
      this.receive(this.ackReply(envelope, "router.dispatch.ack", {
        delivered: targets.map((target) => target.card.agent_id),
        mode: envelope.routing?.mode ?? "direct"
      }));
    }
  }

  receive(envelope: SwarmEnvelope): void {
    if (envelope.idempotency_key) {
      const existing = this.processedKeys.get(envelope.idempotency_key);
      if (existing) {
        this.deliveries?.recordSuperseded(envelope, existing);
        this.events.emitEvent({ type: "log", level: "info", message: `Skipping duplicate envelope ${envelope.type} (idempotent, matched ${existing})` });
        return;
      }
    }

    const autonomy = this.checkAutonomy(envelope);
    if (autonomy.decision === "deny") {
      this.recordReceivedDelivery(envelope);
      this.deliveries?.markFailed(envelope.id, autonomy.reason);
      this.events.emitEvent({ type: "log", level: "warn", message: `Denied envelope ${envelope.type} from ${autonomy.actor_id ?? "unknown"}: ${autonomy.reason}` });
      return;
    }
    this.recordReceivedDelivery(envelope);
    if (envelope.reply_to && (envelope.type === "ack" || envelope.type === "task.start" || envelope.type === "handoff.accept" || envelope.type === "handoff.return")) {
      this.deliveries?.markAcked(envelope.reply_to, envelope);
    } else if (envelope.reply_to && (envelope.type === "error" || envelope.type === "task.reject" || envelope.type === "handoff.reject")) {
      const payload = isRecord(envelope.payload) ? envelope.payload : {};
      this.deliveries?.markFailed(envelope.reply_to, stringField(payload.message) ?? envelope.intent, envelope);
    }
    this.record(envelope);

    if (envelope.type.startsWith("handoff.") && envelope.type !== "handoff.request") {
      const handoffProjection = this.projectHandoffProtocolReceive(envelope);
      if (handoffProjection.status === "conflict") {
        if (envelope.reply_to) {
          this.deliveries?.markFailed(envelope.reply_to, handoffProjection.reason, envelope);
        }
        this.events.emitEvent({ type: "log", level: "warn", message: handoffProjection.reason });
        this.receive(this.errorReply(envelope, "HANDOFF_OWNERSHIP_CONFLICT", handoffProjection.reason));
        this.emit("incoming", envelope);
        return;
      }
    }

    const fromAgent = envelope.from.agent_id;
    if (fromAgent && envelope.type === "task.accept" && envelope.task_id) {
      const ownership = this.acquireTaskOwnership(envelope, envelope.from);
      if (ownership.status === "conflict") {
        if (envelope.reply_to) {
          this.deliveries?.markFailed(envelope.reply_to, ownership.reason, envelope);
        }
        this.events.emitEvent({ type: "log", level: "warn", message: ownership.reason });
        this.receive(this.errorReply(envelope, "OWNERSHIP_CONFLICT", ownership.reason));
        this.emit("incoming", envelope);
        return;
      }
      if (envelope.reply_to) {
        this.deliveries?.markAcked(envelope.reply_to, envelope);
      }
      const assignment = envelope.reply_to ? this.traceStore.get(envelope.reply_to) : undefined;
      if (assignment && taskAssignmentRequiresAccept(assignment)) {
        this.registry.incrementLoad(fromAgent);
      }
      this.actors?.markCurrentTask(fromAgent, {
        task_id: envelope.task_id,
        session_id: envelope.session_id,
        ownership: {
          envelope_id: envelope.id,
          reply_to: envelope.reply_to,
          accepted: true
        }
      });
      this.updateTaskStateFromTaskEnvelope(envelope, "running", {
        assigned_to: { agent_id: fromAgent, role: envelope.from.role, capability: envelope.from.capability }
      });
    }
    if (fromAgent && envelope.type === "task.reject") {
      this.releaseTaskOwnership(envelope, envelope.from, "Task was rejected before or during execution.");
      if (envelope.reply_to) {
        const payload = isRecord(envelope.payload) ? envelope.payload : {};
        this.deliveries?.markFailed(envelope.reply_to, stringField(payload.message ?? payload.reason) ?? envelope.intent, envelope);
      }
      this.registry.decrementLoad(fromAgent);
      this.actors?.clearCurrentTask(fromAgent, { status: "idle" });
      this.updateTaskStateFromTaskEnvelope(envelope, "blocked", {
        assigned_to: { agent_id: fromAgent, role: envelope.from.role, capability: envelope.from.capability },
        last_error: stringField((isRecord(envelope.payload) ? envelope.payload.message ?? envelope.payload.reason : undefined) ?? envelope.intent)
      });
    }
    if (fromAgent && envelope.type === "task.start" && envelope.task_id) {
      this.updateTaskStateFromTaskEnvelope(envelope, "running", {
        assigned_to: { agent_id: fromAgent, role: envelope.from.role, capability: envelope.from.capability }
      });
    }
    if (fromAgent && ["task.result", "task.fail", "task.cancel", "review.result", "error"].includes(envelope.type)) {
      this.registry.decrementLoad(fromAgent);
      if (envelope.type === "task.result" || envelope.type === "task.fail" || envelope.type === "task.cancel") {
        this.releaseTaskOwnership(envelope, envelope.from, envelope.type === "task.result"
          ? "Task completed."
          : envelope.type === "task.fail"
            ? "Task failed."
            : "Task was cancelled.");
        this.actors?.clearCurrentTask(fromAgent, {
          status: envelope.type === "task.fail" ? "degraded" : "idle"
        });
        this.updateTaskStateFromTaskEnvelope(envelope, taskStatusFromTerminalEnvelope(envelope), {
          assigned_to: { agent_id: fromAgent, role: envelope.from.role, capability: envelope.from.capability },
          last_error: envelope.type === "task.fail"
            ? stringField((isRecord(envelope.payload) ? envelope.payload.message ?? envelope.payload.error ?? envelope.payload.summary : undefined) ?? envelope.intent)
            : undefined
        });
      }
    }

    this.emit("incoming", envelope);
  }

  async request<T = unknown>(envelope: SwarmEnvelope, options: RequestOptions): Promise<SwarmEnvelope<T>> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off("incoming", onIncoming);
        this.deliveries?.markFailed(envelope.id, `Timed out waiting for ${options.expect.join(", ")} for ${envelope.task_id ?? envelope.id}`);
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

  private assertAutonomyAllowed(envelope: SwarmEnvelope): void {
    const autonomy = this.checkAutonomy(envelope);
    if (autonomy.decision === "allow") {
      return;
    }
    this.deliveries?.recordQueued(envelope);
    this.deliveries?.markFailed(envelope.id, autonomy.reason);
    this.events.emitEvent({ type: "log", level: "warn", message: `Denied envelope ${envelope.type} from ${autonomy.actor_id ?? "unknown"}: ${autonomy.reason}` });
    throw new Error(`Envelope denied by autonomy policy: ${autonomy.reason}`);
  }

  private checkAutonomy(envelope: SwarmEnvelope) {
    const actorId = envelope.from.agent_id;
    const actor = actorId ? this.actors?.get(actorId) : undefined;
    return decideEnvelopeAutonomy(envelope, actor);
  }

  private recordRouterDelivery(envelope: SwarmEnvelope): void {
    const recipient = { agent_id: "router", role: "router" };
    this.deliveries?.recordQueued(envelope, [recipient]);
    this.deliveries?.markDelivered(envelope.id, [recipient]);
  }

  private recordReceivedDelivery(envelope: SwarmEnvelope): void {
    const recipients = (Array.isArray(envelope.to) ? envelope.to : [envelope.to]).map((address): EnvelopeDeliveryRecipient => ({
      agent_id: address.agent_id,
      role: address.role,
      capability: address.capability
    }));
    this.deliveries?.recordQueued(envelope, recipients);
    this.deliveries?.markDelivered(envelope.id, recipients);
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
    if (envelope.from.agent_id) {
      const payload = isRecord(envelope.payload) ? envelope.payload : {};
      const status = agentStatusField(payload.status);
      this.actors?.heartbeat(envelope.from.agent_id, {
        status,
        current_task_id: stringField(payload.current_task_id ?? payload.currentTaskId) ?? envelope.task_id,
        current_session_id: envelope.session_id,
        metadata: {
          lifecycle: envelope.type,
          payload
        }
      });
    }
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
    this.actors?.upsertFromCard(card, {
      current_session_id: envelope.session_id,
      metadata: {
        registered_by_envelope: envelope.id,
        from: envelope.from
      }
    });
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
    this.actors?.updateStatus(agentId, status, {
      metadata: {
        updated_by_envelope: envelope.id,
        from: envelope.from
      }
    });
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

  private handleUserMessage(envelope: SwarmEnvelope): void {
    this.record(envelope);
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    if (envelope.from.agent_id) {
      this.actors?.heartbeat(envelope.from.agent_id, {
        status: "idle",
        current_session_id: envelope.session_id,
        current_task_id: envelope.task_id ?? null,
        metadata: {
          kind: "source_adapter",
          source: stringField(payload.source),
          source_id: stringField(payload.source_id),
          trust_level: stringField(payload.trust_level),
          route: stringField(payload.route),
          last_envelope_id: envelope.id,
          last_correlation_id: envelope.correlation_id
        }
      });
    }
    this.receive(this.ackReply(envelope, "user.message.ack", {
      source: stringField(payload.source),
      source_id: stringField(payload.source_id),
      dedupe_key: stringField(payload.dedupe_key),
      accepted: true
    }));
  }

  private handleBlackboardWrite(envelope: SwarmEnvelope): void {
    this.record(envelope);
    if (!this.blackboard) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", "Blackboard store is not configured for this router."));
      return;
    }
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    const sessionId = stringField(payload.session_id) ?? envelope.session_id;
    const swarmId = stringField(payload.swarm_id) ?? envelope.swarm_id;
    const taskId = stringField(payload.task_id) ?? envelope.task_id;
    const actor = agentAddressField(payload.created_by ?? payload.actor ?? payload.owner ?? payload.proposer ?? payload.reviewer ?? payload.decider) ?? envelope.from;
    const metadata = this.blackboardMetadataFromEnvelope(envelope, payload);
    const kind = metadata.kind ?? "write";

    try {
      if (kind === "subscription") {
        const subscription = this.blackboard.subscribe({
          session_id: sessionId,
          subscriber: agentAddressField(payload.subscriber) ?? actor,
          filter: blackboardSubscriptionFilter(payload),
          ttl_ms: positiveIntegerField(payload.ttl_ms ?? payload.ttlMs),
          expires_at: stringField(payload.expires_at ?? payload.expiresAt),
          source_envelope_id: envelope.id,
          correlation_id: envelope.correlation_id
        });
        this.receive(this.ackReply(envelope, "blackboard.write.ack", { subscription }));
        return;
      }

      const entry = this.writeBlackboardCollaboration({
        kind,
        payload,
        envelope,
        swarmId,
        sessionId,
        taskId,
        actor,
        metadata
      });
      this.events.emitEvent({ type: "blackboard", entry });
      this.emitBlackboardNotifications(entry, envelope);
      this.receive(this.ackReply(envelope, "blackboard.write.ack", { entry }));
    } catch (error) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", error instanceof Error ? error.message : String(error)));
    }
  }

  private handleBlackboardCollaborationEnvelope(envelope: SwarmEnvelope): void {
    this.record(envelope);
    if (!this.blackboard) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", "Blackboard store is not configured for this router."));
      return;
    }
    const kind = blackboardKindFromEnvelopeType(envelope.type);
    if (!kind) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", `Unsupported blackboard collaboration envelope: ${envelope.type}.`));
      return;
    }
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    const sessionId = stringField(payload.session_id) ?? envelope.session_id;
    const swarmId = stringField(payload.swarm_id) ?? envelope.swarm_id;
    const taskId = stringField(payload.task_id) ?? envelope.task_id;
    const actor = agentAddressField(payload.created_by ?? payload.actor ?? payload.owner ?? payload.proposer ?? payload.reviewer ?? payload.decider) ?? envelope.from;
    const collaborationPayload = { ...payload, kind };
    const metadata = this.blackboardMetadataFromEnvelope(envelope, collaborationPayload);

    try {
      if (kind === "subscription") {
        const subscription = this.blackboard.subscribe({
          session_id: sessionId,
          subscriber: agentAddressField(payload.subscriber) ?? actor,
          filter: blackboardSubscriptionFilter(payload),
          ttl_ms: positiveIntegerField(payload.ttl_ms ?? payload.ttlMs),
          expires_at: stringField(payload.expires_at ?? payload.expiresAt),
          source_envelope_id: envelope.id,
          correlation_id: envelope.correlation_id
        });
        this.receive(this.ackReply(envelope, `${envelope.type}.ack`, { subscription }));
        return;
      }

      const entry = this.writeBlackboardCollaboration({
        kind,
        payload: collaborationPayload,
        envelope,
        swarmId,
        sessionId,
        taskId,
        actor,
        metadata
      });
      this.events.emitEvent({ type: "blackboard", entry });
      this.emitBlackboardNotifications(entry, envelope);
      this.receive(this.ackReply(envelope, `${envelope.type}.ack`, { entry }));
    } catch (error) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", error instanceof Error ? error.message : String(error)));
    }
  }

  private writeBlackboardCollaboration(input: {
    kind: BlackboardCollaborationKind;
    payload: Record<string, unknown>;
    envelope: SwarmEnvelope;
    swarmId: string;
    sessionId: string;
    taskId?: string;
    actor: AgentAddress;
    metadata: BlackboardCollaborationMetadata;
  }): BlackboardEntry {
    if (!this.blackboard) {
      throw new Error("Blackboard store is not configured for this router.");
    }
    const { kind, payload, swarmId, sessionId, taskId, actor, metadata } = input;
    if (kind === "claim") {
      const claimKey = stringField(payload.claim_key ?? payload.claimKey ?? payload.key);
      if (!claimKey) {
        throw new Error("blackboard.write claim requires payload.claim_key or payload.key.");
      }
      return this.blackboard.claim({
        swarm_id: swarmId,
        session_id: sessionId,
        task_id: taskId,
        claim_key: claimKey,
        owner: actor,
        value: "value" in payload ? payload.value : payload.content,
        scope: stringArrayField(payload.scope),
        ttl_ms: positiveIntegerField(payload.ttl_ms ?? payload.ttlMs),
        expires_at: stringField(payload.expires_at ?? payload.expiresAt),
        tags: stringArrayField(payload.tags),
        metadata
      }).entry;
    }

    if (kind === "claim_release") {
      const claimKey = stringField(payload.claim_key ?? payload.claimKey ?? payload.key);
      if (!claimKey) {
        throw new Error("blackboard.write claim_release requires payload.claim_key or payload.key.");
      }
      return this.blackboard.releaseClaim({
        swarm_id: swarmId,
        session_id: sessionId,
        task_id: taskId,
        claim_key: claimKey,
        owner: actor,
        reason: stringField(payload.reason),
        status: blackboardClaimReleaseStatus(payload.status) ?? "released",
        tags: stringArrayField(payload.tags),
        metadata
      });
    }

    if (kind === "proposal") {
      const policy = decisionPolicyFromPayload(payload) ?? defaultDecisionPolicy(payload);
      const policyStatus = decisionPolicyInitialStatus(policy);
      return this.blackboard.propose({
        swarm_id: swarmId,
        session_id: sessionId,
        task_id: taskId,
        proposal_id: stringField(payload.proposal_id ?? payload.proposalId),
        proposer: actor,
        value: proposalValueWithPolicy("value" in payload ? payload.value : payload.content, policy, policyStatus),
        target_key: stringField(payload.target_key ?? payload.targetKey),
        claim_key: stringField(payload.claim_key ?? payload.claimKey),
        tags: stringArrayField(payload.tags),
        metadata: {
          ...metadata,
          decision_policy: policy,
          decision_policy_status: policyStatus,
          decision_waiting_for: decisionWaitingFor(policy)
        }
      });
    }

    if (kind === "review") {
      const proposalId = stringField(payload.proposal_id ?? payload.proposalId);
      const verdict = blackboardReviewVerdict(payload.verdict);
      if (!proposalId || !verdict) {
        throw new Error("blackboard.write review requires payload.proposal_id and payload.verdict.");
      }
      return this.blackboard.reviewProposal({
        swarm_id: swarmId,
        session_id: sessionId,
        task_id: taskId,
        proposal_id: proposalId,
        reviewer: actor,
        verdict,
        value: "value" in payload ? payload.value : payload.content,
        tags: stringArrayField(payload.tags),
        metadata
      });
    }

    if (kind === "decision") {
      const proposalId = stringField(payload.proposal_id ?? payload.proposalId);
      const status = blackboardDecisionFinalStatus(payload.status ?? payload.decision_status ?? payload.decisionStatus);
      if (!proposalId || !status) {
        throw new Error("blackboard.write decision requires payload.proposal_id and accepted/rejected/superseded status.");
      }
      const evaluation = this.evaluateDecisionPolicy({
        sessionId,
        proposalId,
        payload,
        actor,
        requestedStatus: status
      });
      const finalStatus = evaluation.allowed ? status : "rejected";
      const decisionValue = decisionValueWithPolicy("value" in payload ? payload.value : payload.content, {
        requestedStatus: status,
        finalStatus,
        policy: evaluation.policy,
        policyStatus: evaluation.policyStatus,
        waitingFor: evaluation.waitingFor,
        votes: evaluation.votes,
        reason: evaluation.reason,
        supersedesDecisionId: stringField(payload.supersedes_decision_id ?? payload.supersedesDecisionId)
      });
      return this.blackboard.decideProposal({
        swarm_id: swarmId,
        session_id: sessionId,
        task_id: taskId,
        proposal_id: proposalId,
        decider: actor,
        status: finalStatus,
        value: decisionValue,
        tags: stringArrayField(payload.tags),
        metadata: {
          ...metadata,
          decision_status: finalStatus,
          decision_policy: evaluation.policy,
          decision_policy_status: evaluation.policyStatus,
          decision_waiting_for: evaluation.waitingFor,
          decision_votes: evaluation.votes,
          decision_outcome: {
            status: finalStatus,
            reason: evaluation.reason,
            votes: evaluation.votes,
            policy_status: evaluation.policyStatus,
            supersedes_decision_id: stringField(payload.supersedes_decision_id ?? payload.supersedesDecisionId)
          },
          conflict_reason: evaluation.allowed ? metadata.conflict_reason : evaluation.reason
        }
      });
    }

    if (kind === "result") {
      return this.blackboard.recordResult({
        swarm_id: swarmId,
        session_id: sessionId,
        task_id: taskId,
        result_id: stringField(payload.result_id ?? payload.resultId),
        actor,
        value: "value" in payload ? payload.value : payload.content,
        proposal_id: stringField(payload.proposal_id ?? payload.proposalId),
        claim_key: stringField(payload.claim_key ?? payload.claimKey),
        tags: stringArrayField(payload.tags),
        metadata
      });
    }

    const key = stringField(payload.key);
    const entryType = blackboardEntryType(payload.type ?? payload.entryType ?? payload.entry_type);
    if (!key || !entryType) {
      throw new Error("blackboard.write requires payload.key and a valid payload.type.");
    }
    return this.blackboard.write({
      swarm_id: swarmId,
      session_id: sessionId,
      task_id: taskId,
      key,
      type: entryType,
      value: "value" in payload ? payload.value : payload.content,
      created_by: actor,
      visibility: blackboardVisibility(payload.visibility),
      tags: stringArrayField(payload.tags),
      metadata
    });
  }

  private blackboardMetadataFromEnvelope(envelope: SwarmEnvelope, payload: Record<string, unknown>): BlackboardCollaborationMetadata {
    const metadata = isRecord(payload.metadata) ? payload.metadata : {};
    const kind = blackboardCollaborationKind(payload.kind ?? payload.collaboration_kind ?? payload.collaborationKind ?? metadata.kind);
    return {
      ...metadata,
      kind: kind ?? "write",
      source_envelope_id: envelope.id,
      source_envelope_ids: [envelope.id],
      correlation_id: envelope.correlation_id,
      reply_to: envelope.reply_to,
      owner_agent_id: stringField(payload.owner_agent_id ?? payload.ownerAgentId ?? metadata.owner_agent_id ?? metadata.ownerAgentId),
      source_agent_id: envelope.from.agent_id,
      claim_key: stringField(payload.claim_key ?? payload.claimKey ?? metadata.claim_key ?? metadata.claimKey),
      proposal_id: stringField(payload.proposal_id ?? payload.proposalId ?? metadata.proposal_id ?? metadata.proposalId),
      decision_status: blackboardDecisionStatus(payload.decision_status ?? payload.decisionStatus ?? payload.status ?? metadata.decision_status ?? metadata.decisionStatus),
      target_key: stringField(payload.target_key ?? payload.targetKey ?? metadata.target_key ?? metadata.targetKey),
      expires_at: stringField(payload.expires_at ?? payload.expiresAt ?? metadata.expires_at ?? metadata.expiresAt),
      conflict_reason: stringField(payload.conflict_reason ?? payload.conflictReason ?? payload.reason ?? metadata.conflict_reason ?? metadata.conflictReason),
      negotiation_id: stringField(payload.negotiation_id ?? payload.negotiationId ?? metadata.negotiation_id ?? metadata.negotiationId),
      negotiation_action: stringField(payload.negotiation_action ?? payload.negotiationAction ?? metadata.negotiation_action ?? metadata.negotiationAction),
      negotiation_status: stringField(payload.negotiation_status ?? payload.negotiationStatus ?? metadata.negotiation_status ?? metadata.negotiationStatus),
      parent_negotiation_id: stringField(payload.parent_negotiation_id ?? payload.parentNegotiationId ?? metadata.parent_negotiation_id ?? metadata.parentNegotiationId),
      delegated_to: stringField(payload.delegated_to ?? payload.delegatedTo ?? metadata.delegated_to ?? metadata.delegatedTo),
      escalated_to: stringField(payload.escalated_to ?? payload.escalatedTo ?? metadata.escalated_to ?? metadata.escalatedTo),
      delegation_chain: stringArrayField(payload.delegation_chain ?? payload.delegationChain ?? metadata.delegation_chain ?? metadata.delegationChain),
      squad_id: stringField(payload.squad_id ?? payload.squadId ?? metadata.squad_id ?? metadata.squadId),
      squad_action: stringField(payload.squad_action ?? payload.squadAction ?? metadata.squad_action ?? metadata.squadAction),
      squad_status: stringField(payload.squad_status ?? payload.squadStatus ?? metadata.squad_status ?? metadata.squadStatus),
      squad_role: stringField(payload.squad_role ?? payload.squadRole ?? payload.role ?? metadata.squad_role ?? metadata.squadRole),
      squad_member_id: stringField(payload.squad_member_id ?? payload.squadMemberId ?? payload.member_id ?? payload.memberId ?? metadata.squad_member_id ?? metadata.squadMemberId)
    };
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
        tags: stringArrayField(payload.tags),
        updated_by: agentAddressField(payload.updated_by ?? payload.updatedBy ?? payload.created_by ?? payload.actor) ?? envelope.from,
        metadata: this.blackboardMetadataFromEnvelope(envelope, {
          ...payload,
          kind: payload.kind ?? payload.collaboration_kind ?? "update"
        })
      });
      this.events.emitEvent({ type: "blackboard", entry });
      this.emitBlackboardNotifications(entry, envelope);
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
        swarm_id: envelope.swarm_id,
        session_id: stringField(payload.session_id) ?? envelope.session_id,
        task_id: stringField(payload.task_id) ?? envelope.task_id,
        key,
        holder: agentAddressField(payload.holder) ?? envelope.from,
        ttl_ms: positiveIntegerField(payload.ttl_ms ?? payload.ttlMs),
        metadata: this.blackboardMetadataFromEnvelope(envelope, {
          ...payload,
          kind: "lock"
        })
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
        swarm_id: envelope.swarm_id,
        session_id: stringField(payload.session_id) ?? envelope.session_id,
        task_id: stringField(payload.task_id) ?? envelope.task_id,
        key,
        holder: agentAddressField(payload.holder) ?? envelope.from,
        metadata: this.blackboardMetadataFromEnvelope(envelope, {
          ...payload,
          kind: "unlock"
        })
      });
      this.receive(this.ackReply(envelope, "blackboard.unlock.ack", { key, unlocked: true }));
    } catch (error) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", error instanceof Error ? error.message : String(error)));
    }
  }

  private emitBlackboardNotifications(entry: BlackboardEntry, sourceEnvelope: SwarmEnvelope): void {
    if (!this.blackboard) {
      return;
    }
    const subscriptions = this.blackboard.listSubscriptions(entry.session_id);
    for (const subscription of subscriptions) {
      if (!blackboardSubscriptionMatchesEntry(entry, subscription)) {
        continue;
      }
      const notification = createEnvelope({
        swarm_id: entry.swarm_id,
        session_id: entry.session_id,
        task_id: entry.task_id ?? sourceEnvelope.task_id,
        attempt: sourceEnvelope.attempt,
        from: { agent_id: "router", role: "blackboard" },
        to: subscription.subscriber,
        type: "blackboard.notification",
        intent: "blackboard.notification",
        payload: {
          subscription,
          entry,
          source_envelope_id: sourceEnvelope.id
        },
        correlation_id: sourceEnvelope.correlation_id ?? sourceEnvelope.id,
        reply_to: sourceEnvelope.id,
        trace: sourceEnvelope.trace
          ? {
              trace_id: sourceEnvelope.trace.trace_id,
              span_id: `span_blackboard_notification_${Date.now()}`,
              parent_span_id: sourceEnvelope.trace.span_id
            }
          : undefined
      });
      this.receive(notification);
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
      cache_score: numberField(payload.cache_score ?? payload.cacheScore),
      estimated_time_ms: positiveIntegerField(payload.estimated_time_ms ?? payload.estimatedTimeMs),
      estimated_cost: numberField(payload.estimated_cost ?? payload.estimatedCost),
      lease_source_envelope_id: stringField(payload.lease_source_envelope_id ?? payload.leaseSourceEnvelopeId),
      reason: stringField(payload.reason)
    };
    bids.push(bid);
    this.pendingBids.set(key, bids);
    this.receive(this.ackReply(envelope, "bid.submit.ack", { bid, bids }));
  }

  private async handleBidAward(envelope: SwarmEnvelope): Promise<void> {
    this.record(envelope);
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    const taskId = stringField(payload.task_id ?? payload.taskId) ?? envelope.task_id;
    if (!taskId) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", "bid.award requires task_id."));
      return;
    }

    const key = stringField(payload.bid_key ?? payload.bidKey ?? payload.bid_request_id ?? payload.bidRequestId) ?? correlationKey(envelope);
    const bids = this.pendingBids.get(key) ?? [];
    const explicitWinner = agentAddressField(payload.winner ?? payload.assigned_to ?? payload.assignedTo) ??
      agentAddressFromIds(payload.winner_agent_id ?? payload.winnerAgentId ?? payload.agent_id ?? payload.agentId);
    const taskDraft = this.taskFromEnvelope(envelope, "assigned", taskId, explicitWinner);
    const bidEvaluations = new Map<BidSubmission, CapabilityCandidateEvaluation>();
    const evaluateBid = (bid: BidSubmission): CapabilityCandidateEvaluation => {
      const existing = bidEvaluations.get(bid);
      if (existing) {
        return existing;
      }
      const actor = bid.from.agent_id ? this.actors?.get(bid.from.agent_id) : undefined;
      const evaluation = evaluateCapabilityCandidate({
        card: actor ? buildActorCapabilityCard(actor) : undefined,
        requestedCapability: bid.from.capability,
        requiredCapabilities: taskDraft.required_capabilities,
        leaseSourceEnvelopeId: bid.lease_source_envelope_id
      });
      bidEvaluations.set(bid, evaluation);
      return evaluation;
    };
    const winnerBid = explicitWinner
      ? bids.find((bid) => addressMatches(bid.from, explicitWinner))
      : selectBestBid(
          bids,
          taskDraft.required_capabilities,
          (agentId) => this.registry.get(agentId)?.card.load.running_tasks ?? 0,
          (agentId) => this.registry.get(agentId)?.card.capabilities ?? [],
          evaluateBid
        );
    const winner = explicitWinner ?? winnerBid?.from;
    if (!winner) {
      const candidateSummary = bids.map((bid) => formatCandidateEvaluation(bid, evaluateBid(bid))).join("; ");
      this.receive(this.errorReply(
        envelope,
        "INVALID_PAYLOAD",
        candidateSummary
          ? `bid.award found no eligible capability directory candidate: ${candidateSummary}`
          : "bid.award requires an explicit winner or at least one bid.submit for the same correlation."
      ));
      return;
    }
    const candidateEvaluations = bids.map((bid) => ({
      agent_id: bid.from.agent_id,
      capability: bid.from.capability,
      available: evaluateBid(bid).available,
      matched_capabilities: evaluateBid(bid).matched_capabilities,
      missing_capabilities: evaluateBid(bid).missing_capabilities,
      reasons: evaluateBid(bid).reasons,
      recoverySuggestion: evaluateBid(bid).recoverySuggestion
    }));

    const task = this.taskFromEnvelope(envelope, "assigned", taskId, winner);
    const contract = this.taskContractFromEnvelope(envelope);
    const snapshot = this.taskStates?.upsert({
      session_id: envelope.session_id,
      swarm_id: envelope.swarm_id,
      task,
      status: "assigned",
      attempt: envelope.attempt,
      assigned_to: winner,
      capability: winner.capability ?? winnerBid?.from.capability,
      write_policy: contract.write_policy,
      file_scope: contract.file_scope,
      last_error: undefined
    });
    const assignment = createEnvelope({
      swarm_id: envelope.swarm_id,
      session_id: envelope.session_id,
      task_id: taskId,
      attempt: envelope.attempt,
      from: { agent_id: "router", role: "task_market" },
      to: winner,
      type: "task.assign",
      intent: "task.market.assign",
      payload: {
        task,
        task_id: taskId,
        award_envelope_id: envelope.id,
        bid_key: key,
        winning_bid: winnerBid,
        bids_considered: bids.length,
        write_policy: contract.write_policy,
        file_scope: contract.file_scope,
        requires_accept: true,
        protocol: "task_market_bid_award"
      },
      correlation_id: envelope.correlation_id ?? envelope.id,
      reply_to: envelope.id,
      routing: { mode: "direct" },
      trace: envelope.trace
        ? {
            trace_id: envelope.trace.trace_id,
            span_id: `span_bid_award_assign_${Date.now()}`,
            parent_span_id: envelope.trace.span_id
          }
        : undefined
    });

    try {
      await this.dispatch(assignment);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateTaskStateFromTaskEnvelope(envelope, "blocked", {
        assigned_to: winner,
        last_error: message
      });
      this.receive(this.errorReply(envelope, "NO_ROUTE", message));
      return;
    }

    this.receive(this.ackReply(envelope, "bid.award.ack", {
      task: snapshot,
      winner,
      winning_bid: winnerBid,
      bids_considered: bids.length,
      capability_directory_candidates: candidateEvaluations,
      assignment_envelope_id: assignment.id,
      requires_accept: true
    }));
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
    const result = consensusResult(votes, stringField(payload.mode), positiveIntegerField(payload.quorum));
    this.receive(this.ackReply(envelope, "consensus.vote.ack", { vote, votes, result }));
    if (result.decision) {
      const proposalId = stringField(payload.proposal_id ?? payload.proposalId);
      if (proposalId && this.blackboard) {
        const status = result.decision === "approve" ? "accepted" : "rejected";
        const policy = this.decisionPolicyForProposal(envelope.session_id, proposalId, payload);
        const decisionVotes = votes.map((item) => decisionVoteFromConsensusVote(item));
        const outcomeReason = `Consensus ${result.decision} reached for ${proposalId}.`;
        const decision = this.blackboard.decideProposal({
          swarm_id: envelope.swarm_id,
          session_id: envelope.session_id,
          task_id: envelope.task_id,
          proposal_id: proposalId,
          decider: { agent_id: "router", role: "consensus" },
          status,
          value: decisionValueWithPolicy(payload.value ?? payload.content, {
            requestedStatus: status,
            finalStatus: status,
            policy,
            policyStatus: "satisfied",
            waitingFor: [],
            votes: decisionVotes,
            reason: outcomeReason
          }),
          tags: uniqueStrings([...(stringArrayField(payload.tags) ?? []), "consensus", "decision", status]),
          metadata: {
            ...this.blackboardMetadataFromEnvelope(envelope, {
              ...payload,
              kind: "decision",
              proposal_id: proposalId,
              decision_status: status
            }),
            decision_policy: policy,
            decision_policy_status: "satisfied",
            decision_waiting_for: [],
            decision_votes: decisionVotes,
            decision_outcome: {
              status,
              reason: outcomeReason,
              votes: decisionVotes,
              policy_status: "satisfied"
            }
          }
        });
        this.events.emitEvent({ type: "blackboard", entry: decision });
        this.emitBlackboardNotifications(decision, envelope);
      }
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

  private decisionPolicyForProposal(sessionId: string, proposalId: string, payload: Record<string, unknown>): BlackboardDecisionPolicy {
    const explicit = decisionPolicyFromPayload(payload, { defaultMode: false });
    if (explicit) {
      return explicit;
    }
    const proposal = this.blackboard?.query(sessionId, { proposalId })
      .find((entry) => entry.metadata?.kind === "proposal" || (entry.tags ?? []).includes("proposal"));
    const metadataPolicy = decisionPolicyFromUnknown(proposal?.metadata?.decision_policy);
    if (metadataPolicy) {
      return metadataPolicy;
    }
    const value = recordPayload(proposal?.value);
    const valuePolicy = decisionPolicyFromUnknown(value.decision_policy ?? value.decisionPolicy ?? value.policy);
    if (valuePolicy) {
      return valuePolicy;
    }
    const fallbackPayload = {
      ...value,
      risk_level: value.risk_level ?? value.riskLevel ?? proposal?.metadata?.risk_level ?? proposal?.metadata?.riskLevel
    };
    return decisionPolicyFromPayload(fallbackPayload) ?? defaultDecisionPolicy(fallbackPayload);
  }

  private evaluateDecisionPolicy(input: {
    sessionId: string;
    proposalId: string;
    payload: Record<string, unknown>;
    actor: AgentAddress;
    requestedStatus: Extract<BlackboardDecisionStatus, "accepted" | "rejected" | "superseded">;
  }): DecisionPolicyEvaluation {
    const policy = this.decisionPolicyForProposal(input.sessionId, input.proposalId, input.payload);
    const votes = [
      ...this.decisionVotesForProposal(input.sessionId, input.proposalId),
      ...decisionVotesFromPayload(input.payload)
    ];
    if (policy.mode === "timeout_fallback") {
      const timeoutSatisfied = timeoutFallbackSatisfied(input.payload);
      const fallbackStatus = policy.fallback_status ?? "rejected";
      const satisfied = timeoutSatisfied && input.requestedStatus === fallbackStatus;
      return {
        allowed: satisfied,
        policy,
        policyStatus: timeoutSatisfied ? "timeout_fallback" : "waiting",
        waitingFor: timeoutSatisfied ? [] : [`timeout:${policy.timeout_ms ?? 0}`],
        votes,
        reason: timeoutSatisfied
          ? `Timeout fallback resolved ${input.proposalId} as ${fallbackStatus}.`
          : `Timeout fallback has not elapsed for ${input.proposalId}.`
      };
    }
    if (input.requestedStatus !== "accepted") {
      return {
        allowed: true,
        policy,
        policyStatus: "satisfied",
        waitingFor: [],
        votes,
        reason: `Decision ${input.requestedStatus} does not require acceptance gate.`
      };
    }
    if (policy.mode === "single_owner") {
      return {
        allowed: true,
        policy,
        policyStatus: "satisfied",
        waitingFor: [],
        votes,
        reason: "single_owner policy allows the decider to finalize the proposal."
      };
    }
    if (policy.mode === "reviewer_approval") {
      const required = policy.required_reviewers ?? [];
      const approvals = votes.filter((vote) => isApproveVote(vote.vote));
      const satisfied = required.length > 0
        ? required.every((reviewer) => approvals.some((vote) => vote.voter === reviewer))
        : approvals.length > 0;
      const waitingFor = required.length > 0
        ? required.filter((reviewer) => !approvals.some((vote) => vote.voter === reviewer))
        : approvals.length > 0 ? [] : ["reviewer"];
      return {
        allowed: satisfied,
        policy,
        policyStatus: satisfied ? "satisfied" : "waiting",
        waitingFor,
        votes,
        reason: satisfied
          ? "Required reviewer approval is present."
          : `Reviewer approval required before accepting ${input.proposalId}.`
      };
    }
    if (policy.mode === "quorum") {
      const quorum = policy.quorum ?? 1;
      const approvals = votes.filter((vote) => isApproveVote(vote.vote)).length;
      const rejections = votes.filter((vote) => isRejectVote(vote.vote)).length;
      const satisfied = approvals >= quorum && approvals > rejections;
      return {
        allowed: satisfied,
        policy,
        policyStatus: satisfied ? "satisfied" : "waiting",
        waitingFor: satisfied ? [] : [`quorum:${approvals}/${quorum}`],
        votes,
        reason: satisfied
          ? `Quorum ${approvals}/${quorum} approved ${input.proposalId}.`
          : `Quorum ${approvals}/${quorum} has not approved ${input.proposalId}.`
      };
    }
    if (policy.mode === "user_approval") {
      const satisfied = userApprovalSatisfied(input.payload, input.actor);
      return {
        allowed: satisfied,
        policy,
        policyStatus: satisfied ? "satisfied" : "waiting",
        waitingFor: satisfied ? [] : ["user"],
        votes,
        reason: satisfied
          ? "User approval evidence is present."
          : `User approval required before accepting ${input.proposalId}.`
      };
    }
    return {
      allowed: false,
      policy,
      policyStatus: "blocked",
      waitingFor: [],
      votes,
      reason: `Unsupported decision policy mode ${policy.mode}.`
    };
  }

  private decisionVotesForProposal(sessionId: string, proposalId: string): BlackboardDecisionVote[] {
    return this.blackboard?.query(sessionId, { proposalId })
      .filter((entry) => entry.metadata?.kind === "review")
      .map(decisionVoteFromReviewEntry) ?? [];
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
    const contract = this.taskContractFromEnvelope(envelope);
    const snapshot = this.taskStates.upsert({
      session_id: envelope.session_id,
      swarm_id: envelope.swarm_id,
      task,
      status: task.status,
      write_policy: contract.write_policy,
      file_scope: contract.file_scope
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
      status: "cancelled",
      ...this.taskContractFromEnvelope(envelope)
    });
    this.receive(this.ackReply(envelope, "task.cancel.ack", { task: snapshot }));
  }

  private acquireTaskOwnership(envelope: SwarmEnvelope, owner: AgentAddress): TaskOwnershipAcquireResult {
    if (!this.blackboard || !envelope.task_id) {
      return { status: "claimed", claims: [] };
    }

    this.blackboard.expireClaims(envelope.session_id, { swarm_id: envelope.swarm_id });
    const contract = this.taskContractFromEnvelope(envelope);
    const ownerId = owner.agent_id ?? owner.role ?? "unknown";
    const claims: BlackboardEntry[] = [];
    for (const claimKey of this.taskOwnershipClaimKeys(envelope, contract)) {
      const active = this.blackboard.getActiveClaim(envelope.session_id, claimKey);
      const activeOwner = active?.metadata?.owner_agent_id ?? active?.created_by.agent_id ?? active?.created_by.role;
      if (active && activeOwner === ownerId) {
        continue;
      }

      const result = this.blackboard.claim({
        swarm_id: envelope.swarm_id,
        session_id: envelope.session_id,
        task_id: envelope.task_id,
        claim_key: claimKey,
        owner,
        value: {
          status: "claimed",
          claim_key: claimKey,
          task_id: envelope.task_id,
          owner_agent_id: ownerId,
          write_policy: contract.write_policy,
          file_scope: contract.file_scope,
          source_envelope_id: envelope.id
        },
        scope: contract.file_scope,
        ttl_ms: ownershipTtlMs(envelope),
        expires_at: ownershipExpiresAt(envelope),
        tags: ["ownership", claimKey.startsWith("file/") ? "file" : "task"],
        metadata: {
          source_envelope_id: envelope.id,
          source_envelope_ids: [envelope.id],
          correlation_id: envelope.correlation_id,
          reply_to: envelope.reply_to,
          owner_agent_id: ownerId,
          source_agent_id: owner.agent_id,
          claim_key: claimKey,
          lease_ttl_ms: ownershipTtlMs(envelope),
          write_policy: contract.write_policy,
          file_scope: contract.file_scope
        }
      });

      if (result.status === "conflict") {
        for (const claim of claims.reverse()) {
          this.blackboard.releaseClaim({
            swarm_id: envelope.swarm_id,
            session_id: envelope.session_id,
            task_id: envelope.task_id,
            claim_key: claim.metadata?.claim_key ?? claim.key.replace(/^claim\//, ""),
            owner,
            reason: `Rolled back ownership claim because ${result.entry.metadata?.conflict_reason ?? "another owner already holds the lease"}.`,
            status: "released",
            tags: ["ownership", "rollback"],
            metadata: {
              source_envelope_id: envelope.id,
              source_envelope_ids: [envelope.id],
              correlation_id: envelope.correlation_id,
              reply_to: envelope.reply_to,
              owner_agent_id: ownerId
            }
          });
        }
        const reason = result.entry.metadata?.conflict_reason ??
          `Ownership claim ${claimKey} is already owned by another actor.`;
        this.recordOwnershipConflictDecision(envelope, owner, claimKey, reason, result.entry);
        return { status: "conflict", reason, conflict: result.entry, claims };
      }

      claims.push(result.entry);
    }

    return { status: "claimed", claims };
  }

  private releaseTaskOwnership(envelope: SwarmEnvelope, owner: AgentAddress, reason: string): void {
    if (!this.blackboard || !envelope.task_id) {
      return;
    }
    const ownerId = owner.agent_id ?? owner.role ?? "unknown";
    const contract = this.taskContractFromEnvelope(envelope);
    for (const claimKey of this.taskOwnershipClaimKeys(envelope, contract)) {
      const active = this.blackboard.getActiveClaim(envelope.session_id, claimKey);
      const activeOwner = active?.metadata?.owner_agent_id ?? active?.created_by.agent_id ?? active?.created_by.role;
      if (!active || activeOwner !== ownerId) {
        continue;
      }
      this.blackboard.releaseClaim({
        swarm_id: envelope.swarm_id,
        session_id: envelope.session_id,
        task_id: envelope.task_id,
        claim_key: claimKey,
        owner,
        reason,
        status: "released",
        tags: ["ownership", "release"],
        metadata: {
          source_envelope_id: envelope.id,
          source_envelope_ids: [envelope.id],
          correlation_id: envelope.correlation_id,
          reply_to: envelope.reply_to,
          owner_agent_id: ownerId,
          write_policy: contract.write_policy,
          file_scope: contract.file_scope
        }
      });
    }
  }

  private projectHandoffRequest(envelope: SwarmEnvelope): void {
    if (!this.handoffs) {
      return;
    }
    const handoffId = handoffIdFromEnvelope(envelope);
    if (!handoffId) {
      this.events.emitEvent({ type: "log", level: "warn", message: `Skipping handoff.request projection without handoff_id (${envelope.id})` });
      return;
    }
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    const taskPacket = handoffTaskPacketFromEnvelope(envelope);
    this.handoffs.create({
      handoff_id: handoffId,
      worker_id: stringField(payload.worker_id ?? payload.workerId ?? payload.target_agent_id ?? payload.targetAgentId) ?? addressLabel(envelope.to) ?? handoffId,
      parent_session_id: stringField(payload.parent_session_id ?? payload.parentSessionId) ?? envelope.session_id,
      source_agent: stringField(payload.source_agent ?? payload.sourceAgent ?? payload.requested_by ?? payload.requestedBy ?? payload.requester_agent_id ?? payload.requesterAgentId) ?? envelope.from.agent_id ?? "unknown",
      target_agent_spec_id: stringField(payload.target_agent_spec_id ?? payload.targetAgentSpecId ?? payload.agent_spec_id ?? payload.agentSpecId) ?? taskPacket.agent_spec_id,
      reason: stringField(payload.reason ?? payload.summary ?? payload.objective) ?? envelope.intent,
      task_packet: taskPacket,
      requester_agent_id: stringField(payload.requester_agent_id ?? payload.requesterAgentId ?? payload.requested_by ?? payload.requestedBy) ?? envelope.from.agent_id,
      scope: handoffScope(envelope, taskPacket),
      lease_ttl_ms: ownershipTtlMs(envelope),
      lease_expires_at: ownershipExpiresAt(envelope),
      deadline_at: stringField(payload.deadline_at ?? payload.deadlineAt),
      request_envelope_id: envelope.id
    });
  }

  private projectNegotiationEnvelope(envelope: SwarmEnvelope): NegotiationProjectionResult {
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    const action = negotiationActionFromType(envelope.type);
    if (!action) {
      return { status: "projected" };
    }
    const negotiationId = negotiationIdFromEnvelope(envelope);
    if (!negotiationId) {
      return { status: "invalid", reason: `${envelope.type} requires payload.negotiation_id, correlation_id, or task_id.` };
    }
    if (action === "decline") {
      const reason = stringField(payload.reason ?? payload.message ?? payload.summary);
      if (!reason) {
        return { status: "invalid", reason: "negotiation.decline requires payload.reason." };
      }
      if (!hasSuggestedAlternative(payload)) {
        return { status: "invalid", reason: "negotiation.decline requires payload.suggested_alternative." };
      }
    }
    if (action === "delegate") {
      const delegationGuard = this.validateNegotiationDelegation(envelope, payload);
      if (delegationGuard) {
        this.recordNegotiationDecision(envelope, negotiationId, "rejected", {
          action,
          reason: delegationGuard,
          tags: ["negotiation", "delegate", "cycle", "decision"],
          value: negotiationValueFromEnvelope(envelope, {
            action,
            negotiation_id: negotiationId,
            status: "blocked",
            reason: delegationGuard
          })
        });
        return { status: "blocked", reason: delegationGuard };
      }
    }
    if (!this.blackboard) {
      return { status: "projected" };
    }

    if (action === "accept") {
      this.recordNegotiationDecision(envelope, negotiationId, "accepted", {
        action,
        tags: ["negotiation", "accept", "decision"],
        value: negotiationValueFromEnvelope(envelope, {
          action,
          negotiation_id: negotiationId,
          status: "accepted",
          contract: payload.contract ?? payload.accepted_contract ?? payload.acceptedContract ?? payload.terms ?? payload.value
        })
      });
      return { status: "projected" };
    }
    if (action === "decline") {
      this.recordNegotiationDecision(envelope, negotiationId, "rejected", {
        action,
        tags: ["negotiation", "decline", "decision"],
        value: negotiationValueFromEnvelope(envelope, {
          action,
          negotiation_id: negotiationId,
          status: "declined",
          reason: stringField(payload.reason ?? payload.message ?? payload.summary),
          suggested_alternative: payload.suggested_alternative ?? payload.suggestedAlternative
        })
      });
      return { status: "projected" };
    }

    const entry = this.blackboard.propose({
      swarm_id: envelope.swarm_id,
      session_id: envelope.session_id,
      task_id: envelope.task_id,
      proposal_id: negotiationId,
      proposer: envelope.from,
      target_key: `negotiation/${negotiationId}`,
      claim_key: stringField(payload.claim_key ?? payload.claimKey),
      value: negotiationValueFromEnvelope(envelope, {
        action,
        negotiation_id: negotiationId,
        status: action,
        terms: payload.terms ?? payload.proposal ?? payload.counter_terms ?? payload.counterTerms ?? payload.handoff_terms ?? payload.handoffTerms ?? payload.value
      }),
      tags: uniqueStrings(["negotiation", action, ...(stringArrayField(payload.tags) ?? [])]),
      metadata: this.blackboardMetadataFromEnvelope(envelope, {
        ...payload,
        kind: "proposal",
        proposal_id: negotiationId,
        target_key: `negotiation/${negotiationId}`,
        decision_status: "proposed",
        negotiation_id: negotiationId,
        negotiation_action: action,
        negotiation_status: action,
        parent_negotiation_id: stringField(payload.parent_negotiation_id ?? payload.parentNegotiationId),
        delegated_to: action === "delegate" ? addressLabel(envelope.to) : undefined,
        escalated_to: action === "escalate" ? addressLabel(envelope.to) : undefined,
        delegation_chain: negotiationDelegationChain(envelope, payload)
      })
    });
    this.events.emitEvent({ type: "blackboard", entry });
    this.emitBlackboardNotifications(entry, envelope);
    return { status: "projected" };
  }

  private validateNegotiationDelegation(envelope: SwarmEnvelope, payload: Record<string, unknown>): string | undefined {
    const chain = negotiationDelegationChain(envelope, payload);
    const maxDepth = positiveIntegerField(payload.max_delegation_depth ?? payload.maxDelegationDepth) ?? 4;
    const target = addressLabel(envelope.to);
    if (target && chain.includes(target)) {
      return `Delegation cycle blocked for ${negotiationIdFromEnvelope(envelope) ?? envelope.id}: ${target} already appears in delegation chain ${chain.join(" -> ")}.`;
    }
    if (chain.length + 1 > maxDepth) {
      return `Delegation depth blocked for ${negotiationIdFromEnvelope(envelope) ?? envelope.id}: next hop would exceed max_delegation_depth=${maxDepth}.`;
    }
    return undefined;
  }

  private recordNegotiationDecision(
    envelope: SwarmEnvelope,
    negotiationId: string,
    status: Extract<BlackboardDecisionStatus, "accepted" | "rejected" | "superseded">,
    input: {
      action: NegotiationAction;
      value: unknown;
      tags: string[];
      reason?: string;
    }
  ): BlackboardEntry | undefined {
    if (!this.blackboard) {
      return undefined;
    }
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    const entry = this.blackboard.decideProposal({
      swarm_id: envelope.swarm_id,
      session_id: envelope.session_id,
      task_id: envelope.task_id,
      proposal_id: negotiationId,
      decider: envelope.from,
      status,
      value: input.value,
      tags: uniqueStrings([...input.tags, ...(stringArrayField(payload.tags) ?? [])]),
      metadata: this.blackboardMetadataFromEnvelope(envelope, {
        ...payload,
        kind: "decision",
        proposal_id: negotiationId,
        decision_status: status,
        negotiation_id: negotiationId,
        negotiation_action: input.action,
        negotiation_status: status,
        conflict_reason: input.reason,
        delegated_to: input.action === "delegate" ? addressLabel(envelope.to) : undefined,
        escalated_to: input.action === "escalate" ? addressLabel(envelope.to) : undefined,
        delegation_chain: negotiationDelegationChain(envelope, payload)
      })
    });
    this.events.emitEvent({ type: "blackboard", entry });
    this.emitBlackboardNotifications(entry, envelope);
    return entry;
  }

  private handleSquadEnvelope(envelope: SwarmEnvelope): void {
    this.record(envelope);
    if (!this.blackboard) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", "Blackboard store is not configured for squad protocol projection."));
      return;
    }
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    const action = squadActionFromType(envelope.type);
    if (!action) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", `Unsupported squad envelope: ${envelope.type}.`));
      return;
    }
    const squadId = squadIdFromEnvelope(envelope);
    if (!squadId) {
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", `${envelope.type} requires payload.squad_id, correlation_id, or task_id.`));
      return;
    }
    const validation = this.validateSquadEnvelope(envelope, payload, action);
    if (validation.status === "rejected") {
      const entry = this.writeSquadDecision(envelope, squadId, {
        action,
        status: "rejected",
        reason: validation.reason,
        value: squadValueFromEnvelope(envelope, {
          squad_id: squadId,
          action,
          status: "rejected",
          reason: validation.reason,
          evaluation: validation.evaluation
        })
      });
      this.deliveries?.markFailed(envelope.id, validation.reason);
      this.receive(this.errorReply(envelope, "SQUAD_POLICY_REJECTED", validation.reason));
      this.events.emitEvent({ type: "blackboard", entry });
      this.emitBlackboardNotifications(entry, envelope);
      return;
    }

    try {
      const claim = action === "create"
        ? this.blackboard.claim({
            swarm_id: envelope.swarm_id,
            session_id: envelope.session_id,
            task_id: envelope.task_id,
            claim_key: `squad/${squadId}`,
            owner: squadLeaderAddress(envelope, payload),
          value: squadValueFromEnvelope(envelope, {
            squad_id: squadId,
            status: "active",
            action,
            members: squadMembersFromPayload(payload),
            roles: squadRolesFromPayload(payload),
            candidates: this.squadCandidateEvaluations(envelope, payload)
          }),
            scope: stringArrayField(payload.scope ?? payload.file_scope ?? payload.fileScope),
            ttl_ms: positiveIntegerField(payload.lease_ttl_ms ?? payload.leaseTtlMs),
            expires_at: stringField(payload.expires_at ?? payload.expiresAt),
            tags: ["squad", "ownership"],
            metadata: this.blackboardMetadataFromEnvelope(envelope, {
              ...payload,
              kind: "claim",
              claim_key: `squad/${squadId}`,
              squad_id: squadId,
              squad_action: action,
              squad_status: "active",
              owner_agent_id: squadLeaderAddress(envelope, payload).agent_id ?? squadLeaderAddress(envelope, payload).role
            })
          })
        : undefined;
      if (claim?.status === "conflict") {
        const reason = claim.conflict?.metadata?.conflict_reason ?? `Squad ${squadId} is already owned by another actor.`;
        const entry = this.writeSquadDecision(envelope, squadId, {
          action,
          status: "rejected",
          reason,
          value: squadValueFromEnvelope(envelope, {
            squad_id: squadId,
            action,
            status: "rejected",
            reason
          })
        });
        this.deliveries?.markFailed(envelope.id, reason);
        this.receive(this.errorReply(envelope, "SQUAD_OWNERSHIP_CONFLICT", reason));
        this.events.emitEvent({ type: "blackboard", entry });
        this.emitBlackboardNotifications(entry, envelope);
        return;
      }

      const release = action === "dissolve"
        ? this.releaseSquadClaim(envelope, squadId, payload)
        : undefined;
      const entry = this.writeSquadDecision(envelope, squadId, {
        action,
        status: squadStatusForAction(action),
        value: squadValueFromEnvelope(envelope, {
          squad_id: squadId,
          action,
          status: squadStatusForAction(action),
          members: squadMembersFromPayload(payload),
          roles: squadRolesFromPayload(payload),
          member: squadMemberAddress(payload) ?? addressLabel(envelope.to),
          role: stringField(payload.role ?? payload.role_id ?? payload.roleId),
          required_capabilities: squadRequiredCapabilities(payload),
          candidates: this.squadCandidateEvaluations(envelope, payload),
          release_entry_id: release?.entry_id
        })
      });
      this.events.emitEvent({ type: "blackboard", entry });
      this.emitBlackboardNotifications(entry, envelope);
      this.receive(this.ackReply(envelope, `${envelope.type}.ack`, {
        squad_id: squadId,
        action,
        status: squadStatusForAction(action),
        claim: claim?.entry,
        release,
        entry,
        evaluation: validation.evaluation
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deliveries?.markFailed(envelope.id, message);
      this.receive(this.errorReply(envelope, "INVALID_PAYLOAD", message));
    }
  }

  private squadCandidateEvaluations(envelope: SwarmEnvelope, payload: Record<string, unknown>): Array<Record<string, unknown>> {
    const memberPayloads = squadMemberPayloads(payload);
    const addresses = uniqueSquadAddresses([
      { address: squadLeaderAddress(envelope, payload), requiredCapabilities: stringArrayField(payload.leader_capabilities ?? payload.leaderCapabilities) ?? [] },
      ...memberPayloads.map((member) => ({
        address: agentAddressField(member),
        requiredCapabilities: stringArrayField(member.required_capabilities ?? member.requiredCapabilities ?? member.capabilities) ?? []
      })),
      ...squadRolesFromPayload(payload).flatMap((role) => {
        const roleMember = agentAddressField(role.member ?? role.agent ?? role.assignee) ??
          agentAddressFromIds(role.agent_id ?? role.agentId);
        return roleMember
          ? [{
              address: roleMember,
              requiredCapabilities: stringArrayField(role.required_capabilities ?? role.requiredCapabilities ?? role.capabilities) ?? []
            }]
          : [];
      }),
      { address: squadMemberAddress(payload), requiredCapabilities: squadRequiredCapabilities(payload) }
    ]);
    return addresses.map(({ address, requiredCapabilities }) => {
      const actor = address.agent_id ? this.actors?.get(address.agent_id) : undefined;
      const evaluation = evaluateCapabilityCandidate({
        card: actor ? buildActorCapabilityCard(actor) : undefined,
        requestedCapability: address.capability,
        requiredCapabilities
      });
      return {
        agent_id: address.agent_id,
        role: address.role,
        capability: address.capability,
        available: evaluation.available,
        matched_capabilities: evaluation.matched_capabilities,
        missing_capabilities: evaluation.missing_capabilities,
        reasons: evaluation.reasons,
        cache_profile: evaluation.card?.cache_profile,
        risk_level: evaluation.card?.risk_level,
        active_capability_leases: evaluation.card?.leases.active.map((lease) => ({
          capability: lease.capability,
          source_envelope_id: lease.source_envelope_id,
          expires_at: lease.expires_at
        })),
        health_state: evaluation.card?.health.state,
        source_envelope_id: envelope.id
      };
    });
  }

  private validateSquadEnvelope(envelope: SwarmEnvelope, payload: Record<string, unknown>, action: SquadAction): SquadValidationResult {
    if (action !== "role.assign") {
      return { status: "accepted" };
    }
    const member = squadMemberAddress(payload) ?? (Array.isArray(envelope.to) ? envelope.to[0] : envelope.to);
    const requiredCapabilities = squadRequiredCapabilities(payload);
    if (!member?.agent_id || requiredCapabilities.length === 0) {
      return { status: "accepted" };
    }
    const actor = this.actors?.get(member.agent_id);
    const evaluation = evaluateCapabilityCandidate({
      card: actor ? buildActorCapabilityCard(actor) : undefined,
      requiredCapabilities
    });
    if (!evaluation.available) {
      return {
        status: "rejected",
        reason: `Squad role assignment rejected for ${member.agent_id}: ${evaluation.reasons.join(" ")}`,
        evaluation
      };
    }
    return { status: "accepted", evaluation };
  }

  private writeSquadDecision(
    envelope: SwarmEnvelope,
    squadId: string,
    input: {
      action: SquadAction;
      status: string;
      value: unknown;
      reason?: string;
    }
  ): BlackboardEntry {
    if (!this.blackboard) {
      throw new Error("Blackboard store is not configured for squad protocol projection.");
    }
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    return this.blackboard.write({
      swarm_id: envelope.swarm_id,
      session_id: envelope.session_id,
      task_id: envelope.task_id,
      key: `squad/${squadId}/${input.action}/${envelope.id}`,
      type: "decision",
      value: input.value,
      created_by: envelope.from,
      visibility: "team",
      tags: uniqueStrings(["squad", input.action, input.status, ...(stringArrayField(payload.tags) ?? [])]),
      metadata: this.blackboardMetadataFromEnvelope(envelope, {
        ...payload,
        kind: "decision",
        decision_status: input.status === "rejected" ? "rejected" : "accepted",
        squad_id: squadId,
        squad_action: input.action,
        squad_status: input.status,
        conflict_reason: input.reason
      })
    });
  }

  private releaseSquadClaim(envelope: SwarmEnvelope, squadId: string, payload: Record<string, unknown>): BlackboardEntry | undefined {
    if (!this.blackboard) {
      return undefined;
    }
    const active = this.blackboard.getActiveClaim(envelope.session_id, `squad/${squadId}`);
    if (!active) {
      return undefined;
    }
    return this.blackboard.releaseClaim({
      swarm_id: envelope.swarm_id,
      session_id: envelope.session_id,
      task_id: envelope.task_id,
      claim_key: `squad/${squadId}`,
      owner: active.created_by,
      reason: stringField(payload.reason ?? payload.message) ?? "Squad dissolved.",
      status: "released",
      tags: ["squad", "dissolve", "ownership"],
      metadata: this.blackboardMetadataFromEnvelope(envelope, {
        ...payload,
        kind: "claim_release",
        claim_key: `squad/${squadId}`,
        squad_id: squadId,
        squad_action: "dissolve",
        squad_status: "dissolved"
      })
    });
  }

  private projectHandoffProtocolReceive(envelope: SwarmEnvelope): HandoffOwnershipAcquireResult {
    if (!this.handoffs) {
      return { status: "claimed", claims: [] };
    }
    const handoffId = handoffIdFromEnvelope(envelope);
    if (!handoffId) {
      return { status: "claimed", claims: [] };
    }
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    const existing = this.handoffs.get(handoffId);
    if (!existing && envelope.type !== "handoff.request") {
      this.events.emitEvent({ type: "log", level: "warn", message: `Skipping ${envelope.type} projection for unknown handoff ${handoffId}` });
      return { status: "claimed", claims: [] };
    }

    if (envelope.type === "handoff.accept") {
      const ownerAgentId = stringField(payload.owner_agent_id ?? payload.ownerAgentId) ?? envelope.from.agent_id ?? addressLabel(envelope.from) ?? "unknown";
      const ownership = existing
        ? this.acquireHandoffOwnership(envelope, existing, { ...envelope.from, agent_id: ownerAgentId })
        : { status: "claimed" as const, claims: [] };
      if (ownership.status === "conflict") {
        this.handoffs.markConflict({ handoff_id: handoffId, reason: ownership.reason, envelope_id: envelope.id });
        return ownership;
      }
      this.handoffs.markAccepted({
        handoff_id: handoffId,
        owner_agent_id: ownerAgentId,
        envelope_id: envelope.id,
        accepted_at: envelope.created_at,
        lease_ttl_ms: ownershipTtlMs(envelope),
        lease_expires_at: ownershipExpiresAt(envelope)
      });
      return ownership;
    }

    if (envelope.type === "handoff.reject") {
      if (existing) {
        this.releaseHandoffOwnership(envelope, existing, envelope.from, "Handoff was rejected.");
      }
      this.handoffs.markRejected({
        handoff_id: handoffId,
        reason: stringField(payload.reason ?? payload.message ?? payload.summary) ?? "Handoff was rejected.",
        envelope_id: envelope.id
      });
      return { status: "claimed", claims: [] };
    }

    if (envelope.type === "handoff.renew") {
      this.handoffs.renew({
        handoff_id: handoffId,
        owner_agent_id: stringField(payload.owner_agent_id ?? payload.ownerAgentId) ?? envelope.from.agent_id,
        envelope_id: envelope.id,
        lease_ttl_ms: ownershipTtlMs(envelope),
        lease_expires_at: ownershipExpiresAt(envelope)
      });
      return { status: "claimed", claims: [] };
    }

    if (envelope.type === "handoff.checkpoint") {
      this.handoffs.checkpoint({
        handoff_id: handoffId,
        checkpoint: payload.checkpoint ?? payload.last_checkpoint ?? payload.lastCheckpoint ?? payload,
        owner_agent_id: stringField(payload.owner_agent_id ?? payload.ownerAgentId) ?? envelope.from.agent_id,
        envelope_id: envelope.id,
        lease_ttl_ms: ownershipTtlMs(envelope),
        lease_expires_at: ownershipExpiresAt(envelope)
      });
      return { status: "claimed", claims: [] };
    }

    if (envelope.type === "handoff.return") {
      if (existing) {
        this.releaseHandoffOwnership(envelope, existing, envelope.from, "Handoff returned ownership.");
      }
      const status = stringField(payload.status) === "failed" ? "failed" : "returned";
      this.handoffs.finish({
        handoff_id: handoffId,
        status,
        result: stringField(payload.result ?? payload.content ?? payload.summary),
        envelope_id: envelope.id,
        return_contract: payload.return_contract ?? payload.returnContract ?? payload
      });
      return { status: "claimed", claims: [] };
    }

    if (envelope.type === "handoff.take_back") {
      if (existing) {
        const previousOwner = stringField(payload.owner_agent_id ?? payload.ownerAgentId ?? payload.previous_owner ?? payload.previousOwner) ?? existing.owner_agent_id;
        this.releaseHandoffOwnership(
          envelope,
          existing,
          previousOwner ? { agent_id: previousOwner } : envelope.from,
          stringField(payload.reason ?? payload.message) ?? "Handoff ownership was taken back."
        );
      }
      this.handoffs.takeBack(handoffId, {
        requester_agent_id: stringField(payload.requester_agent_id ?? payload.requesterAgentId ?? payload.resulting_owner ?? payload.resultingOwner) ?? envelope.from.agent_id,
        reason: stringField(payload.reason ?? payload.message ?? payload.summary),
        envelope_id: envelope.id
      });
      return { status: "claimed", claims: [] };
    }

    if (envelope.type === "handoff.conflict") {
      this.handoffs.markConflict({
        handoff_id: handoffId,
        reason: stringField(payload.reason ?? payload.message ?? payload.summary) ?? "Handoff ownership conflict.",
        envelope_id: envelope.id
      });
      return { status: "claimed", claims: [] };
    }

    if (envelope.type === "handoff.timeout") {
      this.handoffs.markTimeout({
        handoff_id: handoffId,
        reason: stringField(payload.reason ?? payload.message ?? payload.summary) ?? "Handoff ownership timed out.",
        envelope_id: envelope.id
      });
      return { status: "claimed", claims: [] };
    }

    return { status: "claimed", claims: [] };
  }

  private acquireHandoffOwnership(envelope: SwarmEnvelope, handoff: HandoffSessionRecord, owner: AgentAddress): HandoffOwnershipAcquireResult {
    if (!this.blackboard) {
      return { status: "claimed", claims: [] };
    }

    this.blackboard.expireClaims(envelope.session_id, { swarm_id: envelope.swarm_id });
    const ownerId = owner.agent_id ?? owner.role ?? "unknown";
    const claims: BlackboardEntry[] = [];
    for (const claimKey of this.handoffOwnershipClaimKeys(envelope, handoff)) {
      const active = this.blackboard.getActiveClaim(envelope.session_id, claimKey);
      const activeOwner = active?.metadata?.owner_agent_id ?? active?.created_by.agent_id ?? active?.created_by.role;
      if (active && activeOwner === ownerId) {
        continue;
      }

      const result = this.blackboard.claim({
        swarm_id: envelope.swarm_id,
        session_id: envelope.session_id,
        task_id: handoff.handoff_id,
        claim_key: claimKey,
        owner,
        value: {
          status: "claimed",
          claim_key: claimKey,
          handoff_id: handoff.handoff_id,
          owner_agent_id: ownerId,
          write_policy: handoff.task_packet.write_policy,
          file_scope: handoff.scope ?? handoff.task_packet.file_scope,
          source_envelope_id: envelope.id
        },
        scope: handoff.scope ?? handoff.task_packet.file_scope,
        ttl_ms: ownershipTtlMs(envelope) ?? handoff.lease_ttl_ms,
        expires_at: ownershipExpiresAt(envelope) ?? handoff.lease_expires_at,
        tags: ["handoff", "ownership", claimKey.startsWith("file/") ? "file" : "handoff"],
        metadata: {
          source_envelope_id: envelope.id,
          source_envelope_ids: [envelope.id],
          correlation_id: envelope.correlation_id,
          reply_to: envelope.reply_to,
          owner_agent_id: ownerId,
          source_agent_id: owner.agent_id,
          claim_key: claimKey,
          handoff_id: handoff.handoff_id,
          lease_ttl_ms: ownershipTtlMs(envelope) ?? handoff.lease_ttl_ms,
          write_policy: handoff.task_packet.write_policy,
          file_scope: handoff.scope ?? handoff.task_packet.file_scope
        }
      });

      if (result.status === "conflict") {
        for (const claim of claims.reverse()) {
          this.blackboard.releaseClaim({
            swarm_id: envelope.swarm_id,
            session_id: envelope.session_id,
            task_id: handoff.handoff_id,
            claim_key: claim.metadata?.claim_key ?? claim.key.replace(/^claim\//, ""),
            owner,
            reason: `Rolled back handoff ownership claim because ${result.entry.metadata?.conflict_reason ?? "another owner already holds the lease"}.`,
            status: "released",
            tags: ["handoff", "ownership", "rollback"],
            metadata: {
              source_envelope_id: envelope.id,
              source_envelope_ids: [envelope.id],
              correlation_id: envelope.correlation_id,
              reply_to: envelope.reply_to,
              owner_agent_id: ownerId,
              handoff_id: handoff.handoff_id
            }
          });
        }
        const reason = result.entry.metadata?.conflict_reason ??
          `Handoff ownership claim ${claimKey} is already owned by another actor.`;
        this.recordHandoffConflictDecision(envelope, handoff, owner, claimKey, reason, result.entry);
        return { status: "conflict", reason, conflict: result.entry, claims };
      }

      claims.push(result.entry);
    }
    return { status: "claimed", claims };
  }

  private releaseHandoffOwnership(envelope: SwarmEnvelope, handoff: HandoffSessionRecord, owner: AgentAddress, reason: string): void {
    if (!this.blackboard) {
      return;
    }
    const ownerId = owner.agent_id ?? owner.role;
    for (const claimKey of this.handoffOwnershipClaimKeys(envelope, handoff)) {
      const active = this.blackboard.getActiveClaim(envelope.session_id, claimKey);
      const activeOwner = active?.metadata?.owner_agent_id ?? active?.created_by.agent_id ?? active?.created_by.role;
      if (!active || (ownerId && activeOwner !== ownerId)) {
        continue;
      }
      this.blackboard.releaseClaim({
        swarm_id: envelope.swarm_id,
        session_id: envelope.session_id,
        task_id: handoff.handoff_id,
        claim_key: claimKey,
        owner: ownerId ? owner : active.created_by,
        reason,
        status: "released",
        tags: ["handoff", "ownership", "release"],
        metadata: {
          source_envelope_id: envelope.id,
          source_envelope_ids: [envelope.id],
          correlation_id: envelope.correlation_id,
          reply_to: envelope.reply_to,
          owner_agent_id: activeOwner,
          handoff_id: handoff.handoff_id,
          write_policy: handoff.task_packet.write_policy,
          file_scope: handoff.scope ?? handoff.task_packet.file_scope
        }
      });
    }
  }

  private handoffOwnershipClaimKeys(envelope: SwarmEnvelope, handoff: HandoffSessionRecord): string[] {
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    const fileScope = handoffScope(envelope, handoff.task_packet);
    const writePolicy = writePolicyField(payload.write_policy ?? payload.writePolicy) ?? handoff.task_packet.write_policy;
    const keys = [`handoff/${handoff.handoff_id}`];
    if (writePolicy !== "read_only") {
      keys.push(...fileScope.map((item) => `file/${normalizeClaimSubject(item)}`));
    }
    return uniqueStrings(keys);
  }

  private recordHandoffConflictDecision(
    envelope: SwarmEnvelope,
    handoff: HandoffSessionRecord,
    owner: AgentAddress,
    claimKey: string,
    reason: string,
    conflict: BlackboardEntry
  ): void {
    if (!this.blackboard) {
      return;
    }
    const ownerId = owner.agent_id ?? owner.role ?? "unknown";
    const entry = this.blackboard.write({
      swarm_id: envelope.swarm_id,
      session_id: envelope.session_id,
      task_id: handoff.handoff_id,
      key: `handoff/conflict/${claimKey}/${envelope.id}`,
      type: "decision",
      value: {
        status: "rejected",
        claim_key: claimKey,
        handoff_id: handoff.handoff_id,
        requested_owner: ownerId,
        reason,
        conflict_entry_id: conflict.entry_id,
        source_envelope_id: envelope.id
      },
      created_by: { agent_id: "router", role: "handoff_arbiter" },
      visibility: "team",
      tags: ["handoff", "ownership", "conflict", "decision"],
      metadata: {
        kind: "decision",
        source_envelope_id: envelope.id,
        source_envelope_ids: [envelope.id],
        correlation_id: envelope.correlation_id,
        reply_to: envelope.reply_to,
        owner_agent_id: ownerId,
        source_agent_id: owner.agent_id,
        claim_key: claimKey,
        handoff_id: handoff.handoff_id,
        decision_status: "rejected",
        conflict_with_entry_id: conflict.entry_id,
        conflict_reason: reason
      }
    });
    this.events.emitEvent({ type: "blackboard", entry });
  }

  private recordOwnershipConflictDecision(
    envelope: SwarmEnvelope,
    owner: AgentAddress,
    claimKey: string,
    reason: string,
    conflict: BlackboardEntry
  ): void {
    if (!this.blackboard) {
      return;
    }
    const ownerId = owner.agent_id ?? owner.role ?? "unknown";
    const entry = this.blackboard.write({
      swarm_id: envelope.swarm_id,
      session_id: envelope.session_id,
      task_id: envelope.task_id,
      key: `ownership/conflict/${claimKey}/${envelope.id}`,
      type: "decision",
      value: {
        status: "rejected",
        claim_key: claimKey,
        requested_owner: ownerId,
        current_owner: conflict.metadata?.conflict_reason,
        reason,
        conflict_entry_id: conflict.entry_id,
        source_envelope_id: envelope.id
      },
      created_by: { agent_id: "router", role: "ownership_arbiter" },
      visibility: "team",
      tags: ["ownership", "conflict", "decision"],
      metadata: {
        kind: "decision",
        source_envelope_id: envelope.id,
        source_envelope_ids: [envelope.id],
        correlation_id: envelope.correlation_id,
        reply_to: envelope.reply_to,
        owner_agent_id: ownerId,
        source_agent_id: owner.agent_id,
        claim_key: claimKey,
        decision_status: "rejected",
        conflict_with_entry_id: conflict.entry_id,
        conflict_reason: reason
      }
    });
    this.events.emitEvent({ type: "blackboard", entry });
  }

  private taskContractFromEnvelope(envelope: SwarmEnvelope): {
    write_policy?: "read_only" | "scoped_write" | "workspace_write";
    file_scope: string[];
  } {
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    const taskPayload = isRecord(payload.task) ? payload.task : {};
    const existing = envelope.task_id
      ? this.taskStates?.list(envelope.session_id).find((task) => task.task_id === envelope.task_id)
      : undefined;
    const fileScope = stringArrayField(
      payload.file_scope ??
      payload.fileScope ??
      payload.scope ??
      payload.files ??
      payload.paths ??
      taskPayload.file_scope ??
      taskPayload.fileScope ??
      taskPayload.scope
    ) ?? existing?.file_scope ?? [];
    const writePolicy = writePolicyField(
      payload.write_policy ??
      payload.writePolicy ??
      taskPayload.write_policy ??
      taskPayload.writePolicy
    ) ?? existing?.write_policy ?? (fileScope.length > 0 ? "scoped_write" : undefined);
    return {
      write_policy: writePolicy,
      file_scope: uniqueStrings(fileScope)
    };
  }

  private taskOwnershipClaimKeys(
    envelope: SwarmEnvelope,
    contract: { write_policy?: "read_only" | "scoped_write" | "workspace_write"; file_scope: string[] }
  ): string[] {
    const keys = [`task/${envelope.task_id}`];
    if (contract.write_policy !== "read_only") {
      keys.push(...contract.file_scope.map((item) => `file/${normalizeClaimSubject(item)}`));
    }
    return uniqueStrings(keys);
  }

  private taskFromEnvelope(
    envelope: SwarmEnvelope,
    status: SwarmTask["status"],
    taskId = envelope.task_id,
    assignedTo?: AgentAddress
  ): SwarmTask {
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    const fromPayload = swarmTaskField({ ...(isRecord(payload.task) ? payload.task : payload), task_id: taskId, status });
    if (fromPayload) {
      return {
        ...fromPayload,
        status,
        assigned_to: assignedTo ?? fromPayload.assigned_to
      };
    }
    const existing = taskId
      ? this.taskStates?.list(envelope.session_id).find((task) => task.task_id === taskId)
      : undefined;
    const title = existing?.title ??
      stringField(payload.title) ??
      stringField(payload.objective) ??
      stringField(payload.summary) ??
      taskId ??
      envelope.intent;
    return {
      task_id: taskId ?? envelope.id,
      parent_task_id: existing?.parent_task_id,
      title,
      description: stringField(payload.description) ?? title,
      objective: stringField(payload.objective ?? payload.task ?? payload.summary) ?? title,
      type: swarmTaskTypeField(payload.type) ?? "coding",
      status,
      required_capabilities: stringArrayField(payload.required_capabilities ?? payload.requiredCapabilities) ?? existing?.required_capabilities ?? [],
      inputs: isRecord(payload.inputs) ? payload.inputs : {},
      expected_output: {
        format: expectedOutputFormatField(isRecord(payload.expected_output) ? payload.expected_output.format : undefined)
      },
      dependencies: stringArrayField(payload.dependencies) ?? existing?.dependencies,
      assigned_to: assignedTo ?? existing?.assigned_to,
      risk_class: payload.risk_class === "r0" || payload.risk_class === "r1" || payload.risk_class === "r2" || payload.risk_class === "r3" || payload.risk_class === "r4" ? payload.risk_class : undefined,
      deadline_at: stringField(payload.deadline_at ?? payload.deadlineAt),
      constraints: stringArrayField(payload.constraints),
      acceptance_criteria: stringArrayField(payload.acceptance_criteria ?? payload.acceptanceCriteria)
    };
  }

  private updateTaskStateFromTaskEnvelope(
    envelope: SwarmEnvelope,
    status: SwarmTask["status"],
    options: {
      assigned_to?: AgentAddress;
      last_error?: string;
    } = {}
  ): void {
    if (!this.taskStates || !envelope.task_id) {
      return;
    }
    const task = this.taskFromEnvelope(envelope, status, envelope.task_id, options.assigned_to);
    this.taskStates.upsert({
      session_id: envelope.session_id,
      swarm_id: envelope.swarm_id,
      task,
      status,
      attempt: envelope.attempt,
      assigned_to: options.assigned_to ?? task.assigned_to,
      capability: options.assigned_to?.capability ?? task.assigned_to?.capability,
      ...this.taskContractFromEnvelope(envelope),
      last_error: options.last_error
    });
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
    const subscriptionId = stringField(payload.subscription_id ?? payload.subscriptionId);
    if (subscriptionId) {
      return this.blackboard?.read(sessionId, { subscriptionId, limit: positiveIntegerField(payload.limit) }) ?? [];
    }
    const rawType = payload.type ?? payload.entryType ?? payload.entry_type;
    const type = blackboardEntryType(rawType);
    if (rawType !== undefined && !type) {
      throw new Error("blackboard.read requires a valid payload.type when type is provided.");
    }
    return this.blackboard?.query(sessionId, {
      type,
      tag: stringField(payload.tag),
      keyPrefix: stringField(payload.key_prefix ?? payload.keyPrefix),
      taskId: stringField(payload.task_id ?? payload.taskId),
      agentId: stringField(payload.agent_id ?? payload.agentId),
      claimKey: stringField(payload.claim_key ?? payload.claimKey),
      proposalId: stringField(payload.proposal_id ?? payload.proposalId),
      kind: blackboardCollaborationKind(payload.kind ?? payload.collaboration_kind ?? payload.collaborationKind),
      decisionStatus: blackboardDecisionStatus(payload.decision_status ?? payload.decisionStatus),
      ownerAgentId: stringField(payload.owner_agent_id ?? payload.ownerAgentId),
      sourceEnvelopeId: stringField(payload.source_envelope_id ?? payload.sourceEnvelopeId)
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

function blackboardCollaborationKind(value: unknown): BlackboardCollaborationKind | undefined {
  return value === "write" ||
    value === "update" ||
    value === "lock" ||
    value === "unlock" ||
    value === "claim" ||
    value === "claim_release" ||
    value === "claim_conflict" ||
    value === "proposal" ||
    value === "review" ||
    value === "decision" ||
    value === "result" ||
    value === "subscription"
    ? value
    : undefined;
}

function blackboardClaimReleaseStatus(value: unknown): Extract<BlackboardClaimStatus, "released" | "expired"> | undefined {
  return value === "released" || value === "expired" ? value : undefined;
}

function blackboardDecisionStatus(value: unknown): BlackboardDecisionStatus | undefined {
  return value === "proposed" ||
    value === "reviewed" ||
    value === "accepted" ||
    value === "rejected" ||
    value === "superseded"
    ? value
    : undefined;
}

function blackboardDecisionFinalStatus(value: unknown): Extract<BlackboardDecisionStatus, "accepted" | "rejected" | "superseded"> | undefined {
  return value === "accepted" || value === "rejected" || value === "superseded" ? value : undefined;
}

function blackboardReviewVerdict(value: unknown): "approve" | "reject" | "needs_revision" | undefined {
  return value === "approve" || value === "reject" || value === "needs_revision" ? value : undefined;
}

function blackboardSubscriptionFilter(payload: Record<string, unknown>): BlackboardSubscriptionFilter {
  const rawFilter = isRecord(payload.filter) ? payload.filter : payload;
  return {
    key: stringField(rawFilter.key),
    keyPrefix: stringField(rawFilter.key_prefix ?? rawFilter.keyPrefix),
    tag: stringField(rawFilter.tag),
    taskId: stringField(rawFilter.task_id ?? rawFilter.taskId),
    agentId: stringField(rawFilter.agent_id ?? rawFilter.agentId),
    claimKey: stringField(rawFilter.claim_key ?? rawFilter.claimKey),
    proposalId: stringField(rawFilter.proposal_id ?? rawFilter.proposalId),
    kind: blackboardCollaborationKind(rawFilter.kind ?? rawFilter.collaboration_kind ?? rawFilter.collaborationKind),
    decisionStatus: blackboardDecisionStatus(rawFilter.decision_status ?? rawFilter.decisionStatus)
  };
}

function isBlackboardCollaborationEnvelope(type: SwarmEnvelope["type"]): boolean {
  return type === "blackboard.subscribe" ||
    type === "blackboard.claim" ||
    type === "blackboard.release" ||
    type === "blackboard.proposal" ||
    type === "blackboard.review" ||
    type === "blackboard.decision" ||
    type === "blackboard.result";
}

function blackboardKindFromEnvelopeType(type: SwarmEnvelope["type"]): BlackboardCollaborationKind | undefined {
  switch (type) {
    case "blackboard.subscribe":
      return "subscription";
    case "blackboard.claim":
      return "claim";
    case "blackboard.release":
      return "claim_release";
    case "blackboard.proposal":
      return "proposal";
    case "blackboard.review":
      return "review";
    case "blackboard.decision":
      return "decision";
    case "blackboard.result":
      return "result";
    default:
      return undefined;
  }
}

function blackboardSubscriptionMatchesEntry(entry: BlackboardEntry, subscription: BlackboardSubscriptionRecord): boolean {
  const filter = subscription.filter;
  if (filter.key && entry.key !== filter.key) return false;
  if (filter.keyPrefix && !entry.key.startsWith(filter.keyPrefix)) return false;
  if (filter.tag && !(entry.tags ?? []).includes(filter.tag)) return false;
  if (filter.taskId && entry.task_id !== filter.taskId) return false;
  if (filter.agentId && entry.created_by.agent_id !== filter.agentId) return false;
  if (filter.claimKey && entry.metadata?.claim_key !== filter.claimKey) return false;
  if (filter.proposalId && entry.metadata?.proposal_id !== filter.proposalId) return false;
  if (filter.kind && entry.metadata?.kind !== filter.kind) return false;
  if (filter.decisionStatus && entry.metadata?.decision_status !== filter.decisionStatus) return false;
  return true;
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

function taskAssignmentRequiresAccept(envelope: SwarmEnvelope): boolean {
  const payload = isRecord(envelope.payload) ? envelope.payload : {};
  return payload.requires_accept === true ||
    payload.requiresAccept === true ||
    stringField(payload.protocol) === "task_market_bid_award" ||
    envelope.intent === "task.market.assign";
}

function taskStatusFromTerminalEnvelope(envelope: SwarmEnvelope): SwarmTask["status"] {
  if (envelope.type === "task.result") {
    return "completed";
  }
  if (envelope.type === "task.fail") {
    return "failed";
  }
  if (envelope.type === "task.cancel") {
    return "cancelled";
  }
  return "blocked";
}

function writePolicyField(value: unknown): "read_only" | "scoped_write" | "workspace_write" | undefined {
  return value === "read_only" || value === "scoped_write" || value === "workspace_write"
    ? value
    : undefined;
}

function handoffIdFromEnvelope(envelope: SwarmEnvelope): string | undefined {
  const payload = isRecord(envelope.payload) ? envelope.payload : {};
  return stringField(payload.handoff_id ?? payload.handoffId) ?? envelope.task_id;
}

function handoffTaskPacketFromEnvelope(envelope: SwarmEnvelope): AgentTaskPacket {
  const payload = isRecord(envelope.payload) ? envelope.payload : {};
  const rawPacketValue = payload.task_packet ?? payload.taskPacket;
  const rawPacket: Record<string, unknown> = isRecord(rawPacketValue)
    ? rawPacketValue
    : {};
  const fileScope = stringArrayField(
    rawPacket.file_scope ??
    rawPacket.fileScope ??
    payload.file_scope ??
    payload.fileScope ??
    payload.scope ??
    payload.files ??
    payload.paths
  ) ?? [];
  const writePolicy = writePolicyField(
    rawPacket.write_policy ??
    rawPacket.writePolicy ??
    payload.write_policy ??
    payload.writePolicy
  ) ?? (fileScope.length > 0 ? "scoped_write" : "read_only");
  const targetAddress = Array.isArray(envelope.to) ? envelope.to[0] : envelope.to;
  const agentSpecId = stringField(
    rawPacket.agent_spec_id ??
    rawPacket.agentSpecId ??
    payload.target_agent_spec_id ??
    payload.targetAgentSpecId ??
    payload.agent_spec_id ??
    payload.agentSpecId
  ) ?? targetAddress?.role ?? targetAddress?.capability ?? "handoff_specialist";
  const objective = stringField(
    rawPacket.objective ??
    payload.objective ??
    payload.task ??
    payload.summary ??
    payload.reason
  ) ?? handoffIdFromEnvelope(envelope) ?? envelope.intent;
  const permissionContextValue = rawPacket.permission_context ?? rawPacket.permissionContext;
  const permissionContext: Record<string, unknown> = isRecord(permissionContextValue)
    ? permissionContextValue
    : {};
  const budget: Record<string, unknown> = isRecord(rawPacket.budget) ? rawPacket.budget : {};
  return {
    objective,
    agent_spec_id: agentSpecId,
    invocation_mode: "handoff",
    persona_snapshot: stringField(rawPacket.persona_snapshot ?? rawPacket.personaSnapshot) ?? "",
    role_title: stringField(rawPacket.role_title ?? rawPacket.roleTitle),
    persona_brief: stringField(rawPacket.persona_brief ?? rawPacket.personaBrief),
    relevant_context: stringField(rawPacket.relevant_context ?? rawPacket.relevantContext ?? payload.context),
    file_scope: uniqueStrings(fileScope),
    allowed_tools: stringArrayField(rawPacket.allowed_tools ?? rawPacket.allowedTools) ?? [],
    write_policy: writePolicy,
    permission_context: {
      default_mode: stringField(permissionContext.default_mode ?? permissionContext.defaultMode) === "yolo"
        ? "yolo"
        : stringField(permissionContext.default_mode ?? permissionContext.defaultMode) === "auto-edit"
          ? "auto-edit"
          : stringField(permissionContext.default_mode ?? permissionContext.defaultMode) === "full-auto"
            ? "full-auto"
            : "ask",
      allow: stringArrayField(permissionContext.allow) ?? [],
      ask: stringArrayField(permissionContext.ask) ?? [],
      deny: stringArrayField(permissionContext.deny) ?? [],
      additional_directories: stringArrayField(permissionContext.additional_directories ?? permissionContext.additionalDirectories) ?? []
    },
    budget: {
      max_turns: positiveIntegerField(budget.max_turns ?? budget.maxTurns) ?? 0,
      max_tool_calls: positiveIntegerField(budget.max_tool_calls ?? budget.maxToolCalls) ?? 0
    },
    expected_output: stringField(
      rawPacket.expected_output ??
      rawPacket.expectedOutput ??
      payload.expected_output ??
      payload.expectedOutput ??
      payload.output_contract ??
      payload.outputContract
    ) ?? "Return a handoff result with completed work, remaining risks, artifacts, verification, and next action.",
    return_conditions: stringArrayField(rawPacket.return_conditions ?? rawPacket.returnConditions) ?? []
  };
}

function addressLabel(address: AgentAddress | AgentAddress[]): string | undefined {
  if (Array.isArray(address)) {
    return address.map((item) => addressLabel(item)).find((item): item is string => Boolean(item));
  }
  return address.agent_id ?? address.role ?? address.capability;
}

function handoffScope(envelope: SwarmEnvelope, taskPacket: AgentTaskPacket): string[] {
  const payload = isRecord(envelope.payload) ? envelope.payload : {};
  return uniqueStrings(
    stringArrayField(payload.file_scope ?? payload.fileScope ?? payload.scope ?? payload.files ?? payload.paths) ??
    taskPacket.file_scope
  );
}

function ownershipTtlMs(envelope: SwarmEnvelope): number | undefined {
  const payload = isRecord(envelope.payload) ? envelope.payload : {};
  const metadata = isRecord(payload.metadata) ? payload.metadata : {};
  return positiveIntegerField(
    payload.lease_ttl_ms ??
    payload.leaseTtlMs ??
    payload.ownership_ttl_ms ??
    payload.ownershipTtlMs ??
    metadata.lease_ttl_ms ??
    metadata.leaseTtlMs
  );
}

function ownershipExpiresAt(envelope: SwarmEnvelope): string | undefined {
  const payload = isRecord(envelope.payload) ? envelope.payload : {};
  const metadata = isRecord(payload.metadata) ? payload.metadata : {};
  return stringField(
    payload.lease_expires_at ??
    payload.leaseExpiresAt ??
    payload.ownership_expires_at ??
    payload.ownershipExpiresAt ??
    metadata.lease_expires_at ??
    metadata.leaseExpiresAt
  );
}

function normalizeClaimSubject(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((item) => item?.trim()).filter((item): item is string => Boolean(item)))];
}

function agentAddressFromIds(value: unknown): AgentAddress | undefined {
  const agentId = stringField(value);
  return agentId ? { agent_id: agentId } : undefined;
}

function addressMatches(left: AgentAddress, right: AgentAddress): boolean {
  return Boolean(
    (left.agent_id && right.agent_id && left.agent_id === right.agent_id) ||
    (left.role && right.role && left.role === right.role) ||
    (left.capability && right.capability && left.capability === right.capability)
  );
}

function selectBestBid(
  bids: BidSubmission[],
  requiredCapabilities: string[],
  loadForAgent: (agentId: string) => number,
  capabilitiesForAgent: (agentId: string) => string[],
  evaluateCandidate?: (bid: BidSubmission) => CapabilityCandidateEvaluation
): BidSubmission | undefined {
  const eligible = evaluateCandidate
    ? bids.filter((bid) => evaluateCandidate(bid).available)
    : bids;
  return [...eligible].sort((left, right) => {
    const capability = bidCapabilityScore(right, requiredCapabilities, capabilitiesForAgent) -
      bidCapabilityScore(left, requiredCapabilities, capabilitiesForAgent);
    if (capability !== 0) {
      return capability;
    }
    const lease = Number(Boolean(right.lease_source_envelope_id)) - Number(Boolean(left.lease_source_envelope_id));
    if (lease !== 0) {
      return lease;
    }
    const cacheScore = (right.cache_score ?? 0) - (left.cache_score ?? 0);
    if (cacheScore !== 0) {
      return cacheScore;
    }
    const leftLoad = left.from.agent_id ? loadForAgent(left.from.agent_id) : 0;
    const rightLoad = right.from.agent_id ? loadForAgent(right.from.agent_id) : 0;
    if (leftLoad !== rightLoad) {
      return leftLoad - rightLoad;
    }
    const confidence = (right.confidence ?? 0) - (left.confidence ?? 0);
    if (confidence !== 0) {
      return confidence;
    }
    const leftTime = left.estimated_time_ms ?? Number.MAX_SAFE_INTEGER;
    const rightTime = right.estimated_time_ms ?? Number.MAX_SAFE_INTEGER;
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return (left.estimated_cost ?? Number.MAX_SAFE_INTEGER) - (right.estimated_cost ?? Number.MAX_SAFE_INTEGER);
  })[0];
}

function formatCandidateEvaluation(bid: BidSubmission, evaluation: CapabilityCandidateEvaluation): string {
  return [
    bid.from.agent_id ?? bid.from.role ?? bid.from.capability ?? "unknown",
    evaluation.available ? "available" : "unavailable",
    evaluation.reasons.length ? evaluation.reasons.join(" ") : undefined
  ].filter(Boolean).join(" ");
}

function bidCapabilityScore(
  bid: BidSubmission,
  requiredCapabilities: string[],
  capabilitiesForAgent: (agentId: string) => string[]
): number {
  if (requiredCapabilities.length === 0) {
    return 1;
  }
  const capabilities = new Set([
    bid.from.capability,
    ...(bid.from.agent_id ? capabilitiesForAgent(bid.from.agent_id) : [])
  ].filter((capability): capability is string => Boolean(capability)));
  return requiredCapabilities.every((capability) => capabilities.has(capability)) ? 1 : 0;
}

function correlationKey(envelope: SwarmEnvelope): string {
  return envelope.correlation_id ?? envelope.reply_to ?? envelope.task_id ?? envelope.id;
}

function isExpired(envelope: SwarmEnvelope): boolean {
  if (!envelope.ttl_ms || envelope.ttl_ms <= 0) {
    return false;
  }
  const createdAt = Date.parse(envelope.created_at);
  return Number.isFinite(createdAt) && createdAt + envelope.ttl_ms <= Date.now();
}

type BidSubmission = {
  from: AgentAddress;
  task_id?: string;
  confidence?: number;
  cache_score?: number;
  estimated_time_ms?: number;
  estimated_cost?: number;
  lease_source_envelope_id?: string;
  reason?: string;
};

type ConsensusVote = {
  from: AgentAddress;
  vote: string;
  confidence?: number;
  reason?: string;
};

type DecisionPolicyEvaluation = {
  allowed: boolean;
  policy: BlackboardDecisionPolicy;
  policyStatus: BlackboardDecisionPolicyStatus;
  waitingFor: string[];
  votes: BlackboardDecisionVote[];
  reason: string;
};

type NegotiationAction = "propose" | "counter" | "accept" | "decline" | "delegate" | "escalate";

type NegotiationProjectionResult = {
  status: "projected";
} | {
  status: "invalid" | "blocked";
  reason: string;
};

type SquadAction = "create" | "join" | "leave" | "role.assign" | "dissolve";

type SquadValidationResult = {
  status: "accepted";
  evaluation?: CapabilityCandidateEvaluation;
} | {
  status: "rejected";
  reason: string;
  evaluation?: CapabilityCandidateEvaluation;
};

type TaskOwnershipAcquireResult = {
  status: "claimed";
  claims: BlackboardEntry[];
} | {
  status: "conflict";
  reason: string;
  conflict: BlackboardEntry;
  claims: BlackboardEntry[];
};

type HandoffOwnershipAcquireResult = {
  status: "claimed";
  claims: BlackboardEntry[];
} | {
  status: "conflict";
  reason: string;
  conflict: BlackboardEntry;
  claims: BlackboardEntry[];
};

function isNegotiationEnvelope(type: SwarmEnvelope["type"]): boolean {
  return negotiationActionFromType(type) !== undefined;
}

function negotiationActionFromType(type: SwarmEnvelope["type"]): NegotiationAction | undefined {
  switch (type) {
    case "negotiation.propose":
      return "propose";
    case "negotiation.counter":
      return "counter";
    case "negotiation.accept":
      return "accept";
    case "negotiation.decline":
      return "decline";
    case "negotiation.delegate":
      return "delegate";
    case "negotiation.escalate":
      return "escalate";
    default:
      return undefined;
  }
}

function negotiationIdFromEnvelope(envelope: SwarmEnvelope): string | undefined {
  const payload = isRecord(envelope.payload) ? envelope.payload : {};
  return stringField(payload.negotiation_id ?? payload.negotiationId) ??
    envelope.correlation_id ??
    envelope.task_id;
}

function negotiationDelegationChain(envelope: SwarmEnvelope, payload: Record<string, unknown>): string[] {
  const fromPayload = stringArrayField(payload.delegation_chain ?? payload.delegationChain) ?? [];
  const fromAuth = Array.isArray(envelope.auth?.delegation_chain)
    ? envelope.auth.delegation_chain.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  return uniqueStrings([
    ...fromAuth,
    ...fromPayload,
    stringField(payload.previous_delegate ?? payload.previousDelegate),
    envelope.from.agent_id
  ]);
}

function hasSuggestedAlternative(payload: Record<string, unknown>): boolean {
  const value = payload.suggested_alternative ?? payload.suggestedAlternative ?? payload.alternative ?? payload.delegate_to ?? payload.delegateTo;
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return isRecord(value);
}

function negotiationValueFromEnvelope(envelope: SwarmEnvelope, patch: Record<string, unknown>): Record<string, unknown> {
  const payload = isRecord(envelope.payload) ? envelope.payload : {};
  return {
    ...payload,
    ...patch,
    from: envelope.from,
    to: envelope.to,
    source_envelope_id: envelope.id,
    correlation_id: envelope.correlation_id,
    reply_to: envelope.reply_to
  };
}

function isSquadEnvelope(type: SwarmEnvelope["type"]): boolean {
  return squadActionFromType(type) !== undefined;
}

function squadActionFromType(type: SwarmEnvelope["type"]): SquadAction | undefined {
  switch (type) {
    case "squad.create":
      return "create";
    case "squad.join":
      return "join";
    case "squad.leave":
      return "leave";
    case "squad.role.assign":
      return "role.assign";
    case "squad.dissolve":
      return "dissolve";
    default:
      return undefined;
  }
}

function squadIdFromEnvelope(envelope: SwarmEnvelope): string | undefined {
  const payload = isRecord(envelope.payload) ? envelope.payload : {};
  return stringField(payload.squad_id ?? payload.squadId) ??
    envelope.correlation_id ??
    envelope.task_id;
}

function squadLeaderAddress(envelope: SwarmEnvelope, payload: Record<string, unknown>): AgentAddress {
  return agentAddressField(payload.leader ?? payload.leader_agent ?? payload.leaderAgent ?? payload.owner ?? payload.coordinator) ??
    envelope.from;
}

function squadMemberAddress(payload: Record<string, unknown>): AgentAddress | undefined {
  return agentAddressField(payload.member ?? payload.member_agent ?? payload.memberAgent ?? payload.actor ?? payload.assignee ?? payload.agent);
}

function squadMembersFromPayload(payload: Record<string, unknown>): AgentAddress[] {
  return squadMemberPayloads(payload).map(agentAddressField).filter((member): member is AgentAddress => Boolean(member));
}

function squadMemberPayloads(payload: Record<string, unknown>): Record<string, unknown>[] {
  const members = payload.members;
  return Array.isArray(members)
    ? members.filter((member): member is Record<string, unknown> => isRecord(member))
    : [];
}

function squadRolesFromPayload(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const roles = payload.roles ?? payload.role_assignments ?? payload.roleAssignments;
  return Array.isArray(roles)
    ? roles.filter((item): item is Record<string, unknown> => isRecord(item))
    : [];
}

function squadRequiredCapabilities(payload: Record<string, unknown>): string[] {
  const member = isRecord(payload.member) ? payload.member : {};
  return uniqueStrings([
    ...(stringArrayField(payload.required_capabilities ?? payload.requiredCapabilities) ?? []),
    ...(stringArrayField(payload.capabilities) ?? []),
    ...(stringArrayField(member.required_capabilities ?? member.requiredCapabilities) ?? []),
    ...(stringArrayField(member.capabilities) ?? [])
  ]);
}

function squadStatusForAction(action: SquadAction): string {
  switch (action) {
    case "create":
    case "join":
    case "role.assign":
      return "active";
    case "leave":
      return "member_left";
    case "dissolve":
      return "dissolved";
  }
}

function squadValueFromEnvelope(envelope: SwarmEnvelope, patch: Record<string, unknown>): Record<string, unknown> {
  const payload = isRecord(envelope.payload) ? envelope.payload : {};
  return {
    ...payload,
    ...patch,
    from: envelope.from,
    to: envelope.to,
    source_envelope_id: envelope.id,
    correlation_id: envelope.correlation_id,
    reply_to: envelope.reply_to
  };
}

function uniqueSquadAddresses(values: Array<{ address?: AgentAddress; requiredCapabilities?: string[] }>): Array<{ address: AgentAddress; requiredCapabilities: string[] }> {
  const byKey = new Map<string, { address: AgentAddress; requiredCapabilities: string[] }>();
  for (const value of values) {
    const address = value.address;
    if (!address) {
      continue;
    }
    const key = address.agent_id ?? address.role ?? address.capability;
    if (!key) {
      continue;
    }
    const existing = byKey.get(key);
    if (existing) {
      existing.address = {
        agent_id: existing.address.agent_id ?? address.agent_id,
        role: existing.address.role ?? address.role,
        capability: existing.address.capability ?? address.capability
      };
      existing.requiredCapabilities = uniqueStrings([...existing.requiredCapabilities, ...(value.requiredCapabilities ?? [])]);
      continue;
    }
    byKey.set(key, {
      address,
      requiredCapabilities: uniqueStrings(value.requiredCapabilities ?? [])
    });
  }
  return [...byKey.values()];
}

function recordPayload(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function decisionPolicyFromPayload(
  payload: Record<string, unknown>,
  options: { defaultMode?: boolean } = {}
): BlackboardDecisionPolicy | undefined {
  const embedded = decisionPolicyFromUnknown(payload.decision_policy ?? payload.decisionPolicy ?? payload.policy);
  if (embedded) {
    return embedded;
  }
  const explicitMode = decisionPolicyModeField(
    payload.mode ??
    payload.decision_mode ??
    payload.decisionMode ??
    payload.approval_mode ??
    payload.approvalMode
  );
  if (explicitMode) {
    return policyFromPayloadFields(payload, explicitMode);
  }
  if (options.defaultMode === false) {
    return undefined;
  }
  return defaultDecisionPolicy(payload);
}

function decisionPolicyFromUnknown(value: unknown): BlackboardDecisionPolicy | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const mode = decisionPolicyModeField(
    value.mode ??
    value.decision_mode ??
    value.decisionMode ??
    value.approval_mode ??
    value.approvalMode
  );
  if (!mode) {
    return undefined;
  }
  return policyFromPayloadFields(value, mode);
}

function defaultDecisionPolicy(payload: Record<string, unknown>): BlackboardDecisionPolicy {
  const riskLevel = riskClassField(payload.risk_level ?? payload.riskLevel ?? payload.risk_class ?? payload.riskClass);
  const requiredReviewers = stringArrayField(payload.required_reviewers ?? payload.requiredReviewers ?? payload.reviewers);
  const quorum = positiveIntegerField(payload.quorum ?? payload.required_quorum ?? payload.requiredQuorum);
  const timeoutMs = positiveIntegerField(payload.timeout_ms ?? payload.timeoutMs);
  const trust = stringField(payload.capability_trust ?? payload.capabilityTrust ?? payload.trust)?.toLowerCase();
  const fileScope = stringArrayField(payload.file_scope ?? payload.fileScope ?? payload.scope);
  const fallbackStatus = blackboardDecisionFinalStatus(payload.fallback_status ?? payload.fallbackStatus) ?? "rejected";
  if (riskLevel === "r3" || riskLevel === "r4") {
    return {
      mode: "user_approval",
      risk_level: riskLevel,
      user_approval_required: true,
      reason: "High risk proposals require user approval by default."
    };
  }
  if (requiredReviewers?.length) {
    return {
      mode: "reviewer_approval",
      risk_level: riskLevel,
      required_reviewers: requiredReviewers,
      reason: "Proposal requested reviewer approval."
    };
  }
  if (quorum) {
    return {
      mode: "quorum",
      risk_level: riskLevel,
      quorum,
      reason: "Proposal requested quorum approval."
    };
  }
  if (timeoutMs) {
    return {
      mode: "timeout_fallback",
      risk_level: riskLevel,
      timeout_ms: timeoutMs,
      fallback_status: fallbackStatus,
      reason: "Proposal requested timeout fallback."
    };
  }
  if (trust === "low" || trust === "untrusted" || trust === "unknown") {
    return {
      mode: "reviewer_approval",
      risk_level: riskLevel,
      reason: `Capability trust ${trust} requires reviewer approval.`
    };
  }
  if ((fileScope?.length ?? 0) > 3) {
    return {
      mode: "reviewer_approval",
      risk_level: riskLevel,
      reason: "Broad file scope requires reviewer approval."
    };
  }
  return {
    mode: "single_owner",
    risk_level: riskLevel,
    reason: "Low risk proposal can be finalized by a single owner."
  };
}

function policyFromPayloadFields(payload: Record<string, unknown>, mode: BlackboardDecisionPolicy["mode"]): BlackboardDecisionPolicy {
  const requiredReviewers = stringArrayField(payload.required_reviewers ?? payload.requiredReviewers ?? payload.reviewers);
  const policy: BlackboardDecisionPolicy = {
    mode,
    risk_level: riskClassField(payload.risk_level ?? payload.riskLevel ?? payload.risk_class ?? payload.riskClass),
    required_reviewers: requiredReviewers,
    quorum: positiveIntegerField(payload.quorum ?? payload.required_quorum ?? payload.requiredQuorum) ?? (mode === "quorum" ? 2 : undefined),
    timeout_ms: positiveIntegerField(payload.timeout_ms ?? payload.timeoutMs),
    fallback_status: blackboardDecisionFinalStatus(payload.fallback_status ?? payload.fallbackStatus) ?? (mode === "timeout_fallback" ? "rejected" : undefined),
    user_approval_required: booleanField(payload.user_approval_required ?? payload.userApprovalRequired) ?? (mode === "user_approval" ? true : undefined),
    reason: stringField(payload.reason ?? payload.policy_reason ?? payload.policyReason)
  };
  return compactDecisionPolicy(policy);
}

function compactDecisionPolicy(policy: BlackboardDecisionPolicy): BlackboardDecisionPolicy {
  return Object.fromEntries(
    Object.entries(policy).filter(([, value]) => value !== undefined && (!Array.isArray(value) || value.length > 0))
  ) as BlackboardDecisionPolicy;
}

function decisionPolicyModeField(value: unknown): BlackboardDecisionPolicy["mode"] | undefined {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : undefined;
  switch (normalized) {
    case "single_owner":
    case "single-owner":
    case "owner":
      return "single_owner";
    case "reviewer_approval":
    case "reviewer-approval":
    case "reviewer":
      return "reviewer_approval";
    case "quorum":
      return "quorum";
    case "user_approval":
    case "user-approval":
    case "user":
      return "user_approval";
    case "timeout_fallback":
    case "timeout-fallback":
    case "timeout":
      return "timeout_fallback";
    default:
      return undefined;
  }
}

function riskClassField(value: unknown): RiskClass | undefined {
  return value === "r0" || value === "r1" || value === "r2" || value === "r3" || value === "r4"
    ? value
    : undefined;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function decisionPolicyInitialStatus(policy: BlackboardDecisionPolicy): BlackboardDecisionPolicyStatus {
  return policy.mode === "single_owner" ? "satisfied" : "waiting";
}

function decisionWaitingFor(policy: BlackboardDecisionPolicy, votes: BlackboardDecisionVote[] = []): string[] {
  switch (policy.mode) {
    case "single_owner":
      return [];
    case "reviewer_approval": {
      const approvals = votes.filter((vote) => isApproveVote(vote.vote)).map((vote) => vote.voter).filter((voter): voter is string => Boolean(voter));
      const required = policy.required_reviewers ?? [];
      if (required.length > 0) {
        return required.filter((reviewer) => !approvals.includes(reviewer));
      }
      return approvals.length > 0 ? [] : ["reviewer"];
    }
    case "quorum": {
      const quorum = policy.quorum ?? 1;
      const approvals = votes.filter((vote) => isApproveVote(vote.vote)).length;
      return approvals >= quorum ? [] : [`quorum:${approvals}/${quorum}`];
    }
    case "user_approval":
      return ["user"];
    case "timeout_fallback":
      return [`timeout:${policy.timeout_ms ?? 0}`];
  }
}

function proposalValueWithPolicy(value: unknown, policy: BlackboardDecisionPolicy, policyStatus: BlackboardDecisionPolicyStatus): Record<string, unknown> {
  const base = recordPayload(value);
  return {
    ...("value" in base || isRecord(value) || value === undefined ? base : { value }),
    decision_policy: policy,
    decision_policy_status: policyStatus,
    decision_waiting_for: decisionWaitingFor(policy)
  };
}

function decisionValueWithPolicy(value: unknown, input: {
  requestedStatus: BlackboardDecisionStatus;
  finalStatus: BlackboardDecisionStatus;
  policy: BlackboardDecisionPolicy;
  policyStatus: BlackboardDecisionPolicyStatus;
  waitingFor: string[];
  votes: BlackboardDecisionVote[];
  reason?: string;
  supersedesDecisionId?: string;
}): Record<string, unknown> {
  const base = recordPayload(value);
  return {
    ...("value" in base || isRecord(value) || value === undefined ? base : { value }),
    requested_status: input.requestedStatus,
    status: input.finalStatus,
    decision_policy: input.policy,
    decision_policy_status: input.policyStatus,
    decision_waiting_for: input.waitingFor,
    decision_votes: input.votes,
    decision_outcome: {
      status: input.finalStatus,
      reason: input.reason,
      votes: input.votes,
      policy_status: input.policyStatus,
      supersedes_decision_id: input.supersedesDecisionId
    },
    supersedes_decision_id: input.supersedesDecisionId
  };
}

function decisionVotesFromPayload(payload: Record<string, unknown>): BlackboardDecisionVote[] {
  const votes = Array.isArray(payload.votes) ? payload.votes : Array.isArray(payload.decision_votes) ? payload.decision_votes : [];
  const parsed = votes
    .map(decisionVoteFromUnknown)
    .filter((vote): vote is BlackboardDecisionVote => Boolean(vote));
  const single = decisionVoteFromUnknown({
    vote: payload.vote ?? payload.verdict ?? payload.approval,
    voter: payload.voter ?? payload.reviewer ?? payload.approved_by ?? payload.approvedBy,
    confidence: payload.confidence,
    reason: payload.reason,
    source_envelope_id: payload.source_envelope_id ?? payload.sourceEnvelopeId
  });
  return single ? [...parsed, single] : parsed;
}

function decisionVoteFromUnknown(value: unknown): BlackboardDecisionVote | undefined {
  if (typeof value === "string") {
    return { vote: normalizeDecisionVote(value) };
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const vote = stringField(value.vote ?? value.verdict ?? value.decision ?? value.approval);
  if (!vote) {
    return undefined;
  }
  return {
    voter: stringField(value.voter ?? value.agent_id ?? value.agentId ?? value.reviewer ?? value.user),
    vote: normalizeDecisionVote(vote),
    confidence: numberField(value.confidence),
    reason: stringField(value.reason),
    source_envelope_id: stringField(value.source_envelope_id ?? value.sourceEnvelopeId)
  };
}

function decisionVoteFromReviewEntry(entry: BlackboardEntry): BlackboardDecisionVote {
  const value = recordPayload(entry.value);
  const verdict = stringField(value.verdict) ?? stringField(entry.metadata?.decision_status) ?? "abstain";
  return {
    voter: addressLabel(entry.created_by),
    vote: normalizeDecisionVote(verdict),
    confidence: numberField(value.confidence),
    reason: stringField(value.reason),
    source_envelope_id: entry.metadata?.source_envelope_id
  };
}

function decisionVoteFromConsensusVote(vote: ConsensusVote): BlackboardDecisionVote {
  return {
    voter: addressLabel(vote.from),
    vote: normalizeDecisionVote(vote.vote),
    confidence: vote.confidence,
    reason: vote.reason
  };
}

function normalizeDecisionVote(value: string): BlackboardDecisionVote["vote"] {
  if (isApproveVote(value)) {
    return "approve";
  }
  if (isRejectVote(value) || value.trim().toLowerCase() === "needs_revision") {
    return "reject";
  }
  return value.trim().toLowerCase() || "abstain";
}

function userApprovalSatisfied(payload: Record<string, unknown>, actor: AgentAddress): boolean {
  const approval = isRecord(payload.user_approval) ? payload.user_approval : {};
  const status = stringField(payload.approval_status ?? approval.status)?.toLowerCase();
  const actorLabelValue = addressLabel(actor)?.toLowerCase();
  return payload.user_approved === true ||
    status === "approved" ||
    actorLabelValue === "user";
}

function timeoutFallbackSatisfied(payload: Record<string, unknown>): boolean {
  return payload.timeout_elapsed === true ||
    payload.fallback_triggered === true ||
    payload.timeout_fallback === true;
}

function consensusResult(votes: ConsensusVote[], mode = "majority_vote", quorum?: number): {
  mode: string;
  decision?: "approve" | "reject";
  approvals: number;
  rejections: number;
  abstentions: number;
  quorum?: number;
} {
  const approvals = votes.filter((vote) => isApproveVote(vote.vote)).length;
  const rejections = votes.filter((vote) => isRejectVote(vote.vote)).length;
  const abstentions = Math.max(0, votes.length - approvals - rejections);
  const effectiveQuorum = quorum ?? (mode === "quorum" ? 2 : undefined);
  const decision = effectiveQuorum
    ? approvals >= effectiveQuorum && approvals > rejections
      ? "approve"
      : rejections >= effectiveQuorum || (votes.length >= effectiveQuorum && rejections > approvals)
        ? "reject"
        : undefined
    : mode === "unanimous"
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
  const result: {
    mode: string;
    decision?: "approve" | "reject";
    approvals: number;
    rejections: number;
    abstentions: number;
  } = { mode, decision, approvals, rejections, abstentions };
  return effectiveQuorum ? { ...result, quorum: effectiveQuorum } : result;
}

function isApproveVote(value: string): boolean {
  return ["approve", "approved", "yes", "accept", "pass"].includes(value.trim().toLowerCase());
}

function isRejectVote(value: string): boolean {
  return ["reject", "rejected", "no", "deny", "fail"].includes(value.trim().toLowerCase());
}
