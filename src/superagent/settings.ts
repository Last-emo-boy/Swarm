/**
 * Superagent settings: Sources, Policy, Eval and Executor blocks, validated with the schemas of dsh-superagent's policy.ts and
 * stored as one JSON file under the superagent state directory so people can edit it and every Swarm process reads the same.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod/v4";
import { getSwarmPaths } from "../config/settings.js";
import { key } from "./core/index.js";
import type { AdmissionRow } from "./admission.js";
import { HarnessIdSchema, HarnessProfileSchema, harnessSettingsProblem } from "./harness.js";

export const LIMITS = {
  ruleName: 100,
  ruleInstruction: 2000,
  evalTimeoutSeconds: { min: 30, max: 600 },
  maxWorkers: { min: 1, max: 16 },
  prepareCommand: 4000
} as const;

export const RuleIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const DEFAULT_RULES = [
  {
    id: "copy",
    name: "Copy fixes",
    enabled: true,
    instruction: "Explicit requests to correct a typo, wording, punctuation or existing translation. Preserve product promises and business meaning."
  },
  {
    id: "visual",
    name: "Visual fixes",
    enabled: true,
    instruction: "Explicit implementation requests for local spacing, alignment, overflow or styling, with a specified target or an objectively established existing standard/correct state to restore. Locating an element or calling it inconsistent, unattractive or hard to understand does not establish a target. Do not invent visual style, information hierarchy, rendering or interaction decisions. No redesign, new interaction or behavior. A known spacing defect does not authorize adjacent undefined restyling; assess only a clearly separable authorized scope. If direction or scope is unsettled, observe only: no acknowledgement, worker or unsolicited question."
  }
];
/** An assessment rule; its instruction may also name PR reviewers and whether to wait for their approval. */
export const RuleSchema = z.object({
  id: RuleIdSchema,
  name: z.string().trim().min(1).max(LIMITS.ruleName),
  enabled: z.boolean(),
  instruction: z.string().trim().min(1).max(LIMITS.ruleInstruction)
}).strict();
export type Rule = z.infer<typeof RuleSchema>;
/** A Swarm model reference such as `kimi-coding/kimi-for-coding`; null uses Swarm's configured model for the role. */
const ModelRefSchema = z.string().trim().min(1).nullable().default(null);

export const AllowedSchema = z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict();
const Weak = z.enum(["inferred", "ignore"]);
export const AdmissionRowSchema: z.ZodType<AdmissionRow> = z.object({
  listedUnaddressed: Weak.optional(),
  unlistedAddressed: z.enum(["explicit", "inferred", "ignore"]).optional(),
  unlistedUnaddressed: Weak.optional()
}).strict();
export const AdmissionTableSchema = z.record(z.string(), AdmissionRowSchema);
export const RoleSchema = z.enum(["owner", "maintainer", "everyone"]);
export const WriteLevelSchema = z.enum(["read-only", "local", "github"]);
/** Roles by sender id; a sender with a role is on the list as one on `allowed` is. See `roleOf` in policy.ts. */
export const RolesSchema = z.record(z.string().trim().min(1).max(200), RoleSchema);
/** How far the work of a ticket accepted in each receiving scope (an admission row) may write at most. */
export const CeilingsSchema = z.record(z.string(), WriteLevelSchema);
export const SourcePolicySchema = z.object({
  allowed: z.array(AllowedSchema).default([]),
  admission: AdmissionTableSchema.default({}),
  roles: RolesSchema.optional(),
  ceilings: CeilingsSchema.optional()
}).catchall(z.unknown());
export type SourcePolicy = z.infer<typeof SourcePolicySchema>;
const SourceIdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);
export const PolicyConfigSchema = z.object({
  rules: z.array(RuleSchema).refine((rules) => new Set(rules.map((rule) => rule.id)).size === rules.length, "Duplicate rule IDs").default(DEFAULT_RULES),
  sources: z.record(SourceIdSchema, SourcePolicySchema).default({})
}).strict();
export const EvalConfigSchema = z.object({
  mode: z.enum(["off", "observe", "auto"]).default("observe"),
  timeoutSeconds: z.number().int().min(LIMITS.evalTimeoutSeconds.min).max(LIMITS.evalTimeoutSeconds.max).default(120),
  model: ModelRefSchema
}).strict();
/** Commands the worker needs and that blocking would break: the account wrappers and git. */
export const WORKER_COMMANDS: readonly string[] = ["gh", "lark-cli", "git"];
const CommandNameSchema = z.string().regex(/^[A-Za-z0-9._-]+$/).refine((name) => name !== "." && name !== "..", "Not a command name")
  .refine((name) => !WORKER_COMMANDS.includes(name), `${WORKER_COMMANDS.join(", ")} cannot be blocked`);
