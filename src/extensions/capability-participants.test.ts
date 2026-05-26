import { strict as assert } from "node:assert";
import test from "node:test";
import { buildCapabilityDirectory, evaluateCapabilityCandidate } from "./capability-directory.js";
import { buildCapabilityParticipantSnapshot } from "./capability-participants.js";
import type { McpServerRecord } from "./mcp.js";
import type { SkillRecord } from "./skills.js";
import type { CapabilityDescriptor } from "./types.js";
import type { LspStatusReport } from "../lsp/manager.js";
import type { AgentActorRecord } from "../storage/agent-actor-store.js";

test("capability participants expose MCP disabled Skill trust shadowing and LSP no-provider states", () => {
  const snapshot = buildCapabilityParticipantSnapshot({
    generatedAt: "2026-05-26T00:00:00.000Z",
    capabilities: [
      capability({ id: "mcp_tool.disabled_demo.search", kind: "mcp_tool", providerId: "mcp:disabled-demo", name: "mcp__disabled_demo__search" }),
      capability({ id: "skill.untrusted-reviewer", kind: "skill", providerId: "skills", name: "untrusted-reviewer" }),
      capability({ id: "lsp_tool.python.hover", kind: "lsp_tool", providerId: "lsp:python", name: "lsp.python.hover" })
    ],
    mcpServers: [mcpServer({ id: "disabled-demo", status: "disabled" })],
    skills: [
      skill({ name: "untrusted-reviewer", trust: "untrusted", scope: "project" }),
      skill({ name: "reviewer", path: "E:/workspace/.agents/skills/reviewer/SKILL.md", shadowedBy: "E:/workspace/.swarm/skills/reviewer/SKILL.md" })
    ],
    lspStatus: {
      workspace: "E:/workspace",
      generatedAt: "2026-05-26T00:00:00.000Z",
      providers: [{
        providerId: "python",
        root: "E:/workspace",
        status: "unavailable",
        languageIds: ["python"],
        logPath: "E:/workspace/.swarm/lsp/python.log",
        metadataPath: "E:/workspace/.swarm/lsp/python.json",
        detected: false,
        available: false,
        reason: "Install pyright-langserver or set SWARM_LSP_PYTHON_COMMAND.",
        capabilities: [{
          action: "lsp.hover",
          available: false,
          mode: "unavailable",
          fallback_reason: "provider_unavailable",
          next_action: "Install pyright-langserver or use file.grep/file.read."
        }]
      }]
    } satisfies LspStatusReport
  });

  assert.equal(snapshot.schema_version, "swarm.capability_participants.v1");
  assert.equal(snapshot.summary.total, 4);
  assert.equal(snapshot.summary.disabled, 1);
  assert.equal(snapshot.summary.untrusted, 1);
  assert.equal(snapshot.summary.shadowed, 1);
  assert.equal(snapshot.summary.no_provider, 1);

  const mcp = participant(snapshot, "capability:mcp:disabled-demo");
  assert.equal(mcp.kind, "mcp");
  assert.equal(mcp.state, "disabled");
  assert.equal(mcp.lease.required, true);
  assert.equal(mcp.lease.capability, "mcp:disabled-demo");
  assert.match(mcp.recoverySuggestion ?? "", /Enable MCP/);
  assert.match(mcp.recoverySuggestion ?? "", /capability lease/);
  assert.deepEqual(mcp.capability_ids, ["mcp_tool.disabled_demo.search"]);

  const untrusted = participant(snapshot, "capability:skill:untrusted-reviewer");
  assert.equal(untrusted.state, "untrusted");
  assert.match(untrusted.recoverySuggestion ?? "", /Trust the workspace/);
  assert.deepEqual(untrusted.capability_ids, ["skill.untrusted-reviewer"]);

  const shadowed = participant(snapshot, "capability:skill:reviewer");
  assert.equal(shadowed.state, "shadowed");
  assert.match(shadowed.recoverySuggestion ?? "", /shadowing/);

  const lsp = participant(snapshot, "capability:lsp:python");
  assert.equal(lsp.state, "no-provider");
  assert.equal(lsp.trust, "disabled");
  assert.equal(lsp.lease.required, true);
  assert.deepEqual(lsp.capability_ids, ["lsp_tool.python.hover"]);
  assert.match(lsp.recoverySuggestion ?? "", /Install pyright-langserver/);
});

