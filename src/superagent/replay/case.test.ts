/** The replay case format: saving, loading, and refusing any path inside a git work tree. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { CASE_VERSION, assertPrivate, casePath, listCases, loadCase, replayRoot, saveCase, type ReplayCase } from "./case.js";
import { AT, CHAT, scene } from "./_testing.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "swarm-replay-case-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const kase = (id = "f01-chatter-b023"): ReplayCase => ({ version: CASE_VERSION, id, purpose: "chatter", finding: "F01", scene: scene(),
  recorded: { card: { systemHash: "a".repeat(64), userHash: "b".repeat(64) }, callAt: AT, durationMs: 1200, model: "deepseek-flash",
    provider: "deepseek", outcome: { kind: "said", text: "我发个最小请求打过去" } },
  expect: { kind: "said", rubric: "No commitment.", checks: ["no-commit"] } });

test("saves a case owner-only and loads it back unchanged", () => {
  saveCase(root, kase());
  assert.equal(statSync(casePath(root, "f01-chatter-b023")).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, "cases")).mode & 0o777, 0o700);
  const loaded = loadCase(root, "f01-chatter-b023");
  assert.deepEqual(loaded, kase());
  assert.equal(loaded.scene.chatId, CHAT);
  assert.deepEqual(listCases(root), ["f01-chatter-b023"]);
});

test("refuses a case written with another version", () => {
  const path = casePath(root, "old");
  mkdirSync(join(root, "cases"), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...kase("old"), version: 0 }));
  assert.throws(() => loadCase(root, "old"), /version 0/);
});

test("assertPrivate refuses a path inside a git work tree, however deep", () => {
  mkdirSync(join(root, ".git"));
  assert.throws(() => assertPrivate(root), /git work tree/);
  assert.throws(() => assertPrivate(join(root, "cases", "deep", "path")), /git work tree/);
  // A path with no .git above it is private, such as the state directory outside any repository.
  const free = mkdtempSync(join(tmpdir(), "swarm-replay-free-"));
  try { assert.doesNotThrow(() => assertPrivate(join(free, "replay"))); } finally { rmSync(free, { recursive: true, force: true }); }
});

test("a case id that is not a plain name never reaches the filesystem", () => {
  assert.throws(() => casePath(root, "../escape"), /Not a case id/);
  assert.throws(() => casePath(root, "a/b"), /Not a case id/);
});

test("the replay root sits in the state directory", () => {
  assert.equal(replayRoot("/tmp/state"), join("/tmp/state", "replay"));
});

test("refuses a path that reaches a git work tree through a symlink", () => {
  // A lexical walk finds no `.git` under a link's path: the resolved one does, and private cases must not land there.
  const repo = mkdtempSync(join(tmpdir(), "swarm-replay-link-repo-"));
  writeFileSync(join(repo, ".git"), "gitdir: elsewhere\n");
  mkdirSync(join(repo, ".claude", "worktrees", "x"), { recursive: true });
  const link = join(root, "link");
  symlinkSync(repo, link);
  try {
    assert.throws(() => assertPrivate(join(link, ".claude", "worktrees", "x", "replay")), /git work tree/);
    assert.throws(() => assertPrivate(join(link, "not", "yet", "there")), /git work tree/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
