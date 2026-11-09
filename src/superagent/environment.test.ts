import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { sealedGitConfig, sealedWorkerBin, workerBin, workerEnvironment, workerGitConfig, writeEnvironment } from "./environment.js";
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
  const local = workerEnvironment({ stateDir, github: github as never }, {}, base, "local");
  assert.equal(local.PATH, [sealedWorkerBin(stateDir), "/usr/bin"].join(delimiter));
  assert.equal(local.GIT_CONFIG_GLOBAL, sealedGitConfig(stateDir));
  assert.equal(local[SHELL_PATH_FIRST], sealedWorkerBin(stateDir));
  assert.equal(local.GH_TOKEN, undefined);
  // Without a GitHub account a local worker still gets git without the operator's credentials.
  assert.equal(workerEnvironment({ stateDir }, {}, base, "read-only").GIT_CONFIG_GLOBAL, sealedGitConfig(stateDir));
  assert.equal(workerEnvironment({ stateDir }, {}, base).GIT_CONFIG_GLOBAL, undefined);
});