/**
 * Cluster ticket VMs (vm/kube-control.ts): VMs in pods of a Kubernetes cluster that the deployment set up, which take tickets
 * once the local slots are full. The host reaches the cluster with `kubeconfig` (empty: its service's `kubeconfig`
 * credential); each cluster slot's guest reaches its gateway, on `port` plus the slot, through the deployment's tunnel.
 * `image` is the runner image (empty: SWARM_TICKET_RUNNER_IMAGE, which the deployment sets for its build).
 */
const KubeSchema = z.object({
  kubeconfig: z.string().trim().default(""),
  namespace: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/).default("swarm-tickets"),
  slots: z.number().int().min(1).max(32).default(10),
  port: z.number().int().min(1024).max(65_000).default(47_200),
  image: z.string().trim().default(""),
  cpu: z.number().int().min(1).max(32).default(3),
  memoryMiB: z.number().int().min(1024).max(262_144).default(6144),
  diskGiB: z.number().int().min(5).max(1000).default(20)
}).strict();
export type KubeVm = z.infer<typeof KubeSchema>;
/**
 * Ticket VMs (vm/vm-work.ts): how many run at once on this host, the first of their gateways' ports on 127.0.0.1, one per
 * slot upward, and the cluster whose VMs take tickets once those are full (with no slots here, every ticket's).
 */
const VmSchema = z.object({
  slots: z.number().int().min(0).max(32).default(4),
  port: z.number().int().min(1024).max(65_000).default(47_100),
  kube: KubeSchema.optional()
}).strict().refine((vm) => vm.slots > 0 || !!vm.kube, { message: "No ticket VMs: slots is 0 and kube is not set", path: ["slots"] });
/**
 * Executor settings: worker model, concurrency, ticket directory root (empty defaults to `<stateDir>/work`), `prepare`
 * command run once per new ticket directory, blocked commands, the permission mode workers run under, the agent harness
 * new tickets run on (null for Swarm's own coding loop), the harness profiles of this machine (see harness.ts), and where
 * workers run: as processes of the host's account, or each ticket in a VM of its own, which the deployment provides.
 */
export const ExecutorConfigSchema = z.object({
  model: ModelRefSchema,
  maxWorkers: z.number().int().min(LIMITS.maxWorkers.min).max(LIMITS.maxWorkers.max).default(3),
  directory: z.string().trim().refine((path) => path === "" || path.startsWith("/"), "An absolute path, or empty for <stateDir>/work").default(""),
  prepare: z.string().max(LIMITS.prepareCommand).default(""),
  blockedCommands: z.array(CommandNameSchema).default([]),
  permissionMode: z.enum(["full-auto", "yolo"]).default("full-auto"),
  harness: HarnessIdSchema.nullable().default(null),
  harnesses: z.record(HarnessIdSchema, HarnessProfileSchema).default({}),
  isolation: z.enum(["process", "vm"]).default("process"),
  vm: VmSchema.default(VmSchema.parse({}))
}).strict().superRefine((executor, context) => {
  const problem = harnessSettingsProblem(executor.harness, executor.harnesses);
  if (problem) context.addIssue({ code: "custom", message: problem, path: ["harness"] });
});
const LimitsSchema = z.object({
  /** Live tickets a sender may have at once. */
  openTickets: z.number().int().min(0).optional(),
  /** Messages addressed to the agent a sender may send in an hour, bot commands included. */
  requestsPerHour: z.number().int().min(0).optional()
}).strict();
/**
 * The access model: with it, each accepted ticket gets a capability from its requester's role and its scope's ceiling, only a
 * ticket's requester and maintainers steer it, and each role has limits (see `ACCESS_LIMITS` in policy.ts for the defaults).
 * Without it, every sender on a list may do everything, as before.
 */
export const AccessSchema = z.object({
  limits: z.object({ owner: LimitsSchema.optional(), maintainer: LimitsSchema.optional(), everyone: LimitsSchema.optional() }).strict().default({})
}).strict();
export type Access = z.infer<typeof AccessSchema>;
/**
 * The agent in group chats beyond its work: the chats where it joins the conversation on its own after a lull, who it is
 * there, and how often it may speak. A message that addresses it and asks for no work gets an answer anywhere.
 */
