/**
 * The superagent's Engine as every Swarm process sees it: the SQLite store, the Source registry, the Policy from the
 * settings file, and ports that only queue effects. The TUI and the CLI use it to file requests, answer, stop and retry;
 * workers use it to report; the host adds the runners that carry out what is queued (see `host.ts`).
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Engine, followupOwners, latestAssignment, liveTicket, threadKey, type DomainEvent, type Executor, type Ticket } from "./core/index.js";
import { Commands } from "./commands.js";
import { Effects } from "./effects.js";
import { linkOf } from "./github-link.js";
import { harnessIds } from "./harness.js";
import { HealthBoard } from "./health.js";
import { KV } from "./kv.js";
import { ticketExecution } from "./messages.js";
import { Outbox } from "./outbox.js";
import { settingsPolicy } from "./policy.js";
import { readSettings, settingsPath, superagentStateDir, type Settings, type SettingsRead } from "./settings.js";
import type { Deployment } from "./setup.js";
import { Store } from "./store.js";
import { feishuKind } from "./sources/feishu.js";
import { githubKind } from "./sources/github.js";
import { pullEndNotices } from "./sources/github-pull.js";
import { localKind, localOperator, localTrigger, SOURCE as LOCAL } from "./sources/local.js";
import { SourceRegistry } from "./sources/registry.js";

export const databasePath = (stateDir: string): string => join(stateDir, "superagent.db");

/**
 * The settings the Engine works under: the file's, with the operator's OS account allowed on the local Source unless the
 * file configures the local Source's Policy part itself.
 */
export function effectiveSettings(settings: Settings, operator = localOperator()): Settings {
  if (settings.policy.sources[LOCAL]) return settings;
  return { ...settings, policy: { ...settings.policy, sources: { ...settings.policy.sources, [LOCAL]: { allowed: [{ id: operator }], admission: {} } } } };
}

export interface ClientOptions {
  stateDir?: string;
  /** The deployment once the host resolved it; processes without one can still queue work and read state. */
  deployment?: () => Deployment | undefined;
  now?: () => string;
  /** Domain events after their transaction commits, in this process. */
  onEvent?: (event: DomainEvent) => void;
}

export class SuperagentClient {
  readonly stateDir: string;
  readonly store: Store;
  readonly health = new HealthBoard();
  readonly sources: SourceRegistry;
  readonly effects: Effects;
  readonly outbox: Outbox;
  readonly commands: Commands;
  readonly engine: Engine;
  private read: SettingsRead;
  private readonly listeners = new Set<(event: DomainEvent) => void>();

  constructor(private readonly options: ClientOptions = {}) {
    this.stateDir = options.stateDir ?? superagentStateDir();
    this.read = readSettings(settingsPath(this.stateDir));
    this.store = new Store(databasePath(this.stateDir));
    this.sources = new SourceRegistry(() => this.settings(), this.health);
    for (const kind of [localKind, githubKind, feishuKind]) this.sources.register(kind as never);
    this.effects = new Effects(this.store, this.health);
    const lifetime = new AbortController();
    this.commands = new Commands(() => this.deployment(), {}, lifetime.signal);
    this.outbox = new Outbox({ store: this.store, effects: this.effects, sources: this.sources, commands: this.commands, paused: () => this.settings().paused });
    const executor: Executor = {
      start: (ticket, assignment) => this.effects.enqueue("launch", assignment.id, { ticketId: ticket.id, assignmentId: assignment.id }),
      deliver: (ticket) => this.effects.enqueue("delivery", ticket.id, { ticketId: ticket.id }),
      stop: (ticket, assignment, reason) => this.effects.enqueue("stop", assignment.id, { ticketId: ticket.id, reason })
    };
    this.engine = new Engine({
      repo: this.store,
      scope: this.sources,
      policy: () => settingsPolicy(this.settings(), this.sources, { of: (actor) => linkOf(this.store, actor) }),
      assessor: { request: (candidate) => this.effects.enqueue("assessment", candidate.evalId, { triggerId: candidate.triggers[0]!.id }) },
      executor,
      outbox: this.outbox,
      prepareTicket: (ticket, outcome) => ({ ...ticket, execution: ticketExecution(ticket, outcome, this.settings(), this.stateDir, this.harnessOf(ticket)) }),
      ...(options.now ? { now: options.now } : {}),
      emit: (event) => this.store.afterCommit(() => this.emitted(event))
    });
    if (options.onEvent) this.listeners.add(options.onEvent);
  }

