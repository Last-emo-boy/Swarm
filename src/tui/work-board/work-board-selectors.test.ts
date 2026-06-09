import { strict as assert } from "node:assert";
import test from "node:test";
import type { WorkBoard } from "../../runtime/work-board.js";
import { selectWorkBoardSurface } from "./work-board-selectors.js";

test("selectWorkBoardSurface groups WorkBoard data into product columns and task thread", () => {
  const view = selectWorkBoardSurface({
    board: fixtureBoard(),
    approvals: [{ approval_id: "approval-1", status: "pending", updated_at: "2026-05-29T00:00:00.000Z", risk_class: "r2", target: "src/tui", action: "edit" } as never],
    daemons: [{ daemon_id: "daily-health", status: "running", tick_count: 2, updated_at: "2026-05-29T00:00:00.000Z" } as never],
    skills: [{ name: "tui-designer", trust: "trusted" } as never],
    recentMessages: [{ role: "user", brief: "Make Swarm board-first" }]
  });

  assert.equal(view.title, "Board");
  assert.equal(view.subtitle, "1 active task · 1 approval · 1 blocker");
  assert.equal(view.summary.activeTasks, 1);
  assert.equal(view.summary.approvals, 1);
  assert.equal(view.summary.skills, 1);
  assert.equal(view.columns.find((column) => column.id === "running")?.items[0]?.title, "T-101");
  assert.equal(view.columns.find((column) => column.id === "blocked")?.items[0]?.title, "Fix TUI layout");
  assert.equal(view.selected?.title, "T-101");
  assert.match(view.selected?.objective ?? "", /Board-first/);
  assert(view.selected?.comments.some((line) => /Make Swarm/.test(line)));
  assert.deepEqual(view.selected?.actions, ["Continue"]);
  assert(!view.selected?.actions.some((action) => action.startsWith("/")));
  assert.doesNotMatch(view.subtitle, /workers|helpers|0 approvals|0 blockers/i);
  assert.doesNotMatch(view.selected?.actions.join("\n") ?? "", /teammate/i);
});

test("selectWorkBoardSurface provides an empty thread before work starts", () => {
  const view = selectWorkBoardSurface({ recentMessages: [] });

  assert.equal(view.empty, true);
  assert.equal(view.subtitle, "Ready");
  assert.equal(view.selected?.id, "new-task");
  assert.equal(view.selected?.objective, "Ask Swarm to review or plan this workspace.");
  assert.doesNotMatch(view.selected?.objective ?? "", /inspect|edit|test|explain/i);
  assert.deepEqual(view.selected?.plan, []);
  assert.deepEqual(view.selected?.actions, ["Review this workspace", "Plan a change"]);
  assert(!view.selected?.actions.some((action) => action.startsWith("/")));
  assert.doesNotMatch(view.selected?.plan.join("\n") ?? "", /Type an objective|Result reports|full transcript|assign workers|view workers|automations/i);
});

test("selectWorkBoardSurface keeps automation state out of default activity", () => {
  const view = selectWorkBoardSurface({
    daemons: [{ daemon_id: "daily-health", status: "running", tick_count: 2, updated_at: "2026-05-29T00:00:00.000Z" } as never],
    recentMessages: []
  });

  assert.equal(view.empty, true);
  assert.deepEqual(view.summary.activity, []);
  assert.doesNotMatch(view.subtitle, /automation|daemon/i);
});

test("selectWorkBoardSurface keeps default detail actions to one primary choice", () => {
  const board = fixtureBoard();
  board.tasks = [];
  board.next_actions = [];
  board.sessions = board.sessions.map(({ next_action: _nextAction, ...session }) => session);

  const view = selectWorkBoardSurface({ board, selectedId: "session-101" });

  assert.deepEqual(view.selected?.actions, ["Continue"]);
});