export const ChatterSchema = z.object({
  /** Feishu chats (oc_...) where it joins in on its own; owners set them with /chatter. */
  chats: z.array(z.string().regex(/^oc_[A-Za-z0-9]+$/)).default([]),
  /** Whether it joins in on its own in every group it is in, but those in `off`, instead of only those in `chats`. */
  everywhere: z.boolean().default(false),
  /** With `everywhere`, the groups an owner turned it off in with /chatter off. */
  off: z.array(z.string().regex(/^oc_[A-Za-z0-9]+$/)).default([]),
  /** Who the agent is: its voice, manner and interests, in conversation and in every message its routing and workers write to people. */
  persona: z.string().trim().max(2000).default(""),
  model: ModelRefSchema,
  /** How long a chat stays quiet before the agent considers saying something. */
  lullSeconds: z.number().int().min(10).max(3600).default(90),
  /** The least time between two considerations of one chat. */
  considerMinutes: z.number().int().min(1).max(1440).default(10),
  /** The most messages it posts on its own in one chat in an hour. */
  perHour: z.number().int().min(0).max(30).default(2),
  /** Hours, in `timeZone`, from `from` until `to`, when it posts nothing on its own. */
  quiet: z.object({ from: z.number().int().min(0).max(23), to: z.number().int().min(0).max(23), timeZone: z.string().default("Asia/Shanghai") })
    .strict().optional()
}).strict();
export type Chatter = z.infer<typeof ChatterSchema>;
export const SourceInstanceSchema = z.object({
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({})
}).strict();
export const SettingsSchema = z.object({
  paused: z.boolean().default(false),
  sources: z.record(SourceIdSchema, SourceInstanceSchema).default({}),
  policy: PolicyConfigSchema.default(() => PolicyConfigSchema.parse({})),
  eval: EvalConfigSchema.default(() => EvalConfigSchema.parse({})),
  executor: ExecutorConfigSchema.default(() => ExecutorConfigSchema.parse({})),
  access: AccessSchema.optional(),
  chatter: ChatterSchema.optional()
}).strict();
export type Settings = z.infer<typeof SettingsSchema>;

export const POLICY_REVISION = "mandate-v3";
/**
 * The version of the settings that bear on authorization: rules, accept mode, each Source's Policy part (its roles and
 * ceilings too) and whether the access model is on. Models, concurrency, pause, polling and the access model's limits do not
 * invalidate decisions.
 */
export function policyVersion(settings: Settings): string {
  return key(POLICY_REVISION, JSON.stringify({ rules: settings.policy.rules, mode: settings.eval.mode, sources: settings.policy.sources,
    ...settings.access ? { access: true } : {} }));
}

/** Where the superagent keeps its database, settings, lock, worker shims and, by default, ticket directories. */
export function superagentStateDir(): string {
  return process.env.SWARM_SUPERAGENT_HOME ?? join(getSwarmPaths().home, "superagent");
}
export const settingsPath = (stateDir = superagentStateDir()): string => join(stateDir, "settings.json");

/** A settings file as read: the validated settings, the file's modification time, and the validation error when it is invalid. */
export interface SettingsRead { settings: Settings; mtimeMs: number; error?: string }

/** Reads and validates the settings file; a missing file reads as defaults, an invalid one as defaults with its error. */
export function readSettings(path = settingsPath()): SettingsRead {
  if (!existsSync(path)) return { settings: SettingsSchema.parse({}), mtimeMs: 0 };
  const mtimeMs = statSync(path).mtimeMs;
  try {
    return { settings: SettingsSchema.parse(JSON.parse(readFileSync(path, "utf8"))), mtimeMs };
  } catch (error) {
    const message = error instanceof z.ZodError ? z.prettifyError(error) : error instanceof Error ? error.message : String(error);
    return { settings: SettingsSchema.parse({}), mtimeMs, error: `${path}: ${message}` };
  }
}

/** Validates and writes settings atomically (owner-only permissions), returning what was saved. */
export function writeSettings(value: unknown, path = settingsPath()): Settings {
  const settings = SettingsSchema.parse(value);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  return settings;
}

/** Reads, changes and writes the settings file; `change` receives a copy and returns the next value. */
export function updateSettings(change: (settings: Settings) => Settings, path = settingsPath()): Settings {
  const current = readSettings(path);
  if (current.error) throw new Error(`Fix the settings file before changing it: ${current.error}`);
  return writeSettings(change(structuredClone(current.settings)), path);
}
