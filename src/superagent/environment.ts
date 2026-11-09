/**
 * Worker process environment: CLI shims that bind `gh` and `lark-cli` to the agent's accounts and block disallowed
 * commands, and an isolated git configuration (from dsh-superagent's infra/environment.ts). A ticket whose capability keeps
 * its work local or read-only gets shims that refuse both accounts and a git configuration without credentials. These are
 * defaults, not an OS-level security boundary: workers run under the operator's OS user and can still run programs by
 * absolute path.
 */
import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { SHELL_PATH_FIRST } from "../tools/shell-path.js";
import type { Capability, WriteLevel } from "./core/index.js";
import { WORKER_COMMANDS } from "./settings.js";
import { SetupError, type Deployment } from "./setup.js";

const exec = promisify(execFile);
const MARKER = "# Written by the Swarm superagent on every start; edits are lost.";
export const workerBin = (stateDir: string): string => join(stateDir, "worker-bin");
export const workerGitConfig = (stateDir: string): string => join(stateDir, "worker-gitconfig");
/** The shims and git configuration of a worker whose ticket may not use the agent's accounts: see `sealed`. */
export const sealedWorkerBin = (stateDir: string): string => join(stateDir, "worker-bin-local");
export const sealedGitConfig = (stateDir: string): string => join(stateDir, "worker-gitconfig-local");
/** The shims and git configuration of a worker that writes to GitHub as its requester, with their token in GH_TOKEN. */
export const requesterWorkerBin = (stateDir: string): string => join(stateDir, "worker-bin-requester");
export const requesterGitConfig = (stateDir: string): string => join(stateDir, "worker-gitconfig-requester");
/** Whether a ticket's work may not use the agent's GitHub and Feishu accounts: it keeps its change local, or only reads. */
export const sealed = (write: WriteLevel | undefined): boolean => write === "local" || write === "read-only";
/**
 * Whose accounts a worker's shims and git use: the agent's; none, for a ticket that keeps its work local or only reads; or
 * its requester's, whose GitHub token the host gives the worker in GH_TOKEN.
 */
export type WorkerAccounts = "agent" | "none" | "requester";
/**
 * The accounts of a worker for its ticket's capability: the agent's without one (or for GitHub work accepted before links),
 * its requester's for GitHub work when the host has their token, and none otherwise.
 */
export function workerAccounts(capability: Capability | undefined, token: boolean): WorkerAccounts {
  if (!capability) return "agent";
  if (capability.write !== "github") return "none";
  if (!capability.credential) return "agent";
  return token ? "requester" : "none";
}
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const gitQuote = (value: string): string => `"${value.replace(/[\\"]/g, (char) => `\\${char}`)}"`;
export const credentialHelper = (cli: string): string => `!${shellQuote(cli)} auth git-credential`;

export function withoutDirectory(path: string, dir: string): string {
  return path.split(delimiter).filter((entry) => entry !== dir).join(delimiter);
}

/**
 * The variables that tell git which repository, work tree and index to act on. A host started inside git, such as by
 * `git rebase --exec`, passes them on, and a git started below it would act on that repository.
 */
export const GIT_LOCATION: readonly string[] = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE"];

/**
 * Overrides for a worker's environment: no ambient GitHub tokens, no repository named by the host's environment, no
 * interactive prompts and, with a GitHub account, the isolated git configuration whose credential helper is the agent's CLI.
 */
export function agentVariables(deployment: Pick<Deployment, "stateDir" | "github">, accounts: WorkerAccounts = "agent"): Record<string, string | undefined> {
  const config = { agent: workerGitConfig, none: sealedGitConfig, requester: requesterGitConfig }[accounts](deployment.stateDir);
  return {
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    // The host service's credentials, such as the key that seals linked GitHub tokens, are not the worker's.
    CREDENTIALS_DIRECTORY: undefined,
    ...Object.fromEntries(GIT_LOCATION.map((name) => [name, undefined])),
    ...(deployment.github || accounts !== "agent" ? {
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: undefined,
      GIT_CONFIG_PARAMETERS: undefined,
      GIT_AUTHOR_NAME: undefined,
      GIT_COMMITTER_NAME: undefined,
      GIT_AUTHOR_EMAIL: undefined,
      GIT_COMMITTER_EMAIL: undefined
    } : {}),
    GIT_ASKPASS: "",
    SSH_ASKPASS: undefined,
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1"
  };
}

