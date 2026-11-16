/**
 * `swarm superagent link|repo|takeover`: the GitHub commands a chat has as bot commands (bot-commands.ts), for a terminal
 * where no chat is set up. They link the operator's own GitHub account through the GitHub App's device flow, choose the
 * repository their local tickets work on, and take over a local ticket's patch as a pull request of that account. The
 * link is stored where the host reads every local request's and ticket's link (github-link.ts), so work filed from this
 * terminal then writes to GitHub as the operator, as a linked member's does from a chat.
 */
import { randomUUID } from "node:crypto";
import { githubApp, installUrl, namedRepository, type Device, type GithubApp, type GithubLinks } from "./github-link.js";
import { KV } from "./kv.js";
import type { SuperagentClient } from "./client.js";
import type { Ticket, Trigger } from "./core/index.js";
import { takeOverTicket, ticketNamed, wantPullRequest, type TakeOverRefusal } from "./github-commands.js";
import { watchedRepository } from "./policy.js";
import { localOperator, localTrigger } from "./sources/local.js";
import { sameName } from "./text.js";

export type GithubCommand = "link" | "repo" | "takeover";

const actor = () => ({ source: "local", id: localOperator() });
const minute = (seconds: number): string => `${Math.max(1, Math.round(seconds / 60))} ${Math.round(seconds / 60) === 1 ? "minute" : "minutes"}`;
/** How a refused take-over reads. */
const refusal = (client: SuperagentClient, reason: TakeOverRefusal, ticket: Ticket, login: string | undefined, taker: string | undefined): string => {
  const name = ticket.id.slice(0, 8);
  switch (reason) {
    case "not-local": return `Ticket ${name} does not keep its work local, so there is nothing to take over.`;
    case "already-taken": return `Ticket ${name} was taken over as ticket ${taker} already.`;
    case "not-steerer": return `Only the person who asked for ticket ${name} or a maintainer can take it over.`;
    case "cannot-write":
      return login
        ? `You cannot open pull requests on ${watchedRepository(client.settings())} from here as @${login}.`
        : `Ticket ${name} cannot become a pull request from this terminal: its work is not allowed to write to GitHub here.`;
    case "limit": return `You have as many open tickets as your role allows: take ticket ${name} over once one finishes.`;
  }
};

/** Starts a device flow and says where its code goes, keeping it so `link --wait` can finish it. */
async function startDevice(client: SuperagentClient, links: GithubLinks, github: GithubApp): Promise<Device> {
  const device = await links.start(github);
  client.store.set(KV.links.device, { device, clientId: github.clientId, at: new Date().toISOString() });
  // A code the person reads here: nothing else may show it, or write it where a log would keep it.
  console.log(`Open ${device.verification_uri} and enter ${device.user_code} (expires in ${minute(device.expires_in)}).`);
  return device;
}

/**
 * Runs one of the three commands for this terminal's operator. Everything a person reads goes to stdout; the device code
 * never goes through a log or a journal, since nothing here talks to a model.
 */
export async function runGithubCommand(client: SuperagentClient, command: GithubCommand, args: string[], links: GithubLinks): Promise<void> {
  switch (command) {
    case "link": return link(client, links, args);
    case "repo": return repo(client, links, args);
    case "takeover": return takeover(client, links, args);
  }
}

/** The GitHub App this host links accounts through, which the settings' GitHub Source names. */
const app = (client: SuperagentClient): GithubApp => {
  const found = githubApp(client.settings());
  if (!found) throw new Error("linking GitHub accounts is not set up here: set sources.github.config.app in the settings");
  return found;
};

/** `link [--repo owner/name] [--wait]`: the device flow, printed once, then finished with `--wait` or a second run. */
async function link(client: SuperagentClient, links: GithubLinks, args: string[]): Promise<void> {
  const wait = args.includes("--wait");
  const at = args.indexOf("--repo");
  const wanted = at >= 0 ? args[at + 1] : undefined;
  const github = app(client);
  const who = actor();
  let pending = client.store.get(KV.links.device);
  // A code from another app, or one past its lifetime, is no use: a fresh one is a fresh flow.
  const expired = !!pending && Date.parse(pending.at) + pending.device.expires_in * 1000 <= Date.now();
  if (!pending || pending.clientId !== github.clientId || expired) pending = { device: await startDevice(client, links, github), clientId: github.clientId, at: new Date().toISOString() };
  if (!wait) {
    console.log("Run `swarm superagent link --wait` once you entered it.");
    return;
  }
  // The pending code is spent once polled: a declined or expired wait must not leave it for the next run to reuse, so it
  // is cleared before polling rather than after a success.
  client.store.delete(KV.links.device);
  const tokens = await links.authorized(github, pending.device);
  const view = await links.link(who, tokens);
  console.log(view.repos.length
    ? `Linked as @${view.login}. You can work on ${view.repos.join(", ")}. Install the app on more repositories at ${installUrl(github)}.`
    : `Linked as @${view.login}, but the app is not installed on a repository you can push to: install it at ${installUrl(github)}, then run swarm superagent repo.`);
  if (wanted) await setDefault(client, links, github, wanted);
}

