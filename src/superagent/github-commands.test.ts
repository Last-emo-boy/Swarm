/**
 * What a take-over does, apart from where it is asked: which tickets may be taken over, what it needs first, and the new
 * ticket that applies a local ticket's patch and opens its pull request.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "./testing/expect.js";
import { liveTicket, type Ticket, type Trigger } from "./core/index.js";
import { sameActor } from "./text.js";
import { SuperagentClient } from "./client.js";
import { patchReady, takeOverTicket, wantPullRequest } from "./github-commands.js";
import { linkKey, linkOf } from "./github-link.js";
import { KV } from "./kv.js";
import { settingsPath, writeSettings } from "./settings.js";
import { localOperator, localTrigger } from "./sources/local.js";
import { fileReport, patchPath } from "./ticket-tools.js";

const OPERATOR = localOperator();
const OTHER = "someone-else";
const WATCHED = "owner/watched";
const takerOf = (client: SuperagentClient, ticket: Ticket) => client.store.tickets.list().find((item) => item.mandate.capability?.from === ticket.id);

let stateDir: string;
let client: SuperagentClient;
/** Settings with the access model on or off, and the local Source's Policy part: naming it keeps the operator off its default list. */
const settings = (access: Record<string, unknown> = {}, allowed: string[] = [OPERATOR]) => ({
  sources: { github: { enabled: false, config: { repository: WATCHED, app: { clientId: "Iv23client", slug: "swarm-oauth" } } } },
  policy: { sources: { local: { allowed: allowed.map((id) => ({ id })), admission: {} } } },
  eval: { mode: "observe" },
  access
});
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-github-commands-"));
  writeSettings(settings(), settingsPath(stateDir));
  client = new SuperagentClient({ stateDir });
});
afterEach(() => {
  client.close();
  rmSync(stateDir, { recursive: true, force: true });
});

/** A request from `actor`, accepted as a local ticket of theirs, as the router's accept decision makes one. */
function accepted(actor = OPERATOR, text = "fix the typo"): Ticket {
  const { triggerId } = client.request(text, actor);
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(triggerId)!;
  const decision = client.engine.decide(triggerId, { kind: "accept", title: "Fix the typo", scope: "Fix the typo", reason: "asked", name: "fix-typo", evalId: candidate.evalId });
  return client.store.tickets.get(decision.ticketId!)!;
}
/** Links an account for the local operator as the device flow would, with the repositories they may push to. */
function linkAs(repos = [WATCHED], login = "operator-gh", actor = OPERATOR): void {
  client.store.set(KV.links.github("local", actor), { login, id: 7, repos, reposAt: "", linkedAt: "", access: { iv: "", data: "", tag: "" } });
}
/** A message this terminal's operator wrote, stored as the terminal stores one, which a take-over decides. */
function message(ticket?: Ticket) {
  const trigger = localTrigger({ id: `takeover-${ticket?.id ?? "none"}`, text: `/takeover ${ticket?.id ?? ""}`, ticketId: ticket?.id });
  client.store.atomic(() => client.store.triggers.save(trigger));
  return trigger;
}
/** Has a local ticket report ready with its commits as a patch, as its worker would. */
async function ready(ticket: Ticket): Promise<void> {
  client.engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id);
  const patch = "From 0000 Mon Sep 17 00:00:00 2001\n";
  await fileReport(client, ticket.id, { state: "ready", summary: "Done.", patch: { text: patch, bytes: patch.length, uncommitted: false } });
}

