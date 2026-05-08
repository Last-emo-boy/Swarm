import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { defaultSwarmSettings } from "../config/settings.js";
import type { GeneratedPlan } from "../protocol/types.js";
import {
  decodeInputChunk,
  decodeInputStream,
  editInput,
  flushInputStream,
  insertInputText,
  isBackspaceInput,
  isDeleteInput,
  killInputBackward,
  killInputToLineEnd,
  killInputWordBackward
} from "../tui/input-editing.js";
import { mainPaneShortcutDirection, nextMainPane } from "../tui/main-panes.js";
import {
  acceptSlashCommandCandidate,
  commandCandidatesForInput,
  commandOutputPreview,
  completeSlashCommand,
  formatToolOutputPreview,
  parseSlashCommandLine,
  rawSlashArgsAfter
} from "../tui/slash-commands.js";
import { formatHeadlessProgress, formatRuntimeEventBrief, formatWorkerBrief } from "../runtime/event-formatters.js";
import { workerDisplayLabel } from "../storage/worker-state-store.js";
import { finalActivityMessage, finalActivityPhase, formatToolFailureContent, hasUnresolvedToolFailure, summarizeCodingLoopFinalStatus } from "../runtime/coding-agent-loop.js";
import { delegatedToolStatus, finalAttemptStatus, sessionStatusFromExecutionStatus, workerStatusFromExecutionStatus } from "../runtime/execution-status.js";
import { TaskScheduler } from "../runtime/scheduler.js";
import { normalizeGeneratedPlanForRuntime } from "../runtime/plan-generator.js";
import { inputReducer } from "../tui/input-state.js";
import {
  applyChatInputKey,
  CHAT_INPUT_COMPLETION_LIMIT,
  CHAT_INPUT_COMPLETION_VISIBLE_ROWS,
  chatInputCompletionCandidates,
  chatInputCompletionRows,
  createChatInputControllerState
} from "../tui/chat-input-controller.js";
import {
  emptyIdlePaneSnapshot,
  idlePaneSnapshotSignature,
  symphonyDaemonRecordsSignature
} from "../tui/idle-pane-snapshot.js";
import { approvalInputDecision } from "../tui/approval-input.js";
import { INPUT_RENDER_ROWS, inputViewport, renderInputLineParts } from "../tui/input-rendering.js";
import { editOnboardFieldInput } from "../tui/onboard-input.js";
import { appendTuiLoopActivity, appendTuiRuntimeEvent, sameRuntimeEventDisplay, TUI_EVENT_BUFFER_LIMIT } from "../tui/tui-event-buffer.js";
import { assertToolAllowedByPermissions, resolveReadablePath, resolveWritablePath, toolRequiresApproval } from "../tools/permissions.js";
import { aggregateLintResults, normalizeToolAction, webFetchHttpFailureMetadata } from "../tools/local-tools.js";
import { BuiltinLocalToolProvider } from "../extensions/builtin-tools.js";
import { createEnvelope } from "../protocol/envelope.js";
import { SwarmDatabase } from "../storage/database.js";
import { TraceStore } from "../storage/trace-store.js";
import { BlackboardStore } from "../storage/blackboard-store.js";
import { ArtifactStore } from "../storage/artifact-store.js";
import { TaskStateStore } from "../storage/task-state-store.js";
import { SessionStore } from "../storage/session-store.js";
import { WorkspaceLeaseStore } from "../storage/workspace-lease-store.js";
import { SessionContextStore } from "../storage/session-context-store.js";
import { RuntimeEvents } from "../runtime/events.js";
import { AgentRegistry } from "../runtime/registry.js";
import { EnvelopeRouter } from "../runtime/router.js";
import { SwarmRuntime } from "../runtime/runtime.js";
import { applyStructuredRoutingPolicy } from "../runtime/execution-router.js";
import { renderHostEnvironmentPrompt } from "../runtime/host-context.js";
import { TOOL_RESULT_REPLACEMENT_TAG } from "../runtime/tool-result-budget.js";
import { builtinAgents } from "../runtime/builtin-agents.js";
import type { SymphonyDaemonRecord } from "../symphony/daemon.js";
import type { AgentCard } from "../protocol/types.js";

export type EvalCaseResult = {
  name: string;
  status: "pass" | "fail";
  message: string;
};

