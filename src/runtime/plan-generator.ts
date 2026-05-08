import type { GeneratedPlan } from "../protocol/types.js";
import { OpenAIProvider } from "../providers/openai-provider.js";
import { renderHostEnvironmentPrompt } from "./host-context.js";

const PLAN_GENERATOR_MAX_OUTPUT_TOKENS = 6_000;
const PLAN_REPAIR_MAX_OUTPUT_TOKENS = 2_000;

export class PlanGenerator {
  constructor(private readonly provider: OpenAIProvider, private readonly workspace = process.cwd()) {}

  async generate(objective: string): Promise<GeneratedPlan> {
    const first = await this.provider.generateText({
      model: this.provider.model,
      system: [{ text: plannerSystemPrompt(this.workspace), cache: true }],
      user: JSON.stringify({ objective, output_contract: plannerOutputContract() }, null, 2),
      usage: { purpose: "plan_generator" },
      maxOutputTokens: PLAN_GENERATOR_MAX_OUTPUT_TOKENS
    });

    const firstResult = parseAndNormalizePlan(first, objective);
    if (firstResult.plan) {
      return firstResult.plan;
    }

    const repaired = await this.provider.generateText({
      model: this.provider.model,
      system: [{ text: plannerRepairPrompt(), cache: true }],
      user: JSON.stringify(
        {
          objective,
          parse_error: firstResult.error,
          invalid_output: first,
          output_contract: plannerOutputContract()
        },
        null,
        2
      ),
      usage: { purpose: "plan_generator_repair" },
      maxOutputTokens: PLAN_REPAIR_MAX_OUTPUT_TOKENS
    });
    const repairedResult = parseAndNormalizePlan(repaired, objective);
    if (repairedResult.plan) {
      return repairedResult.plan;
    }

    throw new Error(
      [
        "Planner returned invalid JSON and no swarm plan could be created.",
        `Initial parse error: ${firstResult.error}`,
        `Repair parse error: ${repairedResult.error}`,
        `Initial output excerpt: ${excerpt(first)}`
      ].join("\n")
    );
  }
}

