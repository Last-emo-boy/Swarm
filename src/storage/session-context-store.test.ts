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