test("selectWorkBoardSurface keeps thread detail labels product-facing", () => {
  const board = fixtureBoard();
  board.tasks = board.tasks.map((task) => task.task_id === "task-blocked"
    ? { ...task, dependencies: ["task-running"] }
    : task);
  board.artifacts = [{
    artifact_id: "artifact-1",
    session_id: "session-101",
    path: "E:/Playground/Swarm/.swarm/artifacts/review/report.md",
    type: "report"
  }];

  const taskView = selectWorkBoardSurface({ board, selectedId: "task-blocked" });
  const sessionView = selectWorkBoardSurface({ board, selectedId: "session-101" });

  assert(taskView.selected?.plan.some((line) => /^Waiting on: task-running$/u.test(line)));
  assert(taskView.selected?.plan.some((line) => /^Files: components\/SwarmWorkbenchLayout\.tsx$/u.test(line)));
  assert.deepEqual(taskView.selected?.actions, ["Resolve"]);
  assert(!taskView.selected?.plan.some((line) => /Dependencies:|Scope:|check\(s\) recorded/u.test(line)));
  assert(sessionView.selected?.timeline.some((line) => /^Output: review\/report\.md$/u.test(line)));
  assert(!sessionView.selected?.timeline.some((line) => /Artifact|Last artifact/u.test(line)));
});

test("selectWorkBoardSurface maps failed detail actions to output review", () => {
  const board = fixtureBoard();
  board.tasks = board.tasks.map((task) => task.task_id === "task-blocked"
    ? { ...task, status: "failed", last_error: "Verification failed" }
    : task);

  const view = selectWorkBoardSurface({ board, selectedId: "task-blocked" });

  assert.deepEqual(view.selected?.actions, ["Review output"]);
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
      tasks: 2,
      blocked: 1,
      failed: 0,
      resumable: 0,
      claims: 1,
      changed_files: 2,
      checks: 1,
      artifacts: 0,
      actions: 0
    },
    sessions: [{
      session_id: "session-101",
      status: "running",
      objective: "Build the Board-first Local Agent Workspace",
      source: {
        source: "user",
        human_id: "T-101",
        title: "Board-first workspace",
        labels: ["tui"],
        metadata: {}
      },
      updated_at: "2026-05-29T00:00:00.000Z",
      next_action: "Continue implementation"
    }],
    work_items: [],
    workers: [{
      worker_id: "worker-tui",
      display_name: "Ada",
      role_title: "TUI Specialist",
      status: "running",
      capability: "tui",
      objective: "Implement Board surface",
      file_scope: ["src/tui/SwarmChatApp.tsx"],
      updated_at: "2026-05-29T00:00:00.000Z",
      session_id: "session-101"
    }],
    tasks: [
      {
        task_id: "task-running",
        title: "T-101",
        status: "running",
        attempt: 1,
        dependencies: [],
        file_scope: ["src/tui/SwarmChatApp.tsx"],
        updated_at: "2026-05-29T00:00:00.000Z",
        session_id: "session-101"
      },
      {
        task_id: "task-blocked",
        title: "Fix TUI layout",
        status: "blocked",
        attempt: 1,
        dependencies: [],
        file_scope: ["src/tui/components/SwarmWorkbenchLayout.tsx"],
        last_error: "Need layout decision",
        updated_at: "2026-05-29T00:00:00.000Z",
        session_id: "session-101"
      }
    ],
    claims: [],
    blocked: [{ source: "task", id: "task-blocked", severity: "warning", action: "Resolve layout decision" }],
    failed: [],
    resumable: [],
    changed_files: ["src/tui/SwarmChatApp.tsx", "src/tui/work-board/WorkBoardSurface.tsx"],
    checks: [{ session_id: "session-101", value: "npm run check", status: "recorded" }],
    artifacts: [],
    recent_actions: [],
    next_actions: [{ source: "task", id: "task-blocked", severity: "warning", action: "Resolve layout decision" }],
    filters: ["active", "blocked", "failed", "resumable", "changed-files", "checks"]
  };
}