test("capability directory aggregates actors and extension participants with leases and health", () => {
  const now = "2026-05-26T00:00:00.000Z";
  const capabilities = [
    capability({ id: "mcp_tool.disabled_demo.search", kind: "mcp_tool", providerId: "mcp:disabled-demo", name: "mcp__disabled_demo__search" }),
    capability({ id: "skill.reviewer", kind: "skill", source: "workspace", providerId: "skills", name: "reviewer" }),
    capability({ id: "lsp_tool.python.hover", kind: "lsp_tool", source: "lsp", providerId: "lsp:python", name: "lsp.python.hover", metadata: { languages: ["python"] } })
  ];
  const participants = buildCapabilityParticipantSnapshot({
    generatedAt: now,
    capabilities,
    mcpServers: [mcpServer({ id: "disabled-demo", status: "disabled" })],
    skills: [skill({ name: "reviewer" })],
    lspStatus: {
      workspace: "E:/workspace",
      generatedAt: now,
      providers: [{
        providerId: "python",
        root: "E:/workspace",
        status: "unavailable",
        languageIds: ["python"],
        logPath: "E:/workspace/.swarm/lsp/python.log",
        metadataPath: "E:/workspace/.swarm/lsp/python.json",
        detected: false,
        available: false,
        reason: "Install pyright-langserver or set SWARM_LSP_PYTHON_COMMAND.",
        capabilities: [{
          action: "lsp.hover",
          available: false,
          mode: "unavailable",
          fallback_reason: "provider_unavailable",
          next_action: "Install pyright-langserver or use file.grep/file.read."
        }]
      }]
    } satisfies LspStatusReport
  });
  const directory = buildCapabilityDirectory({
    generatedAt: now,
    now,
    actors: [actor({
      metadata: {
        tools: ["shell.exec"],
        languages: ["typescript"],
        skills: ["reviewer"],
        risk_level: "r2",
        cost_class: "low",
        cache_profile: "stable",
        autonomy_policy: {
          level: "execute",
          capability_leases: [
            { capability: "code.review", actions: ["task.accept"], source_envelope_id: "env-lease-active", expires_at: "2999-01-01T00:00:00.000Z" },
            { capability: "code.test", actions: ["task.accept"], source_envelope_id: "env-lease-expired", expires_at: "2000-01-01T00:00:00.000Z" },
            { capability: "code.deploy", status: "revoked", source_envelope_id: "env-lease-revoked" }
          ]
        }
      }
    })],
    capabilities,
    capabilityParticipants: participants
  });

  assert.equal(directory.schema_version, "swarm.capability_directory.v1");
  assert.equal(directory.summary.total, 4);
  assert.equal(directory.summary.by_kind.actor, 1);
  assert.equal(directory.summary.by_kind.mcp, 1);
  assert.equal(directory.summary.by_kind.skill, 1);
  assert.equal(directory.summary.by_kind.lsp, 1);

  const actorCard = card(directory, "worker:directory");
  assert.equal(actorCard.health.available, true);
  assert.deepEqual(actorCard.capability_ids, ["code.implement", "code.review"]);
  assert.deepEqual(actorCard.tools, ["shell.exec"]);
  assert.deepEqual(actorCard.languages, ["typescript"]);
  assert.deepEqual(actorCard.skills, ["reviewer"]);
  assert.equal(actorCard.risk_level, "r2");
  assert.equal(actorCard.cost_class, "low");
  assert.equal(actorCard.cache_profile, "stable");
  assert.deepEqual(actorCard.leases.active.map((lease) => lease.source_envelope_id), ["env-lease-active"]);
  assert.deepEqual(actorCard.leases.expired.map((lease) => lease.source_envelope_id), ["env-lease-expired"]);
  assert.deepEqual(actorCard.leases.revoked.map((lease) => lease.source_envelope_id), ["env-lease-revoked"]);

  const expiredCapability = evaluateCapabilityCandidate({
    card: actorCard,
    requiredCapabilities: ["code.test"]
  });
  assert.equal(expiredCapability.available, false);
  assert.deepEqual(expiredCapability.missing_capabilities, ["code.test"]);
  assert(expiredCapability.reasons.some((reason) => reason.includes("Missing required capabilities: code.test.")));

  const expiredLease = evaluateCapabilityCandidate({
    card: actorCard,
    requiredCapabilities: ["code.review"],
    leaseSourceEnvelopeId: "env-lease-expired",
    now
  });
  assert.equal(expiredLease.available, false);
  assert.deepEqual(expiredLease.matched_capabilities, ["code.review"]);
  assert(expiredLease.reasons.some((reason) => reason.includes("Capability lease env-lease-expired expired at 2000-01-01T00:00:00.000Z.")));

  const mcp = card(directory, "capability:mcp:disabled-demo");
  assert.equal(mcp.health.available, false);
  assert.match(mcp.health.reason ?? "", /Enable MCP/);
  assert.match(mcp.health.recoverySuggestion ?? "", /Enable MCP/);
  assert.deepEqual(mcp.capability_ids, ["mcp_tool.disabled_demo.search"]);

  const skillCard = card(directory, "capability:skill:reviewer");
  assert.equal(skillCard.health.available, true);
  assert.deepEqual(skillCard.capability_ids, ["skill.reviewer"]);
  assert.deepEqual(skillCard.skills, ["reviewer"]);

  const lsp = card(directory, "capability:lsp:python");
  assert.equal(lsp.health.available, false);
  assert.match(lsp.health.reason ?? "", /Install pyright-langserver/);
  assert.match(lsp.health.recoverySuggestion ?? "", /Install pyright-langserver/);
  assert.deepEqual(lsp.languages, ["python"]);
});

