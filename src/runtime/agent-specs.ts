export type AgentSpec = {
  id: string;
  name: string;
  role: "researcher" | "coder" | "reviewer" | "critic" | "verifier" | "architect" | "self_improver" | "handoff_specialist";
  description: string;
  when_to_use: string;
  capabilities: string[];
  tools: string[];
  write_policy: "read_only" | "scoped_write" | "workspace_write";
  default_budget: {
    max_turns: number;
    max_tool_calls: number;
  };
  output_contract: string;
  prompt: string;
};

export type AgentInvocationMode = "call_subagent" | "handoff" | "parallel";

export type AgentTaskPacket = {
  objective: string;
  agent_spec_id: string;
  invocation_mode: AgentInvocationMode;
  persona_snapshot: string;
  relevant_context?: string;
  file_scope: string[];
  allowed_tools: string[];
  write_policy: AgentSpec["write_policy"];
  budget: AgentSpec["default_budget"];
  expected_output: string;
  return_conditions: string[];
};

export type AgentInvocationRequest = {
  parent_session_id: string;
  requested_by: string;
  capability: string;
  task: string;
  context?: string;
  preferred_agent_spec_id?: string;
  preferred_mode?: AgentInvocationMode;
  file_scope?: string[];
  spawn_reason?: string;
};

export type AgentSpawnDecision = {
  agent_spec_id: string;
  invocation_mode: AgentInvocationMode;
  reason: string;
  confidence: number;
};

