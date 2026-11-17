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
}

export const COMMAND_TABLE = [
  { name: "help", router: true, tui: true },
  { name: "me", router: true, tui: false },
  { name: "link", router: true, tui: false },
  { name: "unlink", router: false, tui: false },
  { name: "repo", router: true, tui: false },
  { name: "role", router: false, tui: false },
  { name: "ceiling", router: false, tui: false },
  { name: "chatter", router: false, tui: false },
  { name: "takeover", router: true, tui: false },
  { name: "devices", router: true, tui: false },
  { name: "memory", router: true, tui: true },
  { name: "forget", router: true, tui: false },
  // State reads: the same store every surface shares, so a question about it is answered the same wherever it is asked.
  { name: "status", router: true, tui: true },
  { name: "tickets", router: true, tui: true },
  { name: "usage", router: true, tui: true },
  { name: "why", router: false, tui: true },
  { name: "mesh", router: false, tui: true }
] as const satisfies readonly CommandSpec[];

/** A command's name, as the table's literal union: a name added to the table is a type error until it is handled. */
export type CommandName = (typeof COMMAND_TABLE)[number]["name"];
export const COMMANDS: readonly CommandName[] = COMMAND_TABLE.map((command) => command.name);
/** The commands the router may run by itself (`AGENT_COMMANDS` in prompts). */
export const ROUTER_COMMANDS: readonly CommandName[] = COMMAND_TABLE.filter((command) => command.router).map((command) => command.name);
/** The commands a terminal hands to the host when its own slash commands have no such name. */
export const FORWARDED: readonly CommandName[] = COMMAND_TABLE.filter((command) => !command.tui).map((command) => command.name);
