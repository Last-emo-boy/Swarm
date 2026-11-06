import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultSwarmSettings } from "../config/settings.js";
import type { LedgerEntry } from "./ledger.js";
import { parseSince, parseUsageArgs, usageReport, usageText } from "./cli.js";

const now = new Date("2026-11-07T12:00:00.000Z");
const entry = (fields: Partial<LedgerEntry>): LedgerEntry => ({
  id: `usage_${Math.random()}`, at: "2026-11-06T09:00:00.000Z", device: "mac", source: "session", provider: "deepseek", model: "deepseek-v4-flash",
  purpose: "main_coding_loop", input: 1_000_000, cached: 800_000, cacheWrite: 0, output: 100_000, ...fields
});
// Saturday 2026-11-07 is off-peak for DeepSeek: 0.2M × 0.15 + 0.8M × 0.003 + 0.1M × 0.6 = $0.0924 a call.
const entries: LedgerEntry[] = [
  entry({ at: "2026-11-07T08:00:00.000Z" }),
  entry({ at: "2026-11-07T09:00:00.000Z", device: "ovh", source: "ticket", sessionId: "worker-abcdef1234", ticketId: "abcdef1234" }),
  entry({ at: "2026-11-07T10:00:00.000Z", provider: "harness:claude", model: "claude-opus-5-5[1m]", harness: "claude", source: "harness",
    ticketId: "abcdef1234", device: "ovh", input: 4360, cached: 4000, cacheWrite: 350, output: 120, reportedCost: 0.5 }),
  entry({ at: "2026-11-07T11:00:00.000Z", provider: "xai", model: "grok-4", input: 2000, cached: 0, output: 300 })
];

test("--since takes hours, days, a date or a time, and --by one of the groupings", () => {
  assert.equal(parseSince("24h", now).toISOString(), "2026-11-06T12:00:00.000Z");
  assert.equal(parseSince("30d", now).toISOString(), "2026-10-08T12:00:00.000Z");
  assert.equal(parseSince("2026-11-01", now).getTime(), new Date(2026, 10, 1).getTime(), "a date starts at its local midnight");
  assert.throws(() => parseSince("last week", now), /--since takes 24h, 7d, 30d or a date/);
  const options = parseUsageArgs(["--since", "30d", "--by=device", "--all-devices", "--json"], now);
  assert.deepEqual({ ...options, since: options.since.toISOString() },
    { since: "2026-10-08T12:00:00.000Z", sinceLabel: "30d", by: "device", allDevices: true, json: true });
  assert.equal(parseUsageArgs([], now).by, "model");
  assert.throws(() => parseUsageArgs(["--by", "colour"], now), /--by takes model, provider, harness, device, ticket, day/);
  assert.throws(() => parseUsageArgs(["--everything"], now), /Unknown option --everything/);
});

test("swarm usage groups the ledger, prices it, and shows unpriced models' tokens", () => {
  const settings = defaultSwarmSettings();
  const devices = [{ device: "mac", calls: 2 }, { device: "ovh", calls: 2 }];
  const byModel = usageReport(entries, devices, { since: parseSince("7d", now), by: "model" }, settings);
  assert.deepEqual(byModel.rows.map((row) => [row.key, row.calls, row.unpriced]), [
    ["harness:claude/claude-opus-5-5[1m]", 1, 0], ["deepseek/deepseek-v4-flash", 2, 0], ["xai/grok-4", 1, 1]
  ]);
  assert.ok(Math.abs(byModel.rows[1]!.cost.USD! - 2 * 0.0924) < 1e-9);
  assert.equal(byModel.total.calls, 4);
  assert.equal(byModel.total.input, 2_000_000 + 4360 + 2000);
  assert.equal(byModel.total.unpriced, 1);

  const by = (grouping: "provider" | "harness" | "device" | "ticket" | "day") =>
    usageReport(entries, devices, { since: parseSince("7d", now), by: grouping }, settings).rows.map((row) => [row.key, row.calls]);
  assert.deepEqual(by("provider"), [["harness:claude", 1], ["deepseek", 2], ["xai", 1]]);
  assert.deepEqual(by("harness"), [["claude", 1], ["-", 3]]);
  assert.deepEqual(by("device"), [["ovh", 2], ["mac", 2]]);
  assert.deepEqual(by("ticket"), [["abcdef12", 2], ["-", 2]]);
  assert.equal(by("day").reduce((sum, [, calls]) => sum + Number(calls), 0), 4, "days are local, so these calls fall on one or two");

  const text = usageText(byModel, "7d");
  assert.match(text, /by model, on mac, ovh:/);
  assert.match(text, /xai\/grok-4\s+1\s+2\.00K\s+0\s+300\s+unpriced/);
  assert.match(text, /total\s+4\s+2\.01M\s+1.60M\s+200K\s+\$0\.6848 \+ 1 unpriced/);
  assert.match(text, /Budgets: none set/);
  const skipped = usageText(usageReport(entries, [...devices, { device: "pi", skipped: "it did not answer (connect ECONNREFUSED)" }], { since: now, by: "model" }, settings), "7d");
  assert.match(skipped, /Skipped pi: it did not answer \(connect ECONNREFUSED\)\./);
});
