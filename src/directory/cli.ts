/**
 * `swarm directory`: who can do what right now, for people and tests. It prints the directory the host wrote while it is
 * fresh, and otherwise builds one in this process, which reads the paired nodes' cards but starts no harness unless
 * `--check` asks for their sign-in checks.
 */
import { existsSync } from "node:fs";
import { freshDirectory, readDirectory, type ReadOptions } from "./read.js";
import type { Directory, PeerEntry } from "./types.js";

const USAGE = `Usage: swarm directory [--json] [--refresh] [--check]

Who can do what right now: this node and its paired nodes, the agent harnesses and where each runs, tool servers,
Sources and providers, and the commands with who may run each.
  --json      The directory as JSON
  --refresh   Build it here even when the host wrote a fresh one
  --check     Also run each harness's sign-in check, which starts the harnesses' own status commands`;

function flag(args: string[], name: string): boolean {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

const workers = (node: { workers?: { free: number; slots: number; queued: number } }): string =>
  node.workers ? `${node.workers.free}/${node.workers.slots} workers free${node.workers.queued ? `, ${node.workers.queued} queued` : ""}` : "workers unknown";
const grant = (value: PeerEntry["grant"]["given"] | "unknown"): string => typeof value === "string" ? value : `scopes: ${value.scopes.join(", ")}`;

/** The directory as lines for people. */
export function directoryText(dir: Directory): string {
  const here = dir.here;
  const lines = [`This node: ${here.name} (host ${here.host}), ${workers(here)}, ${here.takesWork ? "takes work" : "takes no work"}`
    + `${here.machine.length ? `; ${here.machine.join(", ")}` : ""}${here.lends ? `; lends ${here.lends.tools.join(", ")}` : ""}`];
  lines.push(dir.peers.length ? "Paired nodes:" : "Paired nodes: none");
  for (const peer of dir.peers) {
    lines.push(peer.online
      ? `  ${peer.name}: online, ${workers(peer)}, ${peer.takesWork ? "takes work" : "takes no work"}; ${peer.machine.join(", ")}; you give ${grant(peer.grant.given)}, it gives you ${grant(peer.grant.received)}`
        + `${peer.mayThere.length ? ` (${peer.mayThere.join(", ")})` : ""}${peer.lends ? `; lends ${peer.lends.tools.join(", ")}` : ""}${peer.mismatch ? `; ${peer.mismatch}` : ""}`
      : `  ${peer.name}: offline${peer.error ? `: ${peer.error}` : ""}`);
  }
  lines.push("Harnesses:");
  for (const harness of dir.harnesses) {
    lines.push(`  ${harness.id}${harness.isDefault ? " (default)" : ""}: ${harness.runsOn.length ? `runs on ${harness.runsOn.join(", ")}` : "runs on no node"}${harness.readOnly ? "" : "; no read-only turns"}`);
    for (const problem of harness.problems) lines.push(`    ${problem.node}: ${problem.problem}`);
  }
  if (dir.tools.length) {
    lines.push("Tool servers:");
    for (const tool of dir.tools) lines.push(`  ${tool.kind} ${tool.id}${tool.via ? ` from ${tool.via}` : ""}: ${tool.status}, ${tool.tools} tools${tool.lastError ? `; ${tool.lastError}` : ""}`);
  }
  if (dir.sources.length) {
    lines.push("Sources and providers:");
    for (const source of dir.sources) lines.push(`  ${source.name}: ${source.state}${source.detail ? `, ${source.detail}` : ""}`);
  }
  lines.push("Commands:");
  for (const command of dir.commands) lines.push(`  ${command.how.padEnd(48)} ${command.effect.padEnd(5)} ${command.who.join(", ")}: ${command.about}`);
  for (const item of dir.stale) lines.push(`Stale ${item.section}: ${item.why}`);
  return lines.join("\n");
}

export interface DirectoryCommandOptions extends ReadOptions {
  /** Where the answer goes; the terminal by default. */
  print?: (text: string) => void;
}

export async function runDirectoryCommand(input: string[], options: DirectoryCommandOptions = {}): Promise<void> {
  const args = [...input];
  const print = options.print ?? ((text: string) => console.log(text));
  if (flag(args, "help") || args[0] === "help") { print(USAGE); return; }
  const json = flag(args, "json");
  const refresh = flag(args, "refresh");
  const signIn = flag(args, "check");
  if (args.length) throw new Error(`Unknown argument ${args[0]}\n\n${USAGE}`);
  const { superagentStateDir } = await import("../superagent/settings.js");
  const stateDir = options.stateDir ?? superagentStateDir();
  let written: Directory | undefined;
  if (!refresh && !signIn && existsSync(stateDir)) {
    const { SuperagentClient } = await import("../superagent/client.js");
    const client = new SuperagentClient({ stateDir });
    try { written = freshDirectory(client.store, (options.now?.() ?? new Date()).getTime()); } finally { client.close(); }
  }
  const dir = written ?? await readDirectory({ ...options, stateDir, signIn });
  print(json ? JSON.stringify(dir, null, 2) : directoryText(dir));
}
