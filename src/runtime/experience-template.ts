import type { SwarmPolicy } from "../protocol/types.js";

export type ExperienceProfileName =
  | "careful-security-review"
  | "fast-architecture-pass"
  | "autonomous-safe-draft";

export interface ExperienceProfile {
  name: ExperienceProfileName;
  label: string;
  description: string;
  /** Rough expected wall time for a typical mid-size task */
  estimatedMinutes: number;
  /** Human-facing intensity hint */
  intensity: "careful" | "balanced" | "fast";
  /** Recommended review/consensus style for this profile */
  reviewStyle: "strict-reviewer" | "standard-reviewer" | "light-review";
  /** Output verbosity preference */
  outputStyle: "evidence-heavy" | "balanced" | "concise";
  /** Policy deltas to apply on top of a base policy */
  policyDeltas: Partial<SwarmPolicy>;
  /** Starter objective text shown in first-run paths */
  starterObjective: string;
  /** Result requirements that downstream renderers can surface without exposing policy JSON */
  resultRequirements: string[];
  /** Suggested agent role/capability hints (future use) */
  recommendedCapabilities?: string[];
}

export type ExperienceStarter = {
  id: string;
  title: string;
  description: string;
  profileName: ExperienceProfileName;
  command: string;
  objective: string;
  expectedOutcome: string;
};

const PROFILE_OBJECTIVE_TITLES: Record<ExperienceProfileName, string> = {
  "careful-security-review": "Codebase Deep Review",
  "fast-architecture-pass": "Fast Architecture Pass",
  "autonomous-safe-draft": "Safe Draft"
};

const PROFILE_DEFAULT_FOCUS: Record<ExperienceProfileName, string | undefined> = {
  "careful-security-review": "the auth, permissions, and data-boundary code",
  "fast-architecture-pass": "architecture boundaries",
  "autonomous-safe-draft": undefined
};

const PROFILES: Record<ExperienceProfileName, ExperienceProfile> = {
  "careful-security-review": {
    name: "careful-security-review",
    label: "Careful Security Review",
    description: "Evidence-first review for high-risk code areas, with stricter approval and reviewer gates.",
    estimatedMinutes: 8,
    intensity: "careful",
    reviewStyle: "strict-reviewer",
    outputStyle: "evidence-heavy",
    policyDeltas: {
      require_review: true,
      consensus: "reviewer_approval",
      approval_mode: "on-request",
      safety: {
        require_human_approval_for: [
          "tool.shell.exec",
          "tool.file.write",
          "tool.file.edit",
          "package.install",
          "agent.delegate"
        ],
        forbidden_capabilities: ["credential.exfiltrate"],
        sandbox_required: true
      },
      budget: {
        max_tool_calls: 80
      }
    },
    starterObjective: "Review the auth, permissions, and data-boundary code for security and design risks.",
    resultRequirements: [
      "prioritized findings",
      "file:line references",
      "concrete fixes",
      "confidence and evidence summary"
    ],
    recommendedCapabilities: ["security.audit", "code.review", "architecture.critic"]
  },

  "fast-architecture-pass": {
    name: "fast-architecture-pass",
    label: "Fast Architecture Pass",
    description: "A focused architecture pass that trades some depth for faster design insight.",
    estimatedMinutes: 5,
    intensity: "balanced",
    reviewStyle: "standard-reviewer",
    outputStyle: "balanced",
    policyDeltas: {
      require_review: true,
      consensus: "reviewer_approval",
      approval_mode: "on-request",
      safety: {
        require_human_approval_for: [
          "tool.file.write",
          "tool.file.edit",
          "package.install"
        ],
        forbidden_capabilities: ["credential.exfiltrate"],
        sandbox_required: false
      },
      budget: {
        max_tool_calls: 40
      }
    },
    starterObjective: "Review this workspace for architecture bottlenecks, coupling risks, and missing boundaries.",
    resultRequirements: [
      "top architecture risks",
      "affected files or modules",
      "recommended refactors",
      "confidence summary"
    ],
    recommendedCapabilities: ["code.review", "architecture.review"]
  },

  "autonomous-safe-draft": {
    name: "autonomous-safe-draft",
    label: "Autonomous Safe Draft",
    description: "A low-risk draft mode that stays inside strict sandbox and read boundaries.",
    estimatedMinutes: 4,
    intensity: "fast",
    reviewStyle: "light-review",
    outputStyle: "concise",
    policyDeltas: {
      require_review: false,
      consensus: "coordinator_decision",
      approval_mode: "on-failure",
      network_access: "deny",
      safety: {
        require_human_approval_for: ["package.install", "agent.delegate"],
        forbidden_capabilities: ["credential.exfiltrate"],
        sandbox_required: true
      },
      budget: {
        max_tool_calls: 30
      }
    },
    starterObjective: "Draft a safe first pass for this request, staying read-only unless approval is requested.",
    resultRequirements: [
      "concise summary",
      "assumptions",
      "safe next action",
      "verification gap"
    ],
    recommendedCapabilities: ["code.read", "research"]
  }
};

