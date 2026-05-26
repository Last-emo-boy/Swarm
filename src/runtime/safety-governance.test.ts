import { strict as assert } from "node:assert";
import test from "node:test";
import { defaultSwarmSettings } from "../config/settings.js";
import { createCapabilityApprovalRequest } from "../extensions/broker.js";
import type { CapabilityDescriptor } from "../extensions/types.js";
import { createEnvelope } from "../protocol/envelope.js";
import { createToolApprovalRequest, decideToolPermission } from "../tools/permissions.js";
import { decideEnvelopeAutonomy } from "./agent-autonomy-policy.js";
import {
  approvalEnvelopeForRequest,
  attachApprovalGovernance,
  buildApprovalGovernance,
  isApprovalGrantValid
} from "./safety-governance.js";

test("high risk action requires approval envelope", () => {
  const settings = defaultSwarmSettings();
  settings.permissions.defaultMode = "ask";
  const decision = decideToolPermission({ type: "shell.exec", command: "git reset --hard HEAD" }, settings, { workspace: process.cwd() });
  const request = createToolApprovalRequest({ type: "shell.exec", command: "git reset --hard HEAD" }, decision);
  request.session_id = "session-safety-1";
  request.task_id = "task-safety-1";
  attachApprovalGovernance(request, {
    status: "requested",
    actor_id: "worker:safety",
    decision_source: "test.policy",
    now: "2026-05-26T00:00:00.000Z"
  });

  const envelope = approvalEnvelopeForRequest(request, "pending", {
    actor_id: "policy_engine",
    swarm_id: "swarm-safety-1",
    now: "2026-05-26T00:00:00.000Z"
  });

  assert(envelope, "expected approval request envelope");
  assert.equal(envelope.type, "approval.request");
  assert.equal(envelope.payload.approval_id, request.id);
  assert.equal(envelope.payload.status, "requested");
  const governance = envelope.payload.governance as NonNullable<typeof request.governance>;
  assert.equal(governance.scope.actions[0], "shell.exec");
  assert.equal(governance.scope.target, request.target);
  assert.equal(governance.actor_binding.session_id, "session-safety-1");
  assert.equal(envelope.auth?.scopes?.includes("approval.governance"), true);
});

test("approval grant expires and blocks later action", () => {
  const request = createCapabilityApprovalRequest(
    testCapability(),
    { query: "symbols" },
    "session-safety-2",
    "task-safety-2",
    "gateway"
  );
  const grant = buildApprovalGovernance({
    request,
    status: "granted",
    actor_id: "worker:lsp",
    decision_source: "gateway.approval.decision",
    now: "2026-05-26T00:00:00.000Z",
    ttl_ms: 1000
  });

  const valid = isApprovalGrantValid(grant, {
    actor_id: "worker:lsp",
    session_id: "session-safety-2",
    task_id: "task-safety-2",
    action: "lsp.workspace_symbols",
    target: "lsp",
    now: "2026-05-26T00:00:00.500Z"
  });
  assert.equal(valid.valid, true);

  const expired = isApprovalGrantValid(grant, {
    actor_id: "worker:lsp",
    session_id: "session-safety-2",
    task_id: "task-safety-2",
    action: "lsp.workspace_symbols",
    target: "lsp",
    now: "2026-05-26T00:00:02.000Z"
  });
  assert.equal(expired.valid, false);
  assert.match(expired.reason, /expired/);

  const wrongActor = isApprovalGrantValid(grant, {
    actor_id: "worker:other",
    session_id: "session-safety-2",
    task_id: "task-safety-2",
    action: "lsp.workspace_symbols",
    target: "lsp",
    now: "2026-05-26T00:00:00.500Z"
  });
  assert.equal(wrongActor.valid, false);
  assert.match(wrongActor.reason, /bound to actor/);
});

test("yolo mode still records governance evidence", () => {
  const settings = defaultSwarmSettings();
  settings.permissions.defaultMode = "yolo";
  const action = { type: "shell.exec", command: "npm test" } as const;
  const decision = decideToolPermission(action, settings, { workspace: process.cwd() });
  const request = createToolApprovalRequest(action, decision);
  request.session_id = "session-safety-3";
  request.task_id = "task-safety-3";
  attachApprovalGovernance(request, {
    status: "evidence",
    actor_id: "worker:yolo",
    decision_source: "tool.permission",
    now: "2026-05-26T00:00:00.000Z"
  });

  assert.equal(decision.decision, "allow");
  assert.equal(request.governance?.status, "evidence");
  assert.equal(request.governance?.permission_mode, "yolo");
  assert.match(request.governance?.yolo_evidence ?? "", /Yolo permission mode/);

  const envelope = approvalEnvelopeForRequest(request, "approved", {
    actor_id: "worker:yolo",
    swarm_id: "swarm-safety-3",
    now: "2026-05-26T00:00:00.000Z"
  });
  assert.equal(envelope?.type, "approval.grant");
  assert.equal(envelope?.payload.permission_mode, "yolo");
});

test("approval grant envelope is gated above worker execute autonomy", () => {
  const request = createToolApprovalRequest({ type: "file.write", path: "src/a.ts", content: "x" });
  request.session_id = "session-safety-4";
  const envelope = approvalEnvelopeForRequest(request, "approved", {
    actor_id: "worker:plain",
    swarm_id: "swarm-safety-4"
  });
  assert(envelope);
  const assignment = createEnvelope({
    swarm_id: "swarm-safety-4",
    session_id: "session-safety-4",
    from: { agent_id: "worker:plain" },
    to: { agent_id: "main_swarm" },
    type: "task.accept",
    intent: "fixture",
    payload: {}
  });
  assert.equal(assignment.type, "task.accept");
  assert.equal(envelope.type, "approval.grant");
  const decision = decideEnvelopeAutonomy(envelope, {
    actor_id: "worker:plain",
    kind: "worker",
    name: "Plain Worker",
    role: "worker",
    status: "idle",
    capabilities: [],
    load: { running_tasks: 0, max_tasks: 1 },
    heartbeat_state: "fresh",
    last_seen_at: "2026-05-26T00:00:00.000Z",
    registered_at: "2026-05-26T00:00:00.000Z",
    updated_at: "2026-05-26T00:00:00.000Z",
    metadata: {
      autonomy_policy: { level: "execute" }
    }
  });
  assert.equal(decision.decision, "deny");
  assert.equal(decision.required_level, "approve_gated");
});

function testCapability(): CapabilityDescriptor {
  return {
    id: "lsp.workspace_symbols",
    kind: "lsp_tool",
    source: "lsp",
    trust: "trusted",
    providerId: "lsp",
    name: "lsp.workspace_symbols",
    description: "Search workspace symbols.",
    riskClass: "r1",
    permissionName: "Lsp(workspace_symbols)",
    modelVisible: true,
    userVisible: true,
    status: "available"
  };
}