export const builtinAgentSpecs: AgentSpec[] = [
  {
    id: "researcher",
    name: "Research Agent",
    role: "researcher",
    description: "Read-only project explorer for code, logs, docs, and evidence gathering.",
    when_to_use: "Use for codebase reconnaissance, finding relevant files, summarizing logs, and gathering evidence before implementation.",
    capabilities: ["code.research", "file.search", "log.analysis", "docs.summarize"],
    tools: ["file.read", "file.list", "file.glob", "file.grep", "file.stat", "git.status", "git.diff", "git.log", "web.search", "web.fetch", "todo.write"],
    write_policy: "read_only",
    default_budget: { max_turns: 6, max_tool_calls: 24 },
    output_contract: "Return summary, evidence with paths, open questions, risks, and recommended next actions. Do not modify files.",
    prompt: "You are a precise read-only researcher. Gather grounded evidence and cite concrete files, commands, or outputs. Do not edit files."
  },
  {
    id: "coder",
    name: "Code Agent",
    role: "coder",
    description: "Scoped implementation worker for concrete code changes.",
    when_to_use: "Use when the main Swarm has a specific implementation spec with files or modules to change.",
    capabilities: ["code.edit", "code.implement", "project.create", "bug.fix"],
    tools: ["file.read", "file.list", "file.glob", "file.grep", "file.stat", "file.write", "file.edit", "shell.exec", "code.test", "code.lint", "git.status", "git.diff", "git.log", "todo.write"],
    write_policy: "scoped_write",
    default_budget: { max_turns: 8, max_tool_calls: 32 },
    output_contract: "Return summary, changed_files, tests_run, risks, and remaining work. Prefer durable fixes over symptoms.",
    prompt: "You are a scoped implementation worker. Read before editing, keep changes focused, verify when useful, and report changed files."
  },
  {
    id: "reviewer",
    name: "Review Agent",
    role: "reviewer",
    description: "Independent reviewer for diffs, behavior, tests, and regression risk.",
    when_to_use: "Use after code changes, before final answer, or when a worker result needs quality review.",
    capabilities: ["code.review", "diff.review", "test.review"],
    tools: ["file.read", "file.glob", "file.grep", "file.stat", "git.status", "git.diff", "git.log", "code.test", "code.lint", "todo.write"],
    write_policy: "read_only",
    default_budget: { max_turns: 5, max_tool_calls: 20 },
    output_contract: "Return verdict, findings by severity, evidence, required fixes, and test gaps.",
    prompt: "You are an independent reviewer. Prioritize bugs, regressions, missing tests, and unsupported claims. Do not rubber-stamp."
  },
  {
    id: "critic",
    name: "Critic Agent",
    role: "critic",
    description: "Adversarial risk finder for plans, architecture, and assumptions.",
    when_to_use: "Use for complex plans, security-sensitive changes, and self-iteration risk analysis.",
    capabilities: ["risk.analysis", "architecture.critique", "security.review"],
    tools: ["file.read", "file.glob", "file.grep", "file.stat", "git.status", "git.diff", "git.log", "todo.write"],
    write_policy: "read_only",
    default_budget: { max_turns: 5, max_tool_calls: 18 },
    output_contract: "Return risks, counterexamples, weak assumptions, and concrete mitigations.",
    prompt: "You are a skeptical critic. Look for what is wrong, incomplete, risky, or poorly verified."
  },
  {
    id: "verifier",
    name: "Verifier Agent",
    role: "verifier",
    description: "Fresh-eyes verification worker for commands, tests, and behavior checks.",
    when_to_use: "Use after implementation or self-improvement to prove changes work independently.",
    capabilities: ["verify", "test.run", "lint.run"],
    tools: ["file.read", "file.glob", "file.grep", "file.stat", "git.status", "git.diff", "git.log", "code.test", "code.lint", "shell.exec", "todo.write"],
    write_policy: "read_only",
    default_budget: { max_turns: 5, max_tool_calls: 18 },
    output_contract: "Return commands run, pass/fail status, evidence, and unresolved verification gaps.",
    prompt: "You are an independent verifier. Run relevant checks and investigate failures instead of dismissing them."
  },
  {
    id: "architect",
    name: "Architecture Agent",
    role: "architect",
    description: "System design and module-boundary specialist.",
    when_to_use: "Use for broad design, refactors, protocols, and decomposition before coding.",
    capabilities: ["architecture.design", "refactor.plan", "protocol.design"],
    tools: ["file.read", "file.list", "file.glob", "file.grep", "file.stat", "git.status", "git.diff", "todo.write"],
    write_policy: "read_only",
    default_budget: { max_turns: 6, max_tool_calls: 20 },
    output_contract: "Return design options, chosen approach, interfaces, migration steps, and risks.",
    prompt: "You are a pragmatic architect. Favor minimal interfaces, clear ownership, and implementable sequencing."
  },
  {
    id: "self_improver",
    name: "Self Improvement Agent",
    role: "self_improver",
    description: "Swarm self-iteration specialist that reads logs/evals and improves Swarm.",
    when_to_use: "Use when the task is to inspect Swarm behavior, diagnose failure modes, or improve this repository.",
    capabilities: ["self.review", "self.improve", "eval.design", "prompt.improve"],
    tools: ["file.read", "file.list", "file.glob", "file.grep", "file.stat", "file.write", "file.edit", "shell.exec", "code.test", "code.lint", "git.status", "git.diff", "git.log", "todo.write"],
    write_policy: "workspace_write",
    default_budget: { max_turns: 10, max_tool_calls: 40 },
    output_contract: "Return diagnosed failure mode, changed files, checks run, and remaining risks.",
    prompt: "You are Swarm's self-improvement agent. Improve Swarm itself using evidence from logs, traces, evals, and source code."
  },
  {
    id: "handoff_specialist",
    name: "Handoff Specialist",
    role: "handoff_specialist",
    description: "Long-context specialist for a focused task segment handed off by the main Swarm.",
    when_to_use: "Use for deep, focused work where preserving a specialized context across multiple tool turns is valuable.",
    capabilities: ["handoff.deep_work", "focused.execution"],
    tools: ["file.read", "file.list", "file.glob", "file.grep", "file.stat", "file.write", "file.edit", "shell.exec", "code.test", "code.lint", "git.status", "git.diff", "git.log", "todo.write"],
    write_policy: "scoped_write",
    default_budget: { max_turns: 10, max_tool_calls: 36 },
    output_contract: "Return handoff_result, changed_files, checks_run, handoff_back_reason, and unresolved questions.",
    prompt: "You are a focused handoff specialist. Own the delegated segment until done or blocked, then hand control back to the main Swarm."
  }
];

export function listAgentSpecs(): AgentSpec[] {
  return builtinAgentSpecs;
}

export function getAgentSpec(id: string): AgentSpec | undefined {
  return builtinAgentSpecs.find((spec) => spec.id === id);
}

export function renderAgentSpec(spec: AgentSpec): string {
  return [
    `${spec.id}: ${spec.name}`,
    `role=${spec.role}`,
    spec.description,
    "",
    `When to use: ${spec.when_to_use}`,
    `Write policy: ${spec.write_policy}`,
    `Budget: ${spec.default_budget.max_turns} turns / ${spec.default_budget.max_tool_calls} tools`,
    `Capabilities: ${spec.capabilities.join(", ")}`,
    `Tools: ${spec.tools.join(", ")}`,
    "",
    `Output contract: ${spec.output_contract}`,
    "",
    spec.prompt
  ].join("\n");
}
