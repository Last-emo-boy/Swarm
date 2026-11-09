import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SHELL_PATH_FIRST, withPathFirst } from "./shell-path.js";

test("leaves a command alone without directories to keep first, and in a shell that is not POSIX", () => {
  assert.equal(withPathFirst("ls", "/bin/sh", {}), "ls");
  assert.equal(withPathFirst("ls", "/usr/bin/fish", { [SHELL_PATH_FIRST]: "/x" }), "ls");
  assert.equal(withPathFirst("ls", "/bin/zsh", { [SHELL_PATH_FIRST]: "/x'y" }), "PATH='/x'\\''y':\"$PATH\"; export PATH\nls");
});

test("keeps the directories first in a login shell whose profile rebuilds PATH", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-shell-path-"));
  try {
    writeFileSync(join(dir, "ls"), "#!/bin/sh\necho shim\n");
    chmodSync(join(dir, "ls"), 0o755);
    const env = { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, [SHELL_PATH_FIRST]: dir };
    const run = (command: string) => spawnSync("/bin/sh", ["-lc", command], { env, encoding: "utf8" }).stdout.trim();
    assert.equal(run(withPathFirst("ls", "/bin/sh", env)), "shim");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
