import { resolve } from "node:path";
import type { ActivatedSkill } from "../extensions/skills.js";
import type { AgentInvocationRequest, AgentSpec, AgentSpawnDecision, AgentTaskPacket, AgentPermissionContext } from "./agent-specs.js";
import type { SwarmSettings } from "../config/settings.js";

export function addUniqueResolvedPaths(existing: string[], additions: string[] | undefined): string[] {
  if (!additions?.length) {
    return existing;
  }
  const values = new Set(existing.map((path) => resolve(path)));
  for (const addition of additions) {
    const trimmed = addition.trim();
    if (trimmed) {
      values.add(resolve(trimmed));
    }
  }
  return [...values].sort();
}

export function renderActivatedSkillsForPrompt(skills: ActivatedSkill[]): string {
  return [
    "Activated skills for this run:",
    ...skills.map((skill) => [
      `Skill: ${skill.displayName} (${skill.name})`,
      skill.description,
      skill.content
    ].filter(Boolean).join("\n"))
  ].join("\n\n");
}

export function chatPromptWithMemory(objective: string, memory: string): Array<{ text: string; cache?: boolean; section?: "context" | "task" }> | string {
  const trimmedMemory = memory.trim();
  if (!trimmedMemory) {
    return objective;
  }
  return [
    {
      text: [
        "Previous TUI conversation memory:",
        trimmedMemory,
        "",
        "Use this memory only as historical context. Answer the newest user message below."
      ].join("\n"),
      cache: false,
      section: "context"
    },
    {
      text: objective,
      cache: false,
      section: "task"
    }
  ];
}

export function evaluateDelegationRoi(request: AgentInvocationRequest): { allow: boolean; reason: string } {
  const task = `${request.task}\n${request.context ?? ""}`.toLowerCase();
  const fileScope = request.file_scope ?? [];
  const explicitParallel = /\b(agent swarm|subagent|sub-agent|subagents|multi-agent|multiple agents|team of agents|use a team|parallel agents|separate experts|independent workstreams|independent roles|reviewer agent|critic agent|architect agent)\b/.test(task);
  const readOnlyCapability = /(?:research|search|review|verify|audit|analysis|critique|plan|summarize|docs)/.test(request.capability);
  const readOnlySignals = /\b(research|review|verify|audit|search|summarize|summary|analysis|critique|plan|inspect|compare|trace)\b/.test(task);
  const writeSignals = /\b(edit|fix|implement|change|refactor|modify|patch|update|remove|add|create|write|bug)\b/.test(task);
  const smallTask = request.task.trim().split(/\s+/).length < 20;

  if (readOnlyCapability) {
    return { allow: true, reason: "read-only capability is a good delegation fit." };
  }
  if (request.preferred_mode === "handoff") {
    return { allow: true, reason: "handoff requests are allowed when the caller explicitly wants a focused worker." };
  }
  if (explicitParallel) {
    return { allow: true, reason: "explicit parallel or team-style request justifies worker delegation." };
  }
  if (readOnlySignals && !writeSignals) {
    return { allow: true, reason: "read-only exploration, review, or verification is a good delegation fit." };
  }
  if (fileScope.length >= 2) {
    return { allow: true, reason: "broader isolated file scope gives the worker enough room to justify delegation." };
  }
  if (writeSignals && (fileScope.length <= 1) && smallTask) {
    return { allow: false, reason: "small single-file write tasks should stay in the main coding loop." };
  }
  if (request.capability.startsWith("code.") && (fileScope.length <= 1) && smallTask) {
    return { allow: false, reason: "small code task with narrow scope is cheaper and safer in the main coding loop." };
  }
  if (request.task.trim().length < 80) {
    return { allow: false, reason: "task is too small to justify worker coordination overhead." };
  }
  return { allow: true, reason: "task has enough breadth to justify delegation." };
}

