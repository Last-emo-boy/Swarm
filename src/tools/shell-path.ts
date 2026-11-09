/**
 * Directories a Swarm process keeps first on PATH in the login shells its tools run commands in, such as a ticket worker's
 * shims: a login shell's profile rebuilds PATH, which moves them last on macOS (path_helper) and drops them on Debian
 * (/etc/profile), so the command a tool runs puts them back first.
 */
import { basename } from "node:path";

/** The variable naming those directories, separated as on PATH. */
export const SHELL_PATH_FIRST = "SWARM_SHELL_PATH_FIRST";
const POSIX_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** `command` as a login `shell` runs it with `env`'s directories first on PATH; unchanged without them or in a shell that is not POSIX. */
export function withPathFirst(command: string, shell: string, env: NodeJS.ProcessEnv = process.env): string {
  const first = env[SHELL_PATH_FIRST];
  if (!first || !POSIX_SHELLS.has(basename(shell))) return command;
  return `PATH=${quote(first)}:"$PATH"; export PATH\n${command}`;
}
