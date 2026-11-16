/**
 * The superagent's Engine as every Swarm process sees it: the SQLite store, the Source registry, the Policy from the
 * settings file, and ports that only queue effects. The TUI and the CLI use it to file requests, answer, stop and retry;
 * workers use it to report; the host adds the runners that carry out what is queued (see `host.ts`).
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Engine, UserError, followupOwners, key, latestAssignment, latestReport, liveTicket, threadKey, type Decision, type DomainEvent, type Executor, type Ticket,
  type Trigger } from "./core/index.js";
import { Commands } from "./commands.js";
import { Effects } from "./effects.js";
import { linkOf } from "./github-link.js";
import { harnessIds } from "./harness.js";
import type { Journal } from "./journal.js";
import { HealthBoard } from "./health.js";
import { KV } from "./kv.js";
import { ticketExecution } from "./messages.js";
import { noticeChannel, stoppedId, stoppedNotice, unroutedNotice } from "./notices.js";
import { Outbox } from "./outbox.js";
import { settingsPolicy } from "./policy.js";
import { readSettings, settingsPath, superagentStateDir, type Settings, type SettingsRead } from "./settings.js";
import type { Deployment } from "./setup.js";
import { Store } from "./store.js";
import { feishuKind } from "./sources/feishu.js";
import type { SourceKind } from "./sources/kind.js";
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
  /** What a follow-up after a commit threw, such as a notice that could not be queued; unreported, it would vanish. */
  onError?: (error: unknown) => void;
  /** Extra Source kinds to register beside the built-in ones (a test's fake chat kind); the built-in set is unchanged without it. */
  kinds?: readonly SourceKind[];
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
  /** The talking paths' journal (journal.ts), which the host and the tests that drive them install; processes without one record none. */
  journal?: Journal;
  private read: SettingsRead;
  private readonly listeners = new Set<(event: DomainEvent) => void>();

  constructor(private readonly options: ClientOptions = {}) {
    this.stateDir = options.stateDir ?? superagentStateDir();
    this.read = readSettings(settingsPath(this.stateDir));
    this.store = new Store(databasePath(this.stateDir), options.onError);
    this.sources = new SourceRegistry(() => this.settings(), this.health);
    for (const kind of [localKind, githubKind, feishuKind, ...options.kinds ?? []]) this.sources.register(kind as never);
    this.store.setChatSources(() => this.sources);
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
  /** The deployment, once the host resolved it. */
  resolvedDeployment(): Deployment | undefined { return this.options.deployment?.(); }
  deployment(): Deployment {
    const resolved = this.resolvedDeployment();
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
      if (event.type === "assignment.reported" && (event.data.state === "failed" || event.data.state === "blocked")) this.stopped(event.data.ticketId);
      if (event.type === "decision.recorded" && event.data.kind === "unavailable") this.unrouted(event.data.decisionId);
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
  /**
   * A ticket whose work failed or blocked tells its person, once a report: the question it asks them, else that the work
   * stopped and why, unless the worker's report already told them so (see `stoppedId`).
   */
  private stopped(ticketId: string): void {
    const ticket = this.store.tickets.get(ticketId);
    const report = ticket && latestReport(ticket);
    if (!ticket || !report || !liveTicket(ticket) || (report.state !== "failed" && report.state !== "blocked")) return;
    const { attention } = ticket;
    if (attention) {
      if (this.outbox.status(key("attention-reply", attention.id))) return;
      try {
        this.engine.reply({ purpose: "attention", ticketId, question: attention.question, text: attention.question });
      } catch (error) {
        // A question with no conversation to ask it in stays on the ticket for `swarm superagent tickets`.
        if (!(error instanceof UserError)) throw error;
      }
      return;
    }
    const channel = noticeChannel(this.store, ticket);
    const request = this.store.triggers.get(ticket.origin.triggerId)?.text ?? "";
    if (channel) this.outbox.send({ id: stoppedId(ticketId, report.at, report.state), channel, text: stoppedNotice(report.state, report.summary, request), kind: "reply", ticketId });
  }
  /**
   * A request the router did not decide in time tells its person once, where they wrote it, that it was not taken in and
   * that they can send it again: no ticket came of it, so nothing else would tell them.
   */
  private unrouted(decisionId: string): void {
    const decision = this.store.decisions.get(decisionId);
    const request = decision && unroutedRequest(this.store, decision);
    // A source that is off can deliver nothing now: the notice waits rather than filling the outbox with a dead row.
    if (request?.channel && this.sources.channelAllowed(request.channel)) this.outbox.send({ id: key("unavailable", decisionId), channel: request.channel, text: unroutedNotice(request.text), kind: "reply" });
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

/**
 * The request an unavailable Decision left unrouted because the model did not answer in time: the last of its Triggers in
 * which a person addressed the agent in a conversation that takes an answer, else the last a person wrote in one. An Eval
 * holds every message that waited on its Thread, so the last of them may be a bystander's comment that asked for nothing.
 * Undefined for any other Decision: an Eval that ended unavailable because the Policy changed or its Triggers were routed
 * starts again, and an assessment's own verdict is a judgement.
 */
export function unroutedRequest(store: Pick<Store, "triggers">, decision: Decision): Trigger | undefined {
  if (decision.kind !== "unavailable" || decision.strength !== "explicit" || decision.reason[0]?.code !== "timeout") return undefined;
  const written = decision.triggerIds.flatMap((id) => store.triggers.get(id) ?? []).filter((trigger) => trigger.human && trigger.channel);
  return written.filter((trigger) => trigger.addressed).at(-1) ?? written.at(-1);
}

/** Whether a ticket's latest Assignment still runs or waits to run. */
export const assignmentActive = (ticket: Ticket): boolean =>
  liveTicket(ticket) && ["pending", "running"].includes(latestAssignment(ticket)?.state ?? "");