  /** The current settings, read again whenever the file changed; an invalid file keeps the last valid settings. */
  settings(): Settings {
    const path = settingsPath(this.stateDir);
    const fresh = readSettings(path);
    if (fresh.mtimeMs !== this.read.mtimeMs) this.read = fresh.error ? { ...this.read, mtimeMs: fresh.mtimeMs, error: fresh.error } : fresh;
    return effectiveSettings(this.read.settings);
  }
  /** Why the settings file cannot be used, while it is invalid. */
  settingsError(): string | undefined {
    this.settings();
    return this.read.error;
  }
  deployment(): Deployment {
    const resolved = this.options.deployment?.();
    if (!resolved) throw new Error("The superagent host has not resolved its deployment; run `swarm superagent run`");
    return resolved;
  }
  subscribe(listener: (event: DomainEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  close(): void { this.store.close(); }

  /**
   * Files a request from the Swarm TUI or CLI as a new local Thread; it reaches Eval like any explicit request. With
   * `harness`, the ticket it becomes runs on that harness profile instead of the settings' default.
   */
  request(text: string, actor = localOperator(), options: { harness?: string } = {}): { triggerId: string; thread: string } {
    const { harness } = options;
    const known = harnessIds(this.settings().executor.harnesses);
    if (harness && !known.includes(harness)) throw new Error(`No harness "${harness}": choose one of ${known.join(", ")}, or add it under executor.harnesses`);
    const trigger = localTrigger({ id: randomUUID(), text, actor });
    this.store.atomic(() => {
      if (harness) this.store.set(KV.harness.chosen(trigger.id), harness);
      this.engine.receive(trigger);
    });
    return { triggerId: trigger.id, thread: threadKey(trigger.threads[0]!) };
  }

  /** The harness a newly accepted ticket runs on: the one its request was filed with, else the settings' default. */
  private harnessOf(ticket: Ticket): string | undefined {
    const chosen = [ticket.origin.triggerId, ...ticket.origin.triggerIds].map((id) => this.store.get(KV.harness.chosen(id))).find(Boolean);
    return chosen ?? this.settings().executor.harness ?? undefined;
  }

  /**
   * A person's message to a ticket from the Swarm TUI or CLI. On a ticket that started locally it goes on the ticket's own
   * Thread, where its worker decides it; on a ticket from another Source it goes on a local Thread of the ticket's, attached
   * to it as the main Session would attach a message that points at a ticket.
   */
  message(ticketId: string, text: string, actor = localOperator()): { triggerId: string; thread: string } {
    const ticket = this.store.tickets.get(ticketId);
    if (!ticket) throw new Error(`Unknown ticket ${ticketId}`);
    const origin = this.store.triggers.get(ticket.origin.triggerId);
    const own = origin?.source === LOCAL ? origin.threads[0]!.id : undefined;
    const trigger = localTrigger({ id: randomUUID(), text, actor, threadId: own ?? `ticket-${ticketId}`, ticketId });
    this.store.atomic(() => {
      this.engine.receive(trigger);
      if (!own) this.engine.attach(ticketId, trigger.id);
    });
    return { triggerId: trigger.id, thread: threadKey(trigger.threads[0]!) };
  }

  stop(ticketId: string, reason = "Stopped from Swarm"): Ticket { return this.engine.stopTicket(ticketId, reason); }
  retry(ticketId: string): Ticket { return this.engine.retryTicket(ticketId); }

  private emitted(event: DomainEvent): void {
    try {
      // A person's message that reached a ticket, also one that resumed an ended ticket or that an earlier Eval queue released.
      if (event.type === "trigger.received" || event.type === "ticket.resumed" || event.type === "trigger.followup") this.followup(event.data.triggerId);
      if (event.type === "ticket.ended") this.pullEnded(event.data.ticketId);
    } finally {
      for (const listener of this.listeners) listener(event);
    }
  }
  /**
   * A person's message that a ticket's worker decides still goes to a stop check: only the Engine may stop work, on the
   * person's request. Local messages skip it, since the TUI and CLI stop tickets with a command.
   */
  private followup(triggerId: string): void {
    const trigger = this.store.triggers.get(triggerId);
    if (!trigger || trigger.source === LOCAL || !followupOwners(trigger, this.store).length) return;
    this.store.atomic(() => { this.effects.enqueue("followup", triggerId, { triggerId }); });
  }
  /** A ticket that ended with its pull request tells its chat conversations once; GitHub shows the outcome itself. */
  private pullEnded(ticketId: string): void {
    const ticket = this.store.tickets.get(ticketId);
    if (!ticket?.ended) return;
    const request = this.store.triggers.get(ticket.origin.triggerId)?.text ?? "";
    const repository = String(this.settings().sources.github?.config.repository ?? "");
    for (const message of pullEndNotices(ticket, request, repository)) this.outbox.send(message);
  }
}

/** Whether a ticket's latest Assignment still runs or waits to run. */
export const assignmentActive = (ticket: Ticket): boolean =>
  liveTicket(ticket) && ["pending", "running"].includes(latestAssignment(ticket)?.state ?? "");