export function runLocalEvals(root = process.cwd()): EvalCaseResult[] {
  return [
    checkFile(root, "docs/PRD.md", "PRD document exists"),
    checkFile(root, "docs/WORK_KERNEL.md", "Work Kernel design document exists"),
    checkFile(root, "src/symphony/workflow.ts", "Symphony workflow loader exists"),
    checkFile(root, "src/symphony/work-source.ts", "Symphony work source exists"),
    checkFile(root, "src/symphony/workspace.ts", "Symphony workspace preparation exists"),
    checkFile(root, "src/symphony/preview.ts", "Symphony preview ingress exists"),
    checkFile(root, "src/symphony/kernel.ts", "Symphony shares Work Kernel session helpers"),
    checkFile(root, "src/symphony/scheduler.ts", "Symphony scheduler skeleton exists"),
    checkFile(root, "src/symphony/runner.ts", "Symphony runner bridge exists"),
    checkFile(root, "src/symphony/hooks.ts", "Symphony hook runner exists"),
    checkFile(root, "src/symphony/preflight.ts", "Symphony preflight exists"),
    checkFile(root, "src/symphony/status.ts", "Symphony status surface exists"),
    checkFile(root, "src/symphony/cleanup.ts", "Symphony workspace cleanup exists"),
    checkFile(root, "src/symphony/daemon.ts", "Symphony local daemon manager exists"),
    checkFile(root, "src/runtime/swarm-controller.ts", "main Swarm controller exists"),
    checkFile(root, "src/runtime/coding-agent-loop.ts", "coding loop exists"),
    checkFile(root, "src/runtime/agent-specs.ts", "agent spec registry exists"),
    checkFile(root, "src/storage/handoff-store.ts", "handoff store exists"),
    checkContains(root, "src/runtime/execution-router.ts", "needs_parallelism", "execution router uses structured parallelism signal"),
    checkContains(root, "src/runtime/execution-router.ts", "parallelism_reason", "execution router requires parallelism rationale"),
    checkContains(root, "src/runtime/execution-router.ts", "requires_workspace", "execution router reasons about workspace access"),
    checkContains(root, "src/runtime/execution-router.ts", "Full swarm is preferred", "execution router asks the LLM to treat explicit swarm requests as strong routing evidence"),
    checkContains(root, "src/runtime/execution-router.ts", "full_swarm_decision_owner", "execution router leaves full-swarm selection to the LLM"),
    checkContains(root, "src/runtime/execution-router.ts", "execution mode is a starting point", "execution router documents dynamic escalation out of a fixed mode"),
    checkContains(root, "src/runtime/execution-router.ts", "workspace-modifying explicit swarm requests should start in coding_loop", "execution router prompts safe swarm escalation for mutating tasks"),
    checkContains(root, "src/runtime/execution-router.ts", "Using coding_loop preserves the read/edit/verify loop", "execution router policy demotes unsafe mutating full-swarm routes"),
    checkNotContains(root, "src/runtime/execution-router.ts", "detectSwarmPreferenceSignals", "execution router avoids hardcoded swarm preference detection"),
    checkNotContains(root, "src/runtime/execution-router.ts", "hasSubstantialJustification", "execution router avoids deterministic full-swarm justification thresholds"),
    checkNotContains(root, "src/runtime/execution-router.ts", "explicitlyRequestsSwarm", "execution router avoids explicit swarm keyword gate"),
    checkNotContains(root, "src/runtime/execution-router.ts", "clampAutoRoute", "execution router avoids hardcoded route clamp"),
    checkContains(root, "src/runtime/orchestrator.ts", "routeableTaskCapability", "full swarm rejects empty task capabilities before envelope routing"),
    checkContains(root, "src/runtime/plan-generator.ts", "firstNonEmptyCapability", "planner normalization skips empty required_capabilities entries"),
    checkContains(root, "src/runtime/plan-generator.ts", "Do not use Agent or agent.delegate in full-swarm plans", "full swarm planner prompt avoids nested delegation tasks"),
    checkContains(root, "src/runtime/plan-generator.ts", "Do not use placeholder content in Write", "planner prompt rejects placeholder file writes"),
    checkContains(root, "src/runtime/plan-generator.ts", "Bash commands must use the host shell syntax", "planner prompt requires host-specific shell syntax"),
    checkContains(root, "src/runtime/plan-generator.ts", "validateGeneratedToolInputs", "planner normalization validates generated tool inputs"),
    checkContains(root, "src/runtime/plan-generator.ts", "usesPowerShellIncompatiblePosix", "planner normalization rejects POSIX-only PowerShell commands"),
    checkContains(root, "src/runtime/host-context.ts", "Host environment for local tools", "host environment prompt exists"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "renderHostEnvironmentPrompt(input.workspace)", "coding loop injects host environment"),
    checkContains(root, "src/runtime/runtime.ts", "renderHostEnvironmentPrompt(this.workspace)", "chat mode injects host environment"),
    checkContains(root, "src/agents/child-entry.ts", "workerLoopSystemPrompt(workspace)", "worker loop injects host environment"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "workerStore", "worker lifecycle is wired into coding loop"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "invokeAgent", "agent delegates route through main Swarm"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "available_agent_specs", "coding loop exposes agent specs to main Swarm"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "delegation_policy", "coding loop exposes delegation policy"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "dynamic_escalation", "coding loop can dynamically escalate into an internal swarm"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "For explicit swarm or team-role requests", "coding loop prompts early worker spawning for explicit swarm requests"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "tool_schemas", "coding loop exposes tool schemas"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "TOOL_SCHEMAS", "coding loop has local tool schemas"),
    checkContains(root, "src/agents/child-entry.ts", "routeableDelegateCapability", "Child agent delegation rejects empty or unrouteable capabilities"),
    checkContains(root, "src/agents/child-entry.ts", "DELEGATE_CAPABILITY_MISSING", "Child agent delegation returns a structured error for missing capability"),
    checkFile(root, "src/extensions/broker.ts", "Capability broker exists"),
    checkContains(root, "src/runtime/runtime.ts", "new CapabilityBroker", "Runtime owns the capability broker"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "local_tool.", "Coding loop routes built-in tools through capability broker when available"),
    checkContains(root, "src/extensions/broker.ts", "createToolApprovalRequest", "Broker uses local tool approval details for built-in tools"),
    checkContains(root, "src/extensions/broker.ts", "toolRequiresApproval(action", "Broker reuses local tool permission policy for built-in tools"),
    checkContains(root, "src/runtime/runtime.ts", "durable_context.skill", "Runtime records durable skill context"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "Durable session context", "Coding loop injects durable session context"),
    checkContains(root, "src/extensions/mcp.ts", "toolRiskOverrides", "MCP tool risk can be overridden by trusted settings"),
    checkContains(root, "src/runtime/runtime.ts", "recordMcpMaterial", "MCP resources and prompts are materialized through Work Kernel records"),
    checkContains(root, "src/tools/types.ts", "preferred_agent_spec_id", "agent.delegate supports preferred agent spec"),
    checkContains(root, "src/tools/types.ts", "file_scope", "agent.delegate supports scoped handoff inputs"),
    checkContains(root, "src/runtime/events.ts", "self_review", "self-review runtime event exists"),
    checkContains(root, "src/runtime/events.ts", "agent_spawn_decision", "agent spawn event exists"),
    checkContains(root, "src/runtime/events.ts", "workspace_change", "workspace change event exists"),
    checkContains(root, "src/runtime/events.ts", "review_completed", "post-change review event exists"),
    checkContains(root, "src/runtime/events.ts", "verification_completed", "post-change verification event exists"),
    checkFile(root, "src/runtime/event-formatters.ts", "shared runtime event formatter exists"),
    checkContains(root, "src/runtime/event-formatters.ts", "formatWhyReport", "formatter exposes grouped why report"),
    checkContains(root, "src/runtime/event-formatters.ts", "Route Decision", "why report includes route decision section"),
    checkContains(root, "src/runtime/event-formatters.ts", "Delegation Decisions", "why report includes delegation decision section"),
    checkContains(root, "src/runtime/event-formatters.ts", "formatHeadlessProgress", "formatter exposes headless progress"),
    checkContains(root, "src/index.ts", "formatHeadlessProgress", "headless run uses shared progress formatter"),
    checkContains(root, "src/runtime/event-formatters.ts", "agent_spawn_decision", "headless run can surface agent spawn decisions"),
    checkFile(root, "src/runtime/headless-artifacts.ts", "headless artifact exporter exists"),
    checkContains(root, "src/index.ts", "--trajectory", "headless run can write ATIF trajectory artifacts"),
    checkContains(root, "src/index.ts", "loadSwarmVersion", "CLI can report its package version for installed-agent setup"),
    checkContains(root, "src/index.ts", "command === \"--version\"", "CLI accepts --version for installed-agent setup"),
    checkContains(root, "src/runtime/headless-artifacts.ts", "swarm.telemetry.v1", "headless run emits structured telemetry"),
    checkContains(root, "src/runtime/headless-artifacts.ts", "ATIF-v1.7", "headless trajectory uses Harbor-compatible ATIF schema"),
    checkFile(root, "bench/harbor/swarm_agent.py", "Harbor Swarm CLI agent wrapper exists"),
    checkContains(root, "src/providers/openai-provider.ts", "nonEmptyEnv(\"SWARM_WORKER_MODEL\") ?? envModel", "headless model env can configure worker model without persisted settings"),
    checkContains(root, "src/providers/openai-provider.ts", "nonEmptyEnv(\"SWARM_AGGREGATOR_MODEL\") ?? envModel", "headless model env can configure aggregator model without persisted settings"),
    checkContains(root, "bench/harbor/swarm_agent.py", "\"SWARM_MODEL\"", "Harbor wrapper forwards model selection into isolated Swarm homes"),
    checkContains(root, "bench/harbor/swarm_agent.py", "SWARM_RUN_MODE", "Harbor wrapper can select a non-default run mode"),
    checkContains(root, "bench/harbor/swarm_agent.py", "SWARM_PACKAGE", "Harbor wrapper can install packaged Swarm CLI inside the sandbox"),
    checkContains(root, "bench/harbor/swarm_agent.py", "environment.upload_file", "Harbor wrapper uploads local Swarm package artifacts"),
    checkContains(root, "bench/harbor/swarm_agent.py", "agent_dir = environment.env_paths.agent_dir.as_posix()", "Harbor wrapper writes run artifacts through the sandbox agent mount"),
    checkContains(root, "bench/harbor/swarm_agent.py", "environment.env_paths.agent_dir", "Harbor wrapper writes artifacts into the Harbor agent mount"),
    checkContains(root, "package.json", "\"files\"", "npm package manifest explicitly includes build artifacts for Harbor installation"),
    checkContains(root, "package.json", "\"dist\"", "npm package manifest includes compiled CLI output"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "formatWhyReport", "TUI why uses grouped formatter"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "formatWorkerBrief", "TUI workers uses compact worker formatter"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "<ActivityPanel workers={mergeWorkerRecords", "right-side Activity panel summarizes worker records"),
    checkContains(root, "src/tui/idle-pane-snapshot.ts", "runtime.listRecentWorkersForWorkspace", "TUI idle snapshot includes recent worker records"),
    checkContains(root, "src/storage/worker-state-store.ts", "display_name", "worker records persist a human-readable agent name"),
    checkContains(root, "src/storage/worker-state-store.ts", "role_title", "worker records persist a generated role title"),
    checkContains(root, "src/runtime/agent-specs.ts", "persona_brief?: string", "agent spawn decisions support an ephemeral persona brief"),
    checkContains(root, "src/runtime/runtime.ts", "display_name, role_title, persona_brief", "agent spawn prompt asks the LLM for generated worker identity fields"),
    checkContains(root, "src/runtime/runtime.ts", "stripEphemeralAgentPersona", "runtime strips ephemeral persona from durable worker records"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "sessionObjective", "worker loops can persist a durable session objective separate from the prompt"),
    checkFile(root, "src/tui/ChatInputArea.tsx", "TUI chat input component is isolated"),
    checkFile(root, "src/tui/chat-input-controller.ts", "TUI chat input controller is testable outside Ink"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "ChatInputArea", "TUI shell imports the isolated chat input component"),
    checkContains(root, "src/tui/chat-input-controller.ts", "historyDraft", "TUI input preserves the in-progress draft while browsing history"),
    checkContains(root, "src/tui/chat-input-controller.ts", "input.cursor", "TUI input tracks cursor position"),
    checkContains(root, "src/tui/ChatInputArea.tsx", "InputLine", "TUI renders an editable input cursor"),
    checkFile(root, "src/tui/input-rendering.ts", "TUI input rendering helpers are isolated"),
    checkContains(root, "src/tui/input-editing.ts", "isBackspaceInput", "TUI centralizes robust backspace handling"),
    checkContains(root, "src/tui/input-editing.ts", "isDeleteInput", "TUI centralizes robust delete handling"),
    checkContains(root, "src/tui/input-editing.ts", "decodeInputStream", "TUI input buffers split terminal escape sequences"),
    checkContains(root, "src/tui/input-editing.ts", "bracketedPasteContent", "TUI input decodes bracketed paste"),
    checkContains(root, "src/tui/input-editing.ts", "killInputWordBackward", "TUI input exposes readline-style kill operations"),
    checkFile(root, "src/tui/input-state.ts", "TUI input state reducer is isolated from the main app"),
    checkContains(root, "src/tui/input-rendering.ts", "INPUT_RENDER_ROWS", "TUI input renders a compact multi-line prompt viewport"),
    checkContains(root, "src/tui/main-panes.ts", "mainPaneOrder", "TUI centralizes main pane order"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "mainPane", "TUI tracks the active main pane"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "/help all", "TUI header keeps advanced controls behind help all"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "busy && mainPane === \"overview\"", "TUI pane switching remains visible while work is running"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "lastRoute", "TUI tracks the latest actual execution route"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "routeStateFromControllerEvent", "TUI derives route state from controller events"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "latest route=", "TUI overview surfaces the selected local loop or swarm route"),
    checkContains(root, "README.md", "command history with Up/Down", "README documents TUI input editing"),
    checkContains(root, "README.md", "latest actual route selected by auto mode", "README documents actual route visibility"),
    checkContains(root, "src/storage/database.ts", "worker_states", "worker state table exists"),
    checkContains(root, "src/storage/database.ts", "handoff_sessions", "handoff session table exists"),
    checkContains(root, "src/tools/local-tools.ts", "acquireWriteLock", "file write lock exists"),
    checkContains(root, "src/tools/local-tools.ts", "WorkspaceChangeMetadata", "workspace change metadata exists"),
    checkContains(root, "src/config/settings.ts", "\"yolo\"", "yolo permission mode is accepted by settings"),
    checkContains(root, "src/tools/permissions.ts", "mode === \"yolo\"", "yolo bypasses approval prompts"),
    checkContains(root, "src/index.ts", "--yolo", "CLI supports temporary yolo mode"),
    checkContains(root, "src/providers/openai-provider.ts", "webSearchWithResponses", "provider-native OpenAI web search exists"),
    checkContains(root, "src/providers/openai-provider.ts", "web_search_20250305", "provider-native Anthropic web search exists"),
    checkContains(root, "src/providers/openai-provider.ts", "max_output_tokens", "OpenAI Responses requests set max output tokens"),
    checkContains(root, "src/providers/openai-provider.ts", "maxOutputTokens", "Gemini requests set max output tokens"),
    checkContains(root, "src/providers/openai-provider.ts", "input.maxOutputTokens", "provider supports request-scoped max output tokens"),
    checkContains(root, "src/providers/openai-provider.ts", "WEB_SEARCH_MAX_OUTPUT_TOKENS", "provider-native web search uses a bounded output budget"),
    checkContains(root, "src/runtime/execution-router.ts", "ROUTER_MAX_OUTPUT_TOKENS", "execution router uses a small output budget"),
    checkContains(root, "src/runtime/plan-generator.ts", "PLAN_GENERATOR_MAX_OUTPUT_TOKENS", "planner uses a bounded output budget"),
    checkContains(root, "src/runtime/runtime.ts", "CONTROL_PLANE_MAX_OUTPUT_TOKENS", "runtime control-plane calls use small output budgets"),
    checkContains(root, "src/agents/child-entry.ts", "CHILD_WORKER_LOOP_MAX_OUTPUT_TOKENS", "child worker loop uses a bounded output budget"),
    checkContains(root, "src/providers/openai-provider.ts", "SWARM_MAX_OUTPUT_TOKENS", "model output token cap can be overridden from env"),
    checkContains(root, "src/config/settings.ts", "maxOutputTokens", "model output token cap is part of settings"),
    checkContains(root, "src/providers/openai-provider.ts", "cache_control", "Anthropic prompt caching uses cache_control markers"),
    checkContains(root, "src/providers/openai-provider.ts", "prompt_cache_key", "OpenAI prompt caching uses prompt_cache_key"),
    checkContains(root, "src/providers/openai-provider.ts", "cachedContent", "Gemini prompt caching can use cachedContent"),
    checkContains(root, "src/providers/openai-provider.ts", "cachedInputTokens", "Provider usage records cached input tokens"),
    checkContains(root, "src/runtime/runtime.ts", "cached_input", "Runtime usage records cached token counters"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "cache: true", "Coding loop marks stable prompt blocks cacheable"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "compactToolResultHistory(toolResults)", "coding loop compacts historical tool results before replaying context"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "failed tool result is feedback", "coding loop instructs the LLM to continue after recoverable tool failures"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "hasUnresolvedToolFailure", "coding loop treats only unrecovered tool failures as final failures"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "TOOL_RESULT_PERSIST_THRESHOLD_BYTES = 8_000", "coding loop persists large tool outputs instead of replaying them inline"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "TOOL_RESULT_PERSIST_PREVIEW_BYTES = 2_000", "coding loop keeps only a short preview for persisted tool output"),
    checkFile(root, "src/runtime/tool-result-budget.ts", "shared tool result budget module exists"),
    checkFile(root, "src/storage/tool-content-replacement-store.ts", "tool content replacement store exists"),
    checkContains(root, "src/storage/database.ts", "tool_content_replacements", "database persists exact tool result replacement decisions"),
    checkContains(root, "src/runtime/tool-result-budget.ts", "ContentReplacementState", "tool result budget tracks replacement state"),
    checkContains(root, "src/runtime/tool-result-budget.ts", "seenIds", "tool result budget freezes seen tool-result decisions"),
    checkContains(root, "src/runtime/tool-result-budget.ts", "TOOL_RESULT_REPLACEMENT_TAG", "tool result replacements use a deterministic persisted-output tag"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "applyToolResultBudget(compactToolResultHistory(toolResults)", "coding loop applies aggregate tool result budget before model replay"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "codingLoopCacheKey", "coding loop derives stable cache keys from cacheable prompt bytes"),
    checkContains(root, "src/agents/child-entry.ts", "CHILD_TOOL_RESULT_TOTAL_BUDGET_BYTES", "child worker loop uses aggregate tool result budget"),
    checkContains(root, "src/agents/child-entry.ts", "LONG_OUTPUT_THRESHOLD_BYTES = 8_000", "child worker loop persists long outputs with the same threshold as main loop"),
    checkContains(root, "src/providers/openai-provider.ts", "PromptCacheDiagnostics", "provider reports prompt cache diagnostics"),
    checkContains(root, "src/providers/openai-provider.ts", "promptCachePolicies", "provider latches prompt cache policy per cache scope"),
    checkContains(root, "src/providers/openai-provider.ts", "trackPromptCacheDiagnostics", "provider tracks prompt cache break diagnostics"),
    checkContains(root, "src/runtime/runtime.ts", "prompt_cache_diagnostic", "runtime persists prompt cache diagnostic events"),
    checkContains(root, "src/storage/session-context-store.ts", "Files and paths seen", "session context compaction preserves important file signals"),
    checkContains(root, "src/runtime/runtime.ts", "compactWorkerResultForParent", "runtime compacts worker results before returning them to the parent loop"),
    checkContains(root, "src/runtime/runtime.ts", "result_ref", "parent loop receives a worker result artifact reference"),
    checkContains(root, "src/tools/local-tools.ts", "serverWebSearch", "web search can use provider-native search"),
    checkContains(root, "src/tools/local-tools.ts", "allowed_domains", "web search supports domain filters"),
    checkContains(root, "src/tools/local-tools.ts", "validateShellCommandForHost", "shell tools validate commands against the host shell"),
    checkContains(root, "src/tools/local-tools.ts", "Command uses POSIX-only shell syntax", "shell tools reject POSIX-only commands on PowerShell hosts"),
    checkContains(root, "src/tools/local-tools.ts", "explicitly invoke an available shell", "shell tool recovery explains explicit alternate shell usage"),
    checkContains(root, "src/tools/types.ts", "recoverySuggestion", "tool results can carry deterministic recovery guidance"),
    checkContains(root, "src/runtime/events.ts", "recoverySuggestion", "tool result events carry recovery guidance"),
    checkContains(root, "src/runtime/runtime.ts", "recovery_suggestion: event.recoverySuggestion", "runtime persists tool recovery guidance into Work Kernel attempts"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "Recovery:", "TUI surfaces tool and attempt recovery guidance"),
    checkFile(root, "src/storage/approval-store.ts", "approval store exists"),
    checkFile(root, "src/storage/audit-store.ts", "audit store exists"),
    checkFile(root, "src/storage/usage-store.ts", "usage store exists"),
    checkFile(root, "src/storage/task-graph-store.ts", "task graph store exists"),
    checkFile(root, "src/server/gateway.ts", "local Gateway server exists"),
    checkContains(root, "src/protocol/types.ts", "RiskClass", "risk class protocol type exists"),
    checkContains(root, "src/tools/types.ts", "predicted_impact", "approval challenge fields exist"),
    checkFile(root, "src/tui/approval-input.ts", "TUI approval input helper is isolated"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "allow session", "TUI approval view supports session-scoped allow"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "Why now", "TUI approval view surfaces why-now context"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "approvalSessionRuleKey", "TUI approval can remember same action and target for the session"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "if (approval)", "TUI key handling gives approval overlay priority"),
    checkContains(root, "src/tui/approval-input.ts", "key.escape || (key.ctrl && character === \"c\")", "TUI overlays handle Escape and Ctrl+C locally"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "{approval ? (", "TUI renders approvals inline with runtime context"),
    checkNotContains(root, "src/tui/SwarmChatApp.tsx", "return <ApprovalView request={approval} />", "TUI approvals do not replace the full application view"),
    checkContains(root, "src/runtime/runtime.ts", "recordRuntimeEvent", "runtime persists local core events"),
    checkContains(root, "src/runtime/events.ts", "type: \"session\"", "runtime emits session lifecycle events"),
    checkContains(root, "src/protocol/types.ts", "export type WorkItem", "Work Kernel WorkItem type exists"),
    checkContains(root, "src/protocol/types.ts", "export type WorkspaceLease", "Work Kernel workspace lease type exists"),
    checkContains(root, "src/protocol/types.ts", "export type RunAttempt", "Work Kernel run attempt type exists"),
    checkContains(root, "src/protocol/types.ts", "export type WorkSnapshot", "Work Kernel snapshot type exists"),
    checkContains(root, "src/storage/database.ts", "run_attempts", "run attempts table exists"),
    checkContains(root, "src/storage/database.ts", "workspace_leases", "workspace lease table exists"),
    checkFile(root, "src/storage/run-attempt-store.ts", "run attempt store exists"),
    checkFile(root, "src/storage/workspace-lease-store.ts", "workspace lease store exists"),
    checkContains(root, "src/storage/workspace-lease-store.ts", "listRecent", "workspace lease store can list recent leases"),
    checkContains(root, "src/storage/workspace-lease-store.ts", "listBySession", "workspace lease store can list session leases"),
    checkContains(root, "src/runtime/runtime.ts", "getWorkSnapshot", "runtime exposes WorkSnapshot"),
    checkContains(root, "src/server/gateway.ts", "work_snapshot", "Gateway session response includes WorkSnapshot"),
    checkContains(root, "src/index.ts", "symphony preview", "CLI exposes Symphony preview command"),
    checkContains(root, "src/index.ts", "symphony tick", "CLI exposes Symphony scheduler tick command"),
    checkContains(root, "src/index.ts", "symphony daemon", "CLI exposes Symphony daemon command"),
    checkContains(root, "src/index.ts", "symphony status", "CLI exposes Symphony status command"),
    checkContains(root, "src/index.ts", "symphony cleanup", "CLI exposes Symphony cleanup command"),
    checkContains(root, "src/index.ts", "getSymphonyStatus", "CLI reads Symphony status from Work Kernel facts"),
    checkContains(root, "src/index.ts", "cleanupSymphonyWorkspaces", "CLI runs shared Symphony cleanup path"),
    checkContains(root, "src/index.ts", "runSymphonyDaemon", "CLI exposes Symphony daemon entrypoint"),
    checkContains(root, "src/index.ts", "SymphonyDaemonManager", "CLI uses shared local Symphony daemon manager"),
    checkContains(root, "src/index.ts", "manager.start", "CLI starts Symphony daemon through shared manager"),
    checkContains(root, "src/index.ts", "manager.stopAll(\"cli_exit\"", "CLI shuts down Symphony daemon manager"),
    checkContains(root, "src/index.ts", "parsePositiveIntegerOption", "Symphony CLI validates numeric limits"),
    checkContains(root, "src/index.ts", "process.off(\"SIGINT\"", "Symphony daemon cleans signal handlers"),
    checkContains(root, "src/index.ts", "preflight ${issue.severity}", "Symphony daemon prints preflight issue summaries"),
    checkContains(root, "src/server/gateway.ts", "handleSymphony", "Gateway exposes Symphony ingress route"),
    checkContains(root, "src/server/gateway.ts", "action === \"tick\"", "Gateway exposes Symphony scheduler tick route"),
    checkContains(root, "src/server/gateway.ts", "/v1/symphony/status", "Gateway documents Symphony status route"),
    checkContains(root, "src/server/gateway.ts", "request.method === \"GET\" && (!action || action === \"status\")", "Gateway exposes Symphony status route"),
    checkContains(root, "src/server/gateway.ts", "/v1/symphony/cleanup", "Gateway documents Symphony cleanup route"),
    checkContains(root, "src/server/gateway.ts", "action === \"cleanup\"", "Gateway exposes Symphony cleanup route"),
    checkContains(root, "src/server/gateway.ts", "/v1/symphony/daemon/start", "Gateway documents local Symphony daemon start route"),
    checkContains(root, "src/server/gateway.ts", "/v1/symphony/daemon/stop", "Gateway documents local Symphony daemon stop route"),
    checkContains(root, "src/server/gateway.ts", "SymphonyDaemonManager", "Gateway uses shared local Symphony daemon manager"),
    checkContains(root, "src/server/gateway.ts", "this.symphonyDaemons.start", "Gateway can start a local Symphony daemon"),
    checkContains(root, "src/server/gateway.ts", "this.symphonyDaemons.requestStop", "Gateway can stop local Symphony daemon loops"),
    checkContains(root, "src/server/gateway.ts", "this.symphonyDaemons.stopAll(\"gateway_shutdown\"", "Gateway shutdown stops local Symphony daemons"),
    checkContains(root, "src/symphony/daemon.ts", "export class SymphonyDaemonManager", "Shared Symphony daemon manager is exported"),
    checkContains(root, "src/symphony/daemon.ts", "daemon.scheduler.tick()", "Shared daemon dispatches through local Symphony scheduler"),
    checkContains(root, "src/symphony/daemon.ts", "stopAll", "Shared daemon manager can stop all loops"),
    checkContains(root, "src/symphony/daemon.ts", "history: SymphonyDaemonTickSummary[]", "Shared daemon records tick history"),
    checkContains(root, "src/index.ts", "record.history.filter", "CLI daemon prints tick history from shared records"),
    checkContains(root, "src/tui/slash-commands.ts", "/symphony-daemon [daemon_id]", "TUI documents Symphony daemon status command"),
    checkContains(root, "src/tui/slash-commands.ts", "/symphony-start [workflow_path]", "TUI documents Symphony daemon start command"),
    checkContains(root, "src/tui/slash-commands.ts", "/symphony-stop [daemon_id|all]", "TUI documents Symphony daemon stop command"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "SymphonyDaemonManager", "TUI uses shared local Symphony daemon manager"),
    checkContains(root, "src/symphony/preview.ts", "createSymphonyPreview", "Symphony preview creates Work Kernel sessions"),
    checkContains(root, "src/symphony/work-source.ts", "LocalWorkSource", "Symphony has a local work source"),
    checkContains(root, "src/symphony/work-source.ts", "createWorkSourceFromConfig", "Symphony creates work sources from workflow config"),
    checkContains(root, "src/symphony/work-source.ts", "WORK_ITEMS.md", "Symphony defaults to local WORK_ITEMS.md"),
    checkContains(root, "src/symphony/work-source.ts", "parseMarkdownWorkItems", "Symphony parses Markdown checklist work items"),
    checkContains(root, "src/symphony/work-source.ts", "refreshItems", "Symphony work source can refresh known item states"),
    checkContains(root, "src/symphony/work-source.ts", "listTerminalItems", "Symphony work source can list terminal items"),
    checkContains(root, "src/symphony/work-source.ts", "isActiveWorkSourceItem", "Symphony work source filters active items locally"),
    checkContains(root, "src/symphony/work-source.ts", "source: \"symphony\"", "Symphony WorkItems use local Symphony source"),
    checkContains(root, "src/symphony/work-source.ts", "source_id: record.id", "Symphony local source writes source_id instead of external task identifiers"),
    checkContains(root, "src/symphony/work-source.ts", "work_source_kind", "Symphony records local work source kind metadata"),
    checkContains(root, "src/symphony/work-item.ts", "workItemSourceId", "Symphony centralizes local WorkItem identity fallback"),
    checkContains(root, "src/symphony/workflow.ts", "work_source", "Workflow config exposes local work_source"),
    checkContains(root, "src/symphony/preflight.ts", "UNSUPPORTED_WORK_SOURCE", "Symphony preflight validates work source kind"),
    checkContains(root, "src/storage/session-store.ts", "listBySources", "Session store can query multiple WorkItem sources for compatibility"),
    checkContains(root, "src/symphony/scheduler.ts", "class SymphonyScheduler", "Symphony scheduler owns claim and running state"),
    checkContains(root, "src/symphony/scheduler.ts", "claimed", "Symphony scheduler tracks claimed work items"),
    checkContains(root, "src/storage/symphony-claim-store.ts", "tryClaim", "Symphony claims are persisted with a database-level claim path"),
    checkContains(root, "src/storage/symphony-claim-store.ts", "BEGIN IMMEDIATE", "Symphony claims serialize cross-process claim decisions"),
    checkContains(root, "src/storage/symphony-claim-store.ts", "status IN ('failed', 'released')", "Symphony claims use conditional replace rules"),
    checkContains(root, "src/storage/database.ts", "symphony_claims", "Database schema includes durable Symphony claims"),
    checkContains(root, "src/symphony/scheduler.ts", "symphonyClaimStore.tryClaim", "Symphony scheduler guards dispatch with persistent claims"),
    checkContains(root, "src/symphony/scheduler.ts", "runAttemptStore.upsert", "Symphony scheduler writes Work Kernel attempts"),
    checkContains(root, "src/symphony/scheduler.ts", "traceStore.append", "Symphony scheduler writes ASP trace envelopes"),
    checkContains(root, "src/symphony/scheduler.ts", "blackboardStore.write", "Symphony scheduler writes dispatch decisions to blackboard"),
    checkContains(root, "src/symphony/scheduler.ts", "execute", "Symphony scheduler can optionally execute dispatched work"),
    checkContains(root, "src/symphony/scheduler.ts", "recoverFromKernel", "Symphony scheduler recovers state from Work Kernel records"),
    checkContains(root, "src/symphony/scheduler.ts", "symphony.retry", "Symphony scheduler persists retry decisions as Work Kernel attempts"),
    checkContains(root, "src/symphony/scheduler.ts", "symphony.reconcile", "Symphony scheduler persists reconciliation decisions"),
    checkContains(root, "src/symphony/scheduler.ts", "reconcileSourceState", "Symphony scheduler refreshes local source state before dispatch"),
    checkContains(root, "src/symphony/scheduler.ts", "work_item_missing_from_source", "Symphony scheduler cancels runs missing from local source"),
    checkContains(root, "src/symphony/scheduler.ts", "work_item_terminal", "Symphony scheduler cancels terminal local work items"),
    checkContains(root, "src/symphony/scheduler.ts", "SYMPHONY_SESSION_SOURCES", "Symphony recovery reads local Symphony sessions through a shared source constant"),
    checkContains(root, "src/symphony/scheduler.ts", "runSymphonyHook(\"after_create\"", "Symphony scheduler runs after_create hook"),
    checkContains(root, "src/symphony/scheduler.ts", "runSymphonyHook(\"before_run\"", "Symphony scheduler runs before_run hook"),
    checkContains(root, "src/symphony/scheduler.ts", "runSymphonyHook(\"after_run\"", "Symphony scheduler runs after_run hook"),
    checkContains(root, "src/symphony/hooks.ts", "SWARM_SYMPHONY_TRUST_HOOKS", "Symphony hook execution requires explicit trust gate"),
    checkContains(root, "src/symphony/hooks.ts", "SWARM_SYMPHONY_APPROVE_HOOKS", "Symphony hook execution requires explicit approval gate"),
    checkContains(root, "src/symphony/hooks.ts", "SWARM_SYMPHONY_HOOK_INPUT", "Symphony hooks receive structured input"),
    checkContains(root, "src/symphony/hooks.ts", "symphony.hook", "Symphony hooks persist Work Kernel attempts and evidence"),
    checkContains(root, "src/symphony/hooks.ts", "auditStore.append", "Symphony hooks write audit records"),
    checkContains(root, "src/symphony/preflight.ts", "runSymphonyPreflight", "Symphony preflight validates workflow before dispatch"),
    checkContains(root, "src/symphony/preflight.ts", "TEMPLATE_RENDER_FAILED", "Symphony preflight validates prompt rendering"),
    checkContains(root, "src/symphony/preflight.ts", "HOOKS_REQUIRE_TRUST", "Symphony preflight warns about untrusted hooks"),
    checkContains(root, "src/symphony/preflight.ts", "HOOKS_REQUIRE_APPROVAL", "Symphony preflight warns about unapproved hooks"),
    checkContains(root, "src/symphony/preflight.ts", "persistSymphonyPreflight", "Symphony preflight writes Work Kernel facts"),
    checkContains(root, "src/symphony/status.ts", "SYMPHONY_SESSION_SOURCES", "Symphony status reads local Symphony sessions through a shared source constant"),
    checkContains(root, "src/symphony/status.ts", "runAttemptStore.list", "Symphony status reads attempts from Work Kernel"),
    checkContains(root, "src/symphony/status.ts", "workspaceLeaseStore", "Symphony status reads workspace leases from Work Kernel"),
    checkContains(root, "src/symphony/cleanup.ts", "runSymphonyHook(\"before_remove\"", "Symphony cleanup runs before_remove hook"),
    checkContains(root, "src/symphony/cleanup.ts", "rmSync", "Symphony cleanup can remove terminal workspaces"),
    checkContains(root, "src/symphony/cleanup.ts", "SWARM_SYMPHONY_CLEANUP_APPROVE", "Symphony cleanup execution requires explicit approval gate"),
    checkContains(root, "src/symphony/cleanup.ts", "dry_run", "Symphony cleanup defaults to dry-run eligibility"),
    checkContains(root, "src/symphony/cleanup.ts", "retention_min_age", "Symphony cleanup supports min-age retention"),
    checkContains(root, "src/symphony/cleanup.ts", "retention_keep_latest", "Symphony cleanup supports keep-latest retention"),
    checkContains(root, "src/symphony/cleanup.ts", "preserveCleanupManifest", "Symphony cleanup can preserve manifest artifacts"),
    checkContains(root, "src/symphony/workflow.ts", "preserve_artifacts", "Workflow config exposes cleanup artifact preservation"),
    checkContains(root, "src/index.ts", "Retention:", "CLI prints Symphony cleanup retention settings"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "Retention:", "TUI prints Symphony cleanup retention settings"),
    checkContains(root, "src/symphony/cleanup.ts", "workspace_outside_or_equal_root", "Symphony cleanup enforces workspace root boundary"),
    checkContains(root, "src/symphony/cleanup.ts", "symphony.cleanup.removed", "Symphony cleanup writes blackboard decision"),
    checkContains(root, "src/symphony/scheduler.ts", "preflight_failed", "Symphony scheduler blocks dispatch on preflight failure"),
    checkContains(root, "src/server/gateway.ts", "preflight", "Gateway exposes Symphony preflight results"),
    checkContains(root, "src/index.ts", "Preflight:", "CLI prints Symphony preflight results"),
    checkContains(root, "src/symphony/workflow.ts", "after_create", "Workflow config exposes after_create hook"),
    checkContains(root, "src/symphony/workflow.ts", "timeout_ms", "Workflow config exposes hook timeout"),
    checkContains(root, "src/symphony/runner.ts", "export type SymphonyRunner", "Symphony runner interface exists"),
    checkContains(root, "src/symphony/runner.ts", "LocalCodingLoopSymphonyRunner", "Local coding-loop runner implements Symphony runner interface"),
    checkContains(root, "src/symphony/runner.ts", "type: \"blackboard\"", "Symphony runner emits blackboard events for status surfaces"),
    checkContains(root, "src/symphony/runner.ts", "executeWorkSession", "Symphony runner reuses Runtime WorkSession execution"),
    checkContains(root, "src/storage/session-store.ts", "listBySource", "Session store can query WorkSessions by normalized WorkItem source"),
    checkContains(root, "src/storage/run-attempt-store.ts", "listByRunner", "Run attempt store can query attempts by runner"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "sessionId?: string", "coding loop can execute inside an existing WorkSession"),
    checkContains(root, "src/runtime/runtime.ts", "executeWorkSession", "runtime exposes existing WorkSession execution"),
    checkContains(root, "src/runtime/runtime.ts", "workspaceForSession", "runtime resolves attempts against the session workspace lease"),
    checkContains(root, "src/runtime/runtime.ts", "interruptWorkSession", "runtime can interrupt a specific WorkSession"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "requestStop", "coding loop supports deterministic stop requests"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "isSession", "coding loop exposes session identity for targeted cancellation"),
    checkContains(root, "src/symphony/scheduler.ts", "live_stop_requested", "Symphony reconciliation records live runner stop requests"),
    checkContains(root, "src/symphony/runner.ts", "symphony.runner.cancelled", "Symphony runner persists cancelled outcomes"),
    checkContains(root, "src/symphony/hooks.ts", "\"cancelled\"", "Symphony after_run hooks can observe cancelled runs"),
    checkContains(root, "src/symphony/workflow.ts", "renderWorkflowPrompt", "Workflow prompt rendering exists"),
    checkContains(root, "src/symphony/workflow.ts", "parseBlockScalar", "Workflow loader supports multiline hook-style strings"),
    checkContains(root, "src/symphony/workflow.ts", "parseBlockList", "Workflow loader supports YAML block lists"),
    checkContains(root, "src/symphony/workspace.ts", "sanitizeWorkspaceKey", "Symphony workspace keys are sanitized"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "formatWorkSnapshot", "TUI session command renders WorkSnapshot"),
    checkContains(root, "src/tui/slash-commands.ts", "/kernel [workflow_path]", "TUI documents the unified kernel status command"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "formatKernelStatusView", "TUI renders a unified Swarm/Kernel/Symphony status view"),
    checkContains(root, "src/tui/slash-commands.ts", "/work-items [workflow_path]", "TUI documents local Symphony work item inspection"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "createWorkSourceFromConfig", "TUI reads local Symphony work source directly"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "formatWorkItems", "TUI renders local active and terminal work items"),
    checkContains(root, "README.md", "/work-items [workflow_path]", "README documents local work item TUI inspection"),
    checkContains(root, "src/tui/slash-commands.ts", "/attempts [session_id]", "TUI documents Work Kernel attempt inspection"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "runtime.runAttemptStore.list(sessionId, 120)", "TUI reads session attempts from Work Kernel"),
    checkContains(root, "src/runtime/runtime.ts", "listRecentAttemptsForWorkspace", "Runtime exposes workspace-scoped attempt recency"),
    checkContains(root, "src/tui/idle-pane-snapshot.ts", "runtime.listRecentAttemptsForWorkspace", "TUI idle snapshot scopes recent attempts to the current workspace"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "runtime.listRecentAttemptsForWorkspace(50)", "TUI attempts command defaults to current workspace attempts"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "formatRunAttempt", "TUI renders attempt failure, workspace, and recovery details"),
    checkContains(root, "README.md", "/attempts [session_id]", "README documents Work Kernel attempt inspection"),
    checkContains(root, "src/tui/slash-commands.ts", "/leases [session_id|lease_id]", "TUI documents workspace lease inspection"),
    checkContains(root, "src/runtime/runtime.ts", "listRecentLeasesForWorkspace", "Runtime exposes workspace-scoped lease recency"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "runtime.listRecentLeasesForWorkspace(50)", "TUI leases command defaults to current workspace leases"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "formatWorkspaceLease", "TUI renders workspace lease write boundaries"),
    checkContains(root, "README.md", "/leases [session_id\\|lease_id]", "README documents workspace lease inspection"),
    checkContains(root, "src/tui/slash-commands.ts", "/doctor [workflow_path]", "TUI documents local doctor diagnostics"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "formatDoctorReport", "TUI renders local doctor diagnostics"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "getSelectedModelReadiness", "TUI doctor checks model readiness"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "runSymphonyPreflight", "TUI doctor checks Symphony preflight"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "sourceError", "TUI doctor reports local work source read errors"),
    checkContains(root, "README.md", "/doctor [workflow_path]", "README documents TUI doctor diagnostics"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "IdleKernelView", "TUI idle pane renders the Kernel operator surface"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "idlePaneSnapshot.sessions", "TUI idle pane reads recent Work Kernel sessions"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "idlePaneSnapshot.attempts", "TUI idle pane reads recent Work Kernel attempts"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "idlePaneSnapshot.leases", "TUI idle pane reads recent WorkspaceLease records"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "Workspace Leases", "TUI idle pane surfaces workspace write boundaries"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "idlePaneSnapshot.approvals", "TUI idle pane surfaces pending approvals"),
    checkContains(root, "src/tui/ChatInputArea.tsx", "<InputLine value={controllerState.current.input.value}", "TUI chat input renders the current editable draft"),
    checkContains(root, "src/tui/ChatInputArea.tsx", "controllerStateRef", "TUI chat input can use parent-owned controller state"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "controllerStateRef={chatInputState}", "TUI shell preserves chat input state across approval overlays"),
    checkNotContains(root, "src/tui/SwarmChatApp.tsx", "/kernel status", "TUI header does not expose Kernel status as a default path"),
    checkNotContains(root, "src/tui/SwarmChatApp.tsx", "Ctrl+T tasks", "TUI header keeps task internals out of the default path"),
    checkNotContains(root, "src/tui/ChatInputArea.tsx", "useStdin", "TUI chat input avoids raw stdin double-consumption"),
    checkNotContains(root, "src/tui/ChatInputArea.tsx", "renderRawInputLine", "TUI chat input avoids manual ANSI line repaint"),
    checkNotContains(root, "src/tui/SwarmChatApp.tsx", "inputHistory", "TUI shell does not own per-keystroke input history state"),
    checkContains(root, "src/tui/chat-input-controller.ts", "applyChatInputKey", "TUI chat input behavior is centralized in a testable controller"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "loopActivityTimeline", "TUI running pane preserves a recent activity timeline"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "formatLoopActivityLine", "TUI running pane renders compact activity lines"),
    checkFile(root, "src/tui/tui-event-buffer.ts", "TUI event buffer helper is isolated"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "appendTuiRuntimeEvent", "TUI event history avoids duplicate redraw events"),
    checkContains(root, "README.md", "When idle, the TUI main pane acts as the Kernel operator surface", "README documents idle TUI as the Kernel operator surface"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "Recent Attempts", "TUI kernel status view surfaces Work Kernel attempts"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "Symphony", "TUI kernel status view surfaces Symphony state"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "Main commands only. Use /help all for advanced diagnostics, Symphony, agents, tools, and extension controls.", "TUI help groups slash commands"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "formatCapabilitySummary", "TUI capabilities default to a summary surface"),
    checkFile(root, "src/extensions/catalog-summary.ts", "Shared extension catalog summary helpers exist"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "summarizeCapabilityCatalog", "TUI capability summary uses the shared catalog summary model"),
    checkContains(root, "src/server/gateway.ts", "summary: summarizeCapabilityCatalog", "Gateway capability catalog returns the shared summary model"),
    checkContains(root, "src/server/gateway.ts", "summary: summarizeSkillCatalog", "Gateway skills catalog returns the shared summary model"),
    checkContains(root, "src/server/gateway.ts", "summary: summarizePluginCatalog", "Gateway plugins catalog returns the shared summary model"),
    checkContains(root, "src/server/gateway.ts", "summary: summarizeMcpCatalog", "Gateway MCP catalog returns the shared summary model"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "Use /capabilities all for the full catalog.", "TUI capability summary points to explicit advanced expansion"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "formatSkillsSummary", "TUI skills default to a summary surface"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "formatPluginsSummary", "TUI plugins default to a summary surface"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "formatMcpServersSummary", "TUI MCP status defaults to a summary surface"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "Latest Session", "TUI overview surfaces the latest WorkSession summary"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "objective=", "TUI overview shows the current objective in the compact snapshot"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "memory=", "TUI overview surfaces compacted session memory state"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "result=", "TUI overview surfaces the latest result summary"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "formatExecutionResultDisplay", "TUI final outputs use a shared result display formatter"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "Result Card", "TUI final outputs default to a result card"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "Memory Freshness", "TUI result cards explain resume memory freshness"),
    checkContains(root, "README.md", "Normal runs now finish with a result card", "README documents result-oriented final UX"),
    checkContains(root, "src/tui/main-panes.ts", "agents: \"Activity\"", "TUI renames the default worker pane to Activity"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "No active background work.", "TUI right rail hides worker internals when idle"),
    checkContains(root, "README.md", "Activity pane summarizes workers", "README documents activity-first worker UX"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "{busy ? \"Trace\" : \"Summary\"}", "TUI right rail shows summary when idle and trace while busy"),
    checkContains(root, "README.md", "Capability and extension surfaces also start with summaries", "README documents summary-first capability surfaces"),
    checkContains(root, "src/tui/slash-commands.ts", "slashCommands", "TUI centralizes slash command metadata"),
    checkContains(root, "src/tui/ChatInputArea.tsx", "CommandCandidates", "TUI renders slash command candidates"),
    checkContains(root, "src/tui/slash-commands.ts", "completeSlashCommand", "TUI exposes Tab slash command completion logic"),
    checkContains(root, "src/tui/chat-input-controller.ts", "completeSlashCommand", "TUI wires Tab slash command completion"),
    checkContains(root, "src/tui/chat-input-controller.ts", "completionIndex", "TUI tracks a highlighted slash command candidate"),
    checkContains(root, "src/tui/slash-commands.ts", "acceptSlashCommandCandidate", "TUI exposes highlighted candidate accept logic"),
    checkContains(root, "src/tui/slash-commands.ts", "parseSlashCommandLine", "TUI slash commands use a quoted argument parser"),
    checkContains(root, "src/tui/chat-input-controller.ts", "acceptSlashCommandCandidate", "TUI accepts the highlighted slash command candidate"),
    checkContains(root, "src/tui/chat-input-controller.ts", "dismissedCompletionKey", "TUI can dismiss slash command candidates"),
    checkContains(root, "src/tui/ChatInputArea.tsx", "Up/Down select  Tab accepts  Esc closes", "TUI candidate list documents selection keys"),
    checkContains(root, "src/tui/slash-commands.ts", "commandOutputPreview", "TUI exposes inline command output preview logic"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "commandOutputPreview", "TUI renders inline command output previews"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "Latest Result", "TUI overview exposes the latest run or command output without opening details"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "preview: display.preview", "TUI stores result-card previews on normal execution chat messages"),
    checkContains(root, "src/tui/slash-commands.ts", "formatToolOutputPreview", "TUI exposes recent output preview formatting"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "formatToolOutputPreview", "TUI output command lists recent output previews"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "toolOutputs={toolResults.slice(-4)}", "TUI passes recent command output into the idle Kernel pane"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "Command Output", "TUI idle Kernel pane has a command output section"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "prepareSlashToolOutput", "TUI prepares slash tool output for inline display and persistence"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "writeTaskOutput", "TUI persists large slash tool output"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "truncateSlashOutput", "TUI renders preview for large slash tool output"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "character === \"q\"", "TUI detail view can exit with q"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "key.escape || (key.ctrl && (character === \"o\" || character === \"c\"))", "TUI detail overlay owns Escape, Ctrl+O, and Ctrl+C"),
    checkContains(root, "README.md", "Tab accepts", "README documents TUI command completion"),
    checkContains(root, "README.md", "preview in the TUI", "README documents inline command output previews"),
    checkContains(root, "README.md", "Output pane", "README documents idle command output pane"),
    checkContains(root, "README.md", "Large slash tool output is", "README documents persisted slash command output"),
    checkContains(root, "README.md", "Ctrl+N/Ctrl+P switches", "README documents TUI main pane switching"),
    checkContains(root, "README.md", "Backspace/Delete handling", "README documents robust input deletion"),
    checkFile(root, "src/tui/onboard-input.ts", "TUI onboarding input helper is isolated"),
    checkContains(root, "src/tui/slash-commands.ts", "\"Core\"", "TUI help includes Core group"),
    checkContains(root, "src/tui/slash-commands.ts", "\"Kernel\"", "TUI help includes Kernel group"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "\"Symphony\"", "TUI help includes Symphony group"),
    checkContains(root, "src/tui/slash-commands.ts", "\"Config\"", "TUI help includes Config group"),
    checkContains(root, "src/server/gateway.ts", "text/event-stream", "Gateway exposes an event stream"),
    checkContains(root, "README.md", "The CLI TUI is the only product interface", "README makes CLI TUI the product interface boundary"),
    checkContains(root, "docs/PRD.md", "The only product interface is the CLI TUI", "PRD makes CLI TUI the only product interface"),
    checkContains(root, "docs/WORK_KERNEL.md", "Product UI: Swarm TUI", "Work Kernel separates TUI product UI from automation entrypoints"),
    checkContains(root, "Symphony.md", "Any product UI outside the CLI/TUI", "Symphony excludes non-TUI product interfaces"),
    checkNoHtmlProductSurface(root, "docs/WORK_KERNEL.md", "Work Kernel avoids non-TUI product interface planning"),
    checkNoHtmlProductSurface(root, "src/server/gateway.ts", "Gateway root stays API-only"),
    checkContains(root, "src/server/gateway.ts", "gatewayIndex", "Gateway root exposes a JSON API index"),
    checkContains(root, "src/server/gateway.ts", "CLI TUI only", "Gateway index points operators to the TUI"),
    checkContains(root, "src/server/gateway.ts", "/v1/sessions", "Gateway exposes session routes"),
    checkContains(root, "src/server/gateway.ts", "approvals", "Gateway exposes approval routes"),
    checkContains(root, "src/index.ts", "command === \"serve\"", "CLI supports swarm serve"),
    checkContains(root, "src/tui/slash-commands.ts", "/graph [session_id]", "task graph TUI command is documented"),
    checkContains(root, "src/tui/slash-commands.ts", "/audit [session_id]", "audit TUI command is documented"),
    checkContains(root, "src/tui/slash-commands.ts", "/budget [session_id]", "budget TUI command is documented"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "type: \"approval\", request, status: \"pending\"", "TUI slash tools persist approval requests through Kernel events"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "type: \"tool_result\"", "TUI slash tools persist tool results through Kernel events"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "sessionId: chatSessionId.current", "TUI slash tools bind local tool execution to the chat WorkSession id"),
    checkContains(root, "src/runtime/runtime.ts", "ensureTuiChatSession", "runtime can create a TUI chat WorkSession"),
    checkContains(root, "src/runtime/runtime.ts", "mode: \"tui_chat\"", "TUI chat WorkSessions are marked with tui_chat source metadata"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "nextRuntime.ensureTuiChatSession(chatSessionId.current)", "TUI runtime creation anchors the chat state in Work Kernel"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "runtime?.ensureTuiChatSession(chatSessionId.current)", "TUI slash tools ensure their chat WorkSession exists"),
    checkContains(root, "src/tui/slash-commands.ts", "/memory [session_id]", "TUI exposes session memory inspection command"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "formatSessionMemory", "TUI renders remembered session context with freshness"),
    checkContains(root, "README.md", "`/memory [session_id]` shows the remembered context", "README documents session memory continuity UX"),
    checkContains(root, "src/tui/slash-commands.ts", "/resume [session_id] [message]", "TUI documents natural coding-loop resume"),
    checkContains(root, "src/tui/slash-commands.ts", "/continue [message]", "TUI documents natural continue command"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "parseResumeTarget", "TUI resume distinguishes session ids from free-form instructions"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "firstIsExistingSession", "TUI resume only consumes the first token as a session when it exists"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "buildResumePrompt", "TUI can resume ordinary coding-loop sessions through Work Kernel snapshots"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "runtime.executeWorkSession", "TUI resume can continue existing WorkSessions without plan_json"),
    checkNotContains(root, "src/tui/idle-pane-snapshot.ts", "runAttemptStore.listRecent", "TUI idle panes do not show global recent attempts"),
    checkNotContains(root, "src/tui/idle-pane-snapshot.ts", "workspaceLeaseStore.listRecent", "TUI idle panes do not show global recent leases"),
    checkNotContains(root, "src/tui/idle-pane-snapshot.ts", "blackboardStore.listRecent", "TUI idle panes do not show global recent blackboard entries"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "briefForExecutionResult", "TUI final chat summaries distinguish execution status"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "Failed: ${brief}", "TUI final chat summaries label failed runs"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "Stopped: ${brief}", "TUI final chat summaries label stopped runs"),
    checkContains(root, "README.md", "The TUI creates a local Work Kernel session for the current chat state", "README documents TUI chat session anchoring"),
    checkContains(root, "docs/WORK_KERNEL.md", "The TUI now anchors its current chat state as a local Work Kernel session", "Work Kernel doc records TUI chat anchoring"),
    checkContains(root, "src/tui/slash-commands.ts", "/self-review", "self-review TUI command is documented"),
    checkContains(root, "src/tui/slash-commands.ts", "/web <query>", "web search TUI command is documented"),
    checkContains(root, "src/tui/slash-commands.ts", "/agents", "agent registry TUI command is documented"),
    checkContains(root, "src/tui/slash-commands.ts", "/handoffs", "handoff TUI command is documented"),
    checkContains(root, "src/tui/slash-commands.ts", "/changes", "workspace changes TUI command is documented"),
    checkContains(root, "src/tui/slash-commands.ts", "/blackboard", "blackboard query TUI command is documented"),
    checkContains(root, "src/tui/slash-commands.ts", "/symphony [workflow_path]", "Symphony status TUI command is documented"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "formatSymphonyStatus", "TUI renders Symphony status from shared status object"),
    checkContains(root, "src/tui/slash-commands.ts", "/symphony-tick [workflow_path]", "TUI documents manual Symphony scheduler tick"),
    checkContains(root, "src/tui/slash-commands.ts", "/symphony-run-once [workflow_path]", "TUI documents manual Symphony run-once execution"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "runSymphonyTick", "TUI dispatches Symphony through the local scheduler"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "formatSymphonyTick", "TUI renders Symphony tick and run-once results"),
    checkContains(root, "README.md", "/symphony-run-once [workflow_path]", "README documents Symphony run-once TUI operation"),
    checkContains(root, "src/tui/slash-commands.ts", "/symphony-cleanup [workflow_path] [--execute]", "Symphony cleanup TUI command is documented"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "formatSymphonyCleanup", "TUI renders Symphony cleanup results"),
    checkContains(root, "src/tui/slash-commands.ts", "/improve-self", "self-improvement TUI command is documented"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "full-auto|yolo", "TUI documents yolo permission mode"),
    checkContains(root, "docs/PRD.md", "existing blackboard", "PRD keeps existing blackboard terminology"),
    checkNotContains(root, "docs/PRD.md", "blackboard v2", "PRD avoids blackboard v2 terminology"),
    checkNotContains(root, "Symphony.md", "Linear", "Symphony spec avoids Linear binding"),
    checkNotContains(root, "Symphony.md", "https://api.linear.app/graphql", "Symphony spec avoids Linear endpoint"),
    checkNotContains(root, "Symphony.md", "api_key", "Symphony spec avoids hosted task API key"),
    checkNotContains(root, "Symphony.md", "project_slug", "Symphony spec avoids hosted task project slug"),
    checkNotContains(root, "Symphony.md", "hosted task", "Symphony spec avoids hosted task-service framing"),
    checkNotContains(root, "Symphony.md", "task-service API", "Symphony spec avoids task-service API framing"),
    checkNotContains(root, "Symphony.md", "tracker_kind", "Symphony spec uses work_source_kind"),
    checkNotContains(root, "Symphony.md", "app-server", "Symphony spec avoids external app-server as core runner"),
    checkNotContains(root, "Symphony.md", "codex", "Symphony spec avoids vendor-specific runner config"),
    checkContains(root, "Symphony.md", "LocalCodingLoopSymphonyRunner", "Symphony spec names the local Work Kernel runner"),
    checkContains(root, "Symphony.md", "`runner`", "Symphony spec uses local runner config"),
    checkNotContains(root, "docs/WORK_KERNEL.md", "Linear", "Work Kernel doc avoids Linear binding"),
    checkNotContains(root, "docs/WORK_KERNEL.md", "tracker API", "Work Kernel doc avoids tracker API dependency"),
    checkNotContains(root, "docs/WORK_KERNEL.md", "External adapters can come later", "Work Kernel doc keeps adapters out of core plan"),
    checkNotContains(root, "docs/WORK_KERNEL.md", "Gateway HTML", "Work Kernel doc avoids browser debug UI framing"),
    checkTuiSlashCandidateBehavior(),
    checkTuiSlashCompletionSizingBehavior(),
    checkTuiSlashTabCompletionBehavior(),
    checkTuiSlashAcceptBehavior(),
    checkTuiSlashArgumentParserBehavior(),
    checkTuiOutputPreviewBehavior(),
    checkTuiOutputListPreviewBehavior(),
    checkTuiRawInputDecodeBehavior(),
    checkTuiStreamInputDecodeBehavior(),
    checkTuiPastedInputBehavior(),
    checkChatInputControllerBehavior(),
    checkTuiHistoryDraftBehavior(),
    checkTuiReadlineKillBehavior(),
    checkTuiBackspaceBehavior(),
    checkTuiDeleteBehavior(),
    checkTuiUnicodeInputEditingBehavior(),
    checkTuiInputRenderingBehavior(),
    checkTuiOnboardInputEditingBehavior(),
    checkTuiEventBufferBehavior(),
    checkTuiApprovalInputBehavior(),
    checkWorkerDisplayNameBehavior(),
    checkEphemeralWorkerPersonaPersistenceBehavior(root),
    checkAgentContinuationFreshnessBehavior(root),
    checkCodingLoopActivityFormattingBehavior(),
    checkToolRecoveryFormattingBehavior(),
    checkToolFailureContentBehavior(),
    checkShellTimeoutReturnsToolFailureBehavior(root),
    checkBackgroundProcessLifecycleSurfaceBehavior(root),
    checkAgentDelegateInputValidationBehavior(),
    checkBuiltinToolSurfaceBehavior(),
    checkBlackboardToolSurfaceBehavior(root),
    checkBlackboardRouterBehavior(),
    checkSwarmProtocolRouterBehavior(root),
    checkToolResultBudgetReplayBehavior(),
    checkSessionContextCompactionBehavior(),
    checkWorkspaceScopedSessionBehavior(),
    checkWorkspaceScopedRecentKernelBehavior(),
    checkFileToolInputValidationBehavior(root),
    checkLintFailureAggregationBehavior(),
    checkWebFetchHttpFailureMetadataBehavior(),
    checkCodingLoopFailedToolFinalStatusBehavior(),
    checkCodingLoopPersistenceStatusBehavior(),
    checkDelegatedWorkerStatusBehavior(),
    checkHostEnvironmentPromptBehavior(),
    checkWorkspaceModifyingFullSwarmRoutePolicy(),
    checkPlannerRejectsBadToolcallsFromLogs(),
    checkLocalShellToolHostValidationCoverage(root),
    checkFullSwarmPlannerNestedDelegateBehavior(),
    checkFullSwarmBlackboardToolRouteability(),
    checkFullSwarmSchedulerParallelBehavior(),
    checkTuiMainPaneCycleBehavior(),
    checkTuiGlobalControlKeyBehavior(),
    checkTuiIdleSnapshotSignatureBehavior(),
    checkPermissionDenyPrecedenceBehavior(),
    checkNoForbiddenProductName(root)
  ];
}

