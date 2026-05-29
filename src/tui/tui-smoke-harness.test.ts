import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runTuiSmokeHarness } from "./tui-smoke-harness.js";

test("TUI smoke harness captures ANSI screen debug log focus guard and cleanup evidence", async () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), "swarm-tui-smoke-harness-"));
  try {
    const result = await runTuiSmokeHarness({
      out: outputDirectory,
      columns: 100,
      rows: 30,
      createdAt: "2026-05-23T00:00:00.000Z",
      sessionId: "tui-smoke-test"
    });

    assert.equal(result.status, "pass", JSON.stringify(result.checks, null, 2));
    assert(result.stats.truecolorForegroundCount >= 4);
    assert(result.checks.every((check) => check.status === "pass"));
    assert.match(readFileSync(result.files.ansiOutput, "utf8"), /\u001B\[[^m]*38;2;224;151;88m/);
    assert.match(readFileSync(result.files.plainScreen, "utf8"), /Ask Swarm|Reply to selected case|Reply to selected task|tui smoke input|❯/);
    assert.doesNotMatch(readFileSync(result.files.plainScreen, "utf8"), /COMMAND OUTPUT/);
    assert.match(readFileSync(result.files.debugLog, "utf8"), /"section":"tui-exit"/);
    assert.match(readFileSync(result.files.checklist, "utf8"), /Swarm TUI Global Smoke V4/);
  } finally {
    await removeTempDirectory(outputDirectory);
  }
});

async function removeTempDirectory(path: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}
