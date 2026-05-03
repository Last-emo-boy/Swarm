import type { GeneratedPlan } from "../protocol/types.js";
import { OpenAIProvider } from "../providers/openai-provider.js";

export class PlanGenerator {
  constructor(private readonly provider: OpenAIProvider) {}

  async generate(objective: string): Promise<GeneratedPlan> {
    const first = await this.provider.generateText({
      model: this.provider.model,
      system: plannerSystemPrompt(),
      user: JSON.stringify({ objective, output_contract: plannerOutputContract() }, null, 2)
    });

    const firstResult = parseAndNormalizePlan(first, objective);
    if (firstResult.plan) {
      return firstResult.plan;
    }

    const repaired = await this.provider.generateText({
      model: this.provider.model,
      system: plannerRepairPrompt(),
      user: JSON.stringify(
        {
          objective,
          parse_error: firstResult.error,
          invalid_output: first,
          output_contract: plannerOutputContract()
        },
        null,
        2
      )
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

function plannerSystemPrompt(): string {
  return [
    "You are Swarm Planner, the planning component of a local coding-agent CLI.",
    "Your only job is to emit one valid JSON object for the runtime. The runtime will parse your response with JSON.parse.",
    "",
    "Hard output rules:",
    "1. Output JSON only. The first non-whitespace character must be { and the last non-whitespace character must be }.",
    "2. Do not use Markdown fences, comments, prose, XML tags, YAML, TypeScript, or trailing commas.",
    "3. Use double-quoted JSON strings only.",
    "4. Include 2 to 5 tasks. Do not include review or aggregation tasks; the runtime adds them.",
    "5. Every task must include required_capabilities with exactly one primary capability from the allowed list.",
    "6. Tool tasks must include inputs.action matching the capability.",
    "7. For file.read, prefer a single inputs.path. If multiple small files must be read together, inputs.paths may be an array of paths.",
    "8. Prefer discovery before reading: file.glob or file.grep first, then file.read with line ranges for targeted files.",
    "9. Avoid shell-style brace expansion unless necessary; simple patterns such as **/*.ts or **/*.json are easier for tools.",
    "10. Never plan direct reads of secrets or local credentials: .env, .env.*, secrets/**, config/credentials.json, or **/.swarm/config.json.",
    "11. For code audit requests, include at least one source-code file.read task, not only manifests/config files.",
    "12. For TypeScript/JavaScript CLI repositories, likely source files include src/index.ts, src/config/settings.ts, src/runtime/orchestrator.ts, src/agents/child-entry.ts, and src/tools/local-tools.ts. Missing files are acceptable; the tool will report them.",
    "13. For code audit requests, plan to inspect manifests/configs, search risky patterns, read focused code regions, then synthesize findings.",
    "14. Never write files or run shell commands for an audit unless the user explicitly requested code changes or command execution.",
    "",
    "Allowed capabilities and required input actions:",
    "- tool.file.list -> inputs.action=\"file.list\"",
    "- tool.file.read -> inputs.action=\"file.read\"",
    "- tool.file.glob -> inputs.action=\"file.glob\"",
    "- tool.file.grep -> inputs.action=\"file.grep\"",
    "- tool.file.stat -> inputs.action=\"file.stat\"",
    "- tool.file.write -> inputs.action=\"file.write\"",
    "- tool.file.edit -> inputs.action=\"file.edit\"",
    "- tool.shell.exec -> inputs.action=\"shell.exec\"",
    "- web.search -> inputs.action=\"web.search\"",
    "- analysis.synthesize",
    "- research.summarize",
    "- code.inspect",
    "- design.reason",
    "",
    "Valid JSON example:",
    JSON.stringify(
      {
        objective: "Audit this codebase and report risks.",
        summary: "Inspect the local project structure, search for risky patterns, read targeted files, and synthesize an audit report.",
        tasks: [
          {
            task_id: "task_discover_files",
            title: "Discover project files",
            description: "Find source and configuration files relevant to the audit.",
            objective: "Identify the files to inspect without reading large content yet.",
            type: "tool_call",
            status: "pending",
            required_capabilities: ["tool.file.glob"],
            inputs: {
              action: "file.glob",
              root: ".",
              pattern: "**/*.{ts,tsx,js,json,md}",
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
            required_capabilities: ["tool.file.read"],
            inputs: {
              action: "file.read",
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
            required_capabilities: ["tool.file.grep"],
            inputs: {
              action: "file.grep",
              root: "src",
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
        final_artifact: { path: ".swarm/artifacts/audit.md", format: "markdown" }
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
      tasks: "array of 2-5 SwarmTask objects",
      final_artifact: "optional { path: string, format: 'markdown' | 'json' | 'text' }"
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
    }
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

  return {
    objective: typeof plan.objective === "string" && plan.objective.trim() ? plan.objective : objective,
    summary: typeof plan.summary === "string" && plan.summary.trim() ? plan.summary : "Generated swarm plan.",
    tasks: plan.tasks.map((task, index) => {
      const requiredCapabilities =
        Array.isArray(task.required_capabilities) && task.required_capabilities.length > 0
          ? task.required_capabilities
          : [inferCapability(task)];
      return {
        task_id: task.task_id || `task_${index + 1}`,
        title: task.title || `Task ${index + 1}`,
        description: task.description || task.objective || "Run swarm task.",
        objective: task.objective || objective,
        type: task.type || "analysis",
        status: "pending",
        required_capabilities: requiredCapabilities,
        inputs: task.inputs && typeof task.inputs === "object" ? task.inputs : {},
        expected_output: task.expected_output ?? { format: "markdown" },
        dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
        constraints: Array.isArray(task.constraints) ? task.constraints : [],
        acceptance_criteria: Array.isArray(task.acceptance_criteria) ? task.acceptance_criteria : []
      };
    }),
    final_artifact: plan.final_artifact
  };
}

function inferCapability(task: Partial<GeneratedPlan["tasks"][number]>): string {
  const action = String(task.inputs?.action ?? "").trim();
  if (["read_file", "file.read", "tool.file.read"].includes(action)) {
    return "tool.file.read";
  }
  if (["list_files", "file.list", "tool.file.list"].includes(action)) {
    return "tool.file.list";
  }
  if (["grep", "file.grep", "tool.file.grep"].includes(action)) {
    return "tool.file.grep";
  }
  if (["glob", "file.glob", "tool.file.glob"].includes(action)) {
    return "tool.file.glob";
  }
  if (["stat", "file.stat", "tool.file.stat"].includes(action)) {
    return "tool.file.stat";
  }
  if (["write_file", "file.write", "tool.file.write"].includes(action)) {
    return "tool.file.write";
  }
  if (["edit_file", "file.edit", "tool.file.edit"].includes(action)) {
    return "tool.file.edit";
  }
  if (["bash", "shell", "shell.exec", "tool.shell.exec"].includes(action)) {
    return "tool.shell.exec";
  }
  if (["web_search", "web.search"].includes(action)) {
    return "web.search";
  }
  if (task.type === "tool_call") {
    return "tool.file.read";
  }
  return "analysis.synthesize";
}

function excerpt(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}