function checkFile(root: string, path: string, name: string): EvalCaseResult {
  const fullPath = resolve(root, path);
  return existsSync(fullPath)
    ? { name, status: "pass", message: path }
    : { name, status: "fail", message: `${path} missing` };
}

function checkContains(root: string, path: string, needle: string, name: string): EvalCaseResult {
  const fullPath = resolve(root, path);
  if (!existsSync(fullPath)) {
    return { name, status: "fail", message: `${path} missing` };
  }
  const content = readFileSync(fullPath, "utf8");
  return content.includes(needle)
    ? { name, status: "pass", message: `${path} contains ${needle}` }
    : { name, status: "fail", message: `${path} does not contain ${needle}` };
}

function checkNotContains(root: string, path: string, needle: string, name: string): EvalCaseResult {
  const fullPath = resolve(root, path);
  if (!existsSync(fullPath)) {
    return { name, status: "fail", message: `${path} missing` };
  }
  const content = readFileSync(fullPath, "utf8").toLowerCase();
  return content.includes(needle.toLowerCase())
    ? { name, status: "fail", message: `${path} contains forbidden text ${needle}` }
    : { name, status: "pass", message: `${path} does not contain ${needle}` };
}

function checkNoForbiddenProductName(root: string): EvalCaseResult {
  const files = ["src/config/settings.ts", "src/tui/SwarmChatApp.tsx", "src/runtime/runtime.ts"];
  const offenders = files.filter((path) => {
    const fullPath = resolve(root, path);
    return existsSync(fullPath) && /\.claude/i.test(readFileSync(fullPath, "utf8"));
  });
  return offenders.length === 0
    ? { name: "no foreign product config namespace", status: "pass", message: "No .claude references in core Swarm files." }
    : { name: "no foreign product config namespace", status: "fail", message: offenders.join(", ") };
}

