import { EventEmitter } from "node:events";
import type { SwarmEnvelope } from "../protocol/types.js";
import { TraceStore } from "../storage/trace-store.js";
import { RuntimeEvents } from "./events.js";
import { AgentRegistry, type RegisteredAgent } from "./registry.js";

type RequestOptions = {
  expect: SwarmEnvelope["type"][];
  timeout_ms: number;
};

export class EnvelopeRouter extends EventEmitter {
  private readonly processedKeys = new Map<string, string>(); // idempotency_key → envelope_id

  constructor(
    private readonly registry: AgentRegistry,
    private readonly traceStore: TraceStore,
    private readonly events: RuntimeEvents
  ) {
    super();
  }

  async dispatch(envelope: SwarmEnvelope): Promise<void> {
    if (envelope.type === "agent.capability_query") {
      this.handleCapabilityQuery(envelope);
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

    for (const target of targets) {
      target.process?.send(envelope);
      this.registry.incrementLoad(target.card.agent_id);
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
        const target = this.registry.findByCapability(address.capability);
        if (target) {
          targets.push(target);
        }
        continue;
      }

      if (address.role) {
        const target = this.registry.findByRole(address.role);
        if (target) {
          targets.push(target);
        }
      }
    }

    return targets;
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
}