function participant(snapshot: ReturnType<typeof buildCapabilityParticipantSnapshot>, id: string) {
  const found = snapshot.participants.find((item) => item.participant_id === id);
  assert(found, `missing participant ${id}`);
  return found;
}

function card(snapshot: ReturnType<typeof buildCapabilityDirectory>, id: string) {
  const found = snapshot.cards.find((item) => item.participant_id === id);
  assert(found, `missing capability card ${id}`);
  return found;
}

function actor(overrides: Partial<AgentActorRecord> = {}): AgentActorRecord {
  return {
    actor_id: "worker:directory",
    kind: "worker",
    name: "Directory Worker",
    role: "coder",
    status: "idle",
    capabilities: ["code.implement"],
    load: { running_tasks: 0, max_tasks: 1 },
    heartbeat_state: "fresh",
    last_heartbeat_at: "2026-05-26T00:00:00.000Z",
    last_seen_at: "2026-05-26T00:00:00.000Z",
    registered_at: "2026-05-26T00:00:00.000Z",
    updated_at: "2026-05-26T00:00:00.000Z",
    metadata: {},
    ...overrides
  };
}

function mcpServer(overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    id: "demo",
    status: "connected",
    transport: "stdio",
    trust: "workspace",
    exposeTools: true,
    exposeResources: false,
    exposePrompts: false,
    toolCount: 0,
    resourceCount: 0,
    promptCount: 0,
    diagnostics: [],
    ...overrides
  };
}

function skill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  const name = overrides.name ?? "reviewer";
  return {
    name,
    displayName: name,
    description: `${name} skill`,
    path: `E:/workspace/.swarm/skills/${name}/SKILL.md`,
    directory: `E:/workspace/.swarm/skills/${name}`,
    scope: "user",
    trust: "trusted",
    frontmatter: {},
    allowedTools: [],
    resourcePaths: [],
    diagnostics: [],
    ...overrides
  };
}

function capability(overrides: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  const id = overrides.id ?? "capability.demo";
  return {
    id,
    kind: "mcp_tool",
    source: "mcp",
    trust: "trusted",
    providerId: "mcp:demo",
    name: id,
    description: "Test capability.",
    riskClass: "r0",
    permissionName: "Capability(Test)",
    modelVisible: false,
    userVisible: true,
    status: "available",
    ...overrides
  };
}
