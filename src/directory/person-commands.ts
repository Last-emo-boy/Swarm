/**
 * The command lines that stay with people: pairing, grants, lending, placement, pausing, settings and sign-in keys. The
 * directory lists them with `who: ["person"]` so an agent can tell a person what to run, and the permission check refuses
 * any shell command that runs one (`personCommandIn`), in every mode, so no agent runs them. Kept free of heavy imports,
 * since the permission check loads it.
 */
import type { CommandEntry } from "./types.js";

/** Each names its dispatcher, which the tests check, so a renamed command cannot leave a stale line here. */
export const PERSON_COMMANDS: readonly (Omit<CommandEntry, "who"> & { dispatcher: "mesh" | "superagent" | "harness" | "auth"; subcommand: string })[] = [
  { name: "mesh invite", dispatcher: "mesh", subcommand: "invite", effect: "write", how: "swarm mesh invite", about: "pair another device: prints a code it joins with" },
  { name: "mesh join", dispatcher: "mesh", subcommand: "join", effect: "write", how: "swarm mesh join <code>", about: "join the swarm of the device that printed the code" },
  { name: "mesh remove", dispatcher: "mesh", subcommand: "remove", effect: "write", how: "swarm mesh remove <peer>", about: "remove a device from the swarm; every member forgets it" },
  { name: "mesh grant", dispatcher: "mesh", subcommand: "grant", effect: "write", how: "swarm mesh grant <peer> viewer|member|operator", about: "what a paired node may do on this one" },
  { name: "mesh lend", dispatcher: "mesh", subcommand: "lend", effect: "write", how: "swarm mesh lend shell|files <dir>... (--stop to stop)", about: "lend paired nodes a shell or file access in these folders" },
  { name: "mesh pull", dispatcher: "mesh", subcommand: "pull", effect: "write", how: "swarm mesh pull on|off [--repo <owner/name>...]", about: "whether this node takes paired nodes' waiting work" },
  { name: "mesh offer", dispatcher: "mesh", subcommand: "offer", effect: "write", how: "swarm mesh offer on|off", about: "whether paired nodes that pull may take this node's waiting work" },
  { name: "superagent place", dispatcher: "superagent", subcommand: "place", effect: "write", how: "swarm superagent place <ticket> <node>|here", about: "run a ticket's next worker on a paired node, or here" },
  { name: "superagent pause", dispatcher: "superagent", subcommand: "pause", effect: "write", how: "swarm superagent pause|resume", about: "pause or resume processing: new Evals, launches, deliveries and replies" },
  { name: "superagent config", dispatcher: "superagent", subcommand: "config", effect: "write", how: "swarm superagent config path", about: "the settings file a person edits: roles, Sources, harnesses, isolation" },
  { name: "harness check", dispatcher: "harness", subcommand: "check", effect: "read", how: "swarm harness check [<id>]", about: "whether each harness is installed and signed in here; runs their sign-in checks" },
  { name: "auth set-key", dispatcher: "auth", subcommand: "set-key", effect: "write", how: "swarm auth set-key <provider> <api-key>", about: "set a model provider's key" }
];

/** The subcommands of each dispatcher a person-only line runs: `pause|resume` in `how` is two of them. */
const PERSON_SUBCOMMANDS: ReadonlyMap<string, ReadonlyMap<string, (typeof PERSON_COMMANDS)[number]>> = (() => {
  const byDispatcher = new Map<string, Map<string, (typeof PERSON_COMMANDS)[number]>>();
  for (const command of PERSON_COMMANDS) {
    const words = byDispatcher.get(command.dispatcher) ?? new Map<string, (typeof PERSON_COMMANDS)[number]>();
    for (const word of command.how.split(/\s+/)[2]!.split("|")) words.set(word, command);
    byDispatcher.set(command.dispatcher, words);
  }
  return byDispatcher;
})();

/**
 * The person-only command a shell command line runs, if any: `swarm <dispatcher> <subcommand>` anywhere in it, whatever
 * path `swarm` is called by, after an env prefix or `npx`, or after `;`, `&&`, `|`, `(` or a backtick. A line that only
 * mentions one inside a quoted argument, such as `echo "swarm mesh grant"`, runs none.
 */
export function personCommandIn(command: string): (typeof PERSON_COMMANDS)[number] | undefined {
  const words = command.replace(/[;&|()`\n]|\$\(/g, " ; ").match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  for (let index = 0; index < words.length; index += 1) {
    if (words[index]!.split("/").pop() !== "swarm") continue;
    const rest = words.slice(index + 1).filter((word) => !word.startsWith("-"));
    const end = rest.indexOf(";");
    const [dispatcher, subcommand] = (end < 0 ? rest : rest.slice(0, end)).map((word) => word.replace(/^["']|["']$/g, ""));
    const found = dispatcher && subcommand ? PERSON_SUBCOMMANDS.get(dispatcher)?.get(subcommand) : undefined;
    if (found) return found;
  }
  return undefined;
}
