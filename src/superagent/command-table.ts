/**
 * The one bot command table: every surface that can send the agent a message reads its commands here. A `mesh` peer, a
 * Feishu chat, the terminal's own chat and the TUI's `/chat` differ only in how a trigger reaches the host; the commands
 * themselves are this list, so a command added once is reachable from every surface that is paired, and none of them can
 * drift from the prompts or the forwarded names.
 */
export interface CommandSpec {
  name: string;
  /** The router may run it for a person whose message asks for what it does, in their own words. */
  router: boolean;
  /** The terminal keeps its own command of this name and does not forward it to the host. */
  tui: boolean;
  /** Whether it changes anything: a read only answers, a write changes a link, a setting or what the agent keeps. */
  effect: "read" | "write";
  /** What it does, in one line addressed to the router about the person who sends it; prompts and the directory share it. */
  about: string;
}

export const COMMAND_TABLE = [
  { name: "help", router: true, tui: true, effect: "read", about: "what the agent and its commands do" },
  { name: "me", router: true, tui: false, effect: "read", about: "their role, limits and GitHub account" },
  { name: "link", router: true, tui: false, effect: "write", about: "link their GitHub account (the code goes to a direct message)" },
  { name: "unlink", router: false, tui: false, effect: "write", about: "remove their GitHub link" },
  { name: "repo", router: true, tui: false, effect: "write", about: "the repositories they may work on, or with one argument owner/name, set their default" },
  { name: "role", router: false, tui: false, effect: "write", about: "set a person's role to owner, maintainer, everyone or none; for owners" },
  { name: "ceiling", router: false, tui: false, effect: "write", about: "set how far work may write: read-only, local or github; for owners" },
  { name: "chatter", router: false, tui: false, effect: "write", about: "whether the agent joins a group's conversation on its own; for owners" },
  { name: "takeover", router: true, tui: false, effect: "write", about: "with the ticket's id, turn a local ticket's patch into a pull request as them" },
  { name: "devices", router: true, tui: false, effect: "read", about: "the list of what the agent runs work on now, for someone who asks for that list" },
  { name: "memory", router: true, tui: true, effect: "read", about: "what you remember about them, which goes to their direct messages" },
  { name: "forget", router: true, tui: false, effect: "write", about: "with a number from that list, or all, forget it" },
  // State reads: the same store every surface shares, so a question about it is answered the same wherever it is asked.
  { name: "status", router: true, tui: true, effect: "read", about: "whether the agent's host runs, what is not healthy, and how many tickets wait where" },
  { name: "tickets", router: true, tui: true, effect: "read", about: "the open tickets, a page at a time; with a number, that page" },
  { name: "usage", router: true, tui: true, effect: "read", about: "the agent's model calls, tokens and cost today and over the last 30 days" },
  { name: "why", router: false, tui: true, effect: "read", about: "with a ticket's or message's id, how it was routed and what its work did; for maintainers" },
  { name: "mesh", router: false, tui: true, effect: "read", about: "the paired nodes and where each is reached; for maintainers" }
] as const satisfies readonly CommandSpec[];

/** A command's name, as the table's literal union: a name added to the table is a type error until it is handled. */
export type CommandName = (typeof COMMAND_TABLE)[number]["name"];
export const COMMANDS: readonly CommandName[] = COMMAND_TABLE.map((command) => command.name);
/** The commands the router may run by itself (`AGENT_COMMANDS` in prompts). */
export const ROUTER_COMMANDS: readonly CommandName[] = COMMAND_TABLE.filter((command) => command.router).map((command) => command.name);
/** The commands a terminal hands to the host when its own slash commands have no such name. */
export const FORWARDED: readonly CommandName[] = COMMAND_TABLE.filter((command) => !command.tui).map((command) => command.name);