function plannerSystemPrompt(workspace = process.cwd()): string {
  return [
    "You are Swarm Planner, the planning component of a local coding-agent CLI.",
    "Your only job is to emit one valid JSON object for the runtime. The runtime will parse your response with JSON.parse.",
    renderHostEnvironmentPrompt(workspace),
    "",
    "Hard output rules:",
    "1. Output JSON only. The first non-whitespace character must be { and the last non-whitespace character must be }.",
    "2. Do not use Markdown fences, comments, prose, XML tags, YAML, TypeScript, or trailing commas.",
    "3. Use double-quoted JSON strings only.",
    "4. Include intent: inspect_only, modify_workspace, create_project, or report_only.",
    "5. Include 2 to 5 tasks. Do not include review or aggregation tasks; the runtime adds them.",
    "6. Every task must include required_capabilities with exactly one primary capability from the allowed list.",
    "7. Tool tasks must include inputs.action matching the capability.",
    "8. For file.read, prefer a single inputs.path. If multiple small files must be read together, inputs.paths may be an array of paths.",
    "9. Prefer discovery before reading: file.glob or file.grep first, then file.read with line ranges for targeted files.",
    "10. Do not assume a src directory exists. For audits and broad searches, use root=\".\" unless an earlier discovery task proves a narrower directory exists.",
    "11. Avoid shell-style brace expansion unless necessary; simple patterns such as **/*.ts or **/*.json are easier for tools.",
    "12. Never plan direct reads of secrets or local credentials: .env, .env.*, secrets/**, config/credentials.json, or **/.swarm/config.json.",
    "13. For code audit requests, include at least one source-code file.read task, not only manifests/config files.",
    "14. For TypeScript/JavaScript CLI repositories, likely source files include src/index.ts, src/config/settings.ts, src/runtime/orchestrator.ts, src/agents/child-entry.ts, and src/tools/local-tools.ts. Missing files are acceptable; the tool will report them.",
    "15. For code audit requests, plan to inspect manifests/configs, search risky patterns, read focused code regions, then synthesize findings.",
    "16. Never write files or run shell commands for an audit unless the user explicitly requested code changes or command execution.",
    "17. Swarm is a local coding CLI: for build, fix, refactor, or create-project requests, the final product is real workspace file changes, not a report artifact.",
    "18. For modification requests, include read/discovery tasks before edit/write tasks, then include a Bash verification task when a local command is useful.",
    "19. Before editing an existing file, include a full file.read for that file. Line-range reads are fine for inspection, but edits require a full current view.",
    "20. For multi-step implementation tasks, todo.write may be used to keep an explicit task checklist, but it is not a substitute for real file changes.",
    "21. For from-scratch project creation, create normal project files in the workspace paths the user would expect; do not create the final project under .swarm.",
    "22. Do not set final_artifact unless the user explicitly asks to save/export/write a report or output file. Never use .swarm/artifacts as the default final output path.",
    "23. Do not use placeholder content in Write. Write.content must be complete literal file content ready to persist.",
    "24. If content must be generated by an agent, do not plan a Write placeholder. Use an analysis, design.reason, code.inspect, or research.summarize task, or let coding_loop handle the implementation.",
    "25. Bash commands must use the host shell syntax from the host environment section. On Windows, write PowerShell commands, not POSIX shell scripts.",
    "",
    "Allowed capabilities and required input actions:",
    "- Read -> inputs.action=\"Read\"",
    "- Glob -> inputs.action=\"Glob\"",
    "- Grep -> inputs.action=\"Grep\"",
    "- Write -> inputs.action=\"Write\"",
    "- Edit -> inputs.action=\"Edit\"",
    "- NotebookEdit -> inputs.action=\"NotebookEdit\"",
    "- TodoWrite -> inputs.action=\"TodoWrite\"",
    "- BlackboardWrite -> inputs.action=\"BlackboardWrite\"",
    "- BlackboardSearch -> inputs.action=\"BlackboardSearch\"",
    "- BlackboardRead -> inputs.action=\"BlackboardRead\"",
    "- BlackboardList -> inputs.action=\"BlackboardList\"",
    "- Bash -> inputs.action=\"Bash\"",
    "- WebSearch -> inputs.action=\"WebSearch\"",
    "- WebFetch -> inputs.action=\"WebFetch\"",
    "- Do not use Agent or agent.delegate in full-swarm plans; the full swarm orchestrator already assigns each task by required_capabilities.",
    "- If a plan idea looks like delegation, express it as a normal task with a direct capability such as analysis.synthesize, research.summarize, code.inspect, or design.reason.",
    "- analysis.synthesize",
    "- research.summarize",
    "- code.inspect",
    "- design.reason",
    "",
    "Valid JSON example:",
    JSON.stringify(
      {
        objective: "Audit this codebase and report risks.",
        intent: "inspect_only",
        summary: "Inspect the local project structure, search for risky patterns, read targeted files, and synthesize a final response.",
        tasks: [
          {
            task_id: "task_discover_files",
            title: "Discover project files",
            description: "Find source and configuration files relevant to the audit.",
            objective: "Identify the files to inspect without reading large content yet.",
            type: "tool_call",
            status: "pending",
          required_capabilities: ["Glob"],
          inputs: {
              action: "Glob",
              root: ".",
              pattern: "**/*.{ts,tsx,js,jsx,json,md,py,yml,yaml,toml}",
              maxResults: 200
            },
            expected_output: { format: "json" }
          },
          {
            task_id: "task_read_source",
            title: "Read key source files",
            description: "Read likely source entry points and tool/runtime files for direct code evidence.",
            objective: "Collect source code evidence for the audit.",
            type: "tool_call",
            status: "pending",
            required_capabilities: ["Read"],
            inputs: {
              action: "Read",
              paths: ["package.json", "tsconfig.json", "src/index.ts", "src/runtime/orchestrator.ts", "src/agents/child-entry.ts"],
              startLine: 1,
              endLine: -1
            },
            expected_output: { format: "text" },
            dependencies: ["task_discover_files"]
          },
          {
            task_id: "task_search_risks",
            title: "Search for risky code patterns",
            description: "Search for file system, shell, network, auth, and unsafe parsing patterns.",
            objective: "Collect candidate risk locations with line numbers.",
            type: "tool_call",
            status: "pending",
            required_capabilities: ["Grep"],
            inputs: {
              action: "Grep",
              root: ".",
              pattern: "exec|spawn|writeFile|readFile|eval|JSON\\.parse|apiKey|password|token|permission",
              maxMatches: 120,
              contextLines: 1
            },
            expected_output: { format: "json" },
            dependencies: ["task_discover_files"]
          },
          {
            task_id: "task_audit_synthesis",
            title: "Synthesize audit findings",
            description: "Use discovered files and risk matches to produce a concise audit report.",
            objective: "Report concrete risks, evidence, severity, and suggested fixes.",
            type: "analysis",
            status: "pending",
            required_capabilities: ["code.inspect"],
            inputs: {},
            expected_output: { format: "markdown" },
            dependencies: ["task_read_source", "task_search_risks"],
            acceptance_criteria: ["Include severity", "Include file or line evidence when available", "Avoid unsupported claims"]
          }
        ],
        final_artifact: undefined
      },
      null,
      2
    )
  ].join("\n");
}

