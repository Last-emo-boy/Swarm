import { OpenAIProvider } from "../providers/openai-provider.js";

export type RunMode = "auto" | "chat" | "coding_loop" | "full_swarm";

export type RunOptions = {
  mode?: RunMode;
};

type ConcreteRunMode = Exclude<RunMode, "auto">;
type RouteRisk = "low" | "medium" | "high";
type RouteSideEffects = "none" | "read_workspace" | "modify_workspace" | "run_commands" | "network" | "unknown";

export type ExecutionRoute = {
  mode: ConcreteRunMode;
  reason: string;
  confidence: number;
  requires_workspace?: boolean;
  expected_side_effects?: RouteSideEffects;
  needs_parallelism?: boolean;
  parallelism_reason?: string;
  swarm_value?: string;
  risk?: RouteRisk;
  fallback_mode?: ConcreteRunMode;
};

export async function routeExecution(
  objective: string,
  provider: OpenAIProvider,
  options: RunOptions = {}
): Promise<ExecutionRoute> {
  if (options.mode && options.mode !== "auto") {
    return { mode: options.mode, reason: `forced:${options.mode}`, confidence: 1 };
  }

  try {
    const content = await provider.generateText({
      model: provider.workerModel,
      system: routeSystemPrompt(),
      user: JSON.stringify(routeDecisionInput(objective), null, 2)
    });
    try {
      return applyStructuredRoutingPolicy(parseRoute(content));
    } catch (error) {
      const repaired = await provider.generateText({
        model: provider.workerModel,
        system: [
          "You repair invalid JSON for Swarm's execution mode router.",
          "Return exactly one valid JSON object and nothing else.",
          "Preserve the intended decision when possible, but fill every required field from the output contract.",
          "If the invalid output is not recoverable, choose coding_loop with low confidence."
        ].join(" "),
        user: JSON.stringify({
          objective,
          invalid_output: content,
          parse_error: error instanceof Error ? error.message : String(error),
          output_contract: routeOutputContract()
        }, null, 2)
      });
      return applyStructuredRoutingPolicy(parseRoute(repaired));
    }
  } catch (error) {
    return routeDecisionFallback(error);
  }
}

function routeSystemPrompt(): string {
  return [
    "You are Swarm's execution control-plane router for a local coding CLI.",
    "Choose exactly one execution mode using the supplied mode descriptions and routing policy.",
    "This is not a keyword classifier. Base the decision on task shape, required workspace access, side effects, parallelism value, risk, and fallback behavior.",
    "Return exactly one JSON object matching the output contract. Do not include Markdown fences or prose outside JSON."
  ].join(" ");
}

function routeDecisionInput(objective: string): Record<string, unknown> {
  return {
    objective,
    product_principles: [
      "The main Swarm is the only user-facing agent.",
      "Natural language goes to the main Swarm; slash commands are controls, not the primary UX.",
      "LLM control decisions drive routing and interruption.",
      "The reliable local coding loop is the default path for coding and project work.",
      "Full swarm is preferred when the user explicitly asks for Agent Swarm, multiple roles, or independent expert workstreams and the task is more than a small edit.",
      "The coding loop may also escalate into an internal swarm by spawning subagents with agent.delegate; execution mode is a starting point, not a permanent state.",
      "Workers never speak directly to users; worker results return to the main Swarm."
    ],
    available_modes: [
      {
        mode: "chat",
        description: "Answer or discuss without inspecting, modifying, or running commands in the workspace.",
        use_when: [
          "The user asks a conceptual question.",
          "No local files, commands, tools, or current repo state are needed."
        ]
      },
      {
        mode: "coding_loop",
        description: "Main Swarm local coding loop for reading files, editing, running checks, creating projects, and iterating in the current workspace.",
        use_when: [
          "The task touches the local repository or workspace.",
          "The request is a bug fix, feature, refactor, review of current code, setup, command run, or implementation task.",
          "The task can be handled by one coherent agent loop with optional dynamic subagent escalation through agent.delegate."
        ]
      },
      {
        mode: "full_swarm",
        description: "ASP planner/worker/reviewer/aggregator pipeline for explicit or naturally parallel multi-agent work.",
        use_when: [
          "The user explicitly asks to use Agent Swarm, subagents, multiple people/roles, or a team-style split and names independent roles such as frontend, backend, architecture, design, review, or verification.",
          "The task has independent work streams that can run in parallel.",
          "The task benefits from separate expert perspectives, map-reduce over many files/documents, broad audits, or multi-module implementation with independent review.",
          "The extra token, latency, coordination, and predictability costs are justified."
        ],
        avoid_when: [
          "Ordinary bug fixes, small features, focused refactors, single-file edits, or simple Q&A.",
          "Parallelism would mostly duplicate the main agent's work.",
          "The task needs a tight edit/test loop more than broad exploration."
        ]
      }
    ],
    routing_policy: {
      default_mode: "coding_loop",
      chat_requires_no_workspace_access: true,
      full_swarm_decision_owner: "llm",
      conservative_fallback: "coding_loop",
      rationale: [
        "Codex-like usability comes first: local read/edit/run/check flow should be reliable before broad swarm automation.",
        "Multi-agent work should be intentional, scoped, observable, and justified by independent work streams; explicit user requests for swarm or named roles are strong evidence.",
        "Do not keep a project in one state forever: coding_loop can spawn internal workers, and full_swarm can be selected when broad coordination is valuable.",
        "If the decision is uncertain, choose coding_loop."
      ]
    },
    output_contract: routeOutputContract()
  };
}