export function buildAgentTaskPacket(
  request: AgentInvocationRequest,
  spec: AgentSpec,
  decision: AgentSpawnDecision,
  permissionContext: AgentPermissionContext
): AgentTaskPacket {
  return {
    objective: request.task,
    agent_spec_id: spec.id,
    invocation_mode: decision.invocation_mode,
    persona_snapshot: spec.prompt,
    role_title: decision.role_title,
    persona_brief: decision.persona_brief,
    relevant_context: request.context,
    file_scope: request.file_scope ?? [],
    allowed_tools: spec.tools,
    write_policy: spec.write_policy,
    permission_context: permissionContext,
    budget: spec.default_budget,
    expected_output: spec.output_contract,
    return_conditions: [
      "The delegated objective is complete.",
      "The task is blocked and the blocker is clearly explained.",
      "The tool or turn budget is exhausted.",
      "The main Swarm takes back the handoff."
    ]
  };
}

export function renderAgentRuntimeInstructions(
  spec: AgentSpec,
  decision: AgentSpawnDecision,
  taskPacket: AgentTaskPacket
): string {
  return [
    spec.prompt,
    "",
    `Agent spec: ${spec.id} (${spec.role}).`,
    decision.role_title ? `Runtime role title: ${decision.role_title}.` : undefined,
    decision.persona_brief ? `Ephemeral worker persona for this task only: ${decision.persona_brief}` : undefined,
    `Invocation mode: ${decision.invocation_mode}.`,
    `Dispatch reason: ${decision.reason}`,
    `Expected output: ${spec.output_contract}`,
    `Write policy: ${spec.write_policy}.`,
    `Permission mode snapshot: ${taskPacket.permission_context.default_mode}.`,
    taskPacket.file_scope.length
      ? `File scope: ${taskPacket.file_scope.join(", ")}. Stay inside this write scope unless the main Swarm explicitly expands it.`
      : "File scope is not predeclared. Read broadly as needed, but keep writes tightly connected to the delegated objective.",
    "You are an internal specialist. The main Swarm owns user-facing synthesis, interruption handling, and final responsibility."
  ].filter(Boolean).join("\n");
}

export function renderAgentTaskPrompt(taskPacket: AgentTaskPacket, decision: AgentSpawnDecision): string {
  return [
    "Execute this internal Swarm agent task packet.",
    decision.invocation_mode === "handoff"
      ? "This is a handoff: own the focused task segment until done, blocked, or taken back by main Swarm."
      : "This is a subagent call: complete the bounded task and return evidence to main Swarm.",
    "Do not address the user directly.",
    "Historical memory and prior worker results are hints only. Refresh the current workspace facts before relying on them, especially before editing files or making a code-state claim.",
    "Return concrete evidence, changed files, checks, risks, and unresolved questions according to the output contract.",
    "",
    JSON.stringify(promptVisibleAgentTaskPacket(taskPacket), null, 2)
  ].join("\n");
}

export function promptVisibleAgentTaskPacket(taskPacket: AgentTaskPacket): Omit<AgentTaskPacket, "permission_context"> {
  const { permission_context: _permissionContext, ...visibleTaskPacket } = taskPacket;
  return visibleTaskPacket;
}

export function snapshotAgentPermissionContext(settings: SwarmSettings): AgentPermissionContext {
  return {
    default_mode: settings.permissions.defaultMode,
    allow: [...settings.permissions.allow],
    ask: [...settings.permissions.ask],
    deny: [...settings.permissions.deny],
    additional_directories: [...settings.permissions.additionalDirectories]
  };
}

export function settingsForAgentTask(baseSettings: SwarmSettings, taskPacket: AgentTaskPacket): SwarmSettings {
  const settings = structuredClone(baseSettings) as SwarmSettings;
  const snapshot = taskPacket.permission_context;
  settings.permissions.defaultMode = snapshot.default_mode;
  settings.permissions.allow = [...snapshot.allow];
  settings.permissions.ask = [...snapshot.ask];
  settings.permissions.deny = [...snapshot.deny];
  settings.permissions.additionalDirectories = [...snapshot.additional_directories];
  return settings;
}