function plannerRepairPrompt(): string {
  return [
    "You repair invalid Swarm planner output.",
    "Return exactly one valid JSON object matching the provided contract.",
    "Preserve the user's objective and useful plan intent, but fix syntax, missing fields, invalid capabilities, trailing commas, Markdown fences, and prose.",
    "The first non-whitespace character must be { and the last non-whitespace character must be }.",
    "Do not explain the repair."
  ].join("\n");
}

function plannerOutputContract(): Record<string, unknown> {
  return {
    root: {
      objective: "string",
      summary: "string",
      intent: "optional 'inspect_only' | 'modify_workspace' | 'create_project' | 'report_only'",
      tasks: "array of 2-5 SwarmTask objects",
      final_artifact: "optional only when the user explicitly asked to save/export/write an output file; { path: string, format: 'markdown' | 'json' | 'text' }"
    },
    task_required_fields: {
      task_id: "string",
      title: "string",
      description: "string",
      objective: "string",
      type: "research | coding | analysis | review | tool_call | planning | aggregation",
      status: "pending",
      required_capabilities: "array with exactly one allowed capability",
      inputs: "object",
      expected_output: "{ format: 'text' | 'json' | 'markdown' | 'artifact' | 'patch' }",
      dependencies: "optional string[]",
      acceptance_criteria: "optional string[]"
    },
    allowed_capabilities: [...ALLOWED_CAPABILITIES]
  };
}

function parseAndNormalizePlan(text: string, objective: string): { plan?: GeneratedPlan; error?: string } {
  const parsed = parsePlan(text);
  if (!parsed) {
    return { error: "No valid JSON object was found." };
  }
  try {
    return { plan: normalizePlan(parsed, objective) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function normalizeGeneratedPlanForRuntime(plan: GeneratedPlan, objective: string): GeneratedPlan {
  return normalizePlan(plan, objective);
}

function parsePlan(text: string): GeneratedPlan | undefined {
  const candidates = extractJsonCandidates(text);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as GeneratedPlan;
    } catch {
      const cleaned = cleanJsonCandidate(candidate);
      try {
        return JSON.parse(cleaned) as GeneratedPlan;
      } catch {
        // Try the next candidate.
      }
    }
  }
  return undefined;
}

function extractJsonCandidates(text: string): string[] {
  const trimmed = text.trim();
  const candidates = new Set<string>();
  if (trimmed) {
    candidates.add(stripMarkdownFence(trimmed));
  }

  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1]?.trim()).filter(Boolean);
  for (const candidate of fenced) {
    candidates.add(candidate);
  }

  const balanced = extractBalancedJsonObjects(text);
  for (const candidate of balanced) {
    candidates.add(candidate);
  }

  return [...candidates].filter(Boolean);
}

function stripMarkdownFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : text;
}

function extractBalancedJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return objects.sort((a, b) => b.length - a.length);
}