/** Sets the operator's default repository from `wanted`, or explains why the app is not on it. */
async function setDefault(client: SuperagentClient, links: GithubLinks, github: GithubApp, wanted: string): Promise<void> {
  const who = actor();
  const view = await links.refreshRepos(github, who) ?? client.store.get(KV.links.github(who.source, who.id));
  const repo = wanted && view ? namedRepository(wanted, view.repos) : undefined;
  if (!view || !repo) {
    throw new Error(`@${view?.login ?? who.id} cannot push to ${wanted} through the app: install it there at ${installUrl(github)}, then run swarm superagent repo ${wanted}`);
  }
  links.setDefault(who, repo);
  console.log(`Your tickets work on ${repo} unless their request names another.`);
}

/** `repo [owner/name]`: reads again which repositories the operator may work on, and sets or lists their default. */
async function repo(client: SuperagentClient, links: GithubLinks, args: string[]): Promise<void> {
  const github = app(client);
  const who = actor();
  const current = client.store.get(KV.links.github(who.source, who.id));
  if (!current) throw new Error("Your GitHub account is not linked yet: run swarm superagent link");
  if (current.broken) throw new Error("Your GitHub link stopped working: run swarm superagent link again");
  const refreshed = await links.refreshRepos(github, who);
  if (!refreshed) throw new Error("Your GitHub link stopped working: run swarm superagent link again");
  const wanted = args[0];
  if (wanted) {
    const found = namedRepository(wanted, refreshed.repos);
    if (!found) throw new Error(`@${refreshed.login} cannot push to ${wanted} through the app: install it there at ${installUrl(github)}, then run swarm superagent repo ${wanted}`);
    links.setDefault(who, found);
  }
  const view = args[0] ? client.store.get(KV.links.github(who.source, who.id)) ?? refreshed : refreshed;
  console.log(view.repos.length
    ? `You can work on ${view.repos.map((name) => sameName(name, view.defaultRepo ?? "") ? `${name} (default)` : name).join(", ")}.`
    : `The app is not installed on a repository you can push to: install it at ${installUrl(github)}.`);
}

/** `takeover <ticket>`: a local ticket's patch as a pull request of the operator, linking first when that is what lacks. */
async function takeover(client: SuperagentClient, links: GithubLinks, args: string[]): Promise<void> {
  const handle = args[0];
  if (!handle) throw new Error("Usage: swarm superagent takeover <ticket id>");
  const ticket = ticketNamed(client, handle, []);
  if (!ticket) throw new Error(`No ticket ${handle}`);
  const trigger: Trigger = localTrigger({ id: randomUUID(), text: `/takeover ${ticket.id}`, ticketId: ticket.id });
  client.store.atomic(() => client.store.triggers.save(trigger));
  let outcome = takeOverTicket(client, ticket, trigger, client.settings());
  // A link can be made here and now: with one, the same take-over goes through.
  if (outcome.kind === "waiting" && outcome.needs === "link") {
    const github = app(client);
    console.log("Your GitHub account is not linked yet, so this ticket stays local for now.");
    const tokens = await links.authorized(github, await startDevice(client, links, github));
    client.store.delete(KV.links.device);
    const view = await links.link(actor(), tokens);
    console.log(`Linked as @${view.login}.`);
    outcome = takeOverTicket(client, ticket, trigger, client.settings());
    // The retry's refusal is about the repository, not permissions, when the link it just made serves none this work can
    // use: linking again would change nothing, and the install step the link printout named is the next thing to do.
    if (outcome.kind === "refused" && outcome.reason === "cannot-write") {
      if (!view.repos.length) {
        console.log(`The app is not installed on a repository you can push to: install it at ${installUrl(github)}, then run swarm superagent repo.`);
        return;
      }
      const watching = watchedRepository(client.settings());
      if (!view.repos.some((repo) => sameName(repo, watching))) {
        console.log(`The app is not installed on ${watching}, where this ticket's patch opens its pull request: install it there at ${installUrl(github)}, then run swarm superagent repo.`);
        return;
      }
    }
  }
  if (outcome.kind === "taken") {
    console.log(`Ticket ${outcome.ticketId.slice(0, 8)} takes over ticket ${ticket.id.slice(0, 8)}: it applies the patch and opens a pull request.`);
    return;
  }
  if (outcome.kind === "waiting") {
    wantPullRequest(client, ticket, trigger);
    const view = client.store.get(KV.links.github("local", localOperator()));
    console.log(`I'll open the pull request as @${view?.login ?? "you"} once ticket ${ticket.id.slice(0, 8)} reports ready.`);
    return;
  }
  throw new Error(refusal(client, outcome.reason, ticket, client.store.get(KV.links.github("local", localOperator()))?.login, outcome.taker));
}
