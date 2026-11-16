/**
 * What a take-over does, shared by the chat commands that carry one out (bot-commands.ts) and the terminal's
 * `swarm superagent takeover` (github-cli.ts): which tickets may be taken over, what a take-over needs first, and the
 * new ticket that applies a local ticket's patch and opens its pull request as the person who took it over.
 */
import { existsSync } from "node:fs";
import { UserError, latestReport, liveTicket, threadKey, type Ticket, type Trigger } from "./core/index.js";
import type { SuperagentClient } from "./client.js";
import { githubApp, linkOf } from "./github-link.js";
import { KV } from "./kv.js";
import { WorktreeNameSchema } from "./messages.js";
import { allowedWrite, capabilityOf, limitOf, roleOf, steers, watchedRepository } from "./policy.js";
import type { Settings } from "./settings.js";
import { sameActor, sameName } from "./text.js";
import { patchPath } from "./ticket-tools.js";

/** The first eight characters of a ticket's id, how commands and answers name it. */
export const shortId = (id: string): string => id.slice(0, 8);

/**
 * Whether a ticket has the patch of its finished work: its latest report is ready, which is when a local ticket's result
 * keeps its patch, and the host holds that patch's file. One that reported blocked or failed has a patch file too, of
 * unfinished work, which no take-over runs.
 */
export const patchReady = (client: SuperagentClient, ticket: Ticket): boolean =>
  latestReport(ticket)?.state === "ready" && existsSync(patchPath(client.stateDir, ticket));

/** The ticket a take-over names: by its id's start or its name, else the latest local ticket on the trigger's Threads. */
export function ticketNamed(client: SuperagentClient, name: string | undefined, threads: readonly { source: string; id: string }[]): Ticket | undefined {
  const { store } = client;
  if (name) {
    if (name.length < 6) return undefined;
    return store.tickets.list().find((ticket) => ticket.id.startsWith(name) || ticket.execution?.name === name);
  }
  const ids = threads.flatMap((ref) => store.threads.get(threadKey(ref))?.subscriptions ?? []);
  // A ticket from before the access model has no capability, and its work writes as tickets always did: locally.
  return ids.flatMap((id) => store.tickets.get(id) ?? []).filter((ticket) => (ticket.mandate.capability?.write ?? "local") === "local")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/** Why a take-over did not happen, in the words of whoever asked. */
export type TakeOverRefusal = "not-local" | "already-taken" | "not-steerer" | "cannot-write" | "limit";
export type TakeOverOutcome =
  | { kind: "taken"; ticketId: string }
  /** Nothing yet: the taker's GitHub account is not linked, or the ticket has no patch, which a wanted pull request waits for. */
  | { kind: "waiting"; needs: "link" | "patch" }
  /** A refusal, naming the ticket that already took it over when one did. */
  | { kind: "refused"; reason: TakeOverRefusal; taker?: string };

/** The tickets the trigger's sender has open, other than `except`: what their role's open-ticket limit counts. */
export function openTicketsOf(client: SuperagentClient, trigger: Trigger, except?: string): Ticket[] {
  return client.store.tickets.open().filter((ticket) => liveTicket(ticket) && ticket.id !== except && sameActor(ticket.mandate.actor, trigger.actor));
}

/** Remembers that the trigger's sender wants a pull request from a local ticket, which `takeOverWanted` opens. */
export function wantPullRequest(client: SuperagentClient, ticket: Ticket, trigger: Trigger): void {
  client.store.set(KV.links.wanted(ticket.id), { triggerId: trigger.id, at: new Date().toISOString() });
}

/**
 * Takes a local ticket over for the sender of `trigger`, whose message decides the new ticket: it applies the ticket's
 * patch and opens a pull request as the sender's linked GitHub account. Its requester, a maintainer, or, for work nobody
 * asked for, anyone who may write to GitHub here may take it over; a scope's ceiling can refuse the write altogether.
 * A wanted pull request is the caller's to record (see `wantPullRequest`), since only a conversation has somewhere to
 * keep it in.
 */
export function takeOverTicket(client: SuperagentClient, ticket: Ticket, trigger: Trigger, settings: Settings): TakeOverOutcome {
  // Judge the effective write level, as views.ts does: a ticket accepted without the access model stays local.
  if ((ticket.mandate.capability?.write ?? "local") !== "local") return { kind: "refused", reason: "not-local" };
  const taker = client.store.tickets.list().find((item) => item.mandate.capability?.from === ticket.id);
  if (taker) return { kind: "refused", reason: "already-taken", taker: shortId(taker.id) };
  if (ticket.mandate.strength !== "inferred" && !steers(settings, ticket.mandate, trigger.actor)) return { kind: "refused", reason: "not-steerer" };
  const scope = client.sources.scope(trigger);
  const row = scope.listened ? scope.row : undefined;
  const addressed = trigger.addressed === "direct" ? "direct" as const : "mention" as const;
  const mandate = { strength: "explicit" as const, actor: trigger.actor,
    basis: { via: "addressed" as const, addressed, source: trigger.source, ...(row === undefined ? {} : { row }) } };
  // A local ticket's patch is on the watched repository, where the taker opens the pull request as themselves.
  const watched = watchedRepository(settings);
  const link = linkOf(client.store, trigger.actor);
  if (!link || link.broken) {
    if (!githubApp(settings) || allowedWrite(settings, mandate) !== "github") return { kind: "refused", reason: "cannot-write" };
    return { kind: "waiting", needs: "link" };
  }
  const would = capabilityOf(settings, mandate, link, { repository: watched });
  if (would?.write !== "github" || !sameName(would.repository ?? "", watched)) return { kind: "refused", reason: "cannot-write" };
  if (!patchReady(client, ticket)) return { kind: "waiting", needs: "patch" };
  const limit = limitOf(settings, roleOf(settings, trigger.actor), "openTickets");
  if (limit !== undefined && openTicketsOf(client, trigger, ticket.id).length >= limit) return { kind: "refused", reason: "limit" };
  const request = client.store.triggers.get(ticket.origin.triggerId)?.text ?? "";
  const worktree = WorktreeNameSchema.safeParse(ticket.execution?.name.replace(/-[0-9a-f]{12}$/, "")).data ?? "takeover";
  const decision = client.store.atomic(() => {
    const decided = client.engine.decide(trigger.id, { kind: "accept", title: ticket.title, scope: ticket.mandate.scope,
      reason: { code: "takeover", values: { ticket: ticket.id } }, from: ticket.id, name: worktree, repository: watched,
      note: `Takes over ticket ${ticket.id}, whose request was: ${request.slice(0, 1000)}` });
    if (decided.ticketId && liveTicket(client.store.tickets.get(ticket.id)!)) client.engine.stopTicket(ticket.id, `Taken over as ticket ${decided.ticketId}`);
    return decided;
  });
  if (!decision.ticketId) throw new UserError("notAdmissible", { reason: "the take-over was not accepted" });
  client.store.delete(KV.links.wanted(ticket.id));
  return { kind: "taken", ticketId: decision.ticketId };
}
