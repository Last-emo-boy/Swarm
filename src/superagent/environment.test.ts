import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { requesterGitConfig, requesterWorkerBin, sealedGitConfig, sealedWorkerBin, workerAccounts, workerBin, workerEnvironment, workerGitConfig, writeEnvironment } from "./environment.js";
import { SHELL_PATH_FIRST } from "../tools/shell-path.js";

let stateDir: string;
beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), "swarm-environment-")); });
afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); });
const github = { cli: "/usr/bin/gh", login: "agent", noreply: "1+agent@users.noreply.github.com" };

test("gives a worker whose ticket keeps its work local shims that refuse both accounts, and git without credentials", () => {
  writeEnvironment({ stateDir, github: github as never, feishu: { cli: "/usr/bin/lark-cli" } as never }, ["curl"]);
  assert.match(readFileSync(join(workerBin(stateDir), "gh"), "utf8"), /exec '\/usr\/bin\/gh'/);
  assert.match(readFileSync(join(sealedWorkerBin(stateDir), "gh"), "utf8"), /gh is unavailable: this ticket keeps its work local/);
  assert.match(readFileSync(join(sealedWorkerBin(stateDir), "lark-cli"), "utf8"), /lark-cli is unavailable/);
  assert.match(readFileSync(join(sealedWorkerBin(stateDir), "curl"), "utf8"), /curl is blocked/);
  assert.match(readFileSync(workerGitConfig(stateDir), "utf8"), /auth git-credential/);
  assert.doesNotMatch(readFileSync(sealedGitConfig(stateDir), "utf8"), /git-credential/);

  const base = { PATH: [workerBin(stateDir), "/usr/bin"].join(delimiter), GH_TOKEN: "secret" };
  const open = workerEnvironment({ stateDir, github: github as never }, {}, base);
  assert.equal(open.PATH, [workerBin(stateDir), "/usr/bin"].join(delimiter));
  assert.equal(open.GIT_CONFIG_GLOBAL, workerGitConfig(stateDir));
  assert.equal(open[SHELL_PATH_FIRST], workerBin(stateDir));
  const local = workerEnvironment({ stateDir, github: github as never }, {}, base, "none");
  assert.equal(local.PATH, [sealedWorkerBin(stateDir), "/usr/bin"].join(delimiter));
  assert.equal(local.GIT_CONFIG_GLOBAL, sealedGitConfig(stateDir));
  assert.equal(local[SHELL_PATH_FIRST], sealedWorkerBin(stateDir));
  assert.equal(local.GH_TOKEN, undefined);
  // Without a GitHub account a local worker still gets git without the operator's credentials.
  assert.equal(workerEnvironment({ stateDir }, {}, base, "none").GIT_CONFIG_GLOBAL, sealedGitConfig(stateDir));
  assert.equal(workerEnvironment({ stateDir }, {}, base).GIT_CONFIG_GLOBAL, undefined);
});

test("gives a worker that acts as its requester gh itself, with their token, and git credentials from that token", () => {
  writeEnvironment({ stateDir, github: { ...github, cli: "/opt/agent/gh-agent" } as never, feishu: { cli: "/usr/bin/lark-cli" } as never }, []);
  const gh = readFileSync(join(requesterWorkerBin(stateDir), "gh"), "utf8");
  assert.match(gh, /exec 'gh' "\$@"/);
  assert.doesNotMatch(gh, /gh-agent/);
  assert.match(readFileSync(join(requesterWorkerBin(stateDir), "lark-cli"), "utf8"), /exec '\/usr\/bin\/lark-cli'/);
  assert.match(readFileSync(requesterGitConfig(stateDir), "utf8"), /password=\$GH_TOKEN/);
  const env = workerEnvironment({ stateDir, github: github as never }, { GH_TOKEN: "ghu_requester" }, { PATH: "/usr/bin", GH_TOKEN: "agent" }, "requester");
  assert.equal(env.GH_TOKEN, "ghu_requester");
  assert.equal(env.PATH, [requesterWorkerBin(stateDir), "/usr/bin"].join(delimiter));
  assert.equal(env.GIT_CONFIG_GLOBAL, requesterGitConfig(stateDir));
  assert.equal(workerAccounts(undefined, false), "agent");
  assert.equal(workerAccounts({ role: "everyone", write: "local" }, false), "none");
  assert.equal(workerAccounts({ role: "owner", write: "github" }, false), "agent");
  assert.equal(workerAccounts({ role: "owner", write: "github", credential: { login: "a", id: 1 }, repository: "a/b" }, true), "requester");
  assert.equal(workerAccounts({ role: "owner", write: "github", credential: { login: "a", id: 1 }, repository: "a/b" }, false), "none");
});

test("the requester's git credential helper answers with the token in GH_TOKEN", () => {
  writeEnvironment({ stateDir }, []);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: requesterGitConfig(stateDir), GIT_CONFIG_NOSYSTEM: "1", GH_TOKEN: "ghu_secret" };
  const filled = spawnSync("git", ["credential", "fill"], { env, input: "protocol=https\nhost=github.com\n\n", encoding: "utf8" });
  assert.match(filled.stdout, /username=x-access-token\npassword=ghu_secret/);
});