function cleanJsonCandidate(candidate: string): string {
  return candidate
    .replace(/^\uFEFF/, "")
    .replace(/,\s*([}\]])/g, "$1")
    .trim();
}

function normalizePlan(plan: GeneratedPlan, objective: string): GeneratedPlan {
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    throw new Error("Planner returned a plan with no tasks.");
  }

  const normalized: GeneratedPlan = {
    objective: typeof plan.objective === "string" && plan.objective.trim() ? plan.objective : objective,
    summary: typeof plan.summary === "string" && plan.summary.trim() ? plan.summary : "Generated swarm plan.",
    intent: normalizePlanIntent(plan.intent, objective),
    tasks: plan.tasks.map((task, index) => {
      const capability = normalizeCapability(firstNonEmptyCapability(task.required_capabilities) ?? inferCapability(task), task);
      const inputs = task.inputs && typeof task.inputs === "object" ? task.inputs : {};
      const normalizedInputs = normalizeInputsForCapability(inputs, capability);
      validateGeneratedToolInputs(capability, normalizedInputs);
      const type = normalizeTaskType(task.type, capability);
      return {
        task_id: task.task_id || `task_${index + 1}`,
        title: task.title || `Task ${index + 1}`,
        description: task.description || task.objective || "Run swarm task.",
        objective: task.objective || objective,
        type,
        status: "pending",
        required_capabilities: [capability],
        inputs: normalizedInputs,
        expected_output: task.expected_output ?? { format: "markdown" },
        dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
        constraints: Array.isArray(task.constraints) ? task.constraints : [],
        acceptance_criteria: Array.isArray(task.acceptance_criteria) ? task.acceptance_criteria : []
      };
    })
  };
  const finalArtifact = normalizeFinalArtifact(plan.final_artifact, objective);
  if (finalArtifact) {
    normalized.final_artifact = finalArtifact;
  }
  return normalized;
}

function normalizeFinalArtifact(
  artifact: GeneratedPlan["final_artifact"] | undefined,
  objective: string
): GeneratedPlan["final_artifact"] | undefined {
  if (!artifact?.path || !explicitOutputFileRequested(objective)) {
    return undefined;
  }
  const path = artifact.path.replace(/\\/g, "/");
  if (path.startsWith(".swarm/") || path.includes("/.swarm/")) {
    return undefined;
  }
  return {
    path: artifact.path,
    format: artifact.format === "json" || artifact.format === "text" ? artifact.format : "markdown"
  };
}

function normalizePlanIntent(value: unknown, objective: string): GeneratedPlan["intent"] {
  if (value === "inspect_only" || value === "modify_workspace" || value === "create_project" || value === "report_only") {
    return value;
  }
  const text = objective.toLowerCase();
  if (["create", "scaffold", "new project", "from scratch", "从零", "新建项目", "创建项目"].some((keyword) => text.includes(keyword))) {
    return "create_project";
  }
  if (["fix", "implement", "add", "change", "refactor", "update", "修改", "修复", "实现", "加入", "新增", "迭代"].some((keyword) => text.includes(keyword))) {
    return "modify_workspace";
  }
  if (explicitOutputFileRequested(objective)) {
    return "report_only";
  }
  return "inspect_only";
}

function explicitOutputFileRequested(objective: string): boolean {
  const text = objective.toLowerCase();
  return [
    "save",
    "export",
    "write a report",
    "write report",
    "output file",
    "生成报告",
    "保存",
    "导出",
    "写入",
    "输出到",
    "保存到"
  ].some((keyword) => text.includes(keyword));
}