describe("take-over", () => {
  it("refuses a ticket whose requester is someone else when the taker is not a maintainer", async () => {
    // Only the other person is on the list, so this terminal's operator is everyone: not a maintainer of their ticket.
    writeSettings(settings({}, [OTHER]), settingsPath(stateDir));
    const ticket = accepted(OTHER);
    await ready(ticket);
    linkAs();
    const stored = client.store.tickets.get(ticket.id)!;
    expect(takeOverTicket(client, stored, message(stored), client.settings())).toEqual({ kind: "refused", reason: "not-steerer" });
    expect(takerOf(client, stored)).toBeUndefined();
  });
  it("refuses a ticket that does not keep its work local", async () => {
    const ticket = accepted();
    // A ticket of someone who may write to GitHub, which the access model made as its requester.
    client.store.atomic(() => client.store.tickets.save({ ...ticket, mandate: { ...ticket.mandate, capability: { role: "maintainer", write: "github",
      credential: { login: "operator-gh", id: 7 }, repository: WATCHED } } }));
    expect(takeOverTicket(client, client.store.tickets.get(ticket.id)!, message(ticket), client.settings())).toEqual({ kind: "refused", reason: "not-local" });
  });
  it("waits for the patch of a local ticket that has none yet", async () => {
    const ticket = accepted();
    linkAs();
    expect(patchReady(client, ticket)).toBe(false);
    expect(takeOverTicket(client, client.store.tickets.get(ticket.id)!, message(ticket), client.settings())).toEqual({ kind: "waiting", needs: "patch" });
    expect(takerOf(client, ticket)).toBeUndefined();
  });
  it("takes the requester's patched ticket once the access model lets them write, and stops the old one", async () => {
    writeSettings(settings({}), settingsPath(stateDir));
    const ticket = accepted();
    await ready(ticket);
    linkAs();
    const stored = client.store.tickets.get(ticket.id)!;
    const outcome = takeOverTicket(client, stored, message(stored), client.settings());
    expect(outcome.kind).toBe("taken");
    const taken = takerOf(client, ticket)!;
    expect(taken.mandate).toMatchObject({ actor: { source: "local", id: OPERATOR }, capability: { write: "github", from: ticket.id,
      credential: { login: "operator-gh", id: 7 }, repository: WATCHED } });
    expect(liveTicket(client.store.tickets.get(ticket.id)!)).toBe(false);
    // A ticket is taken over once.
    expect(takeOverTicket(client, stored, message(stored), client.settings())).toEqual({ kind: "refused", reason: "already-taken", taker: taken.id.slice(0, 8) });
  });
  it("waits for a link when the ticket is patched but its requester has not linked an account", async () => {
    writeSettings(settings({}), settingsPath(stateDir));
    const ticket = accepted();
    await ready(ticket);
    expect(linkOf(client.store, { source: "local", id: OPERATOR })).toBeUndefined();
    const stored = client.store.tickets.get(ticket.id)!;
    expect(takeOverTicket(client, stored, message(stored), client.settings())).toEqual({ kind: "waiting", needs: "link" });
  });
  it("takes over a ticket accepted without the access model, whose mandate has no capability to say it is local", async () => {
    // Accepted while the access model was off, which stamped no capability, then the model turned on.
    const { access: _off, ...noAccess } = settings() as Record<string, unknown>;
    writeSettings({ ...noAccess, policy: { sources: { local: { allowed: [{ id: OPERATOR }], admission: {} } } } }, settingsPath(stateDir));
    const ticket = accepted();
    // Its host kept no patch, since work with no capability was never kept local; the take-over needs one either way.
    const path = patchPath(stateDir, ticket);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "From 0000 Mon Sep 17 00:00:00 2001\n");
    client.engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id);
    client.engine.report(ticket.id, { state: "ready", summary: "Done." });
    expect(client.store.tickets.get(ticket.id)!.mandate).not.toHaveProperty("capability");
    writeSettings({ ...settings({}), policy: { sources: { local: { allowed: [{ id: OPERATOR }], admission: {} } } } }, settingsPath(stateDir));
    linkAs();
    expect(takeOverTicket(client, client.store.tickets.get(ticket.id)!, message(ticket), client.settings()).kind).toBe("taken");
    expect(takerOf(client, ticket)?.mandate.capability?.from).toBe(ticket.id);
  });
  it("counts a renamed login as the same person by its account number when the role's open tickets are full", async () => {
    // One person under two logins of one account: the ticket is under the account's new name, and an unrelated live
    // ticket of theirs sits under the old one, so the role's single open ticket is already taken.
    writeSettings({ ...settings({ limits: { maintainer: { openTickets: 1 } } }),
      policy: { sources: { local: { allowed: [{ id: OPERATOR }, { id: "new-login" }, { id: "old-login" }], admission: {} } } } }, settingsPath(stateDir));
    // Two requests first, so neither accept sees the other's ticket and refuses it for the same limit.
    const first = client.request("fix the typo");
    const other = localTrigger({ id: "old-typo", text: "fix the other typo", actor: "old-login" });
    client.engine.receive({ ...other, actor: { ...other.actor, accountId: 7 } });
    client.engine.evaluateDue();
    const accept = (triggerId: string) => {
      const decision = client.engine.decide(triggerId, { kind: "accept", title: "Fix the typo", scope: "Fix the typo", reason: "asked", name: `fix-${triggerId.slice(-4)}`,
        evalId: client.engine.candidate(triggerId)!.evalId });
      return client.store.tickets.get(decision.ticketId!)!;
    };
    const ticket = accept(first.triggerId);
    const old = accept(other.id);
    client.store.atomic(() => {
      client.store.tickets.save({ ...client.store.tickets.get(ticket.id)!, mandate: { ...client.store.tickets.get(ticket.id)!.mandate, actor: { source: "local", id: "new-login", accountId: 7 } } });
      client.store.tickets.save({ ...client.store.tickets.get(old.id)!, mandate: { ...client.store.tickets.get(old.id)!.mandate, actor: { source: "local", id: "old-login", accountId: 7 } } });
    });
    expect(liveTicket(client.store.tickets.get(old.id)!)).toBe(true);
    expect(sameActor(client.store.tickets.get(old.id)!.mandate.actor, { source: "local", id: "new-login", accountId: 7 })).toBe(true);
    await ready(client.store.tickets.get(ticket.id)!);
    linkAs([WATCHED], "new-gh", "new-login");
    // The take-over comes from the account's new name, carrying its number as GitHub now sends it.
    const draft = localTrigger({ id: `takeover-${ticket.id}-renamed`, text: `/takeover ${ticket.id}`, ticketId: ticket.id, actor: "new-login" });
    const trigger: Trigger = { ...draft, actor: { ...draft.actor, accountId: 7 } };
    client.store.atomic(() => client.store.triggers.save(trigger));
    expect(takeOverTicket(client, client.store.tickets.get(ticket.id)!, trigger, client.settings())).toEqual({ kind: "refused", reason: "limit" });
    expect(takerOf(client, ticket)).toBeUndefined();
  });
  it("refuses a take-over that would exceed the role's open tickets", async () => {
    writeSettings(settings({ limits: { maintainer: { openTickets: 1 } } }), settingsPath(stateDir));
    const ticket = accepted();
    await ready(ticket);
    linkAs();
    const other = accepted(OPERATOR, "fix another typo");
    expect(liveTicket(client.store.tickets.get(other.id)!)).toBe(true);
    expect(takeOverTicket(client, client.store.tickets.get(ticket.id)!, message(ticket), client.settings())).toEqual({ kind: "refused", reason: "limit" });
    expect(takerOf(client, ticket)).toBeUndefined();
  });
  it("drops the wanted pull request of the ticket a take-over replaces", async () => {
    writeSettings(settings({}), settingsPath(stateDir));
    const ticket = accepted();
    await ready(ticket);
    linkAs();
    const stored = client.store.tickets.get(ticket.id)!;
    const trigger = message(stored);
    wantPullRequest(client, stored, trigger);
    expect(client.store.get(KV.links.wanted(ticket.id))).toBeDefined();
    expect(takeOverTicket(client, stored, trigger, client.settings()).kind).toBe("taken");
    expect(client.store.get(KV.links.wanted(ticket.id))).toBeUndefined();
  });
  it("reads its link under the local Source's own key, as every local request's capability does", () => {
    linkAs();
    expect(linkOf(client.store, { source: "local", id: OPERATOR })).toMatchObject({ login: "operator-gh", repos: [WATCHED] });
    expect(linkKey(stateDir)).toHaveLength(32);
  });
});
