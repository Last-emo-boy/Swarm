import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { UpdateRefused, checkUpdate, otherInstall, runCommand, swarmCommit, swarmRoot, update, type Run } from "./update.js";

// Commits here are the test's own: no signing, hooks or templates from the developer's git config.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Swarm Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Swarm Test", GIT_COMMITTER_EMAIL: "test@example.com"
});

const root = mkdtempSync(join(tmpdir(), "swarm-update-"));
after(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const manifest = (version: string): string => `${JSON.stringify({ name: "agent-swarm-cli", version, scripts: { build: "true" } }, null, 2)}\n`;

let count = 0;
/** A bare remote, a developer's clone that pushes to it, and an install cloned from it at version 0.1.0. */
function clones(): { remote: string; dev: string; install: string; push: (version: string) => string } {
  const base = join(root, String(++count));
  mkdirSync(base);
  const remote = join(base, "remote.git");
  git(base, "init", "--quiet", "--bare", "-b", "main", remote);
  const dev = join(base, "dev");
  git(base, "clone", "--quiet", remote, dev);
  const push = (version: string): string => {
    writeFileSync(join(dev, "package.json"), manifest(version));
    git(dev, "add", "package.json");
    git(dev, "commit", "--quiet", "-m", `version ${version}`);
    git(dev, "push", "--quiet", "origin", "HEAD:main");
    return git(dev, "rev-parse", "--short", "HEAD");
  };
  push("0.1.0");
  const install = join(base, "install");
  git(base, "clone", "--quiet", remote, install);
  return { remote, dev, install, push };
}

/** Runs git for real and records npm, which only says it worked. */
function recording(): { run: Run; npm: string[] } {
  const npm: string[] = [];
  return {
    npm,
    run: async (command, args, cwd) => {
      if (command !== "npm") return runCommand(command, args, cwd);
      npm.push(`${args.join(" ")} in ${cwd}`);
      return { code: 0, stdout: "", stderr: "" };
    }
  };
}

test("a clone behind the branch it tracks pulls, installs, builds and reports the old and new version and commit", async () => {
  const { install, push } = clones();
  const before = git(install, "rev-parse", "--short", "HEAD");
  const newer = push("0.2.0");

  const check = await checkUpdate(install);
  assert.deepEqual({ ...check, root: undefined }, { root: undefined, branch: "main", upstream: "origin/main", version: "0.1.0", commit: before, behind: 1, ahead: 0, changed: [] });
  assert.equal(git(install, "rev-parse", "--short", "HEAD"), before, "checking changes nothing");

  const { run, npm } = recording();
  const lines: string[] = [];
  const result = await update(install, { run, log: (line) => lines.push(line) });
  assert.deepEqual(result.to, { version: "0.2.0", commit: newer });
  assert.equal(result.check.commit, before);
  assert.deepEqual(npm, [`install in ${install}`, `run build in ${install}`]);
  assert.match(lines.join("\n"), /Pulling 1 new commit from origin\/main \(git pull --ff-only\)/);

  const again = recording();
  assert.equal((await update(install, { run: again.run })).to, undefined, "up to date: nothing to do");
  assert.deepEqual(again.npm, []);
});

test("update refuses a clone with uncommitted changes, and --check says so", async () => {
  const { install, push } = clones();
  push("0.2.0");
  writeFileSync(join(install, "package.json"), manifest("0.1.0-local"));
  writeFileSync(join(install, "notes.txt"), "untracked files are left alone\n");
  assert.deepEqual((await checkUpdate(install)).changed, ["package.json"]);
  const { run, npm } = recording();
  await assert.rejects(update(install, { run }), (error: Error) => error instanceof UpdateRefused && /has uncommitted changes in package\.json\. Commit or stash them/.test(error.message));
  assert.deepEqual(npm, []);
});

test("update refuses a clone on a branch that tracks no remote, a detached HEAD, and commits of its own", async () => {
  const { install, push } = clones();
  git(install, "switch", "--quiet", "-c", "experiment");
  await assert.rejects(checkUpdate(install), (error: Error) => error instanceof UpdateRefused
    && /is on branch experiment, which tracks no remote branch[\s\S]*git -C .* switch main/.test(error.message));

  git(install, "switch", "--quiet", "--detach", "main");
  await assert.rejects(checkUpdate(install), /is not on a branch \(HEAD is detached at/);

  git(install, "switch", "--quiet", "main");
  writeFileSync(join(install, "local.txt"), "mine\n");
  git(install, "add", "local.txt");
  git(install, "commit", "--quiet", "-m", "local work");
  push("0.2.0");
  const { run, npm } = recording();
  await assert.rejects(update(install, { run }), /has 1 commit that origin\/main lacks, so it cannot fast-forward to the 1 new one there/);
  assert.deepEqual(npm, []);
});

test("a failed build is reported with its output", async () => {
  const { install, push } = clones();
  push("0.2.0");
  const failing: Run = async (command, args, cwd) => command === "npm" && args[0] === "run"
    ? { code: 2, stdout: "", stderr: "error TS2304: Cannot find name 'x'." } : command === "npm" ? { code: 0, stdout: "", stderr: "" } : runCommand(command, args, cwd);
  await assert.rejects(update(install, { run: failing }), /npm run build failed in [\s\S]*TS2304/);
});

test("an install that is no git checkout is named with what to run instead", async () => {
  const copied = join(root, "lib", "node_modules", "agent-swarm-cli");
  mkdirSync(copied, { recursive: true });
  writeFileSync(join(copied, "package.json"), manifest("0.1.0"));
  await assert.rejects(checkUpdate(copied), (error: Error) => error instanceof UpdateRefused && error.message === otherInstall(copied));
  assert.match(otherInstall(copied, false), /installed as a copied npm package[\s\S]*git clone https:\/\/github.com\/Last-emo-boy\/Swarm/);
  assert.match(otherInstall(join(root, "elsewhere"), false), /is not a git checkout/);
  assert.match(otherInstall("/app", true), /inside a container[\s\S]*rebuild the image/);
});

test("this install's commit is its checkout's HEAD", () => {
  let head: string | undefined;
  try { head = git(swarmRoot(), "rev-parse", "--short", "HEAD"); } catch { head = undefined; }
  assert.equal(swarmCommit(), head);
});
