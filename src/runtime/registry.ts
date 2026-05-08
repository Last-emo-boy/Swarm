import type { ChildProcess } from "node:child_process";
import type { AgentCard } from "../protocol/types.js";
import { RuntimeEvents } from "./events.js";

export type RegisteredAgent = {
  card: AgentCard;
  process?: ChildProcess;
};

export class AgentRegistry {
  private readonly agents = new Map<string, RegisteredAgent>();

  constructor(private readonly events: RuntimeEvents) {}

  register(card: AgentCard, process?: ChildProcess): void {
    this.agents.set(card.agent_id, { card, process });
    this.events.emitEvent({ type: "agent", card });
  }

  updateStatus(agentId: string, status: AgentCard["status"]): void {
    const registered = this.agents.get(agentId);
    if (!registered) {
      return;
    }
    registered.card.status = status;
    this.events.emitEvent({ type: "agent", card: registered.card });
  }

  list(): AgentCard[] {
    return [...this.agents.values()].map((agent) => agent.card);
  }

  listRegistered(): RegisteredAgent[] {
    return [...this.agents.values()];
  }

  get(agentId: string): RegisteredAgent | undefined {
    return this.agents.get(agentId);
  }

  findByCapability(capability: string): RegisteredAgent | undefined {
    return this.queryByCapability(capability)[0];
  }

  queryByCapability(capability: string): RegisteredAgent[] {
    const candidates = [...this.agents.values()].filter((agent) =>
      agent.card.capabilities.includes(capability) && agent.card.status !== "offline"
    );
    return candidates.sort(
      (a, b) =>
        a.card.load.running_tasks - b.card.load.running_tasks ||
        (b.card.reliability?.success_rate ?? 0) - (a.card.reliability?.success_rate ?? 0)
    );
  }

  findByRole(role: string): RegisteredAgent | undefined {
    return this.queryByRole(role)[0];
  }

  queryByRole(role: string): RegisteredAgent[] {
    const candidates = [...this.agents.values()].filter((agent) =>
      agent.card.role === role && agent.card.status !== "offline"
    );
    return candidates.sort(
      (a, b) =>
        a.card.load.running_tasks - b.card.load.running_tasks ||
        (b.card.reliability?.success_rate ?? 0) - (a.card.reliability?.success_rate ?? 0)
    );
  }

  incrementLoad(agentId: string): void {
    const registered = this.agents.get(agentId);
    if (!registered) {
      return;
    }
    registered.card.load.running_tasks += 1;
    registered.card.status = "busy";
    this.events.emitEvent({ type: "agent", card: registered.card });
  }

  decrementLoad(agentId: string): void {
    const registered = this.agents.get(agentId);
    if (!registered) {
      return;
    }
    registered.card.load.running_tasks = Math.max(0, registered.card.load.running_tasks - 1);
    registered.card.status = registered.card.load.running_tasks === 0 ? "idle" : "busy";
    this.events.emitEvent({ type: "agent", card: registered.card });
  }
}