function fileContains(root: string, path: string, needle: string): boolean {
  const fullPath = resolve(root, path);
  return existsSync(fullPath) && readFileSync(fullPath, "utf8").includes(needle);
}

function checkNoHtmlProductSurface(root: string, path: string, name: string): EvalCaseResult {
  const fullPath = resolve(root, path);
  if (!existsSync(fullPath)) {
    return { name, status: "fail", message: `${path} missing` };
  }
  const content = readFileSync(fullPath, "utf8").toLowerCase();
  const forbidden = [
    `mission ${"control"}`,
    `on${"cli"}${"ck"}`,
    `<${"button"}`,
    `gateway ${"html"}`
  ];
  const offender = forbidden.find((fragment) => content.includes(fragment));
  return offender
    ? { name, status: "fail", message: `${path} contains forbidden interface marker` }
    : { name, status: "pass", message: `${path} avoids non-TUI product interface markers` };
}

function checkTuiSlashCandidateBehavior(): EvalCaseResult {
  const candidates = commandCandidatesForInput("/sym", 4).map((candidate) => candidate.name);
  const required = ["symphony", "symphony-tick", "symphony-run-once"];
  const missing = required.filter((name) => !candidates.includes(name));
  return missing.length === 0
    ? { name: "TUI slash candidate behavior works", status: "pass", message: `/sym candidates include ${required.join(", ")}` }
    : { name: "TUI slash candidate behavior works", status: "fail", message: `/sym candidates missing ${missing.join(", ")}` };
}

function checkTuiSlashCompletionSizingBehavior(): EvalCaseResult {
  let state = createChatInputControllerState();
  state = applyChatInputKey(state, "/", {}).state;
  const candidates = chatInputCompletionCandidates(state);
  const rows = chatInputCompletionRows(state);
  const ok = candidates.length === CHAT_INPUT_COMPLETION_LIMIT
    && rows === CHAT_INPUT_COMPLETION_VISIBLE_ROWS + 4
    && candidates.some((candidate) => candidate.name === "kernel")
    && candidates.some((candidate) => candidate.name === "doctor");
  return ok
    ? { name: "TUI slash completion sizing exposes more command choices", status: "pass", message: `${candidates.length} candidates with ${CHAT_INPUT_COMPLETION_VISIBLE_ROWS} visible rows` }
    : { name: "TUI slash completion sizing exposes more command choices", status: "fail", message: `candidates=${candidates.map((candidate) => candidate.name).join(",")} rows=${rows}` };
}

function checkTuiSlashTabCompletionBehavior(): EvalCaseResult {
  const unique = completeSlashCommand("/do", 3);
  const ambiguous = completeSlashCommand("/symphony-r", 11);
  const uniqueOk = unique?.value === "/doctor " && unique.cursor === "/doctor ".length;
  const ambiguousOk = ambiguous?.value === "/symphony-run-once " && ambiguous.cursor === "/symphony-run-once ".length;
  return uniqueOk && ambiguousOk
    ? { name: "TUI slash Tab completion behavior works", status: "pass", message: "/do and /symphony-r complete to executable commands" }
    : {
        name: "TUI slash Tab completion behavior works",
        status: "fail",
        message: `unexpected completions: /do=${unique?.value ?? "-"} /symphony-r=${ambiguous?.value ?? "-"}`
      };
}

function checkTuiSlashAcceptBehavior(): EvalCaseResult {
  const candidate = commandCandidatesForInput("/ker", 4)[0];
  const accepted = acceptSlashCommandCandidate("/ker stale", 4, candidate);
  const ok = candidate?.name === "kernel" && accepted?.value === "/kernel stale" && accepted.cursor === "/kernel ".length;
  return ok
    ? { name: "TUI slash highlighted candidate accept behavior works", status: "pass", message: "accepting /ker inserts /kernel and preserves args" }
    : {
        name: "TUI slash highlighted candidate accept behavior works",
        status: "fail",
        message: `candidate=${candidate?.name ?? "-"} accepted=${accepted?.value ?? "-"} cursor=${accepted?.cursor ?? "-"}`
      };
}

function checkTuiSlashArgumentParserBehavior(): EvalCaseResult {
  const read = parseSlashCommandLine('/read "dir with spaces/file.ts" 10:20');
  const grep = parseSlashCommandLine('/grep "foo bar" "src with spaces"');
  const shell = parseSlashCommandLine('/shell npm run test -- --grep "foo bar"');
  const singleQuotedShell = parseSlashCommandLine('/shell "npm run test"');
  const escaped = parseSlashCommandLine('/read dir\\ with\\ spaces/file.ts');
  const ok = read?.command === "read"
    && read.args[0] === "dir with spaces/file.ts"
    && read.args[1] === "10:20"
    && grep?.args[0] === "foo bar"
    && grep.args[1] === "src with spaces"
    && shell?.rawArgs === 'npm run test -- --grep "foo bar"'
    && rawSlashArgsAfter(shell, 0) === 'npm run test -- --grep "foo bar"'
    && singleQuotedShell?.args[0] === "npm run test"
    && escaped?.args[0] === "dir with spaces/file.ts";
  return ok
    ? { name: "TUI slash argument parser handles quotes and raw shell args", status: "pass", message: "quoted paths, quoted grep patterns, escaped spaces, and shell raw args parse correctly" }
    : {
        name: "TUI slash argument parser handles quotes and raw shell args",
        status: "fail",
        message: `read=${read?.args.join("|") ?? "-"} grep=${grep?.args.join("|") ?? "-"} shell=${shell?.rawArgs ?? "-"} escaped=${escaped?.args.join("|") ?? "-"}`
      };
}

function checkTuiOutputPreviewBehavior(): EvalCaseResult {
  const preview = commandOutputPreview(["line1", "line2", "line3", "line4"].join("\n"), 2, 80);
  const ok = preview === "line1\nline2\n... [2 lines truncated]";
  return ok
    ? { name: "TUI inline output preview behavior works", status: "pass", message: "multi-line tool output is clipped with an omitted-line marker" }
    : { name: "TUI inline output preview behavior works", status: "fail", message: `unexpected preview: ${preview ?? "-"}` };
}

function checkTuiOutputListPreviewBehavior(): EvalCaseResult {
  const rendered = formatToolOutputPreview({
    task_id: "task-1",
    attempt: 2,
    action: "shell",
    status: "success",
    summary: "ran command",
    outputRef: "/tmp/full-output.txt",
    content: "alpha\nbeta\ngamma"
  });
  const ok = rendered.includes("task-1#2 shell [success]: ran command")
    && rendered.includes("Full output: /tmp/full-output.txt")
    && rendered.includes("  alpha");
  return ok
    ? { name: "TUI recent output list preview behavior works", status: "pass", message: "recent output lists status, full-output ref, and inline content preview" }
    : { name: "TUI recent output list preview behavior works", status: "fail", message: rendered };
}

function checkTuiRawInputDecodeBehavior(): EvalCaseResult {
  const backspace = decodeInputChunk("\x7f");
  const ctrlH = decodeInputChunk("\b");
  const forwardDelete = decodeInputChunk("\x1b[3~");
  const enter = decodeInputChunk("\r");
  const newline = decodeInputChunk("\n");
  const text = decodeInputChunk("abc");
  const ok = backspace?.kind === "backspace"
    && ctrlH?.kind === "backspace"
    && forwardDelete?.kind === "delete"
    && enter?.kind === "return"
    && newline?.kind === "newline"
    && text?.kind === "text"
    && text.value === "abc";
  return ok
    ? { name: "TUI raw stdin decode behavior distinguishes deletion keys", status: "pass", message: "DEL/BS are backspace while ESC[3~ is forward delete" }
    : { name: "TUI raw stdin decode behavior distinguishes deletion keys", status: "fail", message: `backspace=${backspace?.kind ?? "-"} ctrlH=${ctrlH?.kind ?? "-"} delete=${forwardDelete?.kind ?? "-"} enter=${enter?.kind ?? "-"} newline=${newline?.kind ?? "-"} text=${text?.kind ?? "-"}` };
}

function checkTuiStreamInputDecodeBehavior(): EvalCaseResult {
  const first = decodeInputStream("", "\x1b[");
  const second = decodeInputStream(first.pending, "3");
  const third = decodeInputStream(second.pending, "~");
  const coalesced = decodeInputStream("", "ab\x7fc");
  const pendingEscape = decodeInputStream("", "\x1b");
  const flushedEscape = flushInputStream(pendingEscape.pending);
  const pasteStart = decodeInputStream("", "\x1b[200~line1\n");
  const pasteEnd = decodeInputStream(pasteStart.pending, "line2\x1b[201~");
  const ok = first.decoded.length === 0
    && first.pending === "\x1b["
    && second.decoded.length === 0
    && second.pending === "\x1b[3"
    && third.decoded.length === 1
    && third.decoded[0]?.kind === "delete"
    && third.pending === ""
    && coalesced.decoded.map((item) => item.kind).join(",") === "text,backspace,text"
    && coalesced.decoded[0]?.kind === "text"
    && coalesced.decoded[0].value === "ab"
    && coalesced.decoded[2]?.kind === "text"
    && coalesced.decoded[2].value === "c"
    && pendingEscape.decoded.length === 0
    && flushedEscape.decoded[0]?.kind === "escape"
    && pasteStart.decoded.length === 0
    && pasteStart.pending === "\x1b[200~line1\n"
    && pasteEnd.decoded[0]?.kind === "paste"
    && pasteEnd.decoded[0].value === "line1\nline2"
    && pasteEnd.pending === "";
  return ok
    ? { name: "TUI streaming input decoder handles split terminal bytes", status: "pass", message: "split Delete, coalesced text/backspace, split paste, and delayed Escape decode predictably" }
    : {
        name: "TUI streaming input decoder handles split terminal bytes",
        status: "fail",
        message: `first=${first.pending}/${first.decoded.length} second=${second.pending}/${second.decoded.length} third=${third.decoded.map((item) => item.kind).join(",")}/${third.pending} coalesced=${coalesced.decoded.map((item) => item.kind).join(",")} flush=${flushedEscape.decoded.map((item) => item.kind).join(",")} paste=${pasteStart.pending.length}/${pasteEnd.decoded.map((item) => item.kind).join(",")}`
      };
}

function checkTuiPastedInputBehavior(): EvalCaseResult {
  const bracketed = decodeInputChunk("\x1b[200~line1\r\nline2\x1b[201~");
  const rawPaste = decodeInputChunk("alpha\r\nbeta");
  const altEnter = decodeInputChunk("\x1b\r");
  const inserted = insertInputText("ab", 1, "X\nY");
  const ok = bracketed?.kind === "paste"
    && bracketed.value === "line1\nline2"
    && rawPaste?.kind === "paste"
    && rawPaste.value === "alpha\nbeta"
    && altEnter?.kind === "newline"
    && inserted.value === "aX\nYb"
    && inserted.cursor === 4;
  return ok
    ? { name: "TUI pasted multi-line input is preserved", status: "pass", message: "bracketed paste, raw paste, and newline insertion keep prompt text intact" }
    : {
        name: "TUI pasted multi-line input is preserved",
        status: "fail",
        message: `bracketed=${bracketed?.kind ?? "-"}:${bracketed?.kind === "paste" ? bracketed.value : ""} raw=${rawPaste?.kind ?? "-"} alt=${altEnter?.kind ?? "-"} inserted=${inserted.value}/${inserted.cursor}`
      };
}

function checkChatInputControllerBehavior(): EvalCaseResult {
  let state = createChatInputControllerState();
  state = applyChatInputKey(state, "a", {}).state;
  state = applyChatInputKey(state, "b", {}).state;
  state = applyChatInputKey(state, "c", {}).state;
  state = applyChatInputKey(state, "", { backspace: true }).state;
  state = applyChatInputKey(state, "j", { ctrl: true }).state;
  state = applyChatInputKey(state, "d", {}).state;
  const beforeSubmit = state.input.value;
  const submitted = applyChatInputKey(state, "\r", { return: true });
  state = submitted.state;
  const submittedHistory = state.history;
  state = applyChatInputKey(state, "x", {}).state;
  state = applyChatInputKey(state, "", { upArrow: true }).state;
  const recalled = state.input.value;
  state = applyChatInputKey(state, "", { downArrow: true }).state;
  const restoredDraft = state.input.value;
  state = createChatInputControllerState();
  state = applyChatInputKey(state, "/", {}).state;
  state = applyChatInputKey(state, "k", {}).state;
  state = applyChatInputKey(state, "e", {}).state;
  const candidates = chatInputCompletionCandidates(state).map((candidate) => candidate.name);
  state = applyChatInputKey(state, "\t", { tab: true }).state;
  const completed = state.input.value;
  const completedState = state;
  const afterInkDeleteAsBackspaceState = applyChatInputKey(completedState, "", { delete: true }).state;
  const afterInkDeleteAsBackspace = afterInkDeleteAsBackspaceState.input.value;
  const afterInkDeleteAsBackspaceCursor = afterInkDeleteAsBackspaceState.input.cursor;
  const beforeForwardDelete = applyChatInputKey(completedState, "", { leftArrow: true }).state;
  const afterForwardDeleteState = applyChatInputKey(beforeForwardDelete, "[3~", { delete: true }).state;
  const afterDelete = afterForwardDeleteState.input.value;
  const ok = beforeSubmit === "ab\nd"
    && submitted.submit === "ab\nd"
    && submittedHistory[0] === "ab\nd"
    && recalled === "ab\nd"
    && restoredDraft === "x"
    && candidates.includes("kernel")
    && completed === "/kernel "
    && afterInkDeleteAsBackspace === "/kernel"
    && afterInkDeleteAsBackspaceCursor === 7
    && afterDelete === "/kernel";
  return ok
    ? { name: "TUI chat input controller covers real component editing flow", status: "pass", message: "typing, delete, newline, submit, history draft, slash completion, and forward delete share the controller path" }
    : {
        name: "TUI chat input controller covers real component editing flow",
        status: "fail",
        message: `before=${JSON.stringify(beforeSubmit)} submit=${JSON.stringify(submitted.submit)} history=${JSON.stringify(state.history)} recalled=${JSON.stringify(recalled)} draft=${JSON.stringify(restoredDraft)} candidates=${candidates.join(",")} completed=${JSON.stringify(completed)} inkBackspace=${JSON.stringify(afterInkDeleteAsBackspace)}/${afterInkDeleteAsBackspaceCursor} afterDelete=${JSON.stringify(afterDelete)}`
      };
}

function checkTuiHistoryDraftBehavior(): EvalCaseResult {
  const browsing = inputReducer(
    { value: "draft prompt", cursor: 12 },
    { type: "history", value: "previous prompt", cursor: 15, historyIndex: 0, historyDraft: "draft prompt", clearDismissed: true }
  );
  const restored = inputReducer(
    browsing,
    { type: "history", value: browsing.historyDraft ?? "", cursor: browsing.historyDraft?.length ?? 0, historyIndex: undefined, historyDraft: browsing.historyDraft, clearDismissed: true }
  );
  const edited = inputReducer(restored, { type: "replace", value: "new draft", cursor: 9, resetHistory: true });
  const ok = browsing.value === "previous prompt"
    && browsing.historyDraft === "draft prompt"
    && restored.value === "draft prompt"
    && restored.historyIndex === undefined
    && restored.historyDraft === "draft prompt"
    && edited.historyDraft === undefined
    && edited.historyIndex === undefined;
  return ok
    ? { name: "TUI input history preserves unsent drafts", status: "pass", message: "Up/Down history navigation restores the in-progress draft" }
    : { name: "TUI input history preserves unsent drafts", status: "fail", message: `browsing=${browsing.value}/${browsing.historyDraft} restored=${restored.value}/${restored.historyDraft} edited=${edited.historyDraft ?? "-"}` };
}

function checkTuiReadlineKillBehavior(): EvalCaseResult {
  const ctrlK = decodeInputChunk("\x0b");
  const ctrlW = decodeInputChunk("\x17");
  const ctrlY = decodeInputChunk("\x19");
  const backward = killInputBackward("alpha beta", 6);
  const lineEnd = killInputToLineEnd("alpha beta\ngamma", 6);
  const newline = killInputToLineEnd("alpha\nbeta", 5);
  const word = killInputWordBackward("alpha beta  ", 12);
  const yanked = insertInputText(word.state.value, word.state.cursor, word.killed);
  const ok = ctrlK?.kind === "ctrl-k"
    && ctrlW?.kind === "ctrl-w"
    && ctrlY?.kind === "ctrl-y"
    && backward.state.value === "beta"
    && backward.state.cursor === 0
    && backward.killed === "alpha "
    && lineEnd.state.value === "alpha \ngamma"
    && lineEnd.state.cursor === 6
    && lineEnd.killed === "beta"
    && newline.state.value === "alphabeta"
    && newline.killed === "\n"
    && word.state.value === "alpha "
    && word.state.cursor === 6
    && word.killed === "beta  "
    && yanked.value === "alpha beta  "
    && yanked.cursor === 12;
  return ok
    ? { name: "TUI readline-style kill and yank behavior works", status: "pass", message: "Ctrl+K/W/U/Y primitives preserve deleted text and cursor positions" }
    : {
        name: "TUI readline-style kill and yank behavior works",
        status: "fail",
        message: `keys=${ctrlK?.kind ?? "-"},${ctrlW?.kind ?? "-"},${ctrlY?.kind ?? "-"} backward=${backward.state.value}/${backward.killed} line=${lineEnd.state.value}/${lineEnd.killed} newline=${newline.state.value}/${newline.killed} word=${word.state.value}/${word.killed} yank=${yanked.value}/${yanked.cursor}`
      };
}

function checkTuiBackspaceBehavior(): EvalCaseResult {
  const flagged = editInput("abc", 2, undefined, { backspace: true });
  const inkDel = editInput("abc", 2, "", { delete: true });
  const rawDel = editInput("abc", 2, "\x7f", {});
  const rawBackspace = editInput("abc", 2, "\b", {});
  const ok = flagged.handled && flagged.state.value === "ac" && flagged.state.cursor === 1
    && inkDel.handled && inkDel.state.value === "ac" && inkDel.state.cursor === 1
    && rawDel.handled && rawDel.state.value === "ac" && rawDel.state.cursor === 1
    && rawBackspace.handled && rawBackspace.state.value === "ac" && rawBackspace.state.cursor === 1
    && isBackspaceInput("\x7f", {})
    && isBackspaceInput("", { delete: true });
  return ok
    ? { name: "TUI backspace behavior handles raw terminal bytes", status: "pass", message: "backspace works for Ink flags, DEL-as-delete, DEL, and BS bytes" }
    : { name: "TUI backspace behavior handles raw terminal bytes", status: "fail", message: "backspace did not remove the character before cursor consistently" };
}

