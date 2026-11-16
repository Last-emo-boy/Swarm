/** The test guard in env.ts: tests cannot launch the developer's real chat or GitHub CLI by its command name. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
/** Runs `program` as a test would, and returns how it ended and what it said. */
const run = (program: string, args: string[] = []) => exec(program, args).then(
  (result) => ({ code: 0, stderr: result.stderr }),
  (error: { code?: number; stderr?: string }) => ({ code: error.code, stderr: error.stderr ?? "" }));

test("runs a guard instead of the real lark-cli or gh when a test calls one by name", async () => {
  // A harmless invocation: were the guard ever gone, this would print a version rather than post for real.
  for (const name of ["lark-cli", "lark-bot", "gh"]) {
    const result = await run(name, ["--version"]);
    assert.equal(result.code, 97, name);
    assert.match(result.stderr, new RegExp(`swarm-test-guard: ${name} is not available in tests`));
  }
});

test("replaces an inherited configuration directory for lark-cli with an empty one", async () => {
  // In a process of its own, as the guard runs once per test process: the variable is set before env.ts loads.
  const script = 'await import(process.argv[1]); console.log(process.env.LARKSUITE_CLI_CONFIG_DIR)';
  const environment = { ...process.env, LARKSUITE_CLI_CONFIG_DIR: "/Users/nobody/.larksuite" };
  const result = await exec(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script, join(import.meta.dirname, "env.ts")],
    { env: environment });
  const config = result.stdout.trim();
  assert.notEqual(config, "/Users/nobody/.larksuite");
  assert.equal(existsSync(config), true, "an empty directory of its own");
  assert.deepEqual(readdirSync(config), []);
});

test("still runs a fake CLI a test writes and names by path", async () => {
  const directory = mkdtempSync(join(tmpdir(), "swarm-test-fake-"));
  try {
    const fake = join(directory, "lark-cli");
    writeFileSync(fake, "#!/bin/sh\necho '{\"ok\": true, \"data\": {}}'\n", { mode: 0o755 });
    const result = await run(fake, ["auth", "status"]);
    assert.deepEqual(result, { code: 0, stderr: "" });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
