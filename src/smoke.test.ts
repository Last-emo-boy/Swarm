import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { formatInstallSmokeResult, runInstallSmoke } from "./smoke.js";

const removeTempDir = (path: string): void => {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  } catch (error) {
    if (!isWindowsEphemeralCleanupError(error)) {
      throw error;
    }
  }
};

const isWindowsEphemeralCleanupError = (error: unknown): boolean => {
  return process.platform === "win32"
    && error instanceof Error
    && "code" in error
    && ((error as { code?: unknown }).code === "EPERM" || (error as { code?: unknown }).code === "EBUSY");
};

test("install smoke resolves docs from package root instead of caller cwd", async () => {
  const swarmHome = mkdtempSync(join(tmpdir(), "swarm-install-smoke-test-home-"));
  const previousCwd = process.cwd();
  const externalCwd = mkdtempSync(join(tmpdir(), "swarm-install-smoke-test-cwd-"));

  try {
    process.chdir(externalCwd);
    const result = await runInstallSmoke({ swarmHome });
    assert.equal(result.status, "pass");
    assert.notEqual(result.package_root, externalCwd);
    assert(result.checks.some((check) => check.id === "docs-links" && check.status === "pass"));
    assert.doesNotMatch(formatInstallSmokeResult(result), /sk-[A-Za-z0-9]/);
  } finally {
    process.chdir(previousCwd);
    removeTempDir(swarmHome);
    removeTempDir(externalCwd);
  }
});

test("swarm smoke CLI emits machine-readable global install smoke result", () => {
  const swarmHome = mkdtempSync(join(tmpdir(), "swarm-smoke-cli-home-"));
  try {
    const result = spawnSync(process.execPath, [
      "--import",
      "tsx",
      "src/index.ts",
      "smoke",
      "--swarm-home",
      swarmHome,
      "--json"
    ], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout) as { schema_version?: string; status?: string; checks?: Array<{ id?: string; status?: string }> };
    assert.equal(parsed.schema_version, "swarm.install_smoke.v1");
    assert.equal(parsed.status, "pass");
    assert(parsed.checks?.some((check) => check.id === "default-renderer" && check.status === "pass"));
    assert(parsed.checks?.some((check) => check.id === "skills-default-catalog" && check.status === "pass"));
  } finally {
    removeTempDir(swarmHome);
  }
});
