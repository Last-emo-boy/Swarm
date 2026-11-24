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
 * path `swarm` is called by, quoted or not (`"swarm"`, `sw''arm`), after an env prefix or `npx`, or after `;`, `&&`, `|`,
 * `(` or a backtick. A line that only mentions one inside a quoted argument, such as `grep -n "swarm mesh grant" docs`,
 * runs none, unless something in the line runs text: then the quoted string is read as a command line too.
 */
export function personCommandIn(command: string): (typeof PERSON_COMMANDS)[number] | undefined {
  return personCommandRun(command, false);
}

/** A word as the shell passes it on, quotes and escapes removed; `spaced` when quoted spaces make it one string of several words. */
type Word = { text: string; spaced: boolean };

/** Programs that run text they are given as a command line or as code: `bash -e -c '...'`, `eval "..."`, `... | sh`, `python3 -c`. */
const RUNS_TEXT = /^(?:sh|bash|zsh|dash|ksh|fish|python[\d.]*|node|perl|ruby|deno|bun|eval|exec|xargs|source|su|ssh|watch)$/;

function personCommandRun(line: string, runs: boolean): (typeof PERSON_COMMANDS)[number] | undefined {
  const commands = commandsIn(line);
  // Where flags, a path or a prefix (env, timeout, nohup, sudo) put the launcher does not matter. Text that runs may run its own
  // quoted strings (`os.system('...')`), so inside it every one is read as a command line. `.` runs a file only as a command.
  runs ||= commands.some((words) => words.some((word, index) => RUNS_TEXT.test(baseName(word.text)) || (index === 0 && word.text === ".")));
  for (const words of commands) {
    for (const [index, word] of words.entries()) {
      const found = word.spaced
        ? runs ? personCommandRun(word.text, true) : undefined
        : baseName(word.text) === "swarm" ? personCommandAfter(words.slice(index + 1)) : undefined;
      if (found) return found;
    }
  }
  return undefined;
}

function personCommandAfter(rest: Word[]): (typeof PERSON_COMMANDS)[number] | undefined {
  const [first, second, third] = rest.filter((word) => !word.text.startsWith("-")).map((word) => word.text);
  // `swarm superagent harness ...` is `swarm harness ...`: superagent/cli.ts hands it to the same command.
  const [dispatcher, subcommand] = first === "superagent" && second === "harness" ? [second, third] : [first, second];
  return dispatcher && subcommand ? PERSON_SUBCOMMANDS.get(dispatcher)?.get(subcommand) : undefined;
}

function baseName(path: string): string {
  return path.split("/").pop()!;
}

/** The commands of a line, split where the shell starts another (`;`, `&`, `|`, `(`, `)`, a backtick, `$(`, a new line), as words. */
function commandsIn(line: string): Word[][] {
  const commands: Word[][] = [[]];
  let word: Word | undefined;
  let quote: string | undefined;
  const add = (text: string, spaced = false) => {
    word ??= { text: "", spaced: false };
    word.text += text;
    word.spaced ||= spaced;
  };
  const end = () => {
    if (word) commands.at(-1)!.push(word);
    word = undefined;
  };
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    const next = line[index + 1] ?? "";
    if (quote) {
      if (char === quote) quote = undefined;
      else if (quote === "\"" && char === "\\" && next && "\"\\$`\n".includes(next)) {
        add(next);
        index += 1;
      } else add(char, /\s/.test(char));
    } else if (char === "'" || char === "\"") {
      quote = char;
      add("");
    } else if (char === "\\") {
      if (next !== "\n") add(next);
      index += 1;
    } else if (/[;&|()`\n]/.test(char) || (char === "$" && next === "(")) {
      end();
      commands.push([]);
      if (char === "$") index += 1;
    } else if (/\s/.test(char)) end();
    else add(char);
  }
  end();
  return commands;
}