function inferCapability(task: Partial<GeneratedPlan["tasks"][number]>): string {
  const action = String(task.inputs?.action ?? "").trim();
  if (["Read", "read_file", "file.read", "tool.file.read"].includes(action)) {
    return "Read";
  }
  if (["LS", "list_files", "file.list", "tool.file.list"].includes(action)) {
    return "Read";
  }
  if (["Grep", "grep", "file.grep", "tool.file.grep"].includes(action)) {
    return "Grep";
  }
  if (["Glob", "glob", "file.glob", "tool.file.glob"].includes(action)) {
    return "Glob";
  }
  if (["stat", "file.stat", "tool.file.stat"].includes(action)) {
    return "Read";
  }
  if (["Write", "write_file", "file.write", "tool.file.write"].includes(action)) {
    return "Write";
  }
  if (["Edit", "edit_file", "file.edit", "tool.file.edit"].includes(action)) {
    return "Edit";
  }
  if (["NotebookEdit", "notebook_edit", "notebook.edit"].includes(action)) {
    return "NotebookEdit";
  }
  if (["Bash", "bash", "shell", "shell.exec", "tool.shell.exec"].includes(action)) {
    return "Bash";
  }
  if (["exec"].includes(action)) {
    return "Bash";
  }
  if (["WebSearch", "web_search", "web.search"].includes(action)) {
    return "WebSearch";
  }
  if (["WebFetch", "web_fetch", "web.fetch", "fetch"].includes(action)) {
    return "WebFetch";
  }
  if (["BlackboardWrite", "blackboard_write", "blackboard.write"].includes(action)) {
    return "BlackboardWrite";
  }
  if (["BlackboardSearch", "blackboard_search", "blackboard.search"].includes(action)) {
    return "BlackboardSearch";
  }
  if (["BlackboardRead", "blackboard_read", "blackboard.read"].includes(action)) {
    return "BlackboardRead";
  }
  if (["BlackboardList", "blackboard_list", "blackboard.list"].includes(action)) {
    return "BlackboardList";
  }
  if (["code_test", "code.test", "run_tests", "run.test", "test"].includes(action)) {
    return "Bash";
  }
  if (["code_lint", "code.lint", "lint"].includes(action)) {
    return "Bash";
  }
  if (["git_status", "git.status"].includes(action)) {
    return "Bash";
  }
  if (["git_diff", "git.diff"].includes(action)) {
    return "Bash";
  }
  if (["git_log", "git.log"].includes(action)) {
    return "Bash";
  }
  if (["git_branch", "git.branch"].includes(action)) {
    return "Bash";
  }
  if (["package_install", "package.install", "install"].includes(action)) {
    return "Bash";
  }
  if (["Agent", "Task", "agent_delegate", "agent.delegate", "delegate"].includes(action)) {
    return "Agent";
  }
  if (task.type === "tool_call") {
    return "Read";
  }
  return "analysis.synthesize";
}

const TOOL_CAPABILITY_ACTIONS: Record<string, string> = {
  "Read": "Read",
  "Glob": "Glob",
  "Grep": "Grep",
  "Write": "Write",
  "Edit": "Edit",
  "NotebookEdit": "NotebookEdit",
  "TodoWrite": "TodoWrite",
  "BlackboardWrite": "BlackboardWrite",
  "BlackboardSearch": "BlackboardSearch",
  "BlackboardRead": "BlackboardRead",
  "BlackboardList": "BlackboardList",
  "Bash": "Bash",
  "WebSearch": "WebSearch",
  "WebFetch": "WebFetch",
  "tool.file.read": "file.read",
  "tool.file.glob": "file.glob",
  "tool.file.grep": "file.grep",
  "tool.file.write": "file.write",
  "tool.file.edit": "file.edit",
  "todo.write": "todo.write",
  "blackboard.write": "blackboard.write",
  "blackboard.search": "blackboard.search",
  "blackboard.read": "blackboard.read",
  "blackboard.list": "blackboard.list",
  "tool.shell.exec": "shell.exec",
  "web.search": "web.search",
  "web.fetch": "web.fetch"
};

const ALLOWED_CAPABILITIES = new Set([
  ...Object.keys(TOOL_CAPABILITY_ACTIONS),
  "analysis.synthesize",
  "research.summarize",
  "code.inspect",
  "design.reason"
]);

function normalizeCapability(capability: string, task: Partial<GeneratedPlan["tasks"][number]>): string {
  const trimmed = capability.trim();
  if (isDelegateToolAction(trimmed)) {
    return requiredNestedDelegateCapability(task);
  }
  if (ALLOWED_CAPABILITIES.has(trimmed)) {
    return trimmed;
  }
  const inferred = inferCapability(task);
  if (isDelegateToolAction(inferred)) {
    return requiredNestedDelegateCapability(task);
  }
  if (ALLOWED_CAPABILITIES.has(inferred)) {
    return inferred;
  }
  return "analysis.synthesize";
}

