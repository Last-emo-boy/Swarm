/** The test guard in env.ts: tests cannot launch the developer's real chat or GitHub CLI by its command name. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  for (const name of ["lark-cli", "lark-bot", "gh"]) {
    const result = await run(name, ["chat", "send", "--message-id", "om_made-up"]);
    assert.equal(result.code, 97, name);
    assert.match(result.stderr, new RegExp(`swarm-test-guard: ${name} is not available in tests`));
  }
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