function checkTuiUnicodeInputEditingBehavior(): EvalCaseResult {
  const emojiBackspace = editInput("a🙂b", 3, undefined, { backspace: true });
  const emojiDelete = editInput("a🙂b", 1, "[3~", {});
  const combining = "e\u0301x";
  const combiningBackspace = editInput(combining, 2, undefined, { backspace: true });
  const movedLeft = inputReducer({ value: "a🙂b", cursor: 4 }, { type: "cursor", cursor: 3 });
  const movedRight = inputReducer({ value: "a🙂b", cursor: 1 }, { type: "cursor", cursor: 2 });
  const ok = emojiBackspace.handled
    && emojiBackspace.state.value === "ab"
    && emojiBackspace.state.cursor === 1
    && emojiDelete.handled
    && emojiDelete.state.value === "ab"
    && emojiDelete.state.cursor === 1
    && combiningBackspace.handled
    && combiningBackspace.state.value === "x"
    && combiningBackspace.state.cursor === 0
    && movedLeft.cursor === 3
    && movedRight.cursor === 3;
  return ok
    ? { name: "TUI unicode input editing keeps graphemes intact", status: "pass", message: "emoji and combining characters delete and move as whole prompt characters" }
    : {
        name: "TUI unicode input editing keeps graphemes intact",
        status: "fail",
        message: `emojiBackspace=${emojiBackspace.handled ? `${emojiBackspace.state.value}/${emojiBackspace.state.cursor}` : "-"} emojiDelete=${emojiDelete.handled ? `${emojiDelete.state.value}/${emojiDelete.state.cursor}` : "-"} combining=${combiningBackspace.handled ? `${combiningBackspace.state.value}/${combiningBackspace.state.cursor}` : "-"} move=${movedLeft.cursor}/${movedRight.cursor}`
      };
}

function checkTuiInputRenderingBehavior(): EvalCaseResult {
  const simple = renderInputLineParts("abc", 1);
  const endCursor = renderInputLineParts("abc", 3);
  const afterBackspace = editInput("abc", 2, undefined, { backspace: true });
  const renderedAfterBackspace = afterBackspace.handled
    ? renderInputLineParts(afterBackspace.state.value, afterBackspace.state.cursor)
    : undefined;
  const emoji = renderInputLineParts("a🙂b", 1);
  const combining = renderInputLineParts("e\u0301x", 0);
  const viewport = inputViewport("one\ntwo\nthree\nfour\nfive", 19, INPUT_RENDER_ROWS);
  const ok = simple.before === "a"
    && simple.current === "b"
    && simple.after === "c"
    && endCursor.before === "abc"
    && endCursor.current === " "
    && endCursor.after === ""
    && renderedAfterBackspace?.before === "a"
    && renderedAfterBackspace.current === "c"
    && renderedAfterBackspace.after === ""
    && emoji.before === "a"
    && emoji.current === "🙂"
    && emoji.after === "b"
    && combining.before === ""
    && combining.current === "e\u0301"
    && combining.after === "x"
    && viewport.value === "... two / three / four / five"
    && viewport.cursor === 25;
  return ok
    ? { name: "TUI input rendering keeps cursor and viewport stable", status: "pass", message: "rendered prompt fragments match edit state for deletion, unicode, end cursor, and multi-line viewport" }
    : {
        name: "TUI input rendering keeps cursor and viewport stable",
        status: "fail",
        message: `simple=${simple.before}/${simple.current}/${simple.after} end=${endCursor.before}/${endCursor.current}/${endCursor.after} backspace=${renderedAfterBackspace ? `${renderedAfterBackspace.before}/${renderedAfterBackspace.current}/${renderedAfterBackspace.after}` : "-"} emoji=${emoji.before}/${emoji.current}/${emoji.after} combining=${combining.before}/${combining.current}/${combining.after} viewport=${viewport.value}/${viewport.cursor}`
      };
}

function checkTuiOnboardInputEditingBehavior(): EvalCaseResult {
  const typed = editOnboardFieldInput("opena", "i", {});
  const flaggedBackspace = editOnboardFieldInput("openai", undefined, { backspace: true });
  const inkDeleteBackspace = editOnboardFieldInput("openai", "", { delete: true });
  const rawDel = editOnboardFieldInput("openai", "\x7f", {});
  const emoji = editOnboardFieldInput("key🙂", undefined, { backspace: true });
  const ignoredReturn = editOnboardFieldInput("openai", "\r", { return: true });
  const ok = typed.handled
    && typed.value === "openai"
    && flaggedBackspace.handled
    && flaggedBackspace.value === "opena"
    && inkDeleteBackspace.handled
    && inkDeleteBackspace.value === "opena"
    && rawDel.handled
    && rawDel.value === "opena"
    && emoji.handled
    && emoji.value === "key"
    && !ignoredReturn.handled;
  return ok
    ? { name: "TUI onboarding input shares robust deletion behavior", status: "pass", message: "onboarding fields handle printable input, raw DEL, delete-as-backspace, grapheme deletion, and leave Enter to form navigation" }
    : {
        name: "TUI onboarding input shares robust deletion behavior",
        status: "fail",
        message: `typed=${typed.handled ? typed.value : "-"} backspace=${flaggedBackspace.handled ? flaggedBackspace.value : "-"} ink=${inkDeleteBackspace.handled ? inkDeleteBackspace.value : "-"} raw=${rawDel.handled ? rawDel.value : "-"} emoji=${emoji.handled ? emoji.value : "-"} return=${ignoredReturn.handled}`
      };
}

function checkTuiEventBufferBehavior(): EvalCaseResult {
  const duplicateActivity = {
    type: "loop_activity" as const,
    session_id: "session-1",
    phase: "running_tool" as const,
    message: "Running shell.exec npm test",
    turn: 1,
    tool: "shell.exec",
    task_id: "task-1"
  };
  const changedActivity = { ...duplicateActivity, message: "Running shell.exec npm run check" };
  const first = appendTuiRuntimeEvent([], duplicateActivity);
  const deduped = appendTuiRuntimeEvent(first, { ...duplicateActivity });
  const changed = appendTuiRuntimeEvent(deduped, changedActivity);
  const timelineFirst = appendTuiLoopActivity([], duplicateActivity, 3);
  const timelineDeduped = appendTuiLoopActivity(timelineFirst, { ...duplicateActivity }, 3);
  const timelineChanged = appendTuiLoopActivity(timelineDeduped, changedActivity, 3);
  let capped = changed;
  for (let index = 0; index < TUI_EVENT_BUFFER_LIMIT + 8; index += 1) {
    capped = appendTuiRuntimeEvent(capped, {
      type: "progress",
      completed: index,
      total: TUI_EVENT_BUFFER_LIMIT + 8
    });
  }
  const last = capped[capped.length - 1];
  const ok = first.length === 1
    && deduped === first
    && changed.length === 2
    && sameRuntimeEventDisplay(duplicateActivity, { ...duplicateActivity })
    && !sameRuntimeEventDisplay(duplicateActivity, changedActivity)
    && timelineFirst.length === 1
    && timelineDeduped === timelineFirst
    && timelineChanged.length === 2
    && capped.length === TUI_EVENT_BUFFER_LIMIT
    && last?.type === "progress"
    && last.completed === TUI_EVENT_BUFFER_LIMIT + 7;
  return ok
    ? { name: "TUI event buffer skips duplicate redraw events", status: "pass", message: "consecutive duplicate runtime events keep the same array while changed events append and the buffer remains capped" }
    : {
        name: "TUI event buffer skips duplicate redraw events",
        status: "fail",
        message: `first=${first.length} dedupedSame=${deduped === first} changed=${changed.length} timeline=${timelineFirst.length}/${timelineDeduped === timelineFirst}/${timelineChanged.length} same=${sameRuntimeEventDisplay(duplicateActivity, { ...duplicateActivity })} capped=${capped.length} last=${last?.type === "progress" ? last.completed : "-"}`
      };
}

function checkTuiApprovalInputBehavior(): EvalCaseResult {
  const yes = approvalInputDecision("y", {});
  const allowOnce = approvalInputDecision("a", {});
  const allowSession = approvalInputDecision("s", {});
  const no = approvalInputDecision("n", {});
  const deny = approvalInputDecision("d", {});
  const escape = approvalInputDecision("", { escape: true });
  const ctrlC = approvalInputDecision("c", { ctrl: true });
  const ignored = approvalInputDecision("x", {});
  const ok = yes.handled && yes.approved && !yes.rememberForSession
    && allowOnce.handled && allowOnce.approved && !allowOnce.rememberForSession
    && allowSession.handled && allowSession.approved && allowSession.rememberForSession
    && no.handled && !no.approved && !no.rememberForSession
    && deny.handled && !deny.approved && !deny.rememberForSession
    && escape.handled && !escape.approved
    && ctrlC.handled && !ctrlC.approved
    && !ignored.handled;
  return ok
    ? { name: "TUI approval input maps decisions deterministically", status: "pass", message: "approval keys approve, deny, remember session, cancel, and ignore unrelated input predictably" }
    : {
        name: "TUI approval input maps decisions deterministically",
        status: "fail",
        message: `yes=${fmtApprovalDecision(yes)} once=${fmtApprovalDecision(allowOnce)} session=${fmtApprovalDecision(allowSession)} no=${fmtApprovalDecision(no)} deny=${fmtApprovalDecision(deny)} escape=${fmtApprovalDecision(escape)} ctrlC=${fmtApprovalDecision(ctrlC)} ignored=${fmtApprovalDecision(ignored)}`
      };
}

function fmtApprovalDecision(decision: ReturnType<typeof approvalInputDecision>): string {
  return decision.handled ? `${decision.approved}/${decision.rememberForSession}` : "ignored";
}

function checkWorkerDisplayNameBehavior(): EvalCaseResult {
  const now = new Date().toISOString();
  const worker = {
    worker_id: "worker_eval_123",
    display_name: "Ada",
    role_title: "Diff Investigator",
    parent_session_id: "session_eval",
    agent_spec_id: "reviewer",
    invocation_mode: "call_subagent" as const,
    capability: "code.review",
    objective: "Review the diff.",
    status: "running" as const,
    file_scope: ["src/runtime/runtime.ts"],
    tool_budget: { max_turns: 1, max_tool_calls: 1 },
    last_result: "Found one blocking issue.\nDetails omitted.",
    created_at: now,
    updated_at: now
  };
  const brief = formatWorkerBrief(worker);
  const started = formatRuntimeEventBrief({
    type: "agent_run_started",
    worker,
    task_packet: {
      objective: worker.objective,
      agent_spec_id: "reviewer",
      invocation_mode: "call_subagent",
      persona_snapshot: "reviewer",
      role_title: "Diff Investigator",
      file_scope: worker.file_scope,
      allowed_tools: [],
      write_policy: "read_only",
      budget: worker.tool_budget,
      expected_output: "brief",
      return_conditions: []
    }
  });
  const ok = workerDisplayLabel(worker) === "Ada / Diff Investigator"
    && brief.includes("Ada / Diff Investigator")
    && brief.includes("worker_eval_123")
    && brief.includes("Found one blocking issue.")
    && started.includes("Ada / Diff Investigator");
  return ok
    ? { name: "worker agent display names surface in TUI/headless formatters", status: "pass", message: "worker brief and agent-run events include the human-readable name plus worker id" }
    : { name: "worker agent display names surface in TUI/headless formatters", status: "fail", message: `brief=${brief} started=${started}` };
}

function checkEphemeralWorkerPersonaPersistenceBehavior(root: string): EvalCaseResult {
  const runtimePath = resolve(root, "src/runtime/runtime.ts");
  if (!existsSync(runtimePath)) {
    return { name: "worker persona brief stays out of durable recall", status: "fail", message: "src/runtime/runtime.ts missing" };
  }
  const content = readFileSync(runtimePath, "utf8");
  const requiredDurableWrites = [
    "const durableTaskPacket = stripEphemeralAgentPersona(taskPacket);",
    "task_packet: durableTaskPacket",
    "decision: durableDecision",
    "sessionObjective: request.task",
    "task_packet: stripEphemeralAgentPersona(event.task_packet)",
    "resource: { worker_id: event.worker.worker_id, task_packet: stripEphemeralAgentPersona(event.task_packet) }"
  ];
  const missing = requiredDurableWrites.filter((needle) => !content.includes(needle));
  const workerContextStart = content.indexOf('if (event.type === "agent_run_started")');
  const workerContextEnd = content.indexOf('if (event.type === "agent_run_completed")', workerContextStart);
  const workerContextBlock = workerContextStart >= 0 && workerContextEnd > workerContextStart
    ? content.slice(workerContextStart, workerContextEnd)
    : "";
  const durableRecallHasPersona = workerContextBlock.includes("persona_brief");
  const ok = missing.length === 0 && !durableRecallHasPersona;
  return ok
    ? { name: "worker persona brief stays out of durable recall", status: "pass", message: "worker task packets are stripped before durable stores and session context omits persona_brief" }
    : { name: "worker persona brief stays out of durable recall", status: "fail", message: `missing=${missing.join(",") || "none"} durableRecallHasPersona=${durableRecallHasPersona}` };
}

function checkAgentContinuationFreshnessBehavior(root: string): EvalCaseResult {
  const runtime = readFileSync(resolve(root, "src/runtime/runtime.ts"), "utf8");
  const tui = readFileSync(resolve(root, "src/tui/SwarmChatApp.tsx"), "utf8");
  const runtimeChecks = [
    "renderWorkspaceFreshnessContract",
    "Treat previous task packets, compacted memory, and worker results as historical clues, not current facts.",
    "Before editing or giving a code-state conclusion, refresh the current workspace",
    "If refreshed facts differ from memory, follow the current workspace state",
    "const workspaceFreshness = this.renderWorkspaceFreshnessContract",
    "taskPacket.relevant_context = [",
    "Historical memory and prior worker results are hints only."
  ];
  const tuiChecks = [
    "runtime.renderWorkspaceFreshnessContract",
    "reason: \"resuming a previous WorkSession\"",
    "fileScope: snapshot.changed_files"
  ];
  const missing = [
    ...runtimeChecks.filter((needle) => !runtime.includes(needle)).map((needle) => `runtime:${needle}`),
    ...tuiChecks.filter((needle) => !tui.includes(needle)).map((needle) => `tui:${needle}`)
  ];
  return missing.length === 0
    ? { name: "agent continuation refreshes stale workspace memory", status: "pass", message: "resume, worker continuation, and spawned agents receive a freshness contract before relying on old memory" }
    : { name: "agent continuation refreshes stale workspace memory", status: "fail", message: `missing=${missing.join("; ")}` };
}

function checkCodingLoopActivityFormattingBehavior(): EvalCaseResult {
  const event = {
    type: "loop_activity" as const,
    session_id: "loop_eval",
    phase: "running_tool" as const,
    message: "Running shell.exec npm test",
    turn: 2,
    tool: "shell.exec",
    task_id: "tool_eval"
  };
  const failed = {
    type: "loop_activity" as const,
    session_id: "loop_eval",
    phase: "failed" as const,
    message: "Failed: Budget exhausted before completion.",
    task_id: "final"
  };
  const brief = formatRuntimeEventBrief(event);
  const headless = formatHeadlessProgress(event);
  const failedBrief = formatRuntimeEventBrief(failed);
  const failedHeadless = formatHeadlessProgress(failed);
  const finalFailed = {
    type: "final" as const,
    session_id: "loop_eval",
    content: "Tool failed.",
    status: "failed" as const,
    outcome: {
      changed_files: ["src/index.ts"],
      intermediate_artifacts: [],
      tests_run: [],
      final_summary: "Failed tool: npm test exited 1"
    }
  };
  const finalBrief = formatRuntimeEventBrief(finalFailed);
  const finalHeadless = formatHeadlessProgress(finalFailed);
  const ok = brief === "activity: Running shell.exec npm test"
    && headless === "activity: Running shell.exec npm test"
    && failedBrief === "activity: Failed: Budget exhausted before completion."
    && failedHeadless === "activity: Failed: Budget exhausted before completion."
    && finalBrief === "final: failed, 1 changed, 0 checks"
    && finalHeadless === "final: failed, 1 changed, 0 checks";
  return ok
    ? { name: "coding loop activity events format for TUI and headless output", status: "pass", message: "loop_activity and final events produce stable current-action and failed-final lines" }
    : { name: "coding loop activity events format for TUI and headless output", status: "fail", message: `brief=${brief} headless=${headless ?? "-"} failed=${failedBrief}/${failedHeadless ?? "-"} final=${finalBrief}/${finalHeadless ?? "-"}` };
}

function checkToolRecoveryFormattingBehavior(): EvalCaseResult {
  const event = {
    type: "tool_result" as const,
    session_id: "recovery_eval",
    task_id: "tool_eval",
    title: "Shell failed",
    action: "shell.exec",
    summary: "command exited 1",
    status: "failed" as const,
    errorCode: "EXIT_1",
    recoverySuggestion: "Read stderr, patch the relevant code, then rerun the same command."
  };
  const brief = formatRuntimeEventBrief(event);
  const headless = formatHeadlessProgress(event);
  const ok = brief.includes("recovery=")
    && brief.includes("Read stderr")
    && headless?.includes("recovery=Read stderr");
  return ok
    ? { name: "tool recovery guidance formats for TUI and headless output", status: "pass", message: "tool_result recoverySuggestion is visible in compact and headless progress" }
    : { name: "tool recovery guidance formats for TUI and headless output", status: "fail", message: `brief=${brief} headless=${headless ?? "-"}` };
}

function checkToolFailureContentBehavior(): EvalCaseResult {
  const content = formatToolFailureContent(
    "file.edit",
    "Refusing to modify src/index.ts before reading it in this session",
    "PERMISSION_DENIED",
    "Inspect the approval or permission rule, then retry with a narrower command."
  );
  const ok = content.includes("ERROR: Refusing to modify")
    && content.includes("Error code: PERMISSION_DENIED")
    && content.includes("Recovery: Inspect the approval")
    && content.includes("Action: file.edit");
  return ok
    ? { name: "tool exception failures include expandable detail content", status: "pass", message: "coding-loop tool exceptions carry ERROR, error code, recovery, and action detail for TUI detail panes" }
    : { name: "tool exception failures include expandable detail content", status: "fail", message: content };
}

function checkShellTimeoutReturnsToolFailureBehavior(root: string): EvalCaseResult {
  const content = readFileSync(resolve(root, "src/tools/local-tools.ts"), "utf8");
  const execNoThrowLikeCc = content.includes("const result = await runShellCommand(action.command, { cwd, timeoutMs, maxOutputBytes });")
    && content.includes('status: succeeded ? "success" : "failed"')
    && content.includes("command timed out after ${timeoutMs}ms")
    && content.includes("timeoutMs,");
  const hasTimeoutAliases = content.includes("inputs.timeoutMs ?? inputs.timeout_ms ?? inputs.timeout")
    && content.includes('if (action === "exec")')
    && content.includes('if (action === "code.test")')
    && content.includes('if (action === "code.build")')
    && content.includes('if (action === "package.install")');
  const ok = execNoThrowLikeCc && hasTimeoutAliases;
  return ok
    ? { name: "shell exec timeout returns a recoverable tool failure", status: "pass", message: "shell/exec/test/build/install timeout aliases normalize and shell command failures resolve as ToolResult failures" }
    : { name: "shell exec timeout returns a recoverable tool failure", status: "fail", message: `execNoThrowLikeCc=${execNoThrowLikeCc} hasTimeoutAliases=${hasTimeoutAliases}` };
}

function checkBackgroundProcessLifecycleSurfaceBehavior(root: string): EvalCaseResult {
  const localTools = readFileSync(resolve(root, "src/tools/local-tools.ts"), "utf8");
  const backgroundModule = readFileSync(resolve(root, "src/tools/background-processes.ts"), "utf8");
  const codingLoop = readFileSync(resolve(root, "src/runtime/coding-agent-loop.ts"), "utf8");
  const builtinTools = readFileSync(resolve(root, "src/extensions/builtin-tools.ts"), "utf8");
  const normalizedStart = normalizeToolAction({ action: "ProcessStart", command: "npm run dev", cwd: ".", description: "dev server" });
  const normalizedTail = normalizeToolAction({ action: "ProcessTail", processId: "proc_1", lines: 20 });
  const normalizedBashBackground = normalizeToolAction({ action: "Bash", command: "npm run dev", run_in_background: true });
  const hasProcessActions = [
    "process.start",
    "process.status",
    "process.list",
    "process.tail",
    "process.grep",
    "process.stop"
  ].every((name) => localTools.includes(`type: "${name}"`) || localTools.includes(`"${name}"`));
  const hasPersistentLogs = backgroundModule.includes("processes")
    && backgroundModule.includes(".log")
    && backgroundModule.includes(".json")
    && backgroundModule.includes("readBackgroundProcessTail")
    && backgroundModule.includes("grepBackgroundProcessLog")
    && backgroundModule.includes("stopBackgroundProcess");
  const hasModelSurface = ["ProcessStart", "ProcessTail", "ProcessGrep", "ProcessStop"].every((name) => codingLoop.includes(`"${name}"`) && builtinTools.includes(`name: "${name}"`));
  const ok = normalizedStart.type === "process.start"
    && normalizedTail.type === "process.tail"
    && normalizedBashBackground.type === "shell.exec"
    && normalizedBashBackground.runInBackground === true
    && hasProcessActions
    && hasPersistentLogs
    && hasModelSurface;
  return ok
    ? { name: "background process lifecycle tools are exposed", status: "pass", message: "process.start/status/list/tail/grep/stop normalize, persist logs, and appear in model-visible tool schemas" }
    : { name: "background process lifecycle tools are exposed", status: "fail", message: `start=${JSON.stringify(normalizedStart)} tail=${JSON.stringify(normalizedTail)} bash=${JSON.stringify(normalizedBashBackground)} processActions=${hasProcessActions} logs=${hasPersistentLogs} modelSurface=${hasModelSurface}` };
}