function nestedDelegateCapability(task: Partial<GeneratedPlan["tasks"][number]>): string | undefined {
  const inputs = task.inputs && typeof task.inputs === "object" ? task.inputs : {};
  const capability = typeof inputs.capability === "string" ? inputs.capability.trim() : "";
  return capability && ALLOWED_CAPABILITIES.has(capability) ? capability : undefined;
}

function requiredNestedDelegateCapability(task: Partial<GeneratedPlan["tasks"][number]>): string {
  const capability = nestedDelegateCapability(task);
  if (capability) {
    return capability;
  }
  throw new Error("Planner returned agent.delegate without inputs.capability. Full-swarm plans must use direct required_capabilities.");
}

function firstNonEmptyCapability(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map(String).map((item) => item.trim()).find(Boolean);
}

function normalizeInputsForCapability(inputs: Record<string, unknown>, capability: string): Record<string, unknown> {
  const action = TOOL_CAPABILITY_ACTIONS[capability];
  if (!action) {
    if (isDelegateToolAction(inputs.action)) {
      const { action: _action, capability: _capability, ...rest } = inputs;
      return rest;
    }
    return inputs;
  }
  return { ...inputs, action };
}

function validateGeneratedToolInputs(capability: string, inputs: Record<string, unknown>): void {
  const action = typeof inputs.action === "string" ? inputs.action : TOOL_CAPABILITY_ACTIONS[capability];
  if ((capability === "Write" || capability === "tool.file.write" || action === "Write" || action === "file.write") && looksLikePlaceholderWrite(inputs.content)) {
    throw new Error("Planner returned placeholder Write.content. Write.content must be complete literal file content.");
  }
  if ((capability === "Bash" || capability === "tool.shell.exec" || action === "Bash" || action === "shell.exec") && process.platform === "win32") {
    const command = typeof inputs.command === "string" ? inputs.command : "";
    if (usesPowerShellIncompatiblePosix(command)) {
      throw new Error("Planner returned a POSIX-only Bash command for a Windows PowerShell host.");
    }
  }
}

function looksLikePlaceholderWrite(content: unknown): boolean {
  if (typeof content !== "string") {
    return false;
  }
  const normalized = content.toLowerCase();
  return [
    "待代理",
    "自主生成完整",
    "placeholder",
    "to be generated by",
    "agent should generate",
    "<todo>",
    "<placeholder>"
  ].some((marker) => normalized.includes(marker));
}

function usesPowerShellIncompatiblePosix(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || explicitlyInvokesAlternateShell(trimmed)) {
    return false;
  }
  return [
    /\bmkdir\s+-p\b/i,
    /<<\s*['"]?EOF['"]?/i,
    /\bcat\s+>\s+\S+\s+<</i,
    /\bcd\s+\$\(pwd\)/i,
    /\s&&\s/,
    /(^|\s)&\s*sleep\b/i
  ].some((pattern) => pattern.test(trimmed));
}

function explicitlyInvokesAlternateShell(command: string): boolean {
  return /^(?:cmd(?:\.exe)?|bash|sh|wsl|pwsh|powershell(?:\.exe)?)\b/i.test(command.trim());
}

function normalizeTaskType(value: unknown, capability: string): GeneratedPlan["tasks"][number]["type"] {
  const type = value === "research" ||
    value === "coding" ||
    value === "analysis" ||
    value === "review" ||
    value === "tool_call" ||
    value === "planning" ||
    value === "aggregation"
    ? value
    : "analysis";
  if (type === "tool_call" && !TOOL_CAPABILITY_ACTIONS[capability]) {
    return "analysis";
  }
  return type;
}

function isDelegateToolAction(value: unknown): boolean {
  return ["Agent", "Task", "agent_delegate", "agent.delegate", "delegate"].includes(String(value ?? "").trim());
}

function excerpt(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}
