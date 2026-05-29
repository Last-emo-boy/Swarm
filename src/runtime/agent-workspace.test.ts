import { strict as assert } from "node:assert";
import test from "node:test";
import type { CapabilityDescriptor, CapabilityProviderSnapshot } from "../extensions/types.js";
import type { SkillRecord } from "../extensions/skills.js";
import type { ApprovalRecord } from "../storage/approval-store.js";
import type { SymphonyDaemonRecord } from "../symphony/daemon.js";
import type { SymphonyStatus } from "../symphony/status.js";
import type { WorkBoard, WorkBoardWorker } from "./work-board.js";
import { buildAgentWorkspaceProjection, findAgentWorkspaceTask } from "./agent-workspace.js";

const GENERATED_AT = "2026-05-29T00:00:00.000Z";

test("agent workspace projects blocked workers into teammates and attention", () => {
  const projection = buildAgentWorkspaceProjection({
    board: board({
      workers: [
        worker({
          worker_id: "worker-blocked",
          display_name: "Ada",
          role_title: "Coder",
          blocked_reason: "Waiting for approval to edit gateway.ts.",
          recovery: "Approve the edit or narrow the file scope."
        })
      ]
    })
  });

  assert.equal(projection.schema_version, "swarm.agent_workspace.v1");
  assert.equal(projection.teammates.length, 1);
  assert.equal(projection.teammates[0]?.id, "worker-blocked");
  assert.equal(projection.teammates[0]?.state, "blocked");
  assert.equal(projection.teammates[0]?.blocked_reason, "Waiting for approval to edit gateway.ts.");
  assert(projection.teammates[0]?.controls.some((control) => control.intent === "teammate.continue"));

  const attention = projection.attention.find((item) => item.kind === "blocked_worker");
  assert(attention, "expected blocked worker attention item");
  assert.equal(attention.source_ref.type, "worker");
  assert.equal(attention.source_ref.id, "worker-blocked");
  assert.equal(attention.recommended_action, "Approve the edit or narrow the file scope.");
});

test("agent workspace exposes lifecycle controls through existing worker and handoff routes", () => {
  const projection = buildAgentWorkspaceProjection({
    board: board({
      workers: [
        worker({
          worker_id: "worker-running",
          status: "running"
        }),
        worker({
          worker_id: "worker-stopped",
          status: "stopped",
          handoff_id: "handoff-1"
        }),
        worker({
          worker_id: "worker-completed",
          status: "completed"
        })
      ],
      claims: [
        {
          claim_id: "handoff-1",
          kind: "handoff",
          session_id: "session-1",
          worker_id: "worker-stopped",
          claim_owner: "worker:worker-stopped",
          status: "active",
          target: "reviewer",
          updated_at: GENERATED_AT,
          recovery: "Take back ownership before resuming this work."
        }
      ]
    })
  });

  const running = requiredTeammate(projection, "worker-running");
  assert.equal(running.state, "active");
  assertControl(running, "stop", true, "/v1/workers/worker-running/stop");
  assertControl(running, "continue", false, "/v1/workers/worker-running/continue");

  const stopped = requiredTeammate(projection, "worker-stopped");
  assert.equal(stopped.state, "resumable");
  assertControl(stopped, "continue", true, "/v1/workers/worker-stopped/continue");
  assertControl(stopped, "resume", true, "/v1/workers/worker-stopped/continue");
  assertControl(stopped, "take_back", true, "/v1/handoffs/handoff-1/take-back");

  const completed = requiredTeammate(projection, "worker-completed");
  assert.equal(completed.state, "done");
  assertControl(completed, "resume", false, "/v1/workers/worker-completed/continue");

  const handoff = projection.attention.find((item) => item.kind === "handoff_wait");
  assert(handoff, "expected active handoff attention item");
  assert.equal(handoff.control_intent, "handoff.take_back");
  assert.equal(handoff.recommended_action, "Take back ownership before resuming this work.");
});

