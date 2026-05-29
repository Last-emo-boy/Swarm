import { strict as assert } from "node:assert";
import test from "node:test";
import type { WorkBoard } from "../../runtime/work-board.js";
import { formatWorkItemThreadRows, selectWorkItemThread } from "./work-item-thread-selectors.js";

test("selectWorkItemThread derives selected task detail from WorkBoard evidence", () => {
  const thread = selectWorkItemThread({
    board: fixtureBoard(),
    selectedId: "task-review",
    recentMessages: [{ role: "user", brief: "Keep chat as the task comment entry." }]
  });

  assert.equal(thread?.id, "task-review");
  assert.equal(thread?.title, "Review board-first TUI");
  assert.equal(thread?.assignee, "Reviewer");
  assert.match(thread?.objective ?? "", /Board-first Local Agent Workspace/);
  assert(thread?.changedFiles.includes("src/tui/work-board/WorkItemThread.tsx"));
  assert(thread?.comments.some((line) => /task comment/.test(line)));
});

test("formatWorkItemThreadRows keeps task thread evidence bounded and user-facing", () => {
  const thread = selectWorkItemThread({ board: fixtureBoard(), selectedId: "task-review" });
  assert(thread);

  const rows = formatWorkItemThreadRows(thread, 5);

  assert.equal(rows.length, 5);
  assert.match(rows[0] ?? "", /Status: running/);
  assert.match(rows[1] ?? "", /Objective:/);
  assert(rows.some((line) => /Plan: Verify selected task thread/.test(line)));
  assert(!rows.some((line) => /ASP|protocol|heartbeat|claim owner/u.test(line)));
});

function fixtureBoard(): WorkBoard {
  return {
    schema_version: "swarm.work_board.v1",
    generated_at: "2026-05-29T00:00:00.000Z",
    scope: { kind: "workspace", workspace_path: "E:/Playground/Swarm" },
    summary: {
      sessions: 1,
      active_sessions: 1,
      workers: 1,
      active_workers: 1,
      resumable_workers: 0,
      tasks: 1,
      blocked: 0,
      failed: 0,
      resumable: 0,
      claims: 0,
      changed_files: 1,
      checks: 1,
      artifacts: 0,
      actions: 0
    },
    sessions: [{
      session_id: "session-review",
      status: "reviewing",
      objective: "Verify the Board-first Local Agent Workspace task thread",
      source: {
        source: "user",
        human_id: "T-108",
        title: "Board-first TUI",
        labels: ["tui"],
        metadata: {}
      },
      updated_at: "2026-05-29T00:00:00.000Z",
      next_action: "Verify selected task thread"
    }],
    work_items: [],
    workers: [{
      worker_id: "worker-reviewer",
      display_name: "Reviewer",
      role_title: "Code Review",
      status: "running",
      capability: "review",
      objective: "Review board-first task thread",
      file_scope: ["src/tui/work-board/WorkItemThread.tsx"],
      updated_at: "2026-05-29T00:00:00.000Z",
      session_id: "session-review"
    }],
    tasks: [{
      task_id: "task-review",
      title: "Review board-first TUI",
      status: "running",
      attempt: 1,
      dependencies: [],
      file_scope: ["src/tui/work-board/WorkItemThread.tsx"],
      updated_at: "2026-05-29T00:00:00.000Z",
      session_id: "session-review"
    }],
    claims: [],
    blocked: [],
    failed: [],
    resumable: [],
    changed_files: ["src/tui/work-board/WorkItemThread.tsx"],
    checks: [{ session_id: "session-review", value: "npm test", status: "recorded" }],
    artifacts: [],
    recent_actions: [],
    next_actions: [{ source: "session", id: "session-review", severity: "info", action: "Verify selected task thread" }],
    filters: ["active", "checks", "changed-files"]
  };
}