export const EXPERIENCE_PROFILE_NAMES = Object.keys(PROFILES) as ExperienceProfileName[];

export function resolveExperienceProfile(name: string): ExperienceProfile | undefined {
  const normalized = name.trim().toLowerCase() as ExperienceProfileName;
  return PROFILES[normalized];
}

export function getAllExperienceProfiles(): ExperienceProfile[] {
  return Object.values(PROFILES);
}

export function buildExperienceObjective(profileName: ExperienceProfileName, focus?: string): string {
  const profile = PROFILES[profileName];
  const normalizedFocus = focus?.trim() || PROFILE_DEFAULT_FOCUS[profileName];
  const title = normalizedFocus
    ? `${PROFILE_OBJECTIVE_TITLES[profileName]}: ${normalizedFocus}`
    : PROFILE_OBJECTIVE_TITLES[profileName];
  return [
    title,
    "",
    `Experience: ${profile.label}.`,
    profile.starterObjective,
    `Result requirements: ${profile.resultRequirements.join(", ")}.`,
    "Keep process details secondary; the primary result should read like a focused outcome report."
  ].join("\n");
}

export function buildCodebaseDeepReviewObjective(focus?: string): string {
  return buildExperienceObjective("careful-security-review", focus);
}

export function getExperienceStarters(): ExperienceStarter[] {
  return [
    {
      id: "codebase-deep-review",
      title: "Codebase Deep Review",
      description: "Find the highest-risk issues in a focused code area.",
      profileName: "careful-security-review",
      command: "/review auth and permissions",
      objective: buildExperienceObjective("careful-security-review", "auth and permissions"),
      expectedOutcome: "Prioritized findings with file:line, fix, confidence, and evidence."
    },
    {
      id: "architecture-pass",
      title: "Fast Architecture Pass",
      description: "Spot coupling, missing boundaries, and design bottlenecks.",
      profileName: "fast-architecture-pass",
      command: "/review architecture boundaries",
      objective: buildExperienceObjective("fast-architecture-pass", "architecture boundaries"),
      expectedOutcome: "Scannable architecture risks and practical next steps."
    },
    {
      id: "safe-draft",
      title: "Safe Draft",
      description: "Get a careful first pass before making changes.",
      profileName: "autonomous-safe-draft",
      command: "/plan safe first pass for this request",
      objective: buildExperienceObjective("autonomous-safe-draft"),
      expectedOutcome: "A concise plan with assumptions and verification gaps."
    }
  ];
}

export function applyExperienceProfileToPolicy(
  base: SwarmPolicy,
  profile: ExperienceProfile
): SwarmPolicy {
  const deltas = profile.policyDeltas;

  const mergedSafety = {
    ...base.safety,
    ...(deltas.safety ?? {}),
    require_human_approval_for: uniqueStrings([
      ...base.safety.require_human_approval_for,
      ...(deltas.safety?.require_human_approval_for ?? [])
    ]),
    forbidden_capabilities: uniqueStrings([
      ...base.safety.forbidden_capabilities,
      ...(deltas.safety?.forbidden_capabilities ?? [])
    ])
  };

  return {
    ...base,
    ...deltas,
    human_approval_for: uniqueStrings([
      ...(base.human_approval_for ?? []),
      ...(deltas.human_approval_for ?? []),
      ...mergedSafety.require_human_approval_for
    ]),
    safety: mergedSafety,
    budget: {
      ...(base.budget ?? {}),
      ...(deltas.budget ?? {})
    },
    // Preserve required fields that should never be lost
    max_agents: deltas.max_agents ?? base.max_agents,
    max_parallel_tasks: deltas.max_parallel_tasks ?? base.max_parallel_tasks,
    timeout_ms: deltas.timeout_ms ?? base.timeout_ms,
    retry: deltas.retry ?? base.retry,
    memory: deltas.memory ?? base.memory
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0).map((value) => value.trim()))];
}
