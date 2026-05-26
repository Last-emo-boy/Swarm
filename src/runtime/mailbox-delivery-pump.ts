import { createEnvelope } from "../protocol/envelope.js";
import type { SwarmEnvelope } from "../protocol/types.js";
import { AgentActorStore } from "../storage/agent-actor-store.js";
import { EnvelopeDeliveryStore, type EnvelopeDeliveryRecord } from "../storage/envelope-delivery-store.js";
import { TraceStore } from "../storage/trace-store.js";
import { budgetDecisionForDelivery, type SwarmBudgetGovernor } from "./budget-governor.js";
import { RuntimeEvents } from "./events.js";

export type MailboxDeliveryHandler = (
  envelope: SwarmEnvelope,
  delivery: EnvelopeDeliveryRecord
) => Promise<SwarmEnvelope | void> | SwarmEnvelope | void;

export type MailboxDeliveryPumpResult = {
  actor_id: string;
  delivered: number;
  acked: number;
  failed: number;
  expired: number;
  missing: number;
  deferred: number;
  sleeping: number;
  rejected: number;
};

export class MailboxDeliveryPump {
  constructor(
    private readonly deliveries: EnvelopeDeliveryStore,
    private readonly traces: TraceStore,
    private readonly actors?: AgentActorStore,
    private readonly events?: RuntimeEvents,
    private readonly receive?: (envelope: SwarmEnvelope) => void,
    private readonly governor?: SwarmBudgetGovernor
  ) {}

  async pumpActor(actorId: string, handler: MailboxDeliveryHandler): Promise<MailboxDeliveryPumpResult> {
    const result: MailboxDeliveryPumpResult = {
      actor_id: actorId,
      delivered: 0,
      acked: 0,
      failed: 0,
      expired: 0,
      missing: 0,
      deferred: 0,
      sleeping: 0,
      rejected: 0
    };
    const queued = this.deliveries
      .list({ agentId: actorId })
      .filter((delivery) =>
        delivery.recipient_agent_id === actorId &&
        (delivery.status === "queued" || delivery.status === "delivered")
      );
    for (const delivery of queued) {
      const envelope = this.traces.get(delivery.envelope_id);
      if (!envelope) {
        this.deliveries.markFailed(delivery.envelope_id, "Envelope payload is missing from trace store.", undefined, [recipient(actorId)]);
        result.missing += 1;
        result.failed += 1;
        continue;
      }
      if (isExpired(envelope)) {
        this.deliveries.recordExpired(envelope, [recipient(actorId)]);
        result.expired += 1;
        continue;
      }
      const budgetDecision = budgetDecisionForDelivery(this.governor, actorId, envelope, delivery);
      if (budgetDecision && budgetDecision.action !== "allow") {
        this.events?.emitEvent({ type: "budget", decision: budgetDecision });
        this.actors?.heartbeat(actorId, {
          status: budgetDecision.action === "reject" ? "degraded" : "draining",
          current_task_id: budgetDecision.preserve_ownership ? envelope.task_id ?? null : null,
          current_session_id: envelope.session_id,
          current_ownership: budgetDecision.preserve_ownership
            ? {
                envelope_id: envelope.id,
                intent: envelope.intent,
                mailbox_delivery_id: delivery.delivery_id,
                budget_decision: budgetDecision.action
              }
            : null,
          metadata: {
            runner_lifecycle: budgetDecision.action === "sleep" ? "sleeping" : "blocked",
            blocked_reason: budgetDecision.reason,
            budget_pressure: budgetDecision.pressure,
            budget_action: budgetDecision.action,
            budget_sleep_until: budgetDecision.sleep_until,
            deferred_envelope_id: budgetDecision.action === "defer" ? envelope.id : undefined
          }
        });
        if (budgetDecision.action === "reject") {
          this.deliveries.markFailed(envelope.id, budgetDecision.reason, undefined, [recipient(actorId)]);
          result.rejected += 1;
          result.failed += 1;
        } else if (budgetDecision.action === "sleep") {
          result.sleeping += 1;
        } else {
          result.deferred += 1;
        }
        continue;
      }
      this.deliveries.markDelivered(envelope.id, [recipient(actorId)]);
      this.actors?.heartbeat(actorId, {
        current_task_id: envelope.task_id ?? null,
        current_session_id: envelope.session_id,
        current_ownership: {
          envelope_id: envelope.id,
          intent: envelope.intent,
          from: envelope.from,
          mailbox_delivery_id: delivery.delivery_id
        }
      });
      result.delivered += 1;
      try {
        const response = await handler(envelope, delivery);
        if (response) {
          this.receive?.(response);
          if (!this.receive) {
            this.traces.append(response);
          }
          this.deliveries.markAcked(envelope.id, response, [recipient(actorId)]);
          result.acked += 1;
        } else if (envelope.routing?.require_ack) {
          const ack = createEnvelope({
            swarm_id: envelope.swarm_id,
            session_id: envelope.session_id,
            task_id: envelope.task_id,
            from: { agent_id: actorId },
            to: envelope.from,
            type: "ack",
            intent: "mailbox.delivery.ack",
            payload: {
              delivered: true,
              delivery_id: delivery.delivery_id
            },
            reply_to: envelope.id,
            correlation_id: envelope.correlation_id ?? envelope.id
          });
          this.receive?.(ack);
          if (!this.receive) {
            this.traces.append(ack);
          }
          this.deliveries.markAcked(envelope.id, ack, [recipient(actorId)]);
          result.acked += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deliveries.markFailed(envelope.id, message, undefined, [recipient(actorId)]);
        this.actors?.heartbeat(actorId, {
          status: "degraded",
          metadata: {
            runner_lifecycle: "blocked",
            blocked_reason: message,
            last_delivery_error: message,
            failed_envelope_id: envelope.id
          }
        });
        this.events?.emitEvent({ type: "log", level: "warn", message: `Mailbox delivery failed for ${actorId}: ${message}` });
        result.failed += 1;
      }
    }
    return result;
  }
}

function recipient(actorId: string): { agent_id: string } {
  return { agent_id: actorId };
}

function isExpired(envelope: SwarmEnvelope): boolean {
  if (!envelope.ttl_ms) {
    return false;
  }
  return Date.now() - Date.parse(envelope.created_at) > envelope.ttl_ms;
}