function checkAgentDelegateInputValidationBehavior(): EvalCaseResult {
  const missingCapability = catchesMessage(
    () => normalizeToolAction({ action: "agent.delegate", task: "Inspect routing behavior" }),
    "agent.delegate requires capability"
  );
  const missingTask = catchesMessage(
    () => normalizeToolAction({ action: "agent.delegate", capability: "code.research" }),
    "agent.delegate requires task"
  );
  const valid = normalizeToolAction({
    action: "agent.delegate",
    capability: "code.research",
    task: "Inspect routing behavior"
  });
  const visibleAgent = normalizeToolAction({
    action: "Agent",
    prompt: "Inspect routing behavior"
  });
  const visibleTask = normalizeToolAction({
    action: "Task",
    prompt: "Inspect routing behavior",
    subagent_type: "reviewer"
  });
  const ok = missingCapability
    && missingTask
    && valid.type === "agent.delegate"
    && valid.capability === "code.research"
    && valid.task === "Inspect routing behavior"
    && visibleAgent.type === "agent.delegate"
    && visibleAgent.capability === "code.research"
    && visibleAgent.task === "Inspect routing behavior"
    && visibleTask.type === "agent.delegate"
    && visibleTask.capability === "reviewer"
    && visibleTask.preferred_agent_spec_id === "reviewer";
  return ok
    ? { name: "agent.delegate validates required inputs before execution", status: "pass", message: "compat agent.delegate stays strict while visible Agent/Task inputs normalize to delegation" }
    : { name: "agent.delegate validates required inputs before execution", status: "fail", message: `missingCapability=${missingCapability} missingTask=${missingTask} valid=${JSON.stringify(valid)} visibleAgent=${JSON.stringify(visibleAgent)} visibleTask=${JSON.stringify(visibleTask)}` };
}

function checkBuiltinToolSurfaceBehavior(): EvalCaseResult {
  const capabilities = new BuiltinLocalToolProvider().listCapabilities();
  const names = new Set(capabilities.map((capability) => capability.name));
  const modelVisibleNames = capabilities.filter((capability) => capability.modelVisible).map((capability) => capability.name).sort();
  const modelVisible = new Set(modelVisibleNames);
  const required = ["Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit", "TodoWrite", "BlackboardWrite", "BlackboardSearch", "BlackboardRead", "BlackboardList", "Bash", "ProcessStart", "ProcessStatus", "ProcessList", "ProcessTail", "ProcessGrep", "ProcessStop", "WebSearch", "WebFetch", "Agent"].sort();
  const missing = required.filter((name) => !modelVisible.has(name));
  const extraVisible = modelVisibleNames.filter((name) => !required.includes(name));
  const forbidden = [`solid${"ity"}.compile`, `Solid${"ity"}Compile`];
  const presentForbidden = forbidden.filter((name) => names.has(name) || modelVisible.has(name));
  const legacyListHidden = names.has("LS") && !modelVisible.has("LS");
  const normalizedRead = normalizeToolAction({ action: "Read", file_path: "src/index.ts" });
  const normalizedEdit = normalizeToolAction({ action: "Edit", file_path: "a.txt", old_string: "x", new_string: "y", replace_all: true });
  const normalizedBash = normalizeToolAction({ action: "Bash", command: "npm run check", timeout: 1000 });
  const normalizedExec = normalizeToolAction({ action: "exec", command: "npm run check", timeout: 2000 });
  const normalizedTest = normalizeToolAction({ action: "code.test", command: "npm test", timeout: 3000 });
  const ok = missing.length === 0
    && extraVisible.length === 0
    && presentForbidden.length === 0
    && legacyListHidden
    && normalizedRead.type === "file.read"
    && normalizedRead.path === "src/index.ts"
    && normalizedEdit.type === "file.edit"
    && normalizedEdit.replaceAll === true
    && normalizedBash.type === "shell.exec"
    && normalizedBash.timeoutMs === 1000
    && normalizedExec.type === "exec"
    && normalizedExec.timeoutMs === 2000
    && normalizedTest.type === "code.test"
    && normalizedTest.timeoutMs === 3000;
  return ok
    ? { name: "built-in tool surface exposes generic coding tools", status: "pass", message: "model-visible tools are the generic coding set, LS is compat-hidden, and domain-specific compile tooling is absent" }
    : { name: "built-in tool surface exposes generic coding tools", status: "fail", message: `missing=${missing.join(",") || "-"} extra=${extraVisible.join(",") || "-"} forbidden=${presentForbidden.join(",") || "-"} legacyListHidden=${legacyListHidden} read=${JSON.stringify(normalizedRead)} edit=${JSON.stringify(normalizedEdit)} bash=${JSON.stringify(normalizedBash)} exec=${JSON.stringify(normalizedExec)} test=${JSON.stringify(normalizedTest)}` };
}

function checkBlackboardToolSurfaceBehavior(root: string): EvalCaseResult {
  const write = normalizeToolAction({ action: "BlackboardWrite", key: "agent.finding", type: "evidence", value: { ok: true }, tags: ["agent"] });
  const search = normalizeToolAction({ action: "BlackboardSearch", query: "finding", tag: "agent", limit: 5 });
  const read = normalizeToolAction({ action: "BlackboardRead", key: "agent.finding" });
  const list = normalizeToolAction({ action: "BlackboardList", type: "evidence", key_prefix: "agent.", limit: 10 });
  const noRawEnvelopeTool = !fileContains(root, "src/extensions/builtin-tools.ts", "EnvelopeWrite")
    && !fileContains(root, "src/extensions/builtin-tools.ts", "sendEnvelope")
    && !fileContains(root, "src/runtime/coding-agent-loop.ts", "EnvelopeWrite");
  const childAllowsRuntimeTraffic = fileContains(root, "src/runtime/runtime.ts", "envelope.type === \"task.progress\"")
    && fileContains(root, "src/runtime/runtime.ts", "envelope.type === \"blackboard.write\"")
    && fileContains(root, "src/runtime/runtime.ts", "envelope.type === \"blackboard.read\"");
  const ok = write.type === "blackboard.write"
    && write.entryType === "evidence"
    && search.type === "blackboard.search"
    && search.query === "finding"
    && read.type === "blackboard.read"
    && read.key === "agent.finding"
    && list.type === "blackboard.list"
    && list.entryType === "evidence"
    && noRawEnvelopeTool
    && childAllowsRuntimeTraffic;
  return ok
    ? { name: "blackboard semantic tools expose shared state without raw envelopes", status: "pass", message: "BlackboardWrite/Search/Read/List normalize to semantic actions and child runtime traffic includes progress plus blackboard envelopes" }
    : { name: "blackboard semantic tools expose shared state without raw envelopes", status: "fail", message: `write=${JSON.stringify(write)} search=${JSON.stringify(search)} read=${JSON.stringify(read)} list=${JSON.stringify(list)} noRawEnvelopeTool=${noRawEnvelopeTool} childAllowsRuntimeTraffic=${childAllowsRuntimeTraffic}` };
}

