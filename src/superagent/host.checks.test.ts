/** The host's sign-in checks (host.ts, registry.check): each enabled Source's own cheap check runs on a slow tick and its
 * outcome lands on the entry the kind declared, in the health snapshot other Swarm processes read. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { z } from "zod/v4";
import { SuperagentHost } from "./host.js";
import { settingsPath, writeSettings } from "./settings.js";
import type { SourceKind } from "./sources/kind.js";
import { hostStatus } from "./views.js";

/** A kind whose check counts its runs and reports on an entry of its own; it has no watch loop, so nothing polls. */
const counting = (runs: { count: number }, fail = false): SourceKind<Record<string, never>> => ({
  kind: "counting", title: "Counting", enabledByDefault: true,
  schema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  health: ["counting-login"],
  check: { entry: "counting-login", verify: async () => { runs.count += 1; if (fail) throw new Error("signed out"); return "Counting ready" } },
});

let stateDir: string;
let host: SuperagentHost | undefined;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-host-checks-"));
  // Only the local Source and the counting kind: no CLI is configured, so setup has nothing to resolve or probe.
  writeSettings({ sources: {}, policy: { sources: {} } }, settingsPath(stateDir));
});
afterEach(async () => { await host?.stop(); host = undefined; rmSync(stateDir, { recursive: true, force: true }); });

test("a started host runs an enabled kind's check once and the snapshot carries its entry; later passes keep it for a while", async () => {
  const runs = { count: 0 };
  host = new SuperagentHost({ stateDir, workerCommand: [process.execPath, "-e", ""], log: () => {},
    complete: async () => { throw new Error("no model in this test"); }, kinds: [counting(runs)] });
  await host.start();
  assert.equal(runs.count, 1, "the first pass ran the check");
  assert.deepEqual(hostStatus(host.client).health["counting-login"] && { state: hostStatus(host.client).health["counting-login"]!.state,
    detail: hostStatus(host.client).health["counting-login"]!.detail }, { state: "ready", detail: "Counting ready" });
  // The interval gates the next passes: the check is not on every 2-second tick.
  await host.pass();
  await host.pass();
  assert.equal(runs.count, 1);
  // A kind with no watch loop is not "Off": the pass keeps the entry its check wrote instead of overwriting it.
  assert.equal(hostStatus(host.client).health["counting-login"]!.state, "ready");
});

test("a failing check writes its message on the entry, and an off Source is never asked", async () => {
  const runs = { count: 0 };
  host = new SuperagentHost({ stateDir, workerCommand: [process.execPath, "-e", ""], log: () => {},
    complete: async () => { throw new Error("no model in this test"); }, kinds: [counting(runs, true), { ...counting({ count: 0 }), kind: "quiet", enabledByDefault: false,
      health: ["quiet-login"], check: { entry: "quiet-login", verify: async () => { throw new Error("must not run") } } }] });
  await host.start();
  assert.equal(runs.count, 1, "the enabled kind's check ran once");
  const entry = hostStatus(host.client).health["counting-login"]!;
  assert.equal(entry.state, "error");
  assert.equal(entry.detail, "signed out");
  // The off kind's entry says so, and its check wrote nothing over it.
  assert.equal(hostStatus(host.client).health["quiet-login"]?.detail, "Off");
});

test("a setup that failed before a deployment resolved stamps no check, so the next pass asks once one resolves", async () => {
  const runs = { count: 0 };
  const lines: string[] = [];
  const signing = (verify: () => Promise<string>): SourceKind<Record<string, never>> => ({
    kind: "signing", title: "Signing", enabledByDefault: true,
    schema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
    health: ["signing-login"], check: { entry: "signing-login", verify },
  });
  // Setup throws before `this.deployment` is set (the environment cannot be written), so the check has nothing to ask.
  host = new SuperagentHost({ stateDir, workerCommand: [process.execPath, "-e", ""], log: (line) => lines.push(line),
    complete: async () => { throw new Error("no model in this test"); },
    kinds: [signing(async () => { runs.count += 1; return "signing ready" })] });
  // The first three setup attempts fail — start's own, its first pass's, and one more — and the fourth resolves. A stamp
  // taken while none had resolved would hold the check until the five-minute interval, so it must run in that fourth pass.
  const real = (host as unknown as { setup: () => Promise<void> }).setup.bind(host);
  let attempts = 0;
  (host as unknown as { setup: () => Promise<void> }).setup = async () => {
    attempts += 1;
    if (attempts <= 3) throw new Error("no environment");
    await real();
  };
  await host.start();
  for (let pass = 0; pass < 3; pass++) await host.pass();
  assert.equal(runs.count, 1, "the check ran in the pass that resolved the deployment");
  (host as unknown as { setup: () => Promise<void> }).setup = real;
});
