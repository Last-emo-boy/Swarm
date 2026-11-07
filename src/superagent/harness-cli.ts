/**
 * `swarm harness list|check [<id>]` (also `swarm superagent harness`): the agent harness profiles of this machine, which
 * tickets' workers and delegated subagents can run on, each with its kind, command, model, whether it is installed, the
 * variables its keys come from and whether they are set (names only, never values), and with `check` whether it is
 * signed in, which runs each harness's own sign-in status command.
 */
import { harnessIds, harnessStatus, type HarnessStatus } from "./harness.js";
import { readSettings, settingsPath } from "./settings.js";

const USAGE = `Usage: swarm harness <command>

Commands:
  list [--json]            Each harness profile: its kind, command, model, whether it is installed, and its keys
  check [<id>] [--json]    The same, and whether each is signed in: runs each harness's sign-in status command

Profiles live under executor.harnesses in ${settingsPath()}; keys are read from environment variables.`;

/** A profile as lines for people: what it runs, and what stops it, if anything. */
function statusLines(status: HarnessStatus): string[] {
  const keys = status.keys.length
    ? status.keys.map((key) => `${key.name} from ${key.from}${key.present ? "" : " (not set)"}`).join(", ")
    : "none";
  return [
    `${status.id} (${status.label})`,
    `  command:   ${status.command}${status.installed ? "" : " (not installed)"}`,
    `  model:     ${status.model ?? "the harness's default"}`,
    `  keys:      ${keys}`,
    ...(status.signedIn === undefined ? [] : [`  signed in: ${status.signedIn ? "yes" : "no"}`]),
    ...(status.problem ? [`  ! ${status.problem}`] : [])
  ];
}

export async function runHarnessCommand(input: string[]): Promise<void> {
  const args = [...input];
  const command = args.shift();
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }
  if (command !== "list" && command !== "check") throw new Error(`Unknown command: swarm harness ${command}\n\n${USAGE}`);
  const at = args.indexOf("--json");
  const json = at >= 0;
  if (json) args.splice(at, 1);
  const where = settingsPath();
  const configured = readSettings(where).settings.executor.harnesses;
  const id = command === "check" ? args.shift() : undefined;
  const ids = id ? [id] : harnessIds(configured);
  const statuses = await Promise.all(ids.map((each) => harnessStatus(each, configured, where, { signIn: command === "check" })));
  if (json) console.log(JSON.stringify(statuses, null, 2));
  else console.log(statuses.map((status) => statusLines(status).join("\n")).join("\n\n"));
  if (id && statuses[0]?.problem) process.exitCode = 1;
}