function checkBlackboardRouterBehavior(): EvalCaseResult {
  const dir = mkdtempSync(resolve(tmpdir(), "swarm-eval-"));
  const database = new SwarmDatabase(resolve(dir, "swarm.db"));
  try {
    const events = new RuntimeEvents();
    const router = new EnvelopeRouter(
      new AgentRegistry(events),
      new TraceStore(database),
      events,
      new BlackboardStore(database)
    );
    const written: unknown[] = [];
    const incoming: Array<{ type: string; intent: string; payload: unknown }> = [];
    events.onEvent((event) => {
      if (event.type === "blackboard") {
        written.push(event.entry);
      }
    });
    router.on("incoming", (envelope) => {
      incoming.push({ type: envelope.type, intent: envelope.intent, payload: envelope.payload });
    });
    const writeEnvelope = createEnvelope({
      swarm_id: "swarm_eval",
      session_id: "session_eval",
      task_id: "task_eval",
      from: { agent_id: "agent_eval", role: "researcher" },
      to: { agent_id: "blackboard", role: "blackboard" },
      type: "blackboard.write",
      intent: "blackboard.write",
      payload: {
        key: "eval.blackboard",
        type: "evidence",
        value: { result: "ok" },
        tags: ["eval"]
      },
      correlation_id: "corr_write"
    });
    void router.dispatch(writeEnvelope);
    const readEnvelope = createEnvelope({
      swarm_id: "swarm_eval",
      session_id: "session_eval",
      task_id: "task_eval",
      from: { agent_id: "agent_eval", role: "researcher" },
      to: { agent_id: "blackboard", role: "blackboard" },
      type: "blackboard.read",
      intent: "blackboard.read",
      payload: { key: "eval.blackboard" },
      correlation_id: "corr_read"
    });
    void router.dispatch(readEnvelope);
    const readAck = incoming.find((envelope) => envelope.intent === "blackboard.read.ack");
    const readPayload = isRecord(readAck?.payload) ? readAck.payload : {};
    const entries = Array.isArray(readPayload.entries) ? readPayload.entries : [];
    const firstEntry = isRecord(entries[0]) ? entries[0] : {};
    const ok = written.length === 1 && firstEntry.key === "eval.blackboard";
    return ok
      ? { name: "router handles blackboard write/read envelopes", status: "pass", message: "router writes blackboard entries and returns read ack entries" }
      : { name: "router handles blackboard write/read envelopes", status: "fail", message: `written=${written.length} incoming=${JSON.stringify(incoming)}` };
  } finally {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkSwarmProtocolRouterBehavior(root: string): EvalCaseResult {
  const dir = mkdtempSync(resolve(tmpdir(), "swarm-protocol-eval-"));
  const database = new SwarmDatabase(resolve(dir, "swarm.db"));
  try {
    const events = new RuntimeEvents();
    const registry = new AgentRegistry(events);
    const sent: unknown[] = [];
    registry.register(evalAgentCard("agent_a", "researcher", ["code.audit"]), { send: (message: unknown) => { sent.push(message); return true; } } as never);
    registry.register(evalAgentCard("agent_b", "reviewer", ["code.audit"]), { send: (message: unknown) => { sent.push(message); return true; } } as never);
    const router = new EnvelopeRouter(
      registry,
      new TraceStore(database),
      events,
      new BlackboardStore(database),
      new ArtifactStore(database),
      new TaskStateStore(database)
    );
    const incoming: Array<{ type: string; intent: string; payload: unknown }> = [];
    router.on("incoming", (envelope) => {
      incoming.push({ type: envelope.type, intent: envelope.intent, payload: envelope.payload });
    });

    const writeEnvelope = createEnvelope({
      swarm_id: "swarm_protocol_eval",
      session_id: "session_protocol_eval",
      task_id: "task_protocol_eval",
      from: { agent_id: "planner", role: "coordinator" },
      to: { agent_id: "blackboard", role: "blackboard" },
      type: "blackboard.write",
      intent: "blackboard.write",
      payload: { key: "protocol.entry", type: "evidence", value: { status: "draft" } }
    });
    void router.dispatch(createEnvelope({
      swarm_id: "swarm_protocol_eval",
      session_id: "session_protocol_eval",
      from: { agent_id: "planner", role: "coordinator" },
      to: { agent_id: "router", role: "router" },
      type: "swarm.init",
      intent: "swarm.init",
      payload: { objective: "protocol eval" }
    }));
    void router.dispatch(createEnvelope({
      swarm_id: "swarm_protocol_eval",
      session_id: "session_protocol_eval",
      from: { agent_id: "dynamic_agent", role: "researcher" },
      to: { agent_id: "router", role: "router" },
      type: "agent.register",
      intent: "agent.register",
      payload: evalAgentCard("dynamic_agent", "researcher", ["docs.summarize"])
    }));
    void router.dispatch(createEnvelope({
      swarm_id: "swarm_protocol_eval",
      session_id: "session_protocol_eval",
      from: { agent_id: "dynamic_agent", role: "researcher" },
      to: { agent_id: "router", role: "router" },
      type: "agent.update_status",
      intent: "agent.update_status",
      payload: { agent_id: "dynamic_agent", status: "busy" }
    }));
    void router.dispatch(createEnvelope({
      swarm_id: "swarm_protocol_eval",
      session_id: "session_protocol_eval",
      task_id: "task_created_eval",
      from: { agent_id: "planner", role: "coordinator" },
      to: { agent_id: "router", role: "router" },
      type: "task.create",
      intent: "task.create",
      payload: {
        task_id: "task_created_eval",
        title: "Protocol task",
        description: "Persist a task created through an envelope.",
        objective: "Persist task",
        type: "analysis",
        status: "created",
        required_capabilities: ["code.audit"],
        inputs: {},
        expected_output: { format: "markdown" }
      }
    }));
    void router.dispatch(createEnvelope({
      swarm_id: "swarm_protocol_eval",
      session_id: "session_protocol_eval",
      task_id: "task_created_eval",
      from: { agent_id: "planner", role: "coordinator" },
      to: { agent_id: "router", role: "router" },
      type: "task.cancel",
      intent: "task.cancel",
      payload: {
        task_id: "task_created_eval",
        title: "Protocol task",
        description: "Persist a task created through an envelope.",
        objective: "Persist task",
        type: "analysis",
        required_capabilities: ["code.audit"],
        inputs: {},
        expected_output: { format: "markdown" }
      }
    }));
    void router.dispatch(createEnvelope({
      swarm_id: "swarm_protocol_eval",
      session_id: "session_protocol_eval",
      from: { agent_id: "planner", role: "coordinator" },
      to: { agent_id: "router", role: "router" },
      type: "artifact.create",
      intent: "artifact.create",
      payload: { artifact_id: "artifact_eval", path: "reports/eval.md", type: "markdown", summary: "draft" }
    }));
    void router.dispatch(createEnvelope({
      swarm_id: "swarm_protocol_eval",
      session_id: "session_protocol_eval",
      from: { agent_id: "planner", role: "coordinator" },
      to: { agent_id: "router", role: "router" },
      type: "artifact.update",
      intent: "artifact.update",
      payload: { artifact_id: "artifact_eval", path: "reports/final.md", type: "markdown", summary: "final" }
    }));
    void router.dispatch(writeEnvelope);
    const writeAck = incoming.find((envelope) => envelope.intent === "blackboard.write.ack");
    const writePayload = isRecord(writeAck?.payload) ? writeAck.payload : {};
    const entry = isRecord(writePayload.entry) ? writePayload.entry : {};

    void router.dispatch(createEnvelope({
      swarm_id: "swarm_protocol_eval",
      session_id: "session_protocol_eval",
      task_id: "task_protocol_eval",
      from: { agent_id: "planner", role: "coordinator" },
      to: { agent_id: "blackboard", role: "blackboard" },
      type: "blackboard.update",
      intent: "blackboard.update",
      payload: { entry_id: entry.entry_id, value: { status: "updated" }, expected_version: 1 }
    }));
    void router.dispatch(createEnvelope({
      swarm_id: "swarm_protocol_eval",
      session_id: "session_protocol_eval",
      task_id: "task_protocol_eval",
      from: { agent_id: "planner", role: "coordinator" },
      to: { agent_id: "blackboard", role: "blackboard" },
      type: "blackboard.lock",
      intent: "blackboard.lock",
      payload: { key: "protocol.entry", ttl_ms: 1000 }
    }));
    void router.dispatch(createEnvelope({
      swarm_id: "swarm_protocol_eval",
      session_id: "session_protocol_eval",
      task_id: "task_protocol_eval",
      from: { agent_id: "planner", role: "coordinator" },
      to: { agent_id: "blackboard", role: "blackboard" },
      type: "blackboard.unlock",
      intent: "blackboard.unlock",
      payload: { key: "protocol.entry" }
    }));
    void router.dispatch(createEnvelope({
      swarm_id: "swarm_protocol_eval",
      session_id: "session_protocol_eval",
      task_id: "task_protocol_eval",
      from: { agent_id: "planner", role: "coordinator" },
      to: { capability: "code.audit" },
      type: "bid.request",
      intent: "bid.request",
      payload: { task_id: "task_protocol_eval", required_capabilities: ["code.audit"] },
      routing: { mode: "broadcast", require_ack: true },
      correlation_id: "bid_eval"
    }));
    void router.dispatch(createEnvelope({
      swarm_id: "swarm_protocol_eval",
      session_id: "session_protocol_eval",
      task_id: "task_protocol_eval",
      from: { agent_id: "agent_a", role: "researcher" },
      to: { agent_id: "planner", role: "coordinator" },
      type: "bid.submit",
      intent: "bid.submit",
      payload: { confidence: 0.9, estimated_time_ms: 1000, reason: "available" },
      correlation_id: "bid_eval"
    }));
    void router.dispatch(createEnvelope({
      swarm_id: "swarm_protocol_eval",
      session_id: "session_protocol_eval",
      task_id: "task_protocol_eval",
      from: { agent_id: "agent_a", role: "researcher" },
      to: { agent_id: "planner", role: "coordinator" },
      type: "consensus.vote",
      intent: "consensus.vote",
      payload: { vote: "approve", mode: "majority_vote" },
      correlation_id: "consensus_eval"
    }));
    void router.dispatch(createEnvelope({
      swarm_id: "swarm_protocol_eval",
      session_id: "session_protocol_eval",
      task_id: "task_protocol_eval",
      from: { agent_id: "agent_b", role: "reviewer" },
      to: { agent_id: "planner", role: "coordinator" },
      type: "consensus.vote",
      intent: "consensus.vote",
      payload: { vote: "approve", mode: "majority_vote" },
      correlation_id: "consensus_eval"
    }));

    const childSendsProgress = fileContains(root, "src/agents/child-entry.ts", "type: \"task.progress\"")
      && fileContains(root, "src/agents/child-entry.ts", "sendProgress(envelope");
    const ok = sent.length === 2
      && incoming.some((envelope) => envelope.intent === "swarm.init.ack")
      && incoming.some((envelope) => envelope.intent === "agent.register.ack")
      && incoming.some((envelope) => envelope.intent === "agent.update_status.ack")
      && incoming.some((envelope) => envelope.intent === "task.create.ack")
      && incoming.some((envelope) => envelope.intent === "task.cancel.ack")
      && incoming.some((envelope) => envelope.intent === "artifact.create.ack")
      && incoming.some((envelope) => envelope.intent === "artifact.update.ack")
      && incoming.some((envelope) => envelope.intent === "router.dispatch.ack")
      && incoming.some((envelope) => envelope.intent === "blackboard.update.ack")
      && incoming.some((envelope) => envelope.intent === "blackboard.lock.ack")
      && incoming.some((envelope) => envelope.intent === "blackboard.unlock.ack")
      && incoming.some((envelope) => envelope.intent === "bid.submit.ack")
      && incoming.some((envelope) => envelope.type === "consensus.result")
      && childSendsProgress;
    return ok
      ? { name: "Swarm.md protocol router paths execute", status: "pass", message: "lifecycle, agent registration/status, task create/cancel, artifacts, broadcast routing, dispatch ack, blackboard update/lock/unlock, bid submit, consensus vote/result, and child task.progress are covered" }
      : { name: "Swarm.md protocol router paths execute", status: "fail", message: `sent=${sent.length} incoming=${JSON.stringify(incoming)} childSendsProgress=${childSendsProgress}` };
  } finally {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function evalAgentCard(agent_id: string, role: AgentCard["role"], capabilities: string[]): AgentCard {
  return {
    agent_id,
    name: agent_id,
    role,
    capabilities,
    status: "idle",
    load: { running_tasks: 0, max_tasks: 2 },
    reliability: { success_rate: 0.9, avg_latency_ms: 1000 }
  };
}

function checkToolResultBudgetReplayBehavior(): EvalCaseResult {
  const dir = mkdtempSync(resolve(tmpdir(), "swarm-tool-budget-eval-"));
  try {
    const script = `
      import { SwarmDatabase } from ${JSON.stringify(new URL("../storage/database.js", import.meta.url).href)};
      import { ToolContentReplacementStore } from ${JSON.stringify(new URL("../storage/tool-content-replacement-store.js", import.meta.url).href)};
      import { applyToolResultBudget, createContentReplacementState, TOOL_RESULT_REPLACEMENT_TAG } from ${JSON.stringify(new URL("../runtime/tool-result-budget.js", import.meta.url).href)};
      const database = new SwarmDatabase(${JSON.stringify(resolve(dir, "swarm.db"))});
      try {
        const store = new ToolContentReplacementStore(database);
        const state = createContentReplacementState({ sessionId: "tool_budget_session", scopeKind: "session", scopeId: "tool_budget_session" });
        const largeContent = "HEAD\\n" + "x".repeat(12000) + "\\nTAIL";
        const first = await applyToolResultBudget([
          { id: "tool_large", action: "file.read", status: "success", summary: "large read", content: largeContent },
          { id: "tool_small", action: "git.status", status: "success", summary: "small status", content: "clean" }
        ], {
          sessionId: "tool_budget_session",
          taskIdPrefix: "eval",
          state,
          store,
          maxFreshBytes: 8000,
          maxTotalBytes: 9000,
          previewBytes: 400
        });
        const records = store.listForScope("session", "tool_budget_session");
        const replayState = createContentReplacementState({ sessionId: "tool_budget_session", scopeKind: "session", scopeId: "tool_budget_session", records });
        const replay = await applyToolResultBudget([
          { id: "tool_large", action: "file.read", status: "success", summary: "large read", content: largeContent }
        ], {
          sessionId: "tool_budget_session",
          taskIdPrefix: "eval",
          state: replayState,
          store,
          maxFreshBytes: 8000,
          maxTotalBytes: 9000,
          previewBytes: 400
        });
        const ok = first[0]?.content?.includes(TOOL_RESULT_REPLACEMENT_TAG)
          && first[0]?.content === records[0]?.replacement_content
          && replay[0]?.content === first[0]?.content
          && first[1]?.content === "clean"
          && records.length === 1
          && records[0]?.tool_result_id === "tool_large";
        console.log(JSON.stringify({ ok, first, records, replay }));
        process.exit(ok ? 0 : 1);
      } finally {
        database.close();
      }
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30_000
    });
    const ok = result.status === 0 && result.stdout.includes(TOOL_RESULT_REPLACEMENT_TAG);
    return ok
      ? { name: "tool result budget replacements replay exactly after resume", status: "pass", message: "large tool output is persisted once, replaced deterministically, and reconstructed from replacement records" }
      : { name: "tool result budget replacements replay exactly after resume", status: "fail", message: `exit=${result.status} stdout=${result.stdout.slice(0, 700)} stderr=${result.stderr.slice(0, 700)}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkSessionContextCompactionBehavior(): EvalCaseResult {
  const dir = mkdtempSync(resolve(tmpdir(), "swarm-context-eval-"));
  const database = new SwarmDatabase(resolve(dir, "swarm.db"));
  try {
    const store = new SessionContextStore(database);
    for (let index = 0; index < 18; index += 1) {
      store.append({
        session_id: "session_context_eval",
        kind: index === 0 ? "objective" : "tool_result",
        role: index === 0 ? "user" : "tool",
        content: `event ${index} ${"x".repeat(280)}`,
        metadata: { index }
      });
    }
    const rendered = store.renderForSession("session_context_eval", {
      maxTokens: 500,
      keepRecentEntries: 4,
      summaryMaxTokens: 300
    });
    const compaction = store.latestCompaction("session_context_eval");
    const entries = store.list("session_context_eval");
    const ok = entries.length === 18
      && compaction !== undefined
      && compaction.kept_entries.length === 4
      && compaction.strategy === "extractive_summary_keep_recent_tail"
      && rendered.includes("Compacted session memory")
      && rendered.includes("Recent session tail")
      && rendered.includes("event 17");
    return ok
      ? { name: "session context compacts older turns while preserving recent tail", status: "pass", message: "SessionContextStore records events, creates extractive compaction, and renders summary plus recent entries" }
      : { name: "session context compacts older turns while preserving recent tail", status: "fail", message: `entries=${entries.length} compaction=${JSON.stringify(compaction)} rendered=${rendered.slice(0, 500)}` };
  } finally {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkWorkspaceScopedSessionBehavior(): EvalCaseResult {
  const dir = mkdtempSync(resolve(tmpdir(), "swarm-session-scope-eval-"));
  const workspaceA = resolve(dir, "workspace-a");
  const workspaceB = resolve(dir, "workspace-b");
  const runtime = new SwarmRuntime({ databasePath: resolve(dir, "swarm.db"), workspace: workspaceA });
  try {
    const sessions = new SessionStore(runtime.database);
    const leases = new WorkspaceLeaseStore(runtime.database);
    const policy = defaultSwarmSettings().runtime ? {
      max_agents: 1,
      max_parallel_tasks: 1,
      timeout_ms: 1000,
      retry: { max_attempts: 1, backoff_ms: 1 },
      require_review: false,
      consensus: "coordinator_decision" as const,
      safety: { require_human_approval_for: [], forbidden_capabilities: [], sandbox_required: false },
      memory: { allow_read: true, allow_write: true, retention: "session" as const }
    } : undefined;
    if (!policy) {
      throw new Error("default settings unavailable");
    }
    const makeSession = (sessionId: string, workspace: string, updatedAt: string) => {
      const lease = leases.createForLocalSession({ session_id: sessionId, workspace });
      sessions.create({
        swarm_id: `swarm_${sessionId}`,
        session_id: sessionId,
        user_request_id: `user_${sessionId}`,
        workspace_lease_id: lease.lease_id,
        objective: `objective ${sessionId}`,
        status: "completed",
        coordinator: { agent_id: "main_swarm", role: "controller" },
        participants: [],
        created_at: updatedAt,
        updated_at: updatedAt,
        policy
      });
    };
    makeSession("session_a_old", workspaceA, "2026-01-01T00:00:00.000Z");
    makeSession("session_b_new", workspaceB, "2026-01-03T00:00:00.000Z");
    makeSession("session_a_new", workspaceA, "2026-01-02T00:00:00.000Z");

    const scoped = runtime.listRecentSessionsForWorkspace(5).map((session) => session.session_id);
    const ok = scoped.length === 2
      && scoped[0] === "session_a_new"
      && scoped[1] === "session_a_old"
      && !scoped.includes("session_b_new");
    return ok
      ? { name: "runtime scopes recent sessions to the current workspace directory", status: "pass", message: "Directory session filtering uses workspace leases instead of global recency" }
      : { name: "runtime scopes recent sessions to the current workspace directory", status: "fail", message: `scoped=${JSON.stringify(scoped)}` };
  } finally {
    runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkWorkspaceScopedRecentKernelBehavior(): EvalCaseResult {
  const dir = mkdtempSync(resolve(tmpdir(), "swarm-kernel-scope-eval-"));
  const workspaceA = resolve(dir, "workspace-a");
  const workspaceB = resolve(dir, "workspace-b");
  const runtime = new SwarmRuntime({ databasePath: resolve(dir, "swarm.db"), workspace: workspaceA });
  try {
    const sessions = new SessionStore(runtime.database);
    const leases = new WorkspaceLeaseStore(runtime.database);
    const policy = defaultSwarmSettings().runtime ? {
      max_agents: 1,
      max_parallel_tasks: 1,
      timeout_ms: 1000,
      retry: { max_attempts: 1, backoff_ms: 1 },
      require_review: false,
      consensus: "coordinator_decision" as const,
      safety: { require_human_approval_for: [], forbidden_capabilities: [], sandbox_required: false },
      memory: { allow_read: true, allow_write: true, retention: "session" as const }
    } : undefined;
    if (!policy) {
      throw new Error("default settings unavailable");
    }
    const makeSession = (sessionId: string, workspace: string, updatedAt: string) => {
      const lease = leases.createForLocalSession({ session_id: sessionId, workspace });
      sessions.create({
        swarm_id: `swarm_${sessionId}`,
        session_id: sessionId,
        user_request_id: `user_${sessionId}`,
        workspace_lease_id: lease.lease_id,
        objective: `objective ${sessionId}`,
        status: "completed",
        coordinator: { agent_id: "main_swarm", role: "controller" },
        participants: [],
        created_at: updatedAt,
        updated_at: updatedAt,
        policy
      });
    };
    makeSession("session_a", workspaceA, "2026-01-02T00:00:00.000Z");
    makeSession("session_b", workspaceB, "2026-01-03T00:00:00.000Z");

    runtime.runAttemptStore.upsert({
      attempt_id: "attempt_a",
      session_id: "session_a",
      kind: "tool_call",
      status: "completed",
      attempt: 1,
      title: "workspace A",
      workspace_path: workspaceA
    });
    runtime.runAttemptStore.upsert({
      attempt_id: "attempt_b",
      session_id: "session_b",
      kind: "tool_call",
      status: "failed",
      attempt: 1,
      title: "workspace B",
      workspace_path: workspaceB
    });
    runtime.blackboardStore.write({
      swarm_id: "swarm_session_a",
      session_id: "session_a",
      key: "a.entry",
      value: "A",
      type: "evidence",
      created_by: { agent_id: "eval" }
    });
    runtime.blackboardStore.write({
      swarm_id: "swarm_session_b",
      session_id: "session_b",
      key: "b.entry",
      value: "B",
      type: "evidence",
      created_by: { agent_id: "eval" }
    });
    runtime.approvalStore.upsert({
      id: "approval_a",
      session_id: "session_a",
      action: "file.read",
      summary: "A",
      detail: "A",
      risk: "write",
      risk_class: "r1",
      target: "a",
      why_now: "eval",
      predicted_impact: "none",
      rollback_plan: "none"
    }, "pending");
    runtime.approvalStore.upsert({
      id: "approval_b",
      session_id: "session_b",
      action: "file.read",
      summary: "B",
      detail: "B",
      risk: "write",
      risk_class: "r1",
      target: "b",
      why_now: "eval",
      predicted_impact: "none",
      rollback_plan: "none"
    }, "pending");
    runtime.workerStateStore.create({
      worker_id: "worker_a",
      parent_session_id: "session_a",
      capability: "code",
      objective: "A",
      tool_budget: { max_turns: 1, max_tool_calls: 1 }
    });
    runtime.workerStateStore.create({
      worker_id: "worker_b",
      parent_session_id: "session_b",
      capability: "code",
      objective: "B",
      tool_budget: { max_turns: 1, max_tool_calls: 1 }
    });
    runtime.handoffStore.create({
      handoff_id: "handoff_a",
      worker_id: "worker_a",
      parent_session_id: "session_a",
      source_agent: "main",
      target_agent_spec_id: "researcher",
      reason: "eval",
      task_packet: {
        objective: "A",
        agent_spec_id: "researcher",
        invocation_mode: "handoff",
        persona_snapshot: "researcher",
        relevant_context: "",
        file_scope: [],
        allowed_tools: [],
        write_policy: "read_only",
        budget: { max_turns: 1, max_tool_calls: 1 },
        expected_output: "brief",
        return_conditions: []
      }
    });
    runtime.handoffStore.create({
      handoff_id: "handoff_b",
      worker_id: "worker_b",
      parent_session_id: "session_b",
      source_agent: "main",
      target_agent_spec_id: "researcher",
      reason: "eval",
      task_packet: {
        objective: "B",
        agent_spec_id: "researcher",
        invocation_mode: "handoff",
        persona_snapshot: "researcher",
        relevant_context: "",
        file_scope: [],
        allowed_tools: [],
        write_policy: "read_only",
        budget: { max_turns: 1, max_tool_calls: 1 },
        expected_output: "brief",
        return_conditions: []
      }
    });

    const attempts = runtime.listRecentAttemptsForWorkspace(10).map((attempt) => attempt.attempt_id);
    const leasesScoped = runtime.listRecentLeasesForWorkspace(10).map((lease) => lease.session_id);
    const blackboard = runtime.listRecentBlackboardForWorkspace(10).map((entry) => entry.session_id);
    const approvals = runtime.listRecentApprovalsForWorkspace(10).map((approval) => approval.approval_id);
    const workers = runtime.listRecentWorkersForWorkspace(10).map((worker) => worker.worker_id);
    const handoffs = runtime.listHandoffsForWorkspace(10).map((handoff) => handoff.handoff_id);
    const ok = attempts.join(",") === "attempt_a"
      && leasesScoped.join(",") === "session_a"
      && blackboard.join(",") === "session_a"
      && approvals.join(",") === "approval_a"
      && workers.join(",") === "worker_a"
      && handoffs.join(",") === "handoff_a";
    return ok
      ? { name: "runtime scopes recent Kernel records to the current workspace directory", status: "pass", message: "attempts, leases, blackboard, approvals, workers, and handoffs filter through workspace leases" }
      : { name: "runtime scopes recent Kernel records to the current workspace directory", status: "fail", message: `attempts=${attempts} leases=${leasesScoped} blackboard=${blackboard} approvals=${approvals} workers=${workers} handoffs=${handoffs}` };
  } finally {
    runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkFileToolInputValidationBehavior(root: string): EvalCaseResult {
  const missingWritePath = catchesMessage(
    () => normalizeToolAction({ action: "file.write", content: "content" }),
    "file.write requires path"
  );
  const missingEditPath = catchesMessage(
    () => normalizeToolAction({ action: "file.edit", oldText: "a", newText: "b" }),
    "file.edit requires path"
  );
  const hasDirectoryGuard = fileContains(root, "src/tools/local-tools.ts", "target is a ${targetType}, not a file")
    && fileContains(root, "src/tools/local-tools.ts", "select a concrete file, then retry file.read")
    && fileContains(root, "src/tools/local-tools.ts", "retry ${action} with a full file path including a filename")
    && fileContains(root, "src/tools/local-tools.ts", "code === \"ENOTDIR\" || code === \"EISDIR\"");
  const ok = missingWritePath && missingEditPath && hasDirectoryGuard;
  return ok
    ? { name: "file tools validate path inputs before raw fs errors", status: "pass", message: "file.read/file.write/file.edit reject invalid paths and directory targets as INVALID_INPUT" }
    : { name: "file tools validate path inputs before raw fs errors", status: "fail", message: `missingWritePath=${missingWritePath} missingEditPath=${missingEditPath} hasDirectoryGuard=${hasDirectoryGuard}` };
}

function checkLintFailureAggregationBehavior(): EvalCaseResult {
  const result = aggregateLintResults([
    {
      action: "code.lint",
      status: "failed",
      summary: "lint command exited 1",
      content: "$ npm run lint\nstderr:\nno-unused-vars",
      errors: ["lint command exited 1"],
      errorCode: "EXIT_1",
      retryable: false,
      recoverable: true,
      recoverySuggestion: "Read lint output, patch the relevant code, then rerun the same command.",
      data: { command: "npm run lint", exitCode: 1 }
    },
    {
      action: "code.lint",
      status: "success",
      summary: "lint command exited 0",
      content: "$ cargo clippy",
      data: { command: "cargo clippy", exitCode: 0 }
    }
  ]);
  const ok = result.status === "failed"
    && result.errorCode === "EXIT_1"
    && result.retryable === false
    && result.recoverable === true
    && result.recoverySuggestion?.includes("Read lint output")
    && result.content?.includes("stderr:")
    && result.errors?.[0] === "lint command exited 1";
  return ok
    ? { name: "code.lint failures aggregate recovery metadata", status: "pass", message: "lint failures carry stderr, error code, retryability, and recovery guidance into the combined result" }
    : {
        name: "code.lint failures aggregate recovery metadata",
        status: "fail",
        message: `status=${result.status} error=${result.errorCode ?? "-"} retry=${String(result.retryable)} recovery=${result.recoverySuggestion ?? "-"} errors=${result.errors?.join(",") ?? "-"}`
      };
}

function checkWebFetchHttpFailureMetadataBehavior(): EvalCaseResult {
  const notFound = webFetchHttpFailureMetadata(404, "Not Found");
  const rateLimited = webFetchHttpFailureMetadata(429, "Too Many Requests");
  const serverError = webFetchHttpFailureMetadata(503, "Service Unavailable");
  const ok = notFound.errorCode === "HTTP_404"
    && notFound.errors?.[0] === "HTTP 404 Not Found"
    && notFound.retryable === false
    && notFound.recoverable === true
    && Boolean(notFound.recoverySuggestion)
    && rateLimited.errorCode === "HTTP_429"
    && rateLimited.retryable === true
    && serverError.errorCode === "HTTP_503"
    && serverError.retryable === true;
  return ok
    ? { name: "web.fetch HTTP failures carry recovery metadata", status: "pass", message: "HTTP 4xx/429/5xx failures expose error codes, retryability, and recovery guidance without a network call" }
    : {
        name: "web.fetch HTTP failures carry recovery metadata",
        status: "fail",
        message: `404=${notFound.errorCode}/${notFound.retryable}/${notFound.recoverySuggestion ? "recovery" : "-"} 429=${rateLimited.errorCode}/${rateLimited.retryable} 503=${serverError.errorCode}/${serverError.retryable}`
      };
}

function checkCodingLoopFailedToolFinalStatusBehavior(): EvalCaseResult {
  const recovered = summarizeCodingLoopFinalStatus({
    stopRequested: false,
    modelStatus: "completed",
    content: "All done after rerun.",
    toolResults: [
      { status: "failed", summary: "npm test exited 1" },
      { status: "success", summary: "npm test passed" }
    ],
    unresolvedFailure: hasUnresolvedToolFailure({
      toolResults: [
        { status: "failed", summary: "npm test exited 1" },
        { status: "success", summary: "npm test passed" }
      ],
      finalText: "All done after rerun."
    })
  });
  const unresolved = summarizeCodingLoopFinalStatus({
    stopRequested: false,
    modelStatus: "completed",
    content: "All done.",
    toolResults: [{ status: "failed", summary: "npm test exited 1" }],
    unresolvedFailure: hasUnresolvedToolFailure({
      toolResults: [{ status: "failed", summary: "npm test exited 1" }],
      finalText: "All done."
    })
  });
  const stopped = summarizeCodingLoopFinalStatus({
    stopRequested: true,
    modelStatus: "completed",
    content: "Interrupted by user.",
    toolResults: [{ status: "failed", summary: "shell command aborted" }]
  });
  const exhausted = summarizeCodingLoopFinalStatus({
    stopRequested: false,
    modelStatus: "continue",
    content: "Need one more tool.",
    toolResults: [{ status: "success", summary: "read files" }],
    budgetExhausted: true
  });
  const ok = recovered.status === "completed"
    && finalActivityMessage(recovered).startsWith("Completed:")
    && finalActivityPhase(recovered) === "completed"
    && unresolved.status === "failed"
    && unresolved.summary.includes("Failed tool: npm test exited 1")
    && finalActivityMessage(unresolved).startsWith("Failed:")
    && finalActivityPhase(unresolved) === "failed"
    && stopped.status === "stopped"
    && finalActivityMessage(stopped, "user interrupt") === "Stopped: user interrupt"
    && finalActivityPhase(stopped) === "stopped"
    && exhausted.status === "failed"
    && exhausted.summary.includes("Budget exhausted before completion")
    && finalActivityMessage(exhausted).startsWith("Failed:")
    && finalActivityPhase(exhausted) === "failed";
  return ok
    ? { name: "coding loop final status reflects recoverable tool failures", status: "pass", message: "failed tool results can recover after later success while unresolved failures and exhausted budgets still fail" }
    : { name: "coding loop final status reflects recoverable tool failures", status: "fail", message: `recovered=${recovered.status}/${recovered.summary} unresolved=${unresolved.status}/${unresolved.summary} stopped=${stopped.status} exhausted=${exhausted.status}/${exhausted.summary}` };
}

function checkCodingLoopPersistenceStatusBehavior(): EvalCaseResult {
  const ok = sessionStatusFromExecutionStatus("completed") === "completed"
    && sessionStatusFromExecutionStatus("failed") === "failed"
    && sessionStatusFromExecutionStatus("stopped") === "cancelled"
    && sessionStatusFromExecutionStatus(undefined) === "completed"
    && finalAttemptStatus("completed") === "completed"
    && finalAttemptStatus("failed") === "failed"
    && finalAttemptStatus("stopped") === "stopped"
    && finalAttemptStatus(undefined) === "completed";
  return ok
    ? { name: "coding loop persistence statuses preserve failures", status: "pass", message: "final session and Work Kernel attempt statuses map failed and stopped results without coercing them to completed" }
    : {
        name: "coding loop persistence statuses preserve failures",
        status: "fail",
        message: `session=${sessionStatusFromExecutionStatus("completed")}/${sessionStatusFromExecutionStatus("failed")}/${sessionStatusFromExecutionStatus("stopped")} attempt=${finalAttemptStatus("completed")}/${finalAttemptStatus("failed")}/${finalAttemptStatus("stopped")}`
      };
}

function checkDelegatedWorkerStatusBehavior(): EvalCaseResult {
  const ok = workerStatusFromExecutionStatus("completed", false) === "completed"
    && workerStatusFromExecutionStatus("failed", false) === "failed"
    && workerStatusFromExecutionStatus("completed", true) === "stopped"
    && workerStatusFromExecutionStatus("stopped", false) === "stopped"
    && delegatedToolStatus("completed") === "success"
    && delegatedToolStatus("failed") === "failed"
    && delegatedToolStatus("stopped") === "partial";
  return ok
    ? { name: "delegated worker failures propagate to tool results", status: "pass", message: "failed worker loops produce failed agent.delegate results while stopped workers stay partial" }
    : {
        name: "delegated worker failures propagate to tool results",
        status: "fail",
        message: `worker=${workerStatusFromExecutionStatus("completed", false)}/${workerStatusFromExecutionStatus("failed", false)}/${workerStatusFromExecutionStatus("completed", true)} tool=${delegatedToolStatus("completed")}/${delegatedToolStatus("failed")}/${delegatedToolStatus("stopped")}`
      };
}

function checkHostEnvironmentPromptBehavior(): EvalCaseResult {
  const workspace = process.platform === "win32" ? "E:\\Playground\\Swarm" : "/tmp/swarm-workspace";
  const prompt = renderHostEnvironmentPrompt(workspace);
  const baseOk = prompt.includes("Host environment for local tools")
    && prompt.includes("platform:")
    && prompt.includes(`workspace: ${workspace}`)
    && prompt.includes("shell invocation:");
  const platformOk = process.platform === "win32"
    ? prompt.includes("PowerShell") && prompt.includes("POSIX-only") && prompt.includes("powershell.exe -NoProfile -Command")
    : prompt.includes("POSIX-compatible shell") && prompt.includes("-lc <command>");
  const ok = baseOk && platformOk;
  return ok
    ? { name: "host environment prompt includes local shell facts", status: "pass", message: "prompt exposes workspace, platform, shell invocation, and platform-specific command guidance" }
    : { name: "host environment prompt includes local shell facts", status: "fail", message: prompt };
}

function checkWorkspaceModifyingFullSwarmRoutePolicy(): EvalCaseResult {
  const route = applyStructuredRoutingPolicy({
    mode: "full_swarm",
    confidence: 0.95,
    reason: "User asked for Agent Swarm with frontend, backend, and architecture roles.",
    requires_workspace: true,
    expected_side_effects: "modify_workspace",
    needs_parallelism: true,
    parallelism_reason: "Independent frontend, backend, and architecture workstreams.",
    swarm_value: "Multiple roles can work in parallel.",
    risk: "medium",
    fallback_mode: "coding_loop"
  });
  const ok = route.mode === "coding_loop"
    && route.fallback_mode === "coding_loop"
    && route.confidence <= 0.8
    && route.reason.includes("can still spawn internal Agent workers");
  return ok
    ? { name: "workspace-modifying full swarm routes use coding loop", status: "pass", message: "mutating full_swarm routes are demoted to coding_loop while preserving Agent delegation" }
    : { name: "workspace-modifying full swarm routes use coding loop", status: "fail", message: JSON.stringify(route) };
}

function checkPlannerRejectsBadToolcallsFromLogs(): EvalCaseResult {
  const placeholderWrite: GeneratedPlan = {
    objective: "Build a simple database app",
    summary: "Bad model output copied from the observed failed log pattern.",
    intent: "create_project",
    tasks: [
      {
        task_id: "task_placeholder_write",
        title: "Write backend",
        description: "Write backend file.",
        objective: "Write backend file.",
        type: "tool_call",
        status: "pending",
        required_capabilities: ["Write"],
        inputs: {
          action: "Write",
          path: "src/engine.ts",
          content: "待代理根据设计文档自主生成完整的 TypeScript 源码"
        },
        expected_output: { format: "text" }
      }
    ]
  };
  const posixShell: GeneratedPlan = {
    ...placeholderWrite,
    tasks: [
      {
        ...placeholderWrite.tasks[0],
        task_id: "task_bad_shell",
        required_capabilities: ["Bash"],
        inputs: {
          action: "Bash",
          command: "mkdir -p simple-db && cat > src/server.js << 'EOF'\nconsole.log('bad')\nEOF",
          timeout: 30000
        }
      }
    ]
  };
  const placeholderRejected = catchesMessage(
    () => normalizeGeneratedPlanForRuntime(placeholderWrite, "Build a simple database app"),
    "placeholder Write.content"
  );
  const shellRejected = process.platform === "win32"
    ? catchesMessage(
        () => normalizeGeneratedPlanForRuntime(posixShell, "Build a simple database app"),
        "POSIX-only Bash command"
      )
    : true;
  const ok = placeholderRejected && shellRejected;
  return ok
    ? { name: "planner rejects bad toolcalls seen in latest logs", status: "pass", message: "placeholder Write content and Windows POSIX-only Bash plans fail normalization before execution" }
    : { name: "planner rejects bad toolcalls seen in latest logs", status: "fail", message: `placeholderRejected=${placeholderRejected} shellRejected=${shellRejected}` };
}

function checkLocalShellToolHostValidationCoverage(root: string): EvalCaseResult {
  const content = readFileSync(resolve(root, "src/tools/local-tools.ts"), "utf8");
  const hasSharedValidator = content.includes("function validateShellCommandForHost");
  const shellUsesValidator = /async function executeShell[\s\S]*?validateShellCommandForHost\(action\.command\)/.test(content);
  const testUsesValidator = /async function executeCodeTest[\s\S]*?validateShellCommandForHost\(action\.command\)/.test(content);
  const buildUsesValidator = /async function executeCodeBuild[\s\S]*?validateShellCommandForHost\(action\.command\)/.test(content);
  const catchesLogPatterns = content.includes("\\bmkdir\\s+-p\\b")
    && content.includes("<<\\s*['\"]?EOF")
    && content.includes("\\bcd\\s+\\$\\(pwd\\)");
  const ok = hasSharedValidator && shellUsesValidator && testUsesValidator && buildUsesValidator && catchesLogPatterns;
  return ok
    ? { name: "local shell tools reject host-incompatible command syntax", status: "pass", message: "shell.exec, code.test, and code.build share Windows POSIX-only command validation before spawning PowerShell" }
    : {
        name: "local shell tools reject host-incompatible command syntax",
        status: "fail",
        message: `shared=${hasSharedValidator} shell=${shellUsesValidator} test=${testUsesValidator} build=${buildUsesValidator} patterns=${catchesLogPatterns}`
      };
}

function checkFullSwarmPlannerNestedDelegateBehavior(): EvalCaseResult {
  const invalid: GeneratedPlan = {
    objective: "Inspect delegated plan",
    summary: "Bad model output using nested delegation.",
    tasks: [
      {
        task_id: "task_delegate",
        title: "Delegated plan task",
        description: "A planner should express this as a normal routed task, not nested delegation.",
        objective: "Inspect delegated plan",
        type: "tool_call",
        status: "pending",
        required_capabilities: ["agent.delegate"],
        inputs: {
          action: "agent.delegate",
          task: "Inspect delegated plan"
        },
        expected_output: { format: "markdown" }
      }
    ]
  };
  const valid: GeneratedPlan = {
    ...invalid,
    tasks: [{
      ...invalid.tasks[0],
      inputs: {
        ...invalid.tasks[0].inputs,
        capability: "design.reason"
      }
    }]
  };
  let invalidRejected = false;
  try {
    normalizeGeneratedPlanForRuntime(invalid, "Inspect delegated plan");
  } catch (error) {
    invalidRejected = error instanceof Error && error.message.includes("agent.delegate without inputs.capability");
  }
  const normalized = normalizeGeneratedPlanForRuntime(valid, "Inspect delegated plan");
  const task = normalized.tasks[0];
  const ok = invalidRejected
    && task?.required_capabilities[0] === "design.reason"
    && task.type === "analysis"
    && task.inputs.action === undefined
    && task.inputs.capability === undefined;
  return ok
    ? { name: "full swarm planner rejects invalid nested delegation tasks", status: "pass", message: "agent.delegate planner tasks require an explicit routed capability and are flattened to direct swarm tasks" }
    : {
        name: "full swarm planner rejects invalid nested delegation tasks",
        status: "fail",
        message: `invalidRejected=${invalidRejected} normalized=${JSON.stringify(task)}`
      };
}

function checkFullSwarmBlackboardToolRouteability(): EvalCaseResult {
  const plan: GeneratedPlan = {
    objective: "Share agent findings through blackboard",
    summary: "Use semantic blackboard tools from a full swarm plan.",
    tasks: [
      {
        task_id: "task_write_blackboard",
        title: "Write shared finding",
        description: "Persist a finding for other agents.",
        objective: "Write a blackboard entry.",
        type: "tool_call",
        status: "pending",
        required_capabilities: ["blackboard.write"],
        inputs: {
          action: "blackboard.write",
          key: "eval.routeability",
          type: "evidence",
          value: { ok: true }
        },
        expected_output: { format: "json" }
      },
      {
        task_id: "task_read_blackboard",
        title: "Read shared finding",
        description: "Read a finding written by another agent.",
        objective: "Read a blackboard entry.",
        type: "tool_call",
        status: "pending",
        required_capabilities: ["BlackboardRead"],
        inputs: {
          action: "BlackboardRead",
          key: "eval.routeability"
        },
        expected_output: { format: "json" },
        dependencies: ["task_write_blackboard"]
      }
    ]
  };
  const normalized = normalizeGeneratedPlanForRuntime(plan, "Share agent findings through blackboard");
  const capabilities = normalized.tasks.map((task) => task.required_capabilities[0]);
  const actions = normalized.tasks.map((task) => task.inputs.action);
  const toolAgent = builtinAgents.find((agent) => agent.role === "tool");
  const toolCapabilities = new Set(toolAgent?.capabilities ?? []);
  const write = normalizeToolAction(normalized.tasks[0]?.inputs ?? {});
  const read = normalizeToolAction(normalized.tasks[1]?.inputs ?? {});
  const scheduler = new TaskScheduler(3);
  const writeSafe = scheduler.isTaskConcurrencySafe(normalized.tasks[0]);
  const readSafe = scheduler.isTaskConcurrencySafe(normalized.tasks[1]);
  const ok = capabilities.join(",") === "blackboard.write,BlackboardRead"
    && actions.join(",") === "blackboard.write,BlackboardRead"
    && write.type === "blackboard.write"
    && read.type === "blackboard.read"
    && toolCapabilities.has("blackboard.write")
    && toolCapabilities.has("BlackboardRead")
    && !writeSafe
    && readSafe;
  return ok
    ? { name: "full swarm blackboard tools are routeable", status: "pass", message: "planner normalization, scheduler safety, and tool-agent capabilities recognize semantic blackboard tools" }
    : {
        name: "full swarm blackboard tools are routeable",
        status: "fail",
        message: `capabilities=${capabilities.join(",")} actions=${actions.join(",")} write=${JSON.stringify(write)} read=${JSON.stringify(read)} toolHasWrite=${toolCapabilities.has("blackboard.write")} toolHasRead=${toolCapabilities.has("BlackboardRead")} safe=${writeSafe}/${readSafe}`
      };
}

function checkFullSwarmSchedulerParallelBehavior(): EvalCaseResult {
  const scheduler = new TaskScheduler(3);
  const readA = evalTask("read_a", "tool_call", ["", "tool.file.read"], { action: "file.read", path: "a.ts" });
  const readB = evalTask("read_b", "tool_call", ["tool.file.grep"], { action: "file.grep", root: ".", pattern: "foo" });
  const analysis = evalTask("analysis", "analysis", ["analysis.synthesize"], {});
  const write = evalTask("write", "tool_call", ["tool.file.edit"], { action: "file.edit", path: "a.ts", oldText: "a", newText: "b" });
  const missingCapability = evalTask("missing_capability", "tool_call", ["", "  "], { action: "file.read", path: "missing.ts" });
  const readyReadOnly = scheduler.selectReadyTasks(new Map([
    [readA.task_id, readA],
    [readB.task_id, readB],
    [analysis.task_id, analysis]
  ]), new Set());
  const readyWithMutation = scheduler.selectReadyTasks(new Map([
    [readA.task_id, readA],
    [write.task_id, write],
    [readB.task_id, readB]
  ]), new Set());
  const readyWithMissingCapability = scheduler.selectReadyTasks(new Map([
    [readA.task_id, readA],
    [missingCapability.task_id, missingCapability],
    [readB.task_id, readB]
  ]), new Set());
  const ok = readyReadOnly.map((task) => task.task_id).join(",") === "read_a,read_b,analysis"
    && readyWithMutation.length === 1
    && readyWithMutation[0]?.task_id === "write"
    && readyWithMissingCapability.length === 1
    && readyWithMissingCapability[0]?.task_id === "missing_capability";
  return ok
    ? { name: "full swarm scheduler batches independent read-only tasks", status: "pass", message: "read-only/tool analysis tasks can dispatch together while mutating or unrouteable tasks serialize" }
    : { name: "full swarm scheduler batches independent read-only tasks", status: "fail", message: `readonly=${readyReadOnly.map((task) => task.task_id).join(",")} mutation=${readyWithMutation.map((task) => task.task_id).join(",")} missing=${readyWithMissingCapability.map((task) => task.task_id).join(",")}` };
}

function evalTask(
  task_id: string,
  type: "tool_call" | "analysis",
  required_capabilities: string[],
  inputs: Record<string, unknown>
): import("../protocol/types.js").SwarmTask {
  return {
    task_id,
    title: task_id,
    description: task_id,
    objective: task_id,
    type,
    status: "pending",
    required_capabilities,
    inputs,
    expected_output: { format: "markdown" },
    dependencies: []
  };
}

function checkTuiDeleteBehavior(): EvalCaseResult {
  const rawDelete = editInput("abc", 1, "\x1b[3~", {});
  const inkDelete = editInput("abc", 1, "[3~", {});
  const ok = rawDelete.handled && rawDelete.state.value === "ac" && rawDelete.state.cursor === 1
    && inkDelete.handled && inkDelete.state.value === "ac" && inkDelete.state.cursor === 1
    && isDeleteInput("\x1b[3~", {})
    && isDeleteInput("[3~", {});
  return ok
    ? { name: "TUI delete behavior handles forward delete", status: "pass", message: "delete removes the character under the cursor" }
    : { name: "TUI delete behavior handles forward delete", status: "fail", message: "delete did not remove the character under cursor consistently" };
}

function checkTuiMainPaneCycleBehavior(): EvalCaseResult {
  const forward = nextMainPane("overview", 1);
  const backward = nextMainPane("overview", -1);
  const wraps = nextMainPane("blackboard", 1);
  const ctrlN = mainPaneShortcutDirection("n", { ctrl: true });
  const ctrlP = mainPaneShortcutDirection("p", { ctrl: true });
  const rawCtrlN = mainPaneShortcutDirection("\x0e", {});
  const rawCtrlP = mainPaneShortcutDirection("\x10", {});
  const ok = forward === "output"
    && backward === "blackboard"
    && wraps === "overview"
    && ctrlN === 1
    && ctrlP === -1
    && rawCtrlN === 1
    && rawCtrlP === -1;
  return ok
    ? { name: "TUI main pane cycle behavior works", status: "pass", message: "Ctrl+N/P pane order wraps predictably for Ink names and raw control bytes" }
    : { name: "TUI main pane cycle behavior works", status: "fail", message: `forward=${forward} backward=${backward} wraps=${wraps} shortcuts=${ctrlN}/${ctrlP}/${rawCtrlN}/${rawCtrlP}` };
}

function checkTuiGlobalControlKeyBehavior(): EvalCaseResult {
  const state = createChatInputControllerState();
  const typed = applyChatInputKey(state, "abc", {}).state;
  const ctrlN = applyChatInputKey(typed, "n", { ctrl: true }).state;
  const plainN = applyChatInputKey(typed, "n", {}).state;
  const rawCtrlP = applyChatInputKey(typed, "\x10", {}).state;
  const ctrlO = applyChatInputKey(typed, "o", { ctrl: true }).state;
  const ctrlT = applyChatInputKey(typed, "t", { ctrl: true }).state;
  const ok = typed.input.value === "abc"
    && plainN.input.value === "abcn"
    && ctrlN === typed
    && rawCtrlP === typed
    && ctrlO === typed
    && ctrlT === typed;
  return ok
    ? { name: "TUI chat input leaves global control keys to the shell", status: "pass", message: "Ctrl+N/P/O/T do not mutate the prompt controller state" }
    : { name: "TUI chat input leaves global control keys to the shell", status: "fail", message: `typed=${typed.input.value} ctrlN=${ctrlN.input.value} rawP=${rawCtrlP.input.value} ctrlO=${ctrlO.input.value} ctrlT=${ctrlT.input.value}` };
}

function checkTuiIdleSnapshotSignatureBehavior(): EvalCaseResult {
  const emptyA = emptyIdlePaneSnapshot();
  const emptyB = emptyIdlePaneSnapshot();
  const snapshotA = {
    ...emptyA,
    sessions: [
      {
        session_id: "session-1",
        swarm_id: "swarm-1",
        objective: "do work",
        status: "running" as const,
        policy_json: "{}",
        participants_json: "[]",
        created_at: "2026-05-07T00:00:00.000Z",
        updated_at: "2026-05-07T00:00:01.000Z"
      }
    ]
  };
  const snapshotB = {
    ...emptyB,
    sessions: [
      {
        ...snapshotA.sessions[0],
        objective: "different display text with same freshness fields"
      }
    ]
  };
  const snapshotChanged = {
    ...snapshotA,
    sessions: [
      {
        ...snapshotA.sessions[0],
        status: "completed" as const,
        updated_at: "2026-05-07T00:00:02.000Z"
      }
    ]
  };
  const daemon: SymphonyDaemonRecord = {
    daemon_id: "daemon-1",
    daemon_key: "key-1",
    status: "running",
    create_workspace: true,
    execute: false,
    tick_count: 1,
    created_at: "2026-05-07T00:00:00.000Z",
    started_at: "2026-05-07T00:00:00.000Z",
    updated_at: "2026-05-07T00:00:01.000Z",
    next_tick_at: "2026-05-07T00:01:01.000Z",
    history: []
  };
  const sameIdle = idlePaneSnapshotSignature(emptyA) === idlePaneSnapshotSignature(emptyB)
    && idlePaneSnapshotSignature(snapshotA) === idlePaneSnapshotSignature(snapshotB);
  const changedIdle = idlePaneSnapshotSignature(snapshotA) !== idlePaneSnapshotSignature(snapshotChanged);
  const sameDaemons = symphonyDaemonRecordsSignature([daemon]) === symphonyDaemonRecordsSignature([{ ...daemon }]);
  const changedDaemons = symphonyDaemonRecordsSignature([daemon]) !== symphonyDaemonRecordsSignature([{ ...daemon, tick_count: 2, updated_at: "2026-05-07T00:01:01.000Z" }]);
  const ok = sameIdle && changedIdle && sameDaemons && changedDaemons;
  return ok
    ? { name: "TUI idle pane polling ignores unchanged snapshots", status: "pass", message: "stable signatures prevent no-op Kernel and Symphony poll updates" }
    : { name: "TUI idle pane polling ignores unchanged snapshots", status: "fail", message: `sameIdle=${sameIdle} changedIdle=${changedIdle} sameDaemons=${sameDaemons} changedDaemons=${changedDaemons}` };
}

function checkPermissionDenyPrecedenceBehavior(): EvalCaseResult {
  const settings = defaultSwarmSettings();
  settings.permissions.defaultMode = "yolo";
  settings.permissions.allow = ["Bash(*)", "Write(**)", "WebFetch(*)"];
  settings.permissions.ask = [];
  settings.permissions.deny = [
    "Bash(npm publish*)",
    "Write(secrets/**)",
    "Edit(secrets/**)",
    "WebFetch(https://example.com/secrets*)",
    "Read(private/**)",
    "Read(**/*.pem)"
  ];
  const workspace = resolve("eval-workspace");

  const deniedShell = { type: "shell.exec" as const, command: "npm publish --dry-run" };
  const deniedWrite = { type: "file.write" as const, path: "secrets/token.txt", content: "secret" };
  const absoluteDeniedWrite = { type: "file.write" as const, path: resolve(workspace, "secrets/token.txt"), content: "secret" };
  const absoluteDeniedEdit = { type: "file.edit" as const, path: resolve(workspace, "secrets/token.txt"), operation: "str_replace" as const, oldText: "a", newText: "b" };
  const deniedWeb = { type: "web.fetch" as const, url: "https://example.com/secrets?id=1" };
  const deniedMultiRead = { type: "file.read" as const, paths: ["src/index.ts", resolve(workspace, "private/token.txt")] };
  const allowedShell = { type: "shell.exec" as const, command: "npm test" };
  const readContext = { workspace, settings };

  const shellDenied = throws(() => toolRequiresApproval(deniedShell, settings, { workspace }));
  const writeDenied = throws(() => assertToolAllowedByPermissions(deniedWrite, settings, { workspace }));
  const absoluteWriteDenied = throws(() => assertToolAllowedByPermissions(absoluteDeniedWrite, settings, { workspace }));
  const absoluteEditDenied = throws(() => assertToolAllowedByPermissions(absoluteDeniedEdit, settings, { workspace }));
  const resolvedAbsoluteWriteDenied = throws(() => resolveWritablePath(absoluteDeniedWrite.path, readContext));
  const multiReadDenied = throws(() => assertToolAllowedByPermissions(deniedMultiRead, settings, { workspace }));
  const webDenied = throws(() => toolRequiresApproval(deniedWeb, settings, { workspace }));
  const privateReadDenied = throws(() => resolveReadablePath("private/token.txt", readContext));
  const pemReadDenied = throws(() => resolveReadablePath("certs/service.pem", readContext));
  const readAllowed = resolveReadablePath("src/index.ts", readContext).endsWith(resolve(workspace, "src/index.ts"));
  const allowed = !toolRequiresApproval(allowedShell, settings, { workspace });
  const ok = shellDenied
    && writeDenied
    && absoluteWriteDenied
    && absoluteEditDenied
    && resolvedAbsoluteWriteDenied
    && multiReadDenied
    && webDenied
    && privateReadDenied
    && pemReadDenied
    && readAllowed
    && allowed;
  return ok
    ? { name: "permission deny rules override allow and yolo modes", status: "pass", message: "deny rules, including path globs and absolute workspace paths, are enforced before approval bypasses" }
    : { name: "permission deny rules override allow and yolo modes", status: "fail", message: `shellDenied=${shellDenied} writeDenied=${writeDenied} absoluteWriteDenied=${absoluteWriteDenied} absoluteEditDenied=${absoluteEditDenied} resolvedAbsoluteWriteDenied=${resolvedAbsoluteWriteDenied} multiReadDenied=${multiReadDenied} webDenied=${webDenied} privateReadDenied=${privateReadDenied} pemReadDenied=${pemReadDenied} readAllowed=${readAllowed} allowed=${allowed}` };
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

function catchesMessage(fn: () => unknown, message: string): boolean {
  try {
    fn();
    return false;
  } catch (error) {
    return error instanceof Error && error.message.includes(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/local-evals.js")) {
  const results = runLocalEvals();
  const failed = results.filter((result) => result.status === "fail");
  console.log(JSON.stringify({ status: failed.length ? "fail" : "pass", results }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
}
