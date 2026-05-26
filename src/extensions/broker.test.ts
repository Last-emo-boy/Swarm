import { strict as assert } from "node:assert";
import test from "node:test";
import { defaultSwarmSettings } from "../config/settings.js";
import type { ToolApprovalRequest, ToolResult } from "../tools/types.js";
import { CapabilityBroker } from "./broker.js";
import type { CapabilityPlane } from "./capability-plane.js";
import type { CapabilityDescriptor } from "./types.js";

test("CapabilityBroker failure metadata links disabled capability to lease and envelope evidence", async () => {
  const capability = testCapability({
    id: "mcp_tool.disabled_demo.search",
    kind: "mcp_tool",
    source: "mcp",
    trust: "disabled",
    providerId: "mcp:disabled-demo",
    name: "mcp__disabled_demo__search",
    permissionName: "McpTool(disabled-demo:search)",
    status: "disabled"
  });
  const events: Array<{ task_id: string; status?: string; recoverySuggestion?: string }> = [];
  const broker = brokerForCapability(capability, events);

  const result = await broker.invoke(
    capability.id,
    { query: "symbol" },
    "session-capability-1",
    { taskId: "task-capability-1", source: "gateway", writePolicy: "read_only" }
  );

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "CAPABILITY_INVOKE_FAILED");
  assert.match(result.recoverySuggestion ?? "", /capability diagnostics/);
  assert.equal(events[0]?.task_id, "task-capability-1");
  assert.equal(events[0]?.status, "failed");

  const metadata = record(result.metadata);
  assert.equal(metadata.capability_id, capability.id);
  assert.equal(metadata.provider_id, "mcp:disabled-demo");
  assert.equal(metadata.participant_id, "capability:mcp:disabled-demo");

  const lease = record(metadata.capability_lease);
  assert.equal(lease.required, true);
  assert.equal(lease.capability, capability.id);
  assert.equal(lease.provider_id, "mcp:disabled-demo");
  assert.equal(lease.source, "gateway");
  assert.equal(lease.write_policy, "read_only");

  const evidence = record(metadata.envelope_evidence);
  assert.equal(evidence.schema_version, "swarm.capability_envelope_evidence.v1");
  assert.equal(evidence.actor_id, "gateway.local");
  assert.equal(evidence.session_id, "session-capability-1");
  assert.equal(evidence.task_id, "task-capability-1");
  assert.equal(evidence.capability_id, capability.id);
  assert.equal(evidence.provider_id, "mcp:disabled-demo");
  assert.equal(evidence.participant_id, "capability:mcp:disabled-demo");
  assert.equal(evidence.source, "gateway");
  assert.equal(evidence.envelope_type, "task.progress");
  assert.equal(evidence.intent, "capability.invoke");
});

test("CapabilityBroker failure metadata preserves skill participant evidence for untrusted capability", async () => {
  const capability = testCapability({
    id: "skill.project-reviewer",
    kind: "skill",
    source: "project",
    trust: "untrusted",
    providerId: "skills",
    name: "project-reviewer",
    permissionName: "Skill(project-reviewer)",
    status: "available"
  });
  const broker = brokerForCapability(capability, []);

  const result = await broker.invoke(
    capability.id,
    { reason: "review task" },
    "session-skill-1",
    { taskId: "task-skill-1", source: "coding_loop" }
  );

  assert.equal(result.status, "failed");
  assert.match(result.summary, /not trusted/);
  assert.equal(result.retryable, true);
  assert.equal(result.recoverable, true);

  const metadata = record(result.metadata);
  assert.equal(metadata.participant_id, "capability:skill:project-reviewer");
  const lease = record(metadata.capability_lease);
  assert.equal(lease.required, true);
  assert.equal(lease.source, "coding_loop");
  const evidence = record(metadata.envelope_evidence);
  assert.equal(evidence.actor_id, "main_swarm");
  assert.equal(evidence.session_id, "session-skill-1");
  assert.equal(evidence.task_id, "task-skill-1");
});

function brokerForCapability(
  capability: CapabilityDescriptor,
  events: Array<{ task_id: string; status?: string; recoverySuggestion?: string }>
): CapabilityBroker {
  return new CapabilityBroker({
    capabilityPlane: {
      getCapability: async (id: string) => id === capability.id ? capability : undefined,
      callMcpTool: async (): Promise<ToolResult> => ({
        action: capability.name,
        status: "success",
        summary: "not reached"
      })
    } as unknown as CapabilityPlane,
    settings: defaultSwarmSettings(),
    workspaceForSession: () => "E:/workspace",
    approvalHandler: async () => true,
    emitApproval: (_request: ToolApprovalRequest) => undefined,
    emitToolResult: (event) => events.push({
      task_id: event.task_id,
      status: event.status,
      recoverySuggestion: event.recoverySuggestion
    }),
    activateSkill: (name) => ({
      name,
      displayName: name,
      description: "test skill",
      path: "E:/workspace/.swarm/skills/test/SKILL.md",
      directory: "E:/workspace/.swarm/skills/test",
      allowedTools: [],
      resourcePaths: [],
      activatedAt: "2026-05-26T00:00:00.000Z",
      content: "test skill",
      scope: "project",
      trust: "trusted"
    })
  });
}

function testCapability(overrides: Partial<CapabilityDescriptor>): CapabilityDescriptor {
  return {
    id: "capability.test",
    kind: "mcp_tool",
    source: "mcp",
    trust: "trusted",
    providerId: "mcp:test",
    name: "capability.test",
    description: "Test capability.",
    riskClass: "r0",
    permissionName: "Capability(Test)",
    modelVisible: false,
    userVisible: true,
    status: "available",
    ...overrides
  };
}

function record(value: unknown): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
