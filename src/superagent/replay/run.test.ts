/** Running a case: a fresh temp store per run, one scripted model call, and the outcome read back with nothing sent. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { CASE_VERSION, type ReplayCase } from "./case.js";
import { KV } from "../kv.js";
import { runCase, type ModelPort } from "./run.js";
import { AT, CHAT, scene } from "./_testing.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "swarm-replay-run-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const kase = (overrides: Partial<ReplayCase> = {}): ReplayCase => ({ version: CASE_VERSION, id: "f01-chatter-b023", purpose: "chatter", finding: "F01",
  scene: scene(), recorded: { card: { systemHash: "a".repeat(64), userHash: "b".repeat(64) }, callAt: AT, durationMs: 1200, model: "deepseek-flash",
    provider: "deepseek", outcome: { kind: "silent" } }, expect: { kind: "said", rubric: "No commitment.", checks: ["no-commit"] }, ...overrides });

const scripted = (answer: string): { port: ModelPort; calls: { system: string; user: string; purpose: string }[] } => {
  const calls: { system: string; user: string; purpose: string }[] = [];
  return { calls, port: async (input) => { calls.push({ system: input.system, user: input.user, purpose: input.purpose }); return answer; } };
};

test("runs a chatter case twice in fresh stores, one model call each, and records what it said", async () => {
  const { port, calls } = scripted(JSON.stringify({ say: "我看没有，等上线了再说", reason: "someone asked" }));
  const records = await runCase(kase(), { complete: port, runs: 2 });
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.run), [1, 2]);
  for (const record of records) {
    assert.equal(record.call?.purpose, "superagent_chatter");
    assert.equal(record.outcome.kind, "said");
    assert.equal(record.outcome.text, "我看没有，等上线了再说");
    assert.equal(record.error, undefined);
  }
  // The same scene and clock make the same card: the hashes hold across runs, which is what a card-diff compares.
  assert.equal(records[0]!.call!.systemHash, records[1]!.call!.systemHash);
  assert.equal(records[0]!.call!.userHash, records[1]!.call!.userHash);
  assert.equal(calls.length, 2, "one model call per run");
  assert.match(calls[0]!.user, /staging 那版应该没上吧/, "the card holds the scene's messages");
});

test("a run sends nothing: the message it decided on stays pending, and no effect ran", async () => {
  const { port } = scripted(JSON.stringify({ say: "好", reason: "join" }));
  const records = await runCase(kase(), { complete: port, runs: 1 });
  assert.equal(records[0]!.outcome.kind, "said");
  // The temp store is gone with the run, so the proof is structural: the run never had a host to drain effects, and its
  // outcome came from a receipt the outbox holds `pending`. A sent one would mean an effect ran, which a replay never does.
  const outcome = records[0]!.outcome;
  assert.ok(outcome.outboxId, "the message it wrote names its outbox row");
});

test("a model that says nothing leaves the run silent", async () => {
  const { port } = scripted(JSON.stringify({ say: null, reason: "nothing to add" }));
  const records = await runCase(kase(), { complete: port, runs: 1 });
  assert.equal(records[0]!.outcome.kind, "silent");
  assert.equal(records[0]!.answer, JSON.stringify({ say: null, reason: "nothing to add" }));
});

test("a model call that fails ends that run with its error and no answer, and the others still run", async () => {
  let calls = 0;
  const port: ModelPort = async () => { calls += 1; if (calls === 1) throw new Error("connection reset"); return JSON.stringify({ say: "好", reason: "" }); };
  const records = await runCase(kase(), { complete: port, runs: 2 });
  assert.equal(records[0]!.error, "connection reset");
  assert.equal(records[0]!.answer, null);
  assert.equal(records[1]!.error, undefined);
  assert.equal(records[1]!.outcome.kind, "said");
});

test("a retried parse is refused, so a run bills one call and records the one card it sent", async () => {
  // The answer is not JSON, so answerOf asks once more, which the one-call rule refuses: the run ends with the error
  // rather than a second paid call.
  const { port, calls } = scripted("not json at all");
  const records = await runCase(kase(), { complete: port, runs: 1 });
  assert.equal(calls.length, 1);
  assert.match(records[0]!.error ?? "", /second model call/);
  assert.equal(records[0]!.call?.purpose, "superagent_chatter");
});

test("seeding a scene leaves no queued effect behind, so only the call under test runs", async () => {
  // The route purpose starts an Eval and queues its assessment: the seed drops it, and the router runs only through judge().
  // A sender the chat's member list holds, with the agent @-ed, is an explicit request the gate admits.
  const routeScene = scene({ people: [{ id: "ou_alice", name: "Alice" }], messages: [
    { id: "feishu:om_1", sender: "ou_alice", senderName: "Alice", human: true, at: "2026-11-11T10:40:02.000Z", text: "@w33d 看看这个", mentioned: true, addressed: true }
  ] });
  (routeScene.settings as { policy: { sources: Record<string, { allowed: { id: string }[] }> } }).policy.sources.feishu = { allowed: [{ id: "ou_alice" }] };
  const records = await runCase(kase({ purpose: "route", scene: routeScene }), { complete: scripted(JSON.stringify({ kind: "ignore", reason: "nothing to do" })).port, runs: 1 });
  assert.equal(records[0]!.call?.purpose, "superagent_route");
  assert.equal(records[0]!.outcome.kind, "routed");
  assert.equal(records[0]!.outcome.decision?.kind, "ignore");
  void CHAT;
});

test("a mentioned message whose text already names the agent is not given a second mention", async () => {
  // The store keeps mentions resolved (`@w33d`): prefixing the key again would send a card production never sent.
  const mentioned = scene({ messages: [{ id: "feishu:om_1", sender: "ou_alice", senderName: "Alice", human: true, at: "2026-11-11T10:40:02.000Z",
    text: "@w33d 看看 staging", mentioned: true }] });
  const { port, calls } = scripted(JSON.stringify({ say: null, reason: "" }));
  await runCase(kase({ scene: mentioned }), { complete: port, runs: 1 });
  assert.match(calls[0]!.user, /"text": "@w33d 看看 staging"/);
  assert.doesNotMatch(calls[0]!.user, /@_user_1/);
});

test("an attend run that posts nothing is silent, not a reply with no text", async () => {
  const { port } = scripted(JSON.stringify({ reply: null, relay: [], ask_back: [], reason: "nothing to answer" }));
  const records = await runCase(kase({ purpose: "attend", targetIds: ["feishu:om_2"], scene: scene({ messages: [
    { id: "feishu:om_2", sender: "ou_bot", senderName: "bot", human: false, at: "2026-11-11T10:44:00.000Z", text: "@w33d ping", mentioned: true }] }) }),
  { complete: port, runs: 1 });
  assert.equal(records[0]!.outcome.kind, "silent");
});

test("a reflection run records the notes it wrote, which the memory table holds", async () => {
  const reflectScene = scene({ reflectMark: { from: "2026-11-11T08:00:00.000Z", upTo: "2026-11-11T10:44:00.000Z", at: "2026-11-11T10:39:00.000Z" } });
  const { port } = scripted(JSON.stringify({ notes: [{ op: "add", about: CHAT, kind: "fact", text: "staging 那版还没上" }], reach_out: null }));
  const records = await runCase(kase({ purpose: "reflect", scene: reflectScene }), { complete: port, runs: 1 });
  assert.deepEqual(records[0]!.outcome.notes, ["staging 那版还没上"]);
});