/**
 * The environment of a worker process: `base` with the agent overrides, the shim directory of its `accounts` first on PATH,
 * and `extra`, which carries the requester's token for a worker that acts as them.
 */
export function workerEnvironment(deployment: Pick<Deployment, "stateDir" | "github">, extra: Record<string, string>,
  base: NodeJS.ProcessEnv = process.env, accounts: WorkerAccounts = "agent"): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const [name, value] of Object.entries(agentVariables(deployment, accounts))) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  const bins = shimDirectories(deployment.stateDir);
  const rest = Object.values(bins).reduce((path, dir) => withoutDirectory(path, dir), base.PATH ?? "");
  const bin = bins[accounts];
  env.PATH = [bin, rest].join(delimiter);
  // The login shells of the worker's tools rebuild PATH from their profile; this keeps the shims first there too.
  env[SHELL_PATH_FIRST] = bin;
  return { ...env, ...extra };
}

const shimDirectories = (stateDir: string): Record<WorkerAccounts, string> =>
  ({ agent: workerBin(stateDir), none: sealedWorkerBin(stateDir), requester: requesterWorkerBin(stateDir) });

/** True when a regular file starts with the marker in its first two lines; links and directories never count. */
function written(file: string): boolean {
  if (!lstatSync(file).isFile()) return false;
  return readFileSync(file, "utf8").split("\n", 2).includes(MARKER);
}
function own(file: string, text: string, mode = 0o644): void {
  let foreign = false;
  try { foreign = !written(file); } catch { /* The file does not exist yet. */ }
  if (foreign) throw new SetupError("foreignFile", { file });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode });
  renameSync(temporary, file);
}

/** Atomically writes the shims `bodies` names into `dir`, and removes the ones it wrote before that `bodies` no longer names. */
function writeShims(dir: string, bodies: ReadonlyMap<string, string>): void {
  mkdirSync(dir, { recursive: true });
  const before = readdirSync(dir).filter((name) => !name.startsWith("."));
  for (const name of before) {
    const file = join(dir, name);
    if (!written(file)) throw new SetupError("foreignFile", { file });
  }
  for (const [name, body] of bodies) {
    const temporary = join(dir, `.${name}.${process.pid}.tmp`);
    writeFileSync(temporary, `#!/bin/sh\n${MARKER}\n${body}\n`, { mode: 0o755 });
    renameSync(temporary, join(dir, name));
  }
  for (const name of before) if (!bodies.has(name)) unlinkSync(join(dir, name));
}

/**
 * Atomically writes the worker CLI shims, those of sealed workers, their git configuration and, with a GitHub account, the
 * isolated git configuration into the state directory, refusing to overwrite files it did not write. Each shim strips the
 * shim directories from PATH before exec, so a wrapper script that resolves `gh` or `lark-cli` by name reaches the real binary.
 */