test("agent workspace projects task cards and task details from WorkBoard truth", () => {
  const projection = buildAgentWorkspaceProjection({
    board: board({
      sessions: [{
        session_id: "session-task-1",
        status: "running",
        objective: "Implement task-centric Agent Workspace projection.",
        source: {
          source: "user",
          human_id: "T-200",
          title: "Task-centric workspace",
          labels: ["product"],
          metadata: {}
        },
        updated_at: GENERATED_AT,
        next_action: "Verify task detail projection."
      }],
      workers: [
        worker({
          worker_id: "worker-task-1",
          display_name: "Task Builder",
          session_id: "session-task-1",
          objective: "Build task projection.",
          trajectory: {
            report: "Task projection implemented.",
            changed_files: ["src/runtime/agent-workspace.ts"],
            checks: ["npm run check"],
            artifacts: []
          }
        })
      ],
      tasks: [{
        task_id: "task-1",
        title: "Consolidate task view model",
        status: "running",
        attempt: 1,
        capability: "product.projection",
        write_policy: "scoped_write",
        file_scope: ["src/runtime/agent-workspace.ts"],
        dependencies: [],
        updated_at: GENERATED_AT,
        session_id: "session-task-1"
      }],
      checks: [{ session_id: "session-task-1", value: "npm run check", status: "recorded" }],
      artifacts: [{ session_id: "session-task-1", path: "artifacts/task.md", type: "summary", summary: "Task evidence", created_at: GENERATED_AT }],
      next_actions: [{ source: "task", id: "task-1", severity: "info", action: "Continue task projection" }]
    })
  });

  assert.equal(projection.summary.tasks, 1);
  assert.equal(projection.tasks[0]?.id, "task-1");
  assert.equal(projection.tasks[0]?.status, "running");
  assert.equal(projection.tasks[0]?.source_session_id, "session-task-1");
  assert.equal(projection.tasks[0]?.source_work_item_key, "T-200");
  assert(projection.tasks[0]?.controls.some((control) => control.intent === "task.continue"));

  const detail = findAgentWorkspaceTask(projection, "T-200");
  assert(detail, "expected task detail by work item key");
  assert.equal(detail.id, "task-1");
  assert.match(detail.objective, /task-centric Agent Workspace/);
  assert(detail.plan.some((line) => /Verify task detail/.test(line)));
  assert(detail.timeline.some((item) => item.source_ref.id === "worker-task-1"));
  assert(detail.result?.changed_files.includes("src/runtime/agent-workspace.ts"));
  assert(detail.next_actions.includes("Continue task projection"));
});

test("agent workspace derives session and orphan worker as task details without duplicating explicit task IDs", () => {
  const projection = buildAgentWorkspaceProjection({
    board: board({
      sessions: [{
        session_id: "session-only",
        status: "completed",
        objective: "Explain current workspace.",
        updated_at: GENERATED_AT
      }],
      workers: [
        worker({
          worker_id: "worker-orphan",
          session_id: undefined,
          status: "stopped",
          objective: "Investigate orphan worker."
        })
      ]
    })
  });

  assert(projection.tasks.some((task) => task.id === "session-only" && task.status === "done"));
  assert(projection.tasks.some((task) => task.id === "worker-orphan" && task.status === "blocked"));
  assert(findAgentWorkspaceTask(projection, "session-only"));
  assert(findAgentWorkspaceTask(projection, "worker-orphan"));
});

test("agent workspace ranks pending approval before blocked worker attention", () => {
  const projection = buildAgentWorkspaceProjection({
    board: board({
      workers: [
        worker({
          worker_id: "worker-blocked",
          blocked_reason: "Needs operator decision."
        })
      ]
    }),
    approvals: [
      approval({
        approval_id: "approval-1",
        summary: "Allow write to src/server/gateway.ts",
        risk_class: "r3"
      })
    ]
  });

  assert.equal(projection.attention[0]?.kind, "approval");
  assert.equal(projection.attention[0]?.source_ref.id, "approval-1");
  assert.equal(projection.attention[1]?.kind, "blocked_worker");
});

