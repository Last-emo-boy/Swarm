import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SwarmDatabase } from "./database.js";
import { AgentMemoryStore } from "./agent-memory-store.js";

type AppendInput = Parameters<AgentMemoryStore["append"]>[0];

test("agent memory write requires envelope cause and retention policy", () => {
  withStore((store) => {
    assert.throws(() => store.append({
      actor_id: "worker:alpha",
      kind: "profile",
      content: "Alpha reviewer profile.",
      retention_policy: "long_term"
    } as AppendInput), /source_envelope_id/);

    assert.throws(() => store.append({
      actor_id: "worker:alpha",
      kind: "profile",
      content: "Alpha reviewer profile.",
      source_envelope_id: "env_profile"
    } as AppendInput), /retention_policy/);
  });
});

test("agent memory summarizes profile, experience, constraints, failures, and tools", () => {
  withStore((store) => {
    store.append({
      actor_id: "worker:alpha",
      kind: "profile",
      content: "Reviewer focused on runtime protocol tests.",
      retention_policy: "long_term",
      source_envelope_id: "env_profile",
      created_at: "2026-05-25T00:00:00.000Z"
    });
    store.append({
      actor_id: "worker:alpha",
      kind: "task_experience",
      content: "Completed TASK-101 by adding projection coverage.",
      retention_policy: "session",
      session_id: "session-1",
      task_id: "TASK-101",
      source_envelope_id: "env_task",
      created_at: "2026-05-25T00:01:00.000Z"
    });
    store.append({
      actor_id: "worker:alpha",
      kind: "learned_constraint",
      content: "Keep raw prompts out of durable agent memory.",
      retention_policy: "long_term",
      source_envelope_id: "env_constraint",
      created_at: "2026-05-25T00:02:00.000Z"
    });
    store.append({
      actor_id: "worker:alpha",
      kind: "failure_pattern",
      content: "Retry after reading current files when edits drift.",
      retention_policy: "long_term",
      source_envelope_id: "env_failure",
      created_at: "2026-05-25T00:03:00.000Z"
    });
    store.append({
      actor_id: "worker:alpha",
      kind: "trusted_tool",
      content: "Use code.test for targeted runtime regressions.",
      trusted_tools: ["code.test"],
      retention_policy: "long_term",
      source_envelope_id: "env_tool",
      created_at: "2026-05-25T00:04:00.000Z"
    });

    const memory = store.project("worker:alpha");
    assert.equal(memory.health, "active");
    assert.equal(memory.profile_summary, "Reviewer focused on runtime protocol tests.");
    assert.equal(memory.entries, 5);
    assert.equal(memory.last_learned_at, "2026-05-25T00:04:00.000Z");
    assert.equal(memory.last_source_envelope_id, "env_tool");
    assert.match(memory.cache_stable_summary, /Keep raw prompts out/);
    assert.match(memory.cache_stable_summary, /Retry after reading current files/);
    assert.deepEqual(memory.recent_tasks, ["Completed TASK-101 by adding projection coverage."]);
    assert.deepEqual(memory.trusted_tools, ["code.test"]);

    const rendered = store.renderForPrompt("worker:alpha");
    assert.match(rendered, /Agent memory summary/);
    assert.match(rendered, /cache_stable_summary_hash=amx:/);
    assert.match(rendered, /trusted_tools=code\.test/);
  });
});