export function writeEnvironment(deployment: Pick<Deployment, "stateDir" | "github" | "feishu">, blockedCommands: readonly string[]): void {
  const { stateDir, github, feishu } = deployment;
  const shims = new Map<string, string>();
  const shim = (name: string, body: string): void => { shims.set(name, body); };
  const dirs = Object.values(shimDirectories(stateDir));
  const withoutShims = [
    `shims=${shellQuote(`:${dirs.join(":")}:`)}`, "rest=", "IFS=:", "set -f",
    "for entry in $PATH; do case $shims in *\":$entry:\"*) ;; *) rest=\"${rest:+$rest:}$entry\" ;; esac; done",
    "set +f", "unset IFS", "PATH=$rest", "export PATH"
  ].join("\n");
  const run = (program: string): string => `${withoutShims}\nexec ${shellQuote(program)} "$@"`;
  const fail = (message: string): string => `echo ${shellQuote(message)} >&2\nexit 1`;
  if (github) shim("gh", run(github.cli));
  shim("lark-cli", feishu ? run(feishu.cli) : fail("lark-cli is unavailable: this installation has no Feishu bot."));
  const instead = github ? `; use gh, which acts as ${github.login}` : "";
  const blocked = [...new Set(blockedCommands.filter((name) => !WORKER_COMMANDS.includes(name)))];
  for (const name of blocked) shim(name, fail(`${name} is blocked in this installation${instead}.`));
  writeShims(workerBin(stateDir), shims);
  // A sealed worker reads GitHub and Feishu through its ticket tools, which the host serves under the accounts.
  const reads = "Read GitHub and Feishu with the ticket tools' read (github/... and feishu/... resources) instead.";
  writeShims(sealedWorkerBin(stateDir), new Map([
    ["gh", fail(`gh is unavailable: this ticket keeps its work local and has no GitHub account. ${reads}`)],
    ["lark-cli", fail(`lark-cli is unavailable: this ticket keeps its work local and has no Feishu account. ${reads}`)],
    ...blocked.map((name) => [name, fail(`${name} is blocked in this installation.`)] as const)
  ]));
  // A worker that acts as its requester runs gh itself, which takes their token from GH_TOKEN, never the agent's wrapper.
  writeShims(requesterWorkerBin(stateDir), new Map([
    ["gh", run("gh")],
    ...[...shims].filter(([name]) => name !== "gh")
  ]));
  const config = (helper: string[]) => [
    MARKER,
    // git refuses to commit without an identity the worker sets, instead of guessing one from the operator's OS user.
    "[user]", "\tuseConfigOnly = true",
    "[credential]", "\thelper =",
    ...helper,
    "[url \"https://github.com/\"]", "\tinsteadOf = git@github.com:", "\tinsteadOf = ssh://git@github.com/",
    // The operator's global gitconfig, which usually holds the Git LFS filters, is not read.
    "[filter \"lfs\"]", "\tclean = git-lfs clean -- %f", "\tsmudge = git-lfs smudge -- %f", "\tprocess = git-lfs filter-process", "\trequired = true"
  ].join("\n") + "\n";
  own(sealedGitConfig(stateDir), config([]));
  own(requesterGitConfig(stateDir), config(["[credential \"https://github.com\"]",
    `\thelper = ${gitQuote('!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$GH_TOKEN"; }; f')}`]));
  if (!github) return;
  own(workerGitConfig(stateDir), config(["[credential \"https://github.com\"]", `\thelper = ${gitQuote(credentialHelper(github.cli))}`]));
}

/** Verifies that a worker's git resolves the agent's GitHub credential helper from the isolated configuration. */
export async function verifyEnvironment(deployment: Pick<Deployment, "github" | "stateDir">): Promise<void> {
  const { github, stateDir } = deployment;
  if (!github) return;
  const env = workerEnvironment(deployment, {});
  const output = await exec("git", ["config", "-z", "--show-origin", "--get-all", "credential.https://github.com.helper"],
    { cwd: stateDir, env, timeout: 60_000 }).then((result) => result.stdout, () => "");
  if (output.split("\0").join("\0") !== [`file:${workerGitConfig(stateDir)}`, credentialHelper(github.cli), ""].join("\0")) {
    throw new SetupError("gitTooOld");
  }
}

/**
 * Verifies that a ticket directory's local or worktree git config defines no `credential.*` or `http.*extraheader` keys,
 * which the agent's git would read from the repository's own config and act on.
 */
export async function verifyDirectory(directory: string, env: NodeJS.ProcessEnv): Promise<void> {
  const args = ["config", "-z", "--show-scope", "--get-regexp", "^(credential\\..*|http\\..*extraheader)$"];
  // `git config --get-regexp` exits with code 1 when no keys match, and 128 outside a repository.
  const output = await exec("git", args, { cwd: directory, env, timeout: 60_000 }).then((result) => result.stdout, (error: { code?: unknown }) => {
    if (error.code === 1 || error.code === 128) return "";
    throw error;
  });
  const scoped = output.split("\0");
  const local = scoped.flatMap((scope, index) =>
    index % 2 === 0 && (scope === "local" || scope === "worktree") ? [scoped[index + 1]!.split("\n")[0]!] : []);
  if (local.length) {
    throw new Error(`The git configuration of the repository in ${directory} sets ${local.join(", ")}, which the agent's git would also read; remove them.`);
  }
}