test("agent workspace promotes failed checks to actionable attention", () => {
  const projection = buildAgentWorkspaceProjection({
    board: board({
      checks: [
        {
          session_id: "session-1",
          value: "npm test failed in gateway-agent-workspace.test.ts",
          status: "failed",
          recovery: "Fix the gateway projection route and rerun tests."
        }
      ]
    })
  });

  const attention = projection.attention.find((item) => item.kind === "failed_check");
  assert(attention, "expected failed check attention item");
  assert.equal(attention.severity, "error");
  assert.equal(attention.recommended_action, "Fix the gateway projection route and rerun tests.");
  assert.equal(projection.summary.critical_attention, 1);
});

test("agent workspace activity filters raw protocol and envelope chatter", () => {
  const projection = buildAgentWorkspaceProjection({
    board: board({
      workers: [
        worker({
          worker_id: "worker-noisy",
          display_name: "Noisy",
          objective: "ASP protocol heartbeat envelope received.",
          trajectory: {
            report: "ASP protocol heartbeat envelope received.",
            changed_files: [],
            checks: [],
            artifacts: []
          }
        }),
        worker({
          worker_id: "worker-useful",
          display_name: "Useful",
          objective: "Implemented Gateway projection.",
          trajectory: {
            report: "Implemented Gateway projection.",
            changed_files: ["src/server/gateway.ts"],
            checks: ["npm test passed"],
            artifacts: []
          }
        })
      ],
      next_actions: [
        {
          source: "action",
          id: "raw-envelope",
          severity: "info",
          action: "protocol envelope heartbeat"
        },
        {
          source: "worker",
          id: "worker-useful",
          severity: "info",
          action: "Review Gateway projection"
        }
      ]
    })
  });

  assert(!projection.activity.some((item) => /ASP|protocol|heartbeat|envelope/i.test(`${item.title} ${item.detail ?? ""}`)));
  assert(projection.activity.some((item) => item.source_ref.id === "worker-useful"));
});

test("agent workspace preserves trusted, untrusted, disabled, shadowed skill and capability states", () => {
  const provider: CapabilityProviderSnapshot = {
    providerId: "skills",
    title: "Agent skills",
    capabilities: 4,
    diagnostics: []
  };
  const projection = buildAgentWorkspaceProjection({
    board: board(),
    providers: [provider],
    skills: [
      skill({ name: "trusted-skill", trust: "trusted" }),
      skill({ name: "untrusted-skill", trust: "untrusted" }),
      skill({ name: "disabled-skill", trust: "disabled" }),
      skill({ name: "shadowed-skill", trust: "trusted", shadowedBy: "/older/SKILL.md" })
    ],
    capabilities: [
      capability({ id: "skill.trusted-skill", trust: "trusted", status: "available" }),
      capability({ id: "skill.untrusted-skill", trust: "untrusted", status: "disabled" }),
      capability({ id: "skill.disabled-skill", trust: "disabled", status: "disabled", modelVisible: false }),
      capability({ id: "local_tool.Write", kind: "local_tool", riskClass: "r3", readOnly: false })
    ]
  });

  assert.equal(projection.skills.find((item) => item.name === "trusted-skill")?.state, "trusted");
  assert.equal(projection.skills.find((item) => item.name === "untrusted-skill")?.state, "untrusted");
  assert.equal(projection.skills.find((item) => item.name === "disabled-skill")?.state, "disabled");
  assert.equal(projection.skills.find((item) => item.name === "shadowed-skill")?.state, "shadowed");

  assert.equal(projection.capabilities.find((item) => item.id === "skill.trusted-skill")?.state, "available");
  assert.equal(projection.capabilities.find((item) => item.id === "skill.untrusted-skill")?.state, "untrusted");
  assert.equal(projection.capabilities.find((item) => item.id === "skill.disabled-skill")?.hidden, true);
  assert.equal(projection.capabilities.find((item) => item.id === "local_tool.Write")?.risk_class, "r3");
});

