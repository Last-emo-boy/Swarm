/**
 * Worker process environment: CLI shims that bind `gh` and `lark-cli` to the agent's accounts and block disallowed
 * commands, and an isolated git configuration (from dsh-superagent's infra/environment.ts). These are defaults, not an
 * OS-level security boundary: workers run under the operator's OS user and can still run programs by absolute path.
 */
import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { WORKER_COMMANDS } from "./settings.js";
import { SetupError, type Deployment } from "./setup.js";

const exec = promisify(execFile);
const MARKER = "# Written by the Swarm superagent on every start; edits are lost.";
export const workerBin = (stateDir: string): string => join(stateDir, "worker-bin");
export const workerGitConfig = (stateDir: string): string => join(stateDir, "worker-gitconfig");
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
export function agentVariables(deployment: Pick<Deployment, "stateDir" | "github">): Record<string, string | undefined> {
  return {
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    ...Object.fromEntries(GIT_LOCATION.map((name) => [name, undefined])),
    ...(deployment.github ? {
      GIT_CONFIG_GLOBAL: workerGitConfig(deployment.stateDir),
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

/** The environment of a worker process: `base` with the agent overrides, the shim directory first on PATH, and `extra`. */
export function workerEnvironment(deployment: Pick<Deployment, "stateDir" | "github">, extra: Record<string, string>,
  base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const [name, value] of Object.entries(agentVariables(deployment))) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  const bin = workerBin(deployment.stateDir);
  env.PATH = [bin, withoutDirectory(base.PATH ?? "", bin)].join(delimiter);
  return { ...env, ...extra };
}

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

/**
 * Atomically writes the worker CLI shims and, with a GitHub account, the isolated git configuration into the state
 * directory, refusing to overwrite files it did not write. Each shim strips the shim directory from PATH before exec, so a
 * wrapper script that resolves `gh` or `lark-cli` by name reaches the real binary.
 */
export function writeEnvironment(deployment: Pick<Deployment, "stateDir" | "github" | "feishu">, blockedCommands: readonly string[]): void {
  const { stateDir, github, feishu } = deployment;
  const dir = workerBin(stateDir);
  mkdirSync(dir, { recursive: true });
  const before = readdirSync(dir).filter((name) => !name.startsWith("."));
  for (const name of before) {
    const file = join(dir, name);
    if (!written(file)) throw new SetupError("foreignFile", { file });
  }
  const kept = new Set<string>();
  const shim = (name: string, body: string): void => {
    const temporary = join(dir, `.${name}.${process.pid}.tmp`);
    writeFileSync(temporary, `#!/bin/sh\n${MARKER}\n${body}\n`, { mode: 0o755 });
    renameSync(temporary, join(dir, name));
    kept.add(name);
  };
  const withoutShims = [
    `self=${shellQuote(dir)}`, "rest=", "IFS=:", "set -f",
    "for entry in $PATH; do [ \"$entry\" = \"$self\" ] || rest=\"${rest:+$rest:}$entry\"; done",
    "set +f", "unset IFS", "PATH=$rest", "export PATH"
  ].join("\n");
  const run = (program: string): string => `${withoutShims}\nexec ${shellQuote(program)} "$@"`;
  const fail = (message: string): string => `echo ${shellQuote(message)} >&2\nexit 1`;
  if (github) shim("gh", run(github.cli));
  shim("lark-cli", feishu ? run(feishu.cli) : fail("lark-cli is unavailable: this installation has no Feishu bot."));
  const instead = github ? `; use gh, which acts as ${github.login}` : "";
  for (const name of new Set(blockedCommands.filter((name) => !WORKER_COMMANDS.includes(name)))) {
    shim(name, fail(`${name} is blocked in this installation${instead}.`));
  }
  for (const name of before) if (!kept.has(name)) unlinkSync(join(dir, name));
  if (!github) return;
  own(workerGitConfig(stateDir), [
    MARKER,
    // git refuses to commit without an identity the worker sets, instead of guessing one from the operator's OS user.
    "[user]", "\tuseConfigOnly = true",
    "[credential]", "\thelper =",
    "[credential \"https://github.com\"]", `\thelper = ${gitQuote(credentialHelper(github.cli))}`,
    "[url \"https://github.com/\"]", "\tinsteadOf = git@github.com:", "\tinsteadOf = ssh://git@github.com/",
    // The operator's global gitconfig, which usually holds the Git LFS filters, is not read.
    "[filter \"lfs\"]", "\tclean = git-lfs clean -- %f", "\tsmudge = git-lfs smudge -- %f", "\tprocess = git-lfs filter-process", "\trequired = true"
  ].join("\n") + "\n");
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
