import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCollaborationCockpitView,
  buildCollaborationTelemetryEvent,
  buildTopologyStripModel,
  collaborationShortcutActionForInput,
  isCollaborationCockpitEnabled
} from "./collaboration-cockpit.js";
import type { RunBoardSurfaceView } from "./run-board/run-board-types.js";

test("collaboration cockpit feature flag disables the view", () => {
  assert.equal(isCollaborationCockpitEnabled("0"), false);
  assert.equal(isCollaborationCockpitEnabled("false"), false);
  assert.equal(isCollaborationCockpitEnabled(undefined), true);
  assert.deepEqual(buildCollaborationCockpitView({ enabled: false }), { enabled: false, overlays: [] });
});

test("topology model combines run board blocked workers and approvals", () => {
  const runBoard = {
    title: "Swarm Board",
    phase: "waiting-attention",
    workers: [
      {
        id: "worker-1",
        label: "Test Runner",
        role: "test",
        status: "stuck",
        currentAction: "running focused test",
        elapsedMs: 72_000,
        owns: [],
        risk: "low",
        canStop: true,
        canRetry: true,
        canTakeBack: false
      }
    ],
    attention: [
      {
        id: "approval-1",
        severity: "blocking",
        kind: "approval",
        title: "Approval",
        summary: "Approval needed",
        evidence: ["Bash npm test"],
        recommendation: "approve if expected",
        actions: [],
        createdAt: "2026-05-28T00:00:00.000Z",
        updatedAt: "2026-05-28T00:00:00.000Z"
      }
    ],
    resultPreview: {
      status: "blocked",
      summary: "Verification blocked",
      changedFiles: [],
      checks: [],
      artifacts: [],
      blockers: [],
      confidence: "medium",
      contributors: [],
      risks: [],
      nextActions: []
    }
  } satisfies RunBoardSurfaceView;
  const model = buildTopologyStripModel({
    runBoard,
    approvalsPending: 0,
    policyMode: "approval",
    sandboxMode: "workspace-write"
  });
  assert.equal(model.ownershipBlocked, 1);
  assert.equal(model.approvalsPending, 1);
  assert.match(model.evidence.join("\n"), /Run Board: workers 1, attention 1/);
  assert.match(model.evidence.join("\n"), /Policy: approval, sandbox workspace-write/);
});

test("collaboration shortcuts only claim empty prompt plain keys", () => {
  assert.equal(collaborationShortcutActionForInput({
    character: "o",
    key: {},
    enabled: true,
    inputIsEmpty: true
  }), "open");
  assert.equal(collaborationShortcutActionForInput({
    character: "n",
    key: {},
    enabled: true,
    inputIsEmpty: true
  }), "negotiation");
  assert.equal(collaborationShortcutActionForInput({
    character: "b",
    key: {},
    enabled: true,
    inputIsEmpty: true
  }), "blackboard");
  assert.equal(collaborationShortcutActionForInput({
    character: "r",
    key: {},
    enabled: true,
    inputIsEmpty: true
  }), "reassign");
  assert.equal(collaborationShortcutActionForInput({
    character: "o",
    key: { ctrl: true },
    enabled: true,
    inputIsEmpty: true
  }), undefined);
  assert.equal(collaborationShortcutActionForInput({
    character: "o",
    key: {},
    enabled: true,
    inputIsEmpty: false
  }), undefined);
  assert.equal(collaborationShortcutActionForInput({
    character: "o",
    key: {},
    enabled: false,
    inputIsEmpty: true
  }), undefined);
  assert.equal(collaborationShortcutActionForInput({
    key: { return: true },
    enabled: true,
    inputIsEmpty: true
  }), undefined);
});

test("collaboration cockpit builds ownership overlays and reassign target from product evidence", () => {
  const runBoard = {
    title: "Swarm Board",
    phase: "waiting-attention",
    workers: [
      {
        id: "worker-test",
        label: "Test Runner",
        role: "test",
        status: "stuck",
        currentAction: "running focused test",
        elapsedMs: 72_000,
        waitingOn: "npm test",
        owns: [],
        risk: "low",
        canStop: true,
        canRetry: true,
        canTakeBack: false
      }
    ],
    attention: [],
    resultPreview: {
      status: "blocked",
      summary: "Verification blocked",
      changedFiles: [],
      checks: [],
      artifacts: [],
      blockers: [],
      confidence: "medium",
      contributors: [],
      risks: [],
      nextActions: []
    }
  } satisfies RunBoardSurfaceView;

  const view = buildCollaborationCockpitView({
    runBoard,
    policyMode: "approval"
  });
  const ownership = view.overlays.find((overlay) => overlay.target === "ownership");

  assert.equal(view.enabled, true);
  assert(ownership);
  assert.match(ownership.rows[0]?.label ?? "", /Test Runner/);
  assert.equal(view.reassign?.targetId, "worker-test");
  assert.equal(view.reassign?.policy, "approval-required");
  assert.doesNotMatch(JSON.stringify(view), /handoff contract id|lease participant|ASP/);
});

test("collaboration cockpit projects negotiation and blackboard overlay rows", () => {
  const view = buildCollaborationCockpitView({
    swarmSurface: {
      generated_at: "2026-05-28T00:00:00.000Z",
      actors: [],
      ownership: [],
      conflicts: [],
      negotiations: [{
        negotiation_id: "nego-1",
        action: "counter",
        status: "counter",
        from: "Reviewer",
        to: "Code Worker",
        session_id: "sess-1",
        task_id: "task-1",
        summary: "Reviewer and Code Worker are comparing fixes.",
        envelope_id: "env-1"
      }],
      squads: [],
      handoffs: [],
      blackboard: [{
        entry_id: "bb-1",
        swarm_id: "swarm-1",
        session_id: "sess-1",
        key: "proposal/1",
        value: { summary: "Use smaller patch" },
        type: "decision",
        created_by: { agent_id: "reviewer" },
        created_at: "2026-05-28T00:00:00.000Z",
        visibility: "team",
        version: 1,
        tags: ["proposal", "decision"],
        metadata: { kind: "decision" }
      }],
      summary: {
        participants: 0,
        active_participants: 0,
        stale_participants: 0,
        inbox_pending: 0,
        outbox_pending: 0,
        ownership_items: 0,
        conflicts: 0,
        negotiations: 1,
        squads: 0
      }
    }
  });

  const negotiation = view.overlays.find((overlay) => overlay.target === "negotiation");
  const blackboard = view.overlays.find((overlay) => overlay.target === "blackboard");

  assert.equal(negotiation?.rows[0]?.id, "nego-1");
  assert.match(negotiation?.rows[0]?.evidence ?? "", /Reviewer/);
  assert.match(blackboard?.rows[0]?.label ?? "", /Proposal|Decision/);
  assert.match(blackboard?.rows[0]?.detail.join("\n") ?? "", /key=proposal\/1/);
});

test("collaboration telemetry schema redacts targets and preserves duration", () => {
  const event = buildCollaborationTelemetryEvent({
    event: "tui.reassign.intent",
    overlay: "ownership",
    action: "reassign",
    target: "token=secret-token-123 C:\\Users\\Ada\\project",
    source: "keyboard",
    result: "queued",
    durationMs: 12.8
  });

  assert.equal(event.event, "tui.reassign.intent");
  assert.equal(event.overlay, "ownership");
  assert.equal(event.durationMs, 12);
  assert.equal(event.source, "keyboard");
  assert.doesNotMatch(JSON.stringify(event), /secret-token-123/);
});