test("agent workspace readiness summarizes provider warnings and automation workflow errors", () => {
  const projection = buildAgentWorkspaceProjection({
    board: board({ scope: { kind: "workspace" } }),
    workspacePath: undefined,
    providers: [
      {
        providerId: "mcp",
        title: "MCP tools",
        capabilities: 1,
        diagnostics: [{ severity: "warn", message: "MCP server is slow." }]
      }
    ],
    capabilities: [capability({ id: "mcp.tool.search", kind: "mcp_tool", providerId: "mcp" })],
    symphonyStatus: symphonyStatus({
      workflow: {
        ok: false,
        error: {
          code: "missing_workflow_file",
          message: "Workflow file not found.",
          path: "E:\\Playground\\Swarm\\WORKFLOW.md"
        }
      }
    })
  });

  assert.equal(projection.summary.readiness, "blocked");
  assertReadiness(projection, "workspace", "unknown", "warning");
  assertReadiness(projection, "capability_providers", "attention", "warning");
  assertReadiness(projection, "automations", "blocked", "error");
  assert(projection.attention.some((item) =>
    item.kind === "automation_exception" &&
    item.reason === "missing_workflow_file: Workflow file not found."
  ));
});

test("agent workspace product label says Automations while routes stay Symphony-compatible", () => {
  const projection = buildAgentWorkspaceProjection({
    board: board(),
    symphonyStatus: symphonyStatus(),
    daemons: [daemon({ daemon_id: "daemon-1", status: "failed", last_error: "workflow parse failed" })]
  });

  assert(projection.automations.length >= 2);
  assert(projection.automations.every((item) => item.product_label === "Automations"));
  assert(projection.automations.every((item) => item.internal_name === "symphony"));
  assert(projection.automations.every((item) => item.route.startsWith("/v1/symphony")));
  assert(projection.attention.some((item) => item.kind === "automation_exception" && item.reason === "workflow parse failed"));
});

function requiredTeammate(projection: ReturnType<typeof buildAgentWorkspaceProjection>, id: string) {
  const teammate = projection.teammates.find((item) => item.id === id);
  assert(teammate, `expected teammate ${id}`);
  return teammate;
}

function assertControl(
  teammate: ReturnType<typeof requiredTeammate>,
  id: "stop" | "continue" | "resume" | "take_back" | "inspect" | "approve" | "retry" | "open",
  enabled: boolean,
  route: string
): void {
  const control = teammate.controls.find((item) => item.id === id);
  assert(control, `expected control ${id} for ${teammate.id}`);
  assert.equal(control.enabled, enabled);
  assert.equal(control.route, route);
}

function assertReadiness(
  projection: ReturnType<typeof buildAgentWorkspaceProjection>,
  id: "workspace" | "work_board" | "approvals" | "capability_providers" | "skills" | "automations" | "gateway_projection",
  status: string,
  severity: string
): void {
  const item = projection.readiness.find((entry) => entry.id === id);
  assert(item, `expected readiness item ${id}`);
  assert.equal(item.status, status);
  assert.equal(item.severity, severity);
}

function board(overrides: Partial<WorkBoard> = {}): WorkBoard {
  return {
    schema_version: "swarm.work_board.v1",
    generated_at: GENERATED_AT,
    scope: {
      kind: "workspace",
      workspace_path: "E:\\Playground\\Swarm"
    },
    summary: {
      sessions: 1,
      active_sessions: 1,
      workers: overrides.workers?.length ?? 0,
      active_workers: overrides.workers?.filter((item) => item.status === "running" || item.status === "pending").length ?? 0,
      resumable_workers: overrides.workers?.filter((item) => item.status !== "running" && item.status !== "pending").length ?? 0,
      tasks: 0,
      blocked: overrides.next_actions?.filter((item) => item.severity === "warning").length ?? 0,
      failed: overrides.checks?.filter((item) => item.status === "failed").length ?? 0,
      resumable: 0,
      claims: overrides.claims?.length ?? 0,
      changed_files: 0,
      checks: overrides.checks?.length ?? 0,
      artifacts: 0,
      actions: 0,
      ...overrides.summary
    },
    sessions: [],
    work_items: [],
    workers: [],
    tasks: [],
    claims: [],
    blocked: [],
    failed: [],
    resumable: [],
    changed_files: [],
    checks: [],
    artifacts: [],
    recent_actions: [],
    next_actions: [],
    filters: ["active", "blocked", "failed", "resumable", "changed-files", "checks"],
    ...overrides
  };
}