test("agent memory survives database reopen with compacted summary", () => {
  const root = mkdtempSync(join(tmpdir(), "swarm-agent-memory-reopen-"));
  const databasePath = join(root, "swarm.db");
  try {
    {
      const database = new SwarmDatabase(databasePath);
      const store = new AgentMemoryStore(database);
      store.append({
        actor_id: "worker:alpha",
        kind: "profile",
        content: "Persistent projection specialist.",
        retention_policy: "long_term",
        source_envelope_id: "env_profile",
        created_at: "2026-05-25T00:00:00.000Z"
      });
      store.append({
        actor_id: "worker:alpha",
        kind: "task_experience",
        content: "Completed a session restart continuity check.",
        retention_policy: "long_term",
        source_envelope_id: "env_task",
        created_at: "2026-05-25T00:01:00.000Z"
      });
      database.close();
    }

    const reopened = new SwarmDatabase(databasePath);
    try {
      const store = new AgentMemoryStore(reopened);
      const memory = store.project("worker:alpha");
      assert.equal(memory.health, "active");
      assert.equal(memory.entries, 2);
      assert.equal(memory.profile_summary, "Persistent projection specialist.");
      assert.equal(memory.last_source_envelope_id, "env_task");
      assert.match(memory.cache_stable_summary, /session restart continuity/);
      assert.match(memory.cache_stable_summary_hash, /^amx:/);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent memory freeze blocks normal writes until unfrozen", () => {
  withStore((store) => {
    assert.throws(() => store.freeze("worker:alpha", {} as Parameters<AgentMemoryStore["freeze"]>[1]), /source_envelope_id/);

    store.freeze("worker:alpha", {
      source_envelope_id: "env_freeze",
      frozen: true,
      now: "2026-05-25T00:00:00.000Z"
    });
    assert.equal(store.project("worker:alpha").health, "frozen");
    assert.equal(store.project("worker:alpha").last_source_envelope_id, "env_freeze");

    assert.throws(() => store.append({
      actor_id: "worker:alpha",
      kind: "task_experience",
      content: "Should not be recorded while frozen.",
      retention_policy: "session",
      source_envelope_id: "env_task"
    }), /frozen/);

    store.freeze("worker:alpha", {
      source_envelope_id: "env_unfreeze",
      frozen: false,
      now: "2026-05-25T00:01:00.000Z"
    });
    store.append({
      actor_id: "worker:alpha",
      kind: "task_experience",
      content: "Recorded after unfreeze.",
      retention_policy: "session",
      source_envelope_id: "env_after_unfreeze"
    });
    assert.equal(store.project("worker:alpha").health, "active");
  });
});

test("agent memory clear hides older entries while preserving trace control", () => {
  withStore((store) => {
    store.append({
      actor_id: "worker:alpha",
      kind: "profile",
      content: "Old profile.",
      retention_policy: "long_term",
      source_envelope_id: "env_old",
      created_at: "2026-05-25T00:00:00.000Z"
    });

    assert.throws(() => store.clear("worker:alpha", {} as Parameters<AgentMemoryStore["clear"]>[1]), /source_envelope_id/);

    store.clear("worker:alpha", {
      source_envelope_id: "env_clear",
      now: "2026-05-25T00:01:00.000Z"
    });
    const cleared = store.project("worker:alpha");
    assert.equal(cleared.health, "cleared");
    assert.equal(cleared.entries, 0);
    assert.equal(cleared.last_source_envelope_id, "env_clear");
    assert.equal(cleared.cleared_at, "2026-05-25T00:01:00.000Z");

    store.append({
      actor_id: "worker:alpha",
      kind: "task_experience",
      content: "Fresh post-clear experience.",
      retention_policy: "session",
      source_envelope_id: "env_new",
      created_at: "2026-05-25T00:02:00.000Z"
    });
    const afterClear = store.project("worker:alpha");
    assert.equal(afterClear.health, "active");
    assert.equal(afterClear.entries, 1);
    assert.doesNotMatch(afterClear.cache_stable_summary, /Old profile/);
    assert.match(afterClear.cache_stable_summary, /Fresh post-clear experience/);
  });
});

test("agent memory compaction preserves stable prefix hash until memory changes", () => {
  withStore((store) => {
    store.append({
      actor_id: "worker:alpha",
      kind: "profile",
      content: "Projection specialist.",
      retention_policy: "long_term",
      source_envelope_id: "env_profile"
    });
    store.append({
      actor_id: "worker:alpha",
      kind: "learned_constraint",
      content: "Never put agent memory into the cacheable prefix.",
      retention_policy: "long_term",
      source_envelope_id: "env_constraint"
    });

    const before = store.project("worker:alpha").cache_stable_summary_hash;
    const compacted = store.compact("worker:alpha", { source_envelope_id: "env_compact" });
    const after = store.project("worker:alpha");

    assert.equal(compacted.last_source_envelope_id, "env_compact");
    assert.equal(after.last_source_envelope_id, "env_compact");
    assert.equal(after.cache_stable_summary_hash, before);
    assert.match(after.cache_stable_summary, /Never put agent memory into the cacheable prefix/);
  });
});

function withStore(run: (store: AgentMemoryStore) => void): void {
  const root = mkdtempSync(join(tmpdir(), "swarm-agent-memory-"));
  const database = new SwarmDatabase(join(root, "swarm.db"));
  const store = new AgentMemoryStore(database);
  try {
    run(store);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
}