function routeOutputContract(): Record<string, unknown> {
  return {
    mode: "chat | coding_loop | full_swarm",
    confidence: "number from 0 to 1",
    reason: "short explanation of the chosen mode",
    requires_workspace: "boolean; true if files, commands, repo state, or local tools are needed",
    expected_side_effects: "none | read_workspace | modify_workspace | run_commands | network | unknown",
    needs_parallelism: "boolean; true only when independent concurrent work streams materially improve the outcome",
    parallelism_reason: "required for full_swarm; describe the independent work streams, otherwise empty string",
    swarm_value: "required for full_swarm; explain why planner/worker/reviewer/aggregator beats one coding loop, otherwise empty string",
    risk: "low | medium | high",
    fallback_mode: "chat | coding_loop; mode to use if the chosen mode is rejected by policy validation"
  };
}

function routeDecisionFallback(error: unknown): ExecutionRoute {
  return {
    mode: "coding_loop",
    confidence: 0,
    reason: `Route decision failed; using conservative local coding loop fallback: ${error instanceof Error ? error.message : String(error)}`,
    requires_workspace: true,
    expected_side_effects: "unknown",
    needs_parallelism: false,
    risk: "medium",
    fallback_mode: "coding_loop"
  };
}

function applyStructuredRoutingPolicy(route: ExecutionRoute): ExecutionRoute {
  if (route.mode === "chat" && (route.requires_workspace || route.expected_side_effects !== "none")) {
    return {
      ...route,
      mode: "coding_loop",
      confidence: Math.min(route.confidence, 0.75),
      reason: [
        "Structured route selected chat, but its own workspace/side-effect fields require the local coding loop.",
        `Router reason: ${route.reason}`
      ].join(" "),
      fallback_mode: "coding_loop"
    };
  }

  if (route.mode !== "full_swarm") {
    return route;
  }

  return route;
}

function parseRoute(text: string): ExecutionRoute {
  const parsed = parseJsonObject(text);
  const mode = parseMode(parsed.mode);
  const confidence = typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
    ? Math.max(0, Math.min(1, parsed.confidence))
    : 0;
  const reason = parseNonEmptyString(parsed.reason, "LLM router selected this mode.", 800);
  return {
    mode,
    confidence,
    reason,
    requires_workspace: typeof parsed.requires_workspace === "boolean" ? parsed.requires_workspace : mode !== "chat",
    expected_side_effects: parseSideEffects(parsed.expected_side_effects, mode === "chat" ? "none" : "unknown"),
    needs_parallelism: typeof parsed.needs_parallelism === "boolean" ? parsed.needs_parallelism : false,
    parallelism_reason: parseOptionalString(parsed.parallelism_reason, 800),
    swarm_value: parseOptionalString(parsed.swarm_value, 800),
    risk: parseRisk(parsed.risk),
    fallback_mode: parseOptionalMode(parsed.fallback_mode) ?? "coding_loop"
  };
}

function parseMode(value: unknown): ConcreteRunMode {
  if (value === "chat" || value === "coding_loop" || value === "full_swarm") {
    return value;
  }
  throw new Error(`Execution router returned invalid mode: ${typeof value === "string" ? value : "(missing)"}`);
}

function parseOptionalMode(value: unknown): ConcreteRunMode | undefined {
  if (value === "chat" || value === "coding_loop" || value === "full_swarm") {
    return value;
  }
  return undefined;
}

function parseSideEffects(value: unknown, fallback: RouteSideEffects): RouteSideEffects {
  if (
    value === "none" ||
    value === "read_workspace" ||
    value === "modify_workspace" ||
    value === "run_commands" ||
    value === "network" ||
    value === "unknown"
  ) {
    return value;
  }
  return fallback;
}

function parseRisk(value: unknown): RouteRisk {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return "medium";
}

function parseNonEmptyString(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maxLength)
    : fallback;
}

function parseOptionalString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maxLength)
    : undefined;
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("Execution router returned non-JSON output.");
    }
    try {
      return JSON.parse(match[0]) as Record<string, unknown>;
    } catch {
      throw new Error("Execution router returned invalid JSON.");
    }
  }
}