function worker(overrides: Partial<WorkBoardWorker> = {}): WorkBoardWorker {
  return {
    worker_id: "worker-1",
    display_name: "Ada",
    role_title: "Coder",
    status: "running",
    capability: "code.implement",
    objective: "Implement Agent Workspace projection.",
    agent_spec_id: "coder",
    invocation_mode: "parallel",
    claim_owner: "main_swarm",
    lease_age: {
      since: "2026-05-29T00:00:00.000Z",
      age_ms: 0,
      label: "0s"
    },
    heartbeat_state: "fresh",
    write_policy: "scoped_write",
    file_scope: ["src/runtime/agent-workspace.ts"],
    requested_by: "main_swarm",
    updated_at: "2026-05-29T00:00:00.000Z",
    session_id: "session-1",
    trajectory: {
      report: "Working on projection.",
      changed_files: [],
      checks: [],
      artifacts: []
    },
    ...overrides
  };
}

function approval(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  const request = {
    id: overrides.approval_id ?? "approval-1",
    session_id: overrides.session_id,
    task_id: overrides.task_id,
    action: "shell",
    summary: overrides.summary ?? "Allow command",
    detail: "Run a verification command.",
    risk: "shell",
    risk_class: overrides.risk_class ?? "r2",
    target: "npm test",
    why_now: "Verification is required.",
    predicted_impact: "Runs tests.",
    rollback_plan: "No persistent changes.",
    attention_note: "Review verification command."
  } as const;
  return {
    approval_id: request.id,
    session_id: request.session_id,
    task_id: request.task_id,
    action: request.action,
    summary: request.summary,
    detail: request.detail,
    risk: request.risk,
    risk_class: request.risk_class,
    target: request.target,
    status: "pending",
    challenge: request,
    created_at: "2026-05-29T00:00:00.000Z",
    updated_at: "2026-05-29T00:00:01.000Z",
    ...overrides
  };
}

function skill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  const name = overrides.name ?? "trusted-skill";
  return {
    name,
    displayName: name,
    description: `${name} description`,
    path: `/skills/${name}/SKILL.md`,
    directory: `/skills/${name}`,
    scope: "project",
    trust: "trusted",
    frontmatter: {},
    allowedTools: [],
    resourcePaths: [],
    diagnostics: [],
    ...overrides
  };
}

function capability(overrides: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  const id = overrides.id ?? "skill.trusted-skill";
  return {
    id,
    kind: "skill",
    source: "project",
    trust: "trusted",
    providerId: "skills",
    name: id,
    title: id,
    description: `${id} description`,
    riskClass: "r0",
    permissionName: id,
    modelVisible: true,
    userVisible: true,
    status: "available",
    diagnostics: [],
    readOnly: true,
    ...overrides
  };
}

function symphonyStatus(overrides: Partial<SymphonyStatus> = {}): SymphonyStatus {
  return {
    workflow: {
      ok: true,
      workflow: {
        path: "E:\\Playground\\Swarm\\WORKFLOW.md",
        config: {},
        prompt_template: "Work on the item."
      }
    },
    generated_at: GENERATED_AT,
    totals: {
      sessions: 1,
      running: 0,
      completed: 1,
      failed: 0,
      cancelled: 0,
      retrying: 0
    },
    scheduler: {
      claimed: [],
      completed: [],
      running: [],
      retrying: [],
      capacity: {
        max_concurrent: 1,
        running: 0,
        available: 1
      }
    },
    live_control: {
      status: "idle",
      severity: "hidden",
      summary: "idle"
    },
    work_board: board(),
    sessions: [],
    ...overrides
  };
}

function daemon(overrides: Partial<SymphonyDaemonRecord> = {}): SymphonyDaemonRecord {
  return {
    daemon_id: "daemon-1",
    daemon_key: "daemon-key",
    status: "running",
    workflow_path: "E:\\Playground\\Swarm\\WORKFLOW.md",
    create_workspace: true,
    execute: false,
    tick_count: 0,
    created_at: GENERATED_AT,
    started_at: GENERATED_AT,
    updated_at: GENERATED_AT,
    history: [],
    ...overrides
  };
}
