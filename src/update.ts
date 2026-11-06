/**
 * `swarm update`: brings a clone install up to date. Swarm installs from a git checkout (`npm install -g .` links the
 * global `swarm` to it), so updating is pulling that checkout, installing its dependencies and building it again. Any
 * other install is named, with what to run instead.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = "https://github.com/Last-emo-boy/Swarm";

export interface Ran { code: number; stdout: string; stderr: string }
/** Runs a program in a folder and says how it ended; never throws. Tests pass their own. */
export type Run = (command: string, args: string[], cwd: string) => Promise<Ran>;

export const runCommand: Run = (command, args, cwd) => new Promise((resolve) => {
  execFile(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (!error) return resolve({ code: 0, stdout, stderr });
    const code = typeof error.code === "number" ? error.code : 127;
    resolve({ code, stdout, stderr: stderr || error.message });
  });
});

/** The root of this Swarm install: the folder with its package.json and dist/, and .git in a clone. */
export const swarmRoot = (): string => realpathSync(fileURLToPath(new URL("..", import.meta.url)));

/** A checkout's short HEAD commit, when `root` is the top of a git checkout. */
function checkoutCommit(root: string): string | undefined {
  try {
    const [top, commit] = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel", "--short", "HEAD"],
      { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n");
    return top && realpathSync(top) === realpathSync(root) ? commit : undefined;
  } catch {
    return undefined;
  }
}

let commit: string | undefined | null = null;
/** The commit this install's checkout is at, short, read once per process; undefined when it is no git checkout. */
export function swarmCommit(): string | undefined {
  if (commit === null) commit = checkoutCommit(swarmRoot());
  return commit;
}

const packageVersion = (root: string): string => {
  try {
    return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
};

/** What `swarm update` cannot do here, with what to do instead. */
export class UpdateRefused extends Error {}

/** How Swarm at `root` was installed when it is no git checkout, and how to update it. */
export function otherInstall(root: string, container = existsSync("/.dockerenv")): string {
  const clone = `git clone ${REPOSITORY} && cd Swarm && npm install && npm run build && npm install -g .`;
  if (container) return `Swarm runs from ${root} inside a container, not from a git checkout: rebuild the image from an updated checkout instead.`;
  if (root.split(sep).includes("node_modules")) {
    return `Swarm at ${root} was installed as a copied npm package, not linked to a clone, so there is nothing to pull. Install it from a clone once and swarm update works from then on: ${clone}`;
  }
  return `Swarm at ${root} is not a git checkout, so there is nothing to pull. Install it from a clone once and swarm update works from then on: ${clone}`;
}

export interface UpdateCheck {
  root: string;
  branch: string;
  /** The remote branch it tracks, such as origin/main. */
  upstream: string;
  version: string;
  commit: string;
  /** Commits on the upstream this checkout lacks, and its own commits the upstream lacks. */
  behind: number;
  ahead: number;
  /** Tracked files with uncommitted changes. */
  changed: string[];
}

async function git(run: Run, root: string, ...args: string[]): Promise<Ran> {
  return run("git", args, root);
}

/** Where the checkout at `root` stands against the branch it tracks, after fetching it. */
export async function checkUpdate(root: string, run: Run = runCommand): Promise<UpdateCheck> {
  const top = await git(run, root, "rev-parse", "--show-toplevel");
  if (top.code !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(root)) throw new UpdateRefused(otherInstall(root));
  const head = (await git(run, root, "rev-parse", "--short", "HEAD")).stdout.trim();
  const branch = await git(run, root, "symbolic-ref", "--quiet", "--short", "HEAD");
  if (branch.code !== 0) {
    throw new UpdateRefused(`${root} is not on a branch (HEAD is detached at ${head}), so there is nothing to pull. Switch it to one that tracks a remote, such as main: git -C ${root} switch main`);
  }
  const name = branch.stdout.trim();
  const upstream = await git(run, root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  if (upstream.code !== 0) {
    throw new UpdateRefused(`${root} is on branch ${name}, which tracks no remote branch, so there is nothing to pull. Switch it to one that does, such as main (git -C ${root} switch main), or, if ${name} was pushed, make it track its remote branch (git -C ${root} branch --set-upstream-to origin/${name}).`);
  }
  const tracked = upstream.stdout.trim();
  const fetched = await git(run, root, "fetch", "--quiet");
  if (fetched.code !== 0) throw new Error(`Could not fetch ${tracked} in ${root}: ${fetched.stderr.trim()}`);
  const [ahead = 0, behind = 0] = (await git(run, root, "rev-list", "--left-right", "--count", "HEAD...@{u}")).stdout.trim().split(/\s+/).map(Number);
  const changed = (await git(run, root, "status", "--porcelain", "--untracked-files=no")).stdout.split("\n").filter(Boolean).map((line) => line.slice(3));
  return { root, branch: name, upstream: tracked, version: packageVersion(root), commit: head, behind, ahead, changed };
}

export interface UpdateResult {
  check: UpdateCheck;
  /** Where it moved, when it pulled anything. */
  to?: { version: string; commit: string };
}

/**
 * Pulls the checkout at `root` forward to the branch it tracks (fast-forward only), installs its dependencies and builds
 * it. Refuses a checkout with uncommitted changes or commits of its own, which a fast-forward would not keep.
 */
export async function update(root: string, options: { run?: Run; log?: (line: string) => void } = {}): Promise<UpdateResult> {
  const run = options.run ?? runCommand;
  const log = options.log ?? (() => {});
  const check = await checkUpdate(root, run);
  if (!check.behind) return { check };
  if (check.changed.length) {
    throw new UpdateRefused(`${root} has uncommitted changes in ${check.changed.join(", ")}. Commit or stash them, then run swarm update again.`);
  }
  if (check.ahead) {
    throw new UpdateRefused(`${root} has ${check.ahead} ${check.ahead === 1 ? "commit" : "commits"} that ${check.upstream} lacks, so it cannot fast-forward to the ${check.behind} new ${check.behind === 1 ? "one" : "ones"} there. Rebase or merge them in ${root}, then run swarm update again.`);
  }
  const step = async (what: string, command: string, args: string[]): Promise<void> => {
    log(`${what} (${command} ${args.join(" ")})…`);
    const ran = await run(command, args, root);
    if (ran.code !== 0) {
      const output = `${ran.stderr}\n${ran.stdout}`.trim().split("\n").slice(-20).join("\n");
      throw new Error(`${command} ${args.join(" ")} failed in ${root}:\n${output}`);
    }
  };
  await step(`Pulling ${check.behind} new ${check.behind === 1 ? "commit" : "commits"} from ${check.upstream}`, "git", ["pull", "--ff-only"]);
  await step("Installing dependencies", "npm", ["install"]);
  await step("Building", "npm", ["run", "build"]);
  const commit = (await git(run, root, "rev-parse", "--short", "HEAD")).stdout.trim();
  return { check, to: { version: packageVersion(root), commit } };
}

const UPDATE_USAGE = `Usage: swarm update [--check]

Updates this Swarm when it was installed from a git clone: pulls the branch it tracks (fast-forward only), runs
npm install and npm run build, and restarts the node service when one runs. --check only says whether an update waits.`;

export async function runUpdateCommand(args: string[]): Promise<void> {
  const unknown = args.find((arg) => arg !== "--check");
  if (unknown) {
    console.log(UPDATE_USAGE);
    if (unknown !== "--help" && unknown !== "help") process.exitCode = 1;
    return;
  }
  const root = swarmRoot();
  try {
    if (args.includes("--check")) {
      const check = await checkUpdate(root);
      console.log(check.behind
        ? `An update waits: ${check.behind} new ${check.behind === 1 ? "commit" : "commits"} on ${check.upstream} (this install is Swarm ${check.version} at ${check.commit}). swarm update installs it.`
        : `Up to date with ${check.upstream}: Swarm ${check.version} at ${check.commit}.`);
      if (check.behind && check.changed.length) console.log(`${root} has uncommitted changes in ${check.changed.join(", ")}; swarm update refuses until they are committed or stashed.`);
      if (check.behind && check.ahead) console.log(`${root} also has ${check.ahead} ${check.ahead === 1 ? "commit" : "commits"} of its own, so swarm update cannot fast-forward it.`);
      return;
    }
    const { check, to } = await update(root, { log: (line) => console.log(line) });
    if (!to) {
      console.log(`Already up to date with ${check.upstream}: Swarm ${check.version} at ${check.commit}.`);
      return;
    }
    console.log(`Updated Swarm ${check.version} (${check.commit}) → ${to.version} (${to.commit}): ${check.behind} new ${check.behind === 1 ? "commit" : "commits"} from ${check.upstream}.`);
    const { restartService } = await import("./mesh/service.js");
    const restarted = await restartService();
    if (restarted) console.log(restarted);
  } catch (error) {
    if (!(error instanceof UpdateRefused)) throw error;
    console.error(error.message);
    process.exitCode = 1;
  }
}
