import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SwarmDatabase } from "./database.js";
import { SessionContextStore } from "./session-context-store.js";

test("session context compaction keeps user objective and active task visible", () => {
  const root = mkdtempSync(join(tmpdir(), "swarm-session-context-"));
  const database = new SwarmDatabase(join(root, "swarm.db"));
  const store = new SessionContextStore(database);
  try {
    store.append({
      session_id: "session-context",
      kind: "objective",
      role: "user",
      content: "User objective: preserve the checkout total regression task.",
      created_at: "2026-05-13T00:00:00.000Z"
    });
    store.append({
      session_id: "session-context",
      kind: "loop_activity",
      role: "system",
      content: "Active task: TASK-008 swarm-aware context cache manager.",
      metadata: { active_task: true },
      created_at: "2026-05-13T00:00:01.000Z"
    });
    for (let index = 0; index < 12; index += 1) {
      store.append({
        session_id: "session-context",
        kind: "tool_result",
        role: "tool",
        content: `Large historical payload ${index}: ${"x".repeat(900)}`,
        created_at: `2026-05-13T00:00:${String(index + 2).padStart(2, "0")}.000Z`
      });
    }

    const rendered = store.renderForSession("session-context", {
      maxTokens: 400,
      keepRecentEntries: 2,
      summaryMaxTokens: 160
    });

    assert.match(rendered, /Protected objective and active task/);
    assert.match(rendered, /preserve the checkout total regression task/);
    assert.match(rendered, /TASK-008 swarm-aware context cache manager/);
    assert.match(rendered, /Recent session tail/);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("session context compacts again only once new entries outgrow the budget, and its summary holds what happened since", () => {
  const root = mkdtempSync(join(tmpdir(), "swarm-session-context-"));
  const database = new SwarmDatabase(join(root, "swarm.db"));
  const store = new SessionContextStore(database);
  const budget = { maxTokens: 2_000, keepRecentEntries: 3, summaryMaxTokens: 600 };
  const add = (index: number, content: string) => {
    store.append({ session_id: "s", kind: index === 0 ? "objective" : "tool_result", role: index === 0 ? "user" : "tool", content,
      created_at: `2026-05-13T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z` });
    store.compact("s", budget);
  };
  try {
    add(0, "Objective: try the 2048-DQN repository.");
    for (let index = 1; index < 30; index += 1) add(index, `step ${index} ${"x".repeat(600)}`);
    const compactions = database.db.prepare("SELECT count(*) AS n FROM session_compactions").get() as { n: number };
    // About one compaction per budget's worth of new entries, not one per entry.
    assert.ok(compactions.n > 0 && compactions.n < 10, `compactions: ${compactions.n}`);
    add(30, "Cloned into /tmp/dqn2048.abc/repo");
    for (let index = 31; index < 45; index += 1) add(index, `step ${index} ${"x".repeat(600)}`);
    const rendered = store.renderForSession("s", budget);
    assert.match(rendered, /try the 2048-DQN repository/);
    assert.match(rendered, /\/tmp\/dqn2048\.abc\/repo/);
    assert.match(rendered, /step 44/);
    assert.ok(rendered.length < 4 * 2_000 + 2_000, `rendered ${rendered.length} characters`);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
