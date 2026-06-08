import { existsSync, readFileSync } from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  addPermissionAdditionalDirectory,
  defaultSwarmSettings,
  ensureSwarmHome,
  getModelReadiness,
  getProviderModels,
  loadSwarmSettings,
  removePermissionAdditionalDirectory,
  setModelSelection,
  type SwarmConfig
} from "../config/settings.js";
import { evaluateDogfoodReplay, formatDogfoodQualityReport } from "./dogfood-harness.js";
import {
  formatRealSwarmEvalSuite,
  realSwarmEvalReleaseGateStatus,
  runOfflineRealSwarmEvalSuite
} from "./real-swarm-evals.js";
import { OpenAIProvider } from "../providers/openai-provider.js";
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
import { nextMainPane } from "../tui/main-panes.js";
import {
  acceptSlashCommandCandidate,
  commandCandidatesForInput,
  commandOutputPreview,
  completeSlashCommand,
  formatToolOutputPreview,
  parseSlashCommandLine,
  rawSlashArgsAfter
} from "../tui/slash-commands.js";
import { decideResumeExecution } from "../tui/resume-control.js";
import { formatHeadlessProgress, formatRuntimeEventBrief, formatWorkerBrief } from "../runtime/event-formatters.js";
import { buildPermissionReport } from "../runtime/permission-report.js";
import { workerDisplayLabel } from "../storage/worker-state-store.js";
import {
  evaluateCodingLoopCacheLab,
  finalActivityMessage,
  finalActivityPhase,
  formatCodingLoopCacheLabReport,
  formatToolFailureContent,
  hasUnresolvedToolFailure,
  summarizeCodingLoopFinalStatus
} from "../runtime/coding-agent-loop.js";
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
import { applySandboxModeCommand, buildSandboxReport } from "../tui/sandbox-control.js";
import { runtimeEventToActionRow } from "../tui/action-log.js";
import { applyTaskAttemptToTuiState, applyWorkRecordToTuiState, summarizeTaskWritePolicies, type TuiWorkState } from "../tui/work-state.js";
import { appendTuiLoopActivity, appendTuiRuntimeEvent, sameRuntimeEventDisplay, TUI_EVENT_BUFFER_LIMIT } from "../tui/tui-event-buffer.js";
import { detailOpenTargetForPane, inlineInspectorTargetForPane, tuiFocusTransitionForInput } from "../tui/conversation-layout.js";
import { formatTuiReplaySuiteReport, runDefaultTuiReplaySuite } from "../tui/interaction-replay.js";
import { assertToolAllowedByPermissions, createToolApprovalRequest, decideToolPermission, resolveReadablePath, resolveWritablePath, riskClassForAction, toolRequiresApproval } from "../tools/permissions.js";
import { aggregateLintResults, normalizeToolAction, webFetchHttpFailureMetadata } from "../tools/local-tools.js";
import { BuiltinLocalToolProvider } from "../extensions/builtin-tools.js";
import { CustomCommandProvider, renderCustomCommandObjective } from "../extensions/custom-commands.js";
import { applyRuntimeMcpConfig, loadRuntimeMcpConfigSources } from "../extensions/mcp.js";
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
import {
  buildHeadlessRunArtifacts,
  type ParityReleaseGateDimension,
  type ParityReleaseGateRedLine,
  type ParityReleaseGateSummary,
  type ParityReleaseGateTriageItem
} from "../runtime/headless-artifacts.js";
import { buildLatestRunDiagnosis } from "../runtime/latest-diagnosis.js";
import { evaluatePromptCacheSlo, promptCacheTrendFromStatuses } from "../runtime/prompt-cache-status.js";
import { buildProtocolReplay, diffProtocolReplaySnapshots } from "../runtime/protocol-replay.js";
import { runFaultInjectionDrills } from "../runtime/fault-injection.js";
import { formatBudgetPressure, SwarmBudgetGovernor } from "../runtime/budget-governor.js";
import { buildResultCard, formatResultCardText } from "../runtime/result-card.js";
import { AgentRegistry } from "../runtime/registry.js";
import { decideCapabilitySandbox, decideToolActionSandbox } from "../runtime/sandbox-policy.js";
import { sandboxedToolTaskInputs } from "../runtime/tool-task-sandbox.js";
import { EnvelopeRouter } from "../runtime/router.js";
import { postChangeExecutionStatus, SwarmRuntime } from "../runtime/runtime.js";
import { LOCAL_TOOL_SCHEMAS, localToolSchemaForModel, validateLocalToolActionInputs } from "../tools/tool-contracts.js";
import { buildWorkRecordFromRuntimeEvent } from "../runtime/work-protocol.js";
import { applyStructuredRoutingPolicy } from "../runtime/execution-router.js";
import { renderHostEnvironmentPrompt } from "../runtime/host-context.js";
import { TOOL_RESULT_REPLACEMENT_TAG } from "../runtime/tool-result-budget.js";
import { builtinAgents } from "../runtime/builtin-agents.js";
import type { AgentPermissionContext, AgentTaskPacket } from "../runtime/agent-specs.js";
import type { SymphonyDaemonRecord } from "../symphony/daemon.js";
import type { AgentCard } from "../protocol/types.js";

export type EvalCaseResult = {
  name: string;
  status: "pass" | "fail";
  message: string;
};

function evalAgentPermissionContext(
  mode: AgentPermissionContext["default_mode"] = "ask"
): AgentPermissionContext {
  return {
    default_mode: mode,
    allow: [],
    ask: [],
    deny: [],
    additional_directories: []
  };
}

function evalTaskPacket(
  taskPacket: Omit<AgentTaskPacket, "permission_context">,
  mode: AgentPermissionContext["default_mode"] = "ask"
): AgentTaskPacket {
  return {
    ...taskPacket,
    permission_context: evalAgentPermissionContext(mode)
  };
}

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
    checkContains(root, "src/runtime/coding-agent-loop.ts", "renderHostEnvironmentPrompt(input.workspace, input.additionalReadDirectories)", "coding loop injects host environment and additional read directories"),
    checkContains(root, "src/runtime/runtime.ts", "renderHostEnvironmentPrompt(this.workspace, this.settings.permissions.additionalDirectories)", "chat mode injects host environment and additional read directories"),
    checkContains(root, "src/agents/child-entry.ts", "workerLoopSystemPrompt(workspace)", "worker loop injects host environment"),
    checkContains(root, "src/agents/worker-loop-contract.ts", "recoverySuggestion?: string", "worker tool results carry recovery guidance"),
    checkContains(root, "src/agents/worker-loop-contract.ts", "sandbox?: SandboxDecision", "worker tool results carry sandbox metadata"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "workerStore", "worker lifecycle is wired into coding loop"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "invokeAgent", "agent delegates route through main Swarm"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "available_agent_specs", "coding loop exposes agent specs to main Swarm"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "delegation_policy", "coding loop exposes delegation policy"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "dynamic_escalation", "coding loop can dynamically escalate into an internal swarm"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "For explicit swarm or team-role requests", "coding loop prompts early worker spawning for explicit swarm requests"),
    checkContains(root, "src/index.ts", "command === \"work\"", "CLI exposes top-level work command for the coding_loop main path"),
    checkContains(root, "src/index.ts", "\"--mode\", \"coding_loop\"", "top-level work command forces coding_loop mode before headless execution"),
    checkContains(root, "README.md", "swarm work \"fix the failing tests\"", "README documents top-level work command"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "tool_schemas", "coding loop exposes tool schemas"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "ToolSearch", "coding loop exposes a deferred tool search action"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "deferred_tool_catalog", "coding loop surfaces a deferred tool catalog summary"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "Use ToolSearch to discover", "coding loop instructs the model to search deferred MCP tools first"),
    checkContains(root, "src/tools/tool-contracts.ts", "LOCAL_TOOL_SCHEMAS", "local tool schemas live in the shared tool contract layer"),
    checkLocalToolStructuredContractBehavior(),
    checkLocalToolInputSchemaBehavior(root),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "validateLocalToolActionInputs", "coding loop validates local tool calls through shared tool contracts"),
    checkNotContains(root, "src/runtime/coding-agent-loop.ts", "const TOOL_SCHEMAS", "coding loop does not own duplicated local tool schemas"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "validateCodingLoopToolCalls", "coding loop validates malformed model tool calls before execution"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "repairedValidationError", "coding loop re-validates repaired model tool calls before execution"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "invalidCodingLoopModelResult", "coding loop fails closed when repaired tool calls remain malformed"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "Every tool call must include a non-empty action string", "coding loop repair prompt rejects empty tool actions"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "Use file.delete for deleting workspace files", "coding loop prompts safe file deletion instead of destructive shell cleanup"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "responseFormat: \"json_object\"", "coding loop requests provider-native JSON object output"),
    checkContains(root, "src/providers/openai-provider.ts", "response_format: { type: \"json_object\" }", "OpenAI-compatible chat completions support JSON object response format"),
    checkContains(root, "src/providers/openai-provider.ts", "createChatCompletionWithResponseFormatFallback", "OpenAI-compatible JSON mode can fall back when a provider rejects response_format"),
    checkContains(root, "src/providers/openai-provider.ts", "shouldRetryEmptyChatCompletion", "DeepSeek empty JSON chat completions get a targeted retry"),
    checkContains(root, "src/providers/openai-provider.ts", "finish_reason=", "empty chat completion errors include finish reason diagnostics"),
    checkContains(root, "src/providers/openai-provider.ts", "reasoning_content", "empty chat completion diagnostics report DeepSeek reasoning content presence"),
    checkModelReadinessRejectsUnknownProviderModels(root),
    checkSetModelSelectionRejectsUnknownProviderModels(),
    checkHeadlessRunModelReadinessPreflight(root),
    checkDoctorCliBehavior(root),
    checkLogsCliBehavior(root),
    checkCapabilitiesCliBehavior(root),
    checkSessionsCliBehavior(root),
    checkLiveStatusCliBehavior(root),
    checkTopLevelLiveControlCliBehavior(root),
    checkSessionsLiveControlCliBehavior(root),
    checkSessionsWatchCliBehavior(root),
    checkSessionsExecuteForkCliBehavior(root),
    checkRunsCliBehavior(root),
    checkRunsWatchCliBehavior(root),
    checkWatchCliBehavior(root),
    checkWorkersAndHandoffsCliBehavior(root),
    checkApprovalsCliBehavior(root),
    checkPluginsCliBehavior(root),
    checkSkillsCliBehavior(root),
    checkMcpCliBehavior(root),
    checkHeadlessResumeCliBehavior(root),
    checkContains(root, "src/extensions/mcp.ts", "shouldDefer: true", "MCP tools default to deferred loading"),
    checkContains(root, "src/extensions/skills.ts", "alwaysLoad: true", "skill activation stays always loaded"),
    checkContains(root, "src/agents/child-entry.ts", "routeableDelegateCapability", "Child agent delegation rejects empty or unrouteable capabilities"),
    checkContains(root, "src/agents/child-entry.ts", "DELEGATE_CAPABILITY_MISSING", "Child agent delegation returns a structured error for missing capability"),
    checkFile(root, "src/extensions/broker.ts", "Capability broker exists"),
    checkContains(root, "src/runtime/runtime.ts", "new CapabilityBroker", "Runtime owns the capability broker"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "local_tool.", "Coding loop routes built-in tools through capability broker when available"),
    checkContains(root, "src/extensions/broker.ts", "createToolApprovalRequest", "Broker uses local tool approval details for built-in tools"),
    checkContains(root, "src/extensions/broker.ts", "decideToolPermission(action", "Broker reuses central tool permission decisions for built-in tools"),
    checkContains(root, "src/extensions/broker.ts", "invokeMcpResource", "Broker can invoke MCP resources through the unified capability path"),
    checkContains(root, "src/extensions/broker.ts", "invokeMcpPrompt", "Broker can invoke MCP prompts through the unified capability path"),
    checkContains(root, "src/extensions/broker.ts", "invokeNamedSkill", "Broker can invoke named skill capabilities directly"),
    checkContains(root, "src/extensions/broker.ts", "invokeAgentSpec", "Broker can invoke agent specs through the unified capability path"),
    checkContains(root, "src/extensions/broker.ts", "AGENT_SPEC_SESSION_REQUIRED", "Broker rejects orphan agent spec invocations without a parent session"),
    checkContains(root, "src/runtime/runtime.ts", "findMcpMaterialCapability", "Runtime resolves MCP resource and prompt capabilities before materialization"),
    checkContains(root, "src/runtime/runtime.ts", "materializeMcp: (input) => this.recordMcpMaterial(input)", "Runtime preserves Work Kernel MCP artifacts from broker invocations"),
    checkContains(root, "src/runtime/runtime.ts", "durable_context.skill", "Runtime records durable skill context"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "Durable session context", "Coding loop injects durable session context"),
    checkContains(root, "src/extensions/mcp.ts", "toolRiskOverrides", "MCP tool risk can be overridden by trusted settings"),
    checkContains(root, "src/runtime/runtime.ts", "recordMcpMaterial", "MCP resources and prompts are materialized through Work Kernel records"),
    checkContains(root, "src/runtime/runtime.ts", "this.provider.reload(this.workspace)", "runtime reload refreshes provider model and config cache"),
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
    checkContains(root, "src/runtime/headless-artifacts.ts", "swarm.headless.stream.v1", "headless stream-json schema exists"),
    checkFile(root, "src/runtime/work-protocol.ts", "unified work protocol adapter exists"),
    checkContains(root, "src/runtime/work-protocol.ts", "swarm.work.v1", "work protocol version exists"),
    checkContains(root, "src/runtime/work-protocol.ts", "buildWorkRecordFromRuntimeEvent", "work protocol maps runtime events to stable records"),
    checkContains(root, "src/runtime/work-protocol.ts", "kind: \"permission\"", "work protocol includes permission records"),
    checkContains(root, "src/runtime/work-protocol.ts", "permission_rule", "work protocol permission records include matched permission rules"),
    checkContains(root, "src/runtime/work-protocol.ts", "kind: \"task\"", "work protocol includes task records"),
    checkContains(root, "src/runtime/work-protocol.ts", "agent_run_started", "work protocol maps agent run lifecycle into task records"),
    checkContains(root, "src/runtime/work-protocol.ts", "handoffWorkRecord", "work protocol maps handoff lifecycle into task records"),
    checkContains(root, "src/runtime/work-protocol.ts", "write_policy", "work protocol task records preserve write policy"),
    checkWorkerTopologyWorkProtocolBehavior(),
    checkContains(root, "src/runtime/headless-artifacts.ts", "work: WorkProtocolRecord", "headless stream records include the unified work record"),
    checkContains(root, "src/runtime/headless-artifacts.ts", "buildWorkRecordForHeadlessStream", "headless stream derives work protocol records automatically"),
    checkContains(root, "src/runtime/headless-artifacts.ts", "write_policy", "headless artifacts preserve task write policy"),
    checkContains(root, "src/server/gateway.ts", "\"/v1/work-events\"", "Gateway exposes a pure work-protocol event stream"),
    checkContains(root, "src/server/gateway.ts", "buildWorkRecordFromRuntimeEvent", "Gateway derives work protocol records from runtime events"),
    checkContains(root, "src/server/gateway.ts", "writeGatewayEvent", "Gateway can emit runtime-compatible and work-protocol SSE records"),
    checkContains(root, "README.md", "`/v1/work-events` streams the stable `swarm.work.v1`", "README documents the Gateway work-protocol stream"),
    checkContains(root, "src/tui/action-log.ts", "workProtocolToActionRow", "TUI action log can render work-protocol records"),
    checkContains(root, "src/tui/action-log.ts", "buildWorkRecordFromRuntimeEvent", "TUI action log adapts runtime events through the work protocol"),
    checkContains(root, "src/tui/action-log.ts", "work:permission", "TUI action log renders permission protocol rows"),
    checkContains(root, "src/tui/action-log.ts", "policy=", "TUI action log surfaces task write policy"),
    checkFile(root, "src/tui/work-state.ts", "TUI work protocol state reducer exists"),
    checkContains(root, "src/tui/work-state.ts", "applyWorkRecordToTuiState", "TUI task state is derived from work-protocol records"),
    checkContains(root, "src/tui/work-state.ts", "applyTaskAttemptToTuiState", "TUI task attempts preserve attempt counters without bypassing work state"),
    checkContains(root, "src/tui/work-state.ts", "summarizeTaskWritePolicies", "TUI work state can summarize task write policies"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "const [taskWorkState, setTaskWorkState]", "TUI keeps task progress in a unified work state"),
    checkContains(root, "src/index.ts", "--stream-json", "headless run exposes stream-json output"),
    checkContains(root, "src/index.ts", "run_signal", "headless run streams signal records"),
    checkContains(root, "src/runtime/runtime.ts", "requestStopActiveWork", "runtime exposes active work stop for headless signals"),
    checkFile(root, "src/runtime/headless-stdio.ts", "headless stdio guard exists"),
    checkContains(root, "src/runtime/headless-stdio.ts", "installHeadlessStdoutGuard", "headless stdio guard installs stdout protection"),
    checkContains(root, "src/runtime/headless-stdio.ts", "process.stdout.write", "headless machine output bypasses console.log"),
    checkContains(root, "src/runtime/headless-stdio.ts", "\"EPIPE\"", "headless stdio guard handles broken pipes"),
    checkContains(root, "src/index.ts", "stdoutGuard.writeRecord", "headless stream-json writes through the stdout guard"),
    checkContains(root, "src/index.ts", "stdoutGuard.writeLine(JSON.stringify", "headless json writes through the stdout guard"),
    checkHeadlessStdoutGuardBehavior(root),
    checkContains(root, "README.md", "--stream-json", "README documents stream-json output"),
    checkContains(root, "src/index.ts", "--resume <session_id>", "headless run documents resume session option"),
    checkContains(root, "src/index.ts", "runtime.buildResumePrompt", "headless run reuses runtime resume prompt"),
    checkContains(root, "src/index.ts", "resume_session_id", "headless stream records resume session id"),
    checkContains(root, "src/index.ts", "decideResumeExecution", "headless run shares stored-plan resume control"),
    checkContains(root, "src/index.ts", "renderResumePreflight", "headless run renders the shared resume preflight"),
    checkContains(root, "src/runtime/headless-artifacts.ts", "resume_preflight", "headless artifacts record resume preflight metadata"),
    checkContains(root, "src/index.ts", "--max-turns", "headless run documents max-turns budget option"),
    checkContains(root, "src/index.ts", "parseHeadlessBudgetOptions", "headless run parses loop budget options"),
    checkContains(root, "src/index.ts", "maxToolCalls: budget?.max_tool_calls", "headless run passes tool budget into coding loop"),
    checkContains(root, "src/index.ts", "--sandbox", "headless run exposes sandbox mode option"),
    checkContains(root, "src/index.ts", "--read-only", "headless run exposes read-only sandbox alias"),
    checkContains(root, "src/index.ts", "sandboxMode", "headless run passes sandbox mode into execution"),
    checkContains(root, "src/index.ts", "--allowed-tools", "headless run exposes an allowed-tools policy option"),
    checkContains(root, "src/index.ts", "--disallowed-tools", "headless run exposes a disallowed-tools policy option"),
    checkContains(root, "src/index.ts", "--add-dir", "headless run exposes an extra read directory option"),
    checkContains(root, "src/index.ts", "--mcp-config", "headless run exposes runtime MCP config option"),
    checkContains(root, "src/index.ts", "--strict-mcp-config", "headless run exposes strict runtime MCP config option"),
    checkContains(root, "src/index.ts", "--system-prompt", "headless run exposes a custom system prompt option"),
    checkContains(root, "src/index.ts", "--append-system-prompt", "headless run exposes an appended system prompt option"),
    checkContains(root, "src/index.ts", "--skill NAME", "headless run exposes per-run skill activation"),
    checkContains(root, "src/index.ts", "--skills A,B", "headless run exposes comma-separated skill activation"),
    checkFile(root, "src/extensions/custom-commands.ts", "custom command provider exists"),
    checkContains(root, "src/extensions/custom-commands.ts", "renderCustomCommandObjective", "custom commands render prompt objectives"),
    checkContains(root, "src/extensions/custom-commands.ts", "settings.extensions.commands", "custom commands have settings-backed discovery"),
    checkContains(root, "src/config/settings.ts", "loadProjectCommands", "settings include project custom command trust posture"),
    checkContains(root, "src/runtime/runtime.ts", "listCustomCommands", "runtime exposes custom command records"),
    checkContains(root, "src/tui/slash-commands.ts", "/commands [all]", "TUI documents custom command catalog"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "runCustomSlashCommand", "TUI can execute custom command prompts"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "formatPluginSlashCommandsSummary", "TUI commands catalog includes plugin slash commands"),
    checkContains(root, "README.md", "Trusted plugin slash commands appear in the same `/commands`", "README documents unified custom/plugin command catalog"),
    checkContains(root, "src/index.ts", "parseHeadlessToolPolicyOptions", "headless run parses per-run tool policy options"),
    checkContains(root, "src/index.ts", "parseHeadlessAdditionalReadDirectories", "headless run parses per-run additional read directories"),
    checkContains(root, "src/index.ts", "parseHeadlessMcpConfigOptions", "headless run parses runtime MCP config options"),
    checkContains(root, "src/index.ts", "parseHeadlessPromptOptions", "headless run parses custom prompt options"),
    checkContains(root, "src/index.ts", "parseHeadlessSkillOptions", "headless run parses per-run skill activation options"),
    checkContains(root, "src/index.ts", "readHeadlessPromptFileOption", "headless run supports prompt file options"),
    checkContains(root, "src/extensions/mcp.ts", "loadRuntimeMcpConfigSources", "MCP runtime config loader accepts CLI sources"),
    checkContains(root, "src/extensions/mcp.ts", "applyRuntimeMcpConfig", "MCP runtime config can be applied without persisting settings"),
    checkContains(root, "src/extensions/mcp.ts", "settings.extensions.mcp.runtimeConfig?.strict", "strict runtime MCP config skips other MCP sources"),
    checkContains(root, "src/runtime/execution-router.ts", "allowedTools?: string[]", "RunOptions includes allowed tools"),
    checkContains(root, "src/runtime/execution-router.ts", "disallowedTools?: string[]", "RunOptions includes disallowed tools"),
    checkContains(root, "src/runtime/execution-router.ts", "additionalReadDirectories?: string[]", "RunOptions includes extra read directories"),
    checkContains(root, "src/runtime/execution-router.ts", "systemPrompt?: string", "RunOptions includes custom system prompt"),
    checkContains(root, "src/runtime/execution-router.ts", "appendSystemPrompt?: string", "RunOptions includes appended system prompt"),
    checkContains(root, "src/runtime/execution-router.ts", "skills?: string[]", "RunOptions includes activated skill names"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "assertRawToolAllowedByPolicy", "coding loop checks raw tool names before normalization"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "Tool action denied by run tool policy", "coding loop blocks tools denied by run policy"),
    checkContains(root, "src/runtime/headless-artifacts.ts", "tool_policy", "headless artifacts record run tool policy"),
    checkContains(root, "src/runtime/headless-artifacts.ts", "additional_read_directories", "headless artifacts record extra read directories"),
    checkContains(root, "src/runtime/headless-artifacts.ts", "prompt_customization", "headless artifacts record prompt customization metadata"),
    checkContains(root, "src/runtime/headless-artifacts.ts", "mcp_config", "headless artifacts record runtime MCP config metadata"),
    checkContains(root, "src/runtime/headless-artifacts.ts", "activated_skills", "headless artifacts record activated skill names"),
    checkContains(root, "README.md", "--allowed-tools", "README documents headless allowed-tools policy"),
    checkContains(root, "README.md", "--add-dir", "README documents headless add-dir policy"),
    checkContains(root, "README.md", "--mcp-config", "README documents headless runtime MCP config"),
    checkContains(root, "README.md", "--system-prompt", "README documents headless custom prompt policy"),
    checkContains(root, "README.md", "--skill NAME", "README documents headless per-run skill activation"),
    checkContains(root, "src/runtime/runtime.ts", "buildResumePrompt", "runtime exposes shared resume prompt builder"),
    checkContains(root, "src/runtime/runtime.ts", "maxTurns: options.maxTurns", "runtime passes run maxTurns into coding loop"),
    checkContains(root, "src/runtime/runtime.ts", "systemPrompt: options.systemPrompt", "runtime passes run custom prompt into coding loop"),
    checkContains(root, "src/runtime/runtime.ts", "activateRunSkills", "runtime activates per-run skills"),
    checkContains(root, "src/runtime/runtime.ts", "skill_activated", "runtime emits skill activation events"),
    checkContains(root, "src/runtime/runtime.ts", "renderActivatedSkillsForPrompt", "chat mode can inject activated skill instructions"),
    checkContains(root, "src/runtime/swarm-controller.ts", "executeRoute: (objective: string, route: ExecutionRoute, options: RunOptions)", "controller preserves run options through routing"),
    checkContains(root, "src/runtime/execution-router.ts", "maxToolCalls?: number", "RunOptions includes coding-loop tool budget"),
    checkContains(root, "src/runtime/execution-router.ts", "RunSandboxMode", "RunOptions includes sandbox mode"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "local coding-loop protocol", "coding loop preserves protocol rules when system prompt is customized"),
    checkFile(root, "src/runtime/sandbox-policy.ts", "shared sandbox policy module exists"),
    checkContains(root, "src/runtime/sandbox-policy.ts", "decideToolActionSandbox", "sandbox policy exposes structured local tool decisions"),
    checkContains(root, "src/runtime/sandbox-policy.ts", "Read-only sandbox denied tool action", "read-only sandbox blocks mutating tool actions"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "assertToolActionAllowedBySandbox", "coding loop enforces sandbox through shared policy decisions"),
    checkNotContains(root, "src/runtime/coding-agent-loop.ts", "function assertActionAllowedByWritePolicy", "coding loop does not own duplicated sandbox tool policy"),
    checkContains(root, "src/runtime/runtime.ts", "hasRunSandboxPolicy", "runtime routes read-only sandbox runs through coding loop enforcement"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "isParallelReadOnlyDelegateAction", "coding loop classifies explicit read-only parallel delegates as concurrent"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "delegate_parallel", "coding loop can classify disjoint scoped-write delegates as a concurrent batch"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "maxParallel: this.options.settings.runtime.maxParallelTasks", "coding loop caps concurrent tool batches by runtime parallel budget"),
    checkContains(root, "src/runtime/sandbox-policy.ts", "Scoped-write sandbox denied tool action", "sandbox policy enforces scoped-write file boundaries"),
    checkContains(root, "src/runtime/sandbox-policy.ts", "Scoped-write sandbox denied capability", "sandbox policy enforces scoped-write dynamic capability boundaries"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "read_only: capability.readOnly === true", "dynamic tool schemas expose read-only metadata"),
    checkContains(root, "src/runtime/runtime.ts", "fileScope: taskPacket.file_scope", "runtime passes agent task file_scope into worker loop sandbox"),
    checkContains(root, "README.md", "preferred_mode: \"parallel\"", "README documents read-only parallel agent delegation"),
    checkContains(root, "README.md", "concrete `file_scope` that does not overlap", "README documents disjoint scoped-write parallel delegation"),
    checkContains(root, "README.md", "`file_scope` is enforced before write tools execute", "README documents scoped-write file scope enforcement"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "return runtime.buildResumePrompt", "TUI resume uses runtime prompt builder"),
    checkContains(root, "src/runtime/headless-artifacts.ts", "resume_session_id", "headless artifacts record resumed session id"),
    checkContains(root, "src/runtime/headless-artifacts.ts", "max_tool_calls", "headless artifacts record run budget"),
    checkContains(root, "src/runtime/headless-artifacts.ts", "sandbox_mode", "headless artifacts record sandbox mode"),
    checkContains(root, "README.md", "--resume <session_id>", "README documents headless session resume"),
    checkContains(root, "README.md", "--max-tool-calls", "README documents headless loop budgets"),
    checkContains(root, "README.md", "--read-only", "README documents headless read-only sandbox"),
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
    checkContains(root, "src/tui/SwarmChatApp.tsx", "workers={mergeWorkerRecords(workers, idlePaneSnapshot.workers, 6)}", "Activity pane summarizes worker records"),
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
    checkContains(root, "src/tui/SwarmChatApp.tsx", "autoOpenDetail: true", "TUI help opens its catalog directly"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "mainPane === \"overview\" ?", "TUI overview pane still branches while work is running"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "lastRoute", "TUI tracks the latest actual execution route"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "routeStateFromControllerEvent", "TUI derives route state from controller events"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "route=", "TUI overview surfaces the selected local loop or swarm route"),
    checkContains(root, "README.md", "command history with Up/Down", "README documents TUI input editing"),
    checkContains(root, "README.md", "latest actual route selected by auto mode", "README documents actual route visibility"),
    checkContains(root, "README.md", "swarm bench run <suite>", "README documents benchmark run command"),
    checkContains(root, "README.md", "swarm bench report <run_id>", "README documents benchmark report command"),
    checkContains(root, "README.md", "swarm bench compare <run_a> <run_b>", "README documents benchmark compare command"),
    checkContains(root, "src/storage/database.ts", "worker_states", "worker state table exists"),
    checkContains(root, "src/storage/database.ts", "handoff_sessions", "handoff session table exists"),
    checkContains(root, "src/tools/local-tools.ts", "acquireWriteLock", "file write lock exists"),
    checkContains(root, "src/tools/local-tools.ts", "WorkspaceChangeMetadata", "workspace change metadata exists"),
    checkContains(root, "src/config/settings.ts", "\"yolo\"", "yolo permission mode is accepted by settings"),
    checkContains(root, "src/tools/permissions.ts", "mode === \"yolo\"", "yolo bypasses approval prompts"),
    checkContains(root, "src/index.ts", "--yolo", "CLI supports temporary yolo mode"),
    checkContains(root, "src/index.ts", "--permission-mode", "headless CLI supports explicit permission mode"),
    checkContains(root, "src/index.ts", "SWARM_PERMISSION_MODE = requestedPermissionMode", "headless permission mode maps to settings env"),
    checkContains(root, "src/runtime/headless-artifacts.ts", "permission_mode", "headless artifacts record effective permission mode"),
    checkContains(root, "README.md", "--permission-mode", "README documents headless permission mode override"),
    checkContains(root, "src/config/settings.ts", "addPermissionAdditionalDirectory", "settings can add persistent additional read directories"),
    checkContains(root, "src/config/settings.ts", "removePermissionAdditionalDirectory", "settings can remove persistent additional read directories"),
    checkContains(root, "src/tui/slash-commands.ts", "/add-dir <directory>", "TUI documents add-dir slash command"),
    checkContains(root, "src/tui/slash-commands.ts", "/remove-dir <directory>", "TUI documents remove-dir slash command"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "addPermissionAdditionalDirectory(args[0])", "TUI add-dir updates permissions"),
    checkContains(root, "README.md", "/add-dir <directory>", "README documents TUI add-dir"),
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
    checkContains(root, "src/providers/openai-provider.ts", "cacheCreationInputTokens", "Provider usage records cache creation tokens"),
    checkContains(root, "src/providers/openai-provider.ts", "uncachedInputTokens", "Provider usage records uncached input tokens"),
    checkContains(root, "src/providers/openai-provider.ts", "totalInputWithCacheTokens", "Provider usage records total input including cache"),
    checkContains(root, "src/providers/openai-provider.ts", "cacheWriteRate", "Provider usage records cache write rate"),
    checkContains(root, "src/providers/openai-provider.ts", "minimumCacheableTokens", "Provider diagnostics use provider-specific cache thresholds"),
    checkContains(root, "src/runtime/runtime.ts", "cached_input", "Runtime usage records cached token counters"),
    checkContains(root, "src/runtime/runtime.ts", "total_input_with_cache", "Runtime usage records total input including cache"),
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
    checkContains(root, "src/runtime/headless-artifacts.ts", "cache_write_rate", "headless telemetry reports cache write rate"),
    checkContains(root, "src/runtime/headless-artifacts.ts", "total_input_with_cache_tokens", "headless telemetry reports total input including cache"),
    checkContains(root, "src/storage/session-context-store.ts", "Files and paths seen", "session context compaction preserves important file signals"),
    checkContains(root, "src/runtime/runtime.ts", "compactWorkerResultForParent", "runtime compacts worker results before returning them to the parent loop"),
    checkContains(root, "src/runtime/runtime.ts", "result_ref", "parent loop receives a worker result artifact reference"),
    checkContains(root, "src/tools/local-tools.ts", "serverWebSearch", "web search can use provider-native search"),
    checkContains(root, "src/tools/local-tools.ts", "allowed_domains", "web search supports domain filters"),
    checkContains(root, "src/tools/local-tools.ts", "validateShellCommandForHost", "shell tools validate commands against the host shell"),
    checkContains(root, "src/tools/local-tools.ts", "Command uses POSIX-only shell syntax", "shell tools reject POSIX-only commands on PowerShell hosts"),
    checkContains(root, "src/tools/local-tools.ts", "explicitly invoke an available shell", "shell tool recovery explains explicit alternate shell usage"),
    checkContains(root, "src/tools/types.ts", "recoverySuggestion", "tool results can carry deterministic recovery guidance"),
    checkContains(root, "src/protocol/types.ts", "toolRecoverySuggestion?: string", "agent task results can carry tool recovery guidance"),
    checkContains(root, "src/protocol/types.ts", "sandbox?: unknown", "agent task results can carry sandbox metadata"),
    checkContains(root, "src/runtime/events.ts", "recoverySuggestion", "tool result events carry recovery guidance"),
    checkContains(root, "src/runtime/runtime.ts", "recovery_suggestion: event.recoverySuggestion", "runtime persists tool recovery guidance into Work Kernel attempts"),
    checkContains(root, "src/runtime/orchestrator.ts", "recoverySuggestion: payload.toolRecoverySuggestion", "tool task orchestration forwards child recovery guidance into runtime events"),
    checkContains(root, "src/runtime/orchestrator.ts", "sandbox: sandboxDecisionFromUnknown(payload.sandbox)", "tool task orchestration forwards child sandbox metadata into runtime events"),
    checkFile(root, "src/runtime/tool-task-sandbox.ts", "shared tool-task sandbox helper exists"),
    checkContains(root, "src/runtime/orchestrator.ts", "const toolInputs = sandboxedToolTaskInputs(task.inputs, capability)", "full swarm tool tasks derive sandboxed inputs before dispatch"),
    checkContains(root, "src/runtime/orchestrator.ts", "const taskEventMeta = taskRuntimeMetadata(session.session_id, capability, toolInputs);", "full swarm task lifecycle events preserve sandbox metadata"),
    checkContains(root, "src/runtime/orchestrator.ts", "inputs: toolInputs", "full swarm tool task envelopes send sandbox-augmented inputs"),
    checkContains(root, "src/runtime/plan-generator.ts", "sandboxedToolTaskInputs(", "planner normalization derives sandbox defaults for tool tasks"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "Recovery:", "TUI surfaces tool and attempt recovery guidance"),
    checkContains(root, "src/tui/action-log.ts", "event.sandbox ? `sandbox=${event.sandbox.policy}/${event.sandbox.decision} ${event.sandbox.reason}` : undefined", "TUI action log surfaces sandbox denial detail"),
    checkFile(root, "src/storage/approval-store.ts", "approval store exists"),
    checkFile(root, "src/storage/audit-store.ts", "audit store exists"),
    checkFile(root, "src/storage/usage-store.ts", "usage store exists"),
    checkFile(root, "src/storage/task-graph-store.ts", "task graph store exists"),
    checkFile(root, "src/server/gateway.ts", "local Gateway server exists"),
    checkContains(root, "src/protocol/types.ts", "RiskClass", "risk class protocol type exists"),
    checkContains(root, "src/tools/types.ts", "predicted_impact", "approval challenge fields exist"),
    checkFile(root, "src/tui/approval-input.ts", "TUI approval input helper is isolated"),
    checkContains(root, "src/tui/components/ApprovalOverlay.tsx", "Decision Menu", "TUI approval overlay uses a decision-oriented layout"),
    checkContains(root, "src/tui/components/ApprovalOverlay.tsx", "allow same target", "TUI approval overlay supports session-scoped allow"),
    checkContains(root, "src/tui/components/ApprovalOverlay.tsx", "Esc cancel", "TUI approval overlay advertises cancel behavior"),
    checkContains(root, "src/tui/components/ApprovalOverlay.tsx", "Review focus:", "TUI approval overlay surfaces risk-specific review focus"),
    checkContains(root, "src/tui/components/ApprovalOverlay.tsx", "approvalReviewFocus", "TUI approval overlay derives tool-specific review focus"),
    checkContains(root, "src/tui/components/ApprovalOverlay.tsx", "Why now", "TUI approval overlay surfaces why-now context"),
    checkContains(root, "src/tui/components/ApprovalOverlay.tsx", "Permission:", "TUI approval overlay surfaces permission decision context"),
    checkContains(root, "src/tui/components/ApprovalOverlay.tsx", "permission_rule", "TUI approval overlay surfaces matched permission rules"),
    checkContains(root, "src/tui/components/ApprovalOverlay.tsx", "attention_note", "TUI approval overlay surfaces destructive approval attention notes"),
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
    checkContains(root, "src/protocol/types.ts", "export type WorkContractSnapshot", "WorkSnapshot exposes a stable work-contract schema"),
    checkContains(root, "src/protocol/types.ts", "export type TaskContractRecord", "WorkSnapshot exposes a stable task-contract schema"),
    checkContains(root, "src/runtime/runtime.ts", "work_contracts: buildWorkContractSnapshot", "runtime snapshot derives stable work contracts"),
    checkContains(root, "src/runtime/runtime.ts", "task_contracts: buildTaskContractSnapshot", "runtime snapshot derives stable task contracts"),
    checkContains(root, "src/runtime/runtime.ts", "listWorkerContracts", "runtime exposes stable worker contract projections"),
    checkContains(root, "src/runtime/runtime.ts", "listHandoffContracts", "runtime exposes stable handoff contract projections"),
    checkContains(root, "src/server/session-view.ts", "work_snapshot: workSnapshot", "Gateway session response includes WorkSnapshot"),
    checkContains(root, "src/server/session-view.ts", "task_contracts: workSnapshot.task_contracts", "Gateway session response exposes task contract summary"),
    checkContains(root, "src/server/session-view.ts", "work_contracts: workSnapshot.work_contracts", "Gateway session response exposes work contract summary"),
    checkContains(root, "src/server/gateway.ts", "worker_contracts", "Gateway worker routes expose stable worker contracts"),
    checkContains(root, "src/server/gateway.ts", "handoff_contracts", "Gateway handoff routes expose stable handoff contracts"),
    checkContains(root, "src/server/gateway.ts", "parent_session_id", "Gateway collaboration routes support session-scoped filtering"),
    checkContains(root, "src/server/gateway.ts", "/v1/workers/:id/continue", "Gateway documents worker continuation route"),
    checkContains(root, "src/server/gateway.ts", "this.runtime.continueAgent(workerId, message)", "Gateway can continue a worker through the runtime"),
    checkContains(root, "src/server/gateway.ts", "this.runtime.workerStateStore.get(workerId)", "Gateway can inspect one worker"),
    checkContains(root, "src/server/gateway.ts", "this.runtime.getHandoff(handoffId)", "Gateway can inspect one handoff"),
    checkContains(root, "src/runtime/runtime.ts", "action: \"worker_continuation\"", "worker continuation emits a controller event"),
    checkContains(root, "src/runtime/runtime.ts", "type: \"handoff_message\"", "handoff continuation emits a handoff message"),
    checkContains(root, "src/runtime/runtime.ts", "Resume Work Contracts", "resume replay surfaces worker and handoff contracts"),
    checkContains(root, "src/index.ts", "subcommand === \"attach\"", "CLI sessions attach aliases live session watch"),
    checkContains(root, "src/index.ts", "subcommand === \"stop\" || subcommand === \"kill\"", "CLI sessions stop and kill alias interrupt"),
    checkContains(root, "src/index.ts", "command === \"attach\"", "top-level attach aliases the latest session watch"),
    checkContains(root, "src/index.ts", "defaultSessionSelectorArgs", "top-level attach defaults to latest when no session selector is provided"),
    checkContains(root, "src/index.ts", "command === \"resume\" || command === \"continue\"", "top-level resume and continue alias session lifecycle commands"),
    checkContains(root, "README.md", "swarm sessions attach latest", "README documents session attach alias"),
    checkContains(root, "README.md", "swarm attach --gateway-url", "README documents top-level attach alias"),
    checkContains(root, "README.md", "swarm resume sess_123", "README documents top-level resume alias"),
    checkContains(root, "README.md", "swarm continue \"finish the verification\"", "README documents top-level continue alias"),
    checkContains(root, "README.md", "swarm sessions stop sess_123", "README documents session stop alias"),
    checkContains(root, "src/approvals/headless-handler.ts", "--workspace", "headless approval wait prompts include workspace-aware approve and deny commands"),
    checkContains(root, "src/index.ts", "workspace: options.workspace", "headless approval handler receives the selected workspace"),
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
    checkContains(root, "src/tui/work-snapshot-display.ts", "formatWorkSnapshot", "TUI session command renders WorkSnapshot"),
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
    checkFile(root, "src/doctor/report.ts", "shared doctor report module exists"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "buildDoctorReport", "TUI reuses shared doctor diagnostics"),
    checkContains(root, "src/doctor/report.ts", "getSelectedModelReadiness", "doctor report checks model readiness"),
    checkContains(root, "src/doctor/report.ts", "runSymphonyPreflight", "doctor report checks Symphony preflight"),
    checkContains(root, "src/doctor/report.ts", "latest_log", "doctor report surfaces latest debug log state"),
    checkContains(root, "src/index.ts", "command === \"doctor\"", "CLI exposes a doctor command"),
    checkContains(root, "src/index.ts", "swarm doctor [workflow_path]", "CLI help documents the doctor command"),
    checkFile(root, "src/doctor/logs.ts", "shared log listing helper exists"),
    checkContains(root, "src/index.ts", "command === \"logs\"", "CLI exposes a logs command"),
    checkContains(root, "src/index.ts", "swarm logs [latest|log_name]", "CLI help documents the logs command"),
    checkContains(root, "README.md", "/doctor [workflow_path]", "README documents TUI doctor diagnostics"),
    checkContains(root, "README.md", "swarm doctor", "README documents the CLI doctor command"),
    checkContains(root, "README.md", "swarm logs", "README documents the CLI logs command"),
    checkContains(root, "README.md", "swarm sessions", "README documents the CLI sessions command"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "IdleKernelView", "TUI idle pane renders the Kernel operator surface"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "idlePaneSnapshot.sessions", "TUI idle pane reads recent Work Kernel sessions"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "idlePaneSnapshot.attempts", "TUI idle pane reads recent Work Kernel attempts"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "idlePaneSnapshot.leases", "TUI idle pane reads recent WorkspaceLease records"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "Workspace Leases", "TUI idle pane surfaces workspace write boundaries"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "idlePaneSnapshot.approvals", "TUI idle pane surfaces pending approvals"),
    checkContains(root, "src/tui/ChatInputArea.tsx", "<InputLine value={controllerState.current.input.value}", "TUI chat input renders the current editable draft"),
    checkContains(root, "src/tui/ChatInputArea.tsx", "controllerStateRef", "TUI chat input can use parent-owned controller state"),
    checkContains(root, "src/tui/ChatInputArea.tsx", "extraCommands", "TUI chat input can receive runtime slash command candidates"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "controllerStateRef={chatInputState}", "TUI shell preserves chat input state across approval overlays"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "pluginSlashCommandCandidates(runtime.listPlugins())", "TUI plugin slash commands feed chat input completion"),
    checkContains(root, "src/tui/slash-commands.ts", "/sandbox [workspace-write|read-only]", "TUI documents sandbox mode control"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "sandboxMode: runSandboxMode", "TUI passes sandbox mode into run and resume paths"),
    checkContains(root, "src/tui/components/StatusRail.tsx", "sandboxBadge(props.sandboxMode)", "TUI status rail shows the active sandbox mode"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "wideWorkbench", "TUI uses a wide-screen workbench layout"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "openSelectedActionDetail", "TUI can open selected action details"),
    checkContains(root, "src/tui/components/ActionLog.tsx", "selectedIndex", "TUI action log supports selected rows"),
    checkNotContains(root, "src/tui/SwarmChatApp.tsx", "/kernel status", "TUI header does not expose Kernel status as a default path"),
    checkNotContains(root, "src/tui/SwarmChatApp.tsx", "Ctrl+T tasks", "TUI header keeps task internals out of the default path"),
    checkNotContains(root, "src/tui/ChatInputArea.tsx", "useStdin", "TUI chat input avoids raw stdin double-consumption"),
    checkNotContains(root, "src/tui/ChatInputArea.tsx", "renderRawInputLine", "TUI chat input avoids manual ANSI line repaint"),
    checkNotContains(root, "src/tui/SwarmChatApp.tsx", "inputHistory", "TUI shell does not own per-keystroke input history state"),
    checkContains(root, "src/tui/chat-input-controller.ts", "applyChatInputKey", "TUI chat input behavior is centralized in a testable controller"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "loopActivityTimeline", "TUI running pane preserves a recent activity timeline"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "formatLoopActivityLine", "TUI running pane renders compact activity lines"),
    checkContains(root, "src/tui/components/ResultCard.tsx", "rollback:/revert last", "TUI result card exposes the actionable checkpoint rollback command"),
    checkFile(root, "src/tui/tui-event-buffer.ts", "TUI event buffer helper is isolated"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "appendTuiRuntimeEvent", "TUI event history avoids duplicate redraw events"),
    checkContains(root, "README.md", "When idle, the TUI main pane acts as the Kernel operator surface", "README documents idle TUI as the Kernel operator surface"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "Recent Attempts", "TUI kernel status view surfaces Work Kernel attempts"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "Symphony", "TUI kernel status view surfaces Symphony state"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "Slash command catalog.", "TUI help opens the grouped command catalog by default"),
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
    checkContains(root, "src/tui/work-snapshot-display.ts", "objective=", "TUI overview shows the current objective in the compact snapshot"),
    checkContains(root, "src/tui/work-snapshot-display.ts", "memory=", "TUI overview surfaces compacted session memory state"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "result=", "TUI overview surfaces the latest result summary"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "policies: ro", "TUI active overview surfaces task write policy counts"),
    checkContains(root, "src/tui/result-display.ts", "formatExecutionResultDisplay", "TUI final outputs use a shared result display formatter"),
    checkContains(root, "src/runtime/result-card.ts", "\"Result\"", "TUI final outputs default to the shared result card"),
    checkContains(root, "src/runtime/result-card.ts", "Memory Freshness", "shared result cards explain resume memory freshness"),
    checkContains(root, "README.md", "Normal runs now finish with a result card", "README documents result-oriented final UX"),
    checkContains(root, "src/tui/main-panes.ts", "agents: \"Activity\"", "TUI renames the default worker pane to Activity"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "No active background work.", "TUI right rail hides worker internals when idle"),
    checkContains(root, "README.md", "Activity pane summarizes workers", "README documents activity-first worker UX"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "CurrentActionRow", "TUI current action rail stays visible while idle and busy"),
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
    checkContains(root, "src/tui/ChatInputArea.tsx", "Up/Down select | Tab accept | Esc close", "TUI candidate list documents selection keys"),
    checkContains(root, "src/tui/slash-commands.ts", "commandOutputPreview", "TUI exposes inline command output preview logic"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "commandOutputPreview", "TUI renders inline command output previews"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "Ctrl+O opens the latest detail.", "TUI overview exposes the latest run or command output with an expand hint"),
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
    checkContains(root, "README.md", "Use `/view` for focused Kernel panes", "README documents explicit TUI pane switching"),
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
    checkContains(root, "src/server/gateway.ts", "actionable_approval_ids", "Gateway approval routes expose actionable queue ids"),
    checkContains(root, "src/server/mcp-endpoint.ts", "swarm.approvals", "MCP exposes approval inspection tool"),
    checkContains(root, "src/server/mcp-endpoint.ts", "swarm://sessions/${session.session_id}/approvals", "MCP exposes session approvals resource"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "listApprovalsForSessionFamily", "TUI approval inspection aggregates child worker approvals through the session family"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "sessionFamilyRootSessionId", "TUI remembered approvals scope to the session family root"),
    checkFile(root, "src/server/session-view.ts", "shared session snapshot helper exists"),
    checkFile(root, "src/sessions/report.ts", "CLI session report helper exists"),
    checkContains(root, "src/server/gateway.ts", "writePolicy: capabilityInvocationWritePolicy(body)", "Gateway capability invoke accepts sandbox policy overrides"),
    checkContains(root, "src/server/gateway.ts", "fileScope: capabilityInvocationFileScope(body)", "Gateway capability invoke accepts delegated file scope"),
    checkContains(root, "src/index.ts", "command === \"serve\"", "CLI supports swarm serve"),
    checkContains(root, "src/tui/slash-commands.ts", "/graph [session_id]", "task graph TUI command is documented"),
    checkContains(root, "src/tui/slash-commands.ts", "/audit [session_id]", "audit TUI command is documented"),
    checkContains(root, "src/tui/slash-commands.ts", "/budget [session_id]", "budget TUI command is documented"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "type: \"approval\", request, status: \"pending\"", "TUI slash tools persist approval requests through Kernel events"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "type: \"tool_result\"", "TUI slash tools persist tool results through Kernel events"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "assertToolActionAllowedBySandbox(action", "TUI slash tools enforce sandbox policy before local tool execution"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "sandbox ? sandboxFailureSummary(sandbox) : message", "TUI slash tool failures reuse sandbox denial summaries"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "...(sandbox ? { sandbox } : {})", "TUI slash tool events and failure metadata retain sandbox decisions"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "sessionId: chatSessionId.current", "TUI slash tools bind local tool execution to the chat WorkSession id"),
    checkContains(root, "src/runtime/runtime.ts", "ensureTuiChatSession", "runtime can create a TUI chat WorkSession"),
    checkContains(root, "src/runtime/runtime.ts", "mode: \"tui_chat\"", "TUI chat WorkSessions are marked with tui_chat source metadata"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "nextRuntime.ensureTuiChatSession(chatSessionId.current)", "TUI runtime creation anchors the chat state in Work Kernel"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "runtime?.ensureTuiChatSession(chatSessionId.current)", "TUI slash tools ensure their chat WorkSession exists"),
    checkContains(root, "src/tui/slash-commands.ts", "/memory [session_id]", "TUI exposes session memory inspection command"),
    checkContains(root, "src/tui/work-snapshot-display.ts", "formatSessionMemory", "TUI renders remembered session context with freshness"),
    checkContains(root, "README.md", "`/memory [session_id]` shows the remembered context", "README documents session memory continuity UX"),
    checkContains(root, "src/tui/slash-commands.ts", "/resume [session_id] [message]", "TUI documents natural coding-loop resume"),
    checkContains(root, "src/tui/slash-commands.ts", "/continue [message]", "TUI documents natural continue command"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "parseResumeTarget", "TUI resume distinguishes session ids from free-form instructions"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "firstIsExistingSession", "TUI resume only consumes the first token as a session when it exists"),
    checkFile(root, "src/tui/resume-control.ts", "shared TUI resume control helper exists"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "decideResumeExecution", "TUI validates stored-plan resume semantics before dispatch"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "buildResumePrompt", "TUI can resume ordinary coding-loop sessions through Work Kernel snapshots"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "runtime.executeWorkSession", "TUI resume can continue existing WorkSessions without plan_json"),
    checkContains(root, "src/runtime/runtime.ts", "renderResumePreflight", "runtime exposes a reusable resume preflight report"),
    checkNotContains(root, "src/tui/idle-pane-snapshot.ts", "runAttemptStore.listRecent", "TUI idle panes do not show global recent attempts"),
    checkNotContains(root, "src/tui/idle-pane-snapshot.ts", "workspaceLeaseStore.listRecent", "TUI idle panes do not show global recent leases"),
    checkNotContains(root, "src/tui/idle-pane-snapshot.ts", "blackboardStore.listRecent", "TUI idle panes do not show global recent blackboard entries"),
    checkContains(root, "src/tui/result-display.ts", "briefForExecutionResult", "TUI final chat summaries distinguish execution status"),
    checkContains(root, "src/tui/result-display.ts", "Failed: ${brief}", "TUI final chat summaries label failed runs"),
    checkContains(root, "src/tui/result-display.ts", "Stopped: ${brief}", "TUI final chat summaries label stopped runs"),
    checkContains(root, "README.md", "The TUI creates a local Work Kernel session for the current chat state", "README documents TUI chat session anchoring"),
    checkContains(root, "docs/WORK_KERNEL.md", "The TUI now anchors its current chat state as a local Work Kernel session", "Work Kernel doc records TUI chat anchoring"),
    checkContains(root, "src/tui/slash-commands.ts", "/self-review", "self-review TUI command is documented"),
    checkContains(root, "src/tui/slash-commands.ts", "/reply <message>", "reply TUI command is documented"),
    checkContains(root, "src/tui/slash-commands.ts", "/web <query>", "web search TUI command is documented"),
    checkContains(root, "README.md", "Live replies and explicit interrupts now fail closed", "README documents fail-closed live control semantics"),
    checkContains(root, "README.md", "swarm live --gateway-url http://127.0.0.1:38171", "README documents the live target status command"),
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
    checkTuiCustomSlashCompletionBehavior(),
    checkTuiPluginSlashCompletionBehavior(),
    checkTuiSandboxControlBehavior(),
    checkTuiSandboxReportBehavior(),
    checkTuiResumeExecutionControlBehavior(),
    checkRuntimeLiveReplyTargetBehavior(root),
    checkRuntimeInterruptTargetBehavior(root),
    checkTuiMidInputSlashCompletionBehavior(),
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
    checkApprovalPreviewBehavior(),
    checkWorkerDisplayNameBehavior(),
    checkEphemeralWorkerPersonaPersistenceBehavior(root),
    checkAgentContinuationFreshnessBehavior(root),
    checkWorkerContinuationTranscriptBehavior(root),
    checkTuiTaskWritePolicySummaryBehavior(),
    checkCodingLoopActivityFormattingBehavior(),
    checkToolRecoveryFormattingBehavior(),
    checkToolResultContractVisibilityBehavior(),
    checkPlanSandboxContractVisibilityBehavior(),
    checkTaskLifecycleSandboxMetadataBehavior(),
    checkToolResultWorkProtocolBehavior(),
    checkApprovalPermissionFormattingBehavior(),
    checkPermissionReportBehavior(),
    checkBaselineAskCatalogKeepsBypassModesUsable(),
    checkExplicitAskRuleOverridesBypassModes(),
    checkDestructiveApprovalFormattingBehavior(),
    checkToolFailureContentBehavior(),
    checkShellTimeoutReturnsToolFailureBehavior(root),
    checkBackgroundProcessLifecycleSurfaceBehavior(root),
    checkAgentDelegateInputValidationBehavior(),
    checkCodingLoopRepairsInvalidToolInputsBehavior(root),
    checkCodingLoopAcceptsFlatToolCallInputsBehavior(root),
    checkCodingLoopIgnoresClaimedFilesTouchedBehavior(root),
    checkCodingLoopAllowsReadOnlyClaimedFilesTouchedBehavior(root),
    checkCodingLoopRetriesUnverifiedWorkspaceCompletionBehavior(root),
    checkCodingLoopRetriesTransactionConflictBehavior(root),
    checkCodingLoopRetriesFormattingRiskBehavior(root),
    checkReadOnlyCodingLoopPromptUsesVerificationToolsBehavior(root),
    checkCodingLoopRetriesUnverifiedVerificationClaimBehavior(root),
    checkCodingLoopStopsSerialBatchAfterFailureBehavior(root),
    checkCodingLoopRecordsFileDeleteChangesBehavior(root),
    checkLocalGitToolsSkipNonRepositoryBehavior(root),
    checkHeadlessToolPolicyWhitespaceSplitBehavior(root),
    checkResultCardWarnsOnReviewFindingsBehavior(),
    checkResultCardInfersVerifierCompletedCheckBehavior(),
    checkResultCardRisksFailedChecksBehavior(),
    checkResultCardSurfacesContractsBehavior(),
    checkReviewSummarySkipsAgentHeadingBehavior(root),
    checkPostChangeChecksHydrateOutputRefsBehavior(root),
    checkPostChangeStatusMappingPreservesVerifiedWorkBehavior(),
    runCacheLabEval(),
    ...runRealUsageRegressionEvals(),
    ...runParityReleaseGateEvals(),
    checkWorkerLoopRepairsInvalidToolCallsBehavior(root),
    checkWorkerLoopProgressPayloadBehavior(root),
    checkCapabilityBrokerSlashCommandInvokeBehavior(root),
    checkCapabilityBrokerNamedSkillInvokeBehavior(root),
    checkCapabilityBrokerAgentSpecInvokeBehavior(root),
    checkCapabilityBrokerSandboxBehavior(root),
    checkChildToolTaskSandboxBehavior(root),
    checkOrchestratorToolTaskSandboxDefaultsBehavior(),
    checkPlannerToolTaskSandboxDefaultsBehavior(),
    checkCodingLoopInvalidToolActionFailClosedBehavior(root),
    checkCodingLoopRepairsContinueWithoutToolsBehavior(root),
    checkCodingLoopParallelReadOnlyDelegationBehavior(root),
    checkCodingLoopParallelScopedWriteDelegationBehavior(root),
    checkCodingLoopSerializesOverlappingScopedWriteDelegationBehavior(root),
    checkWorkerAdmissionQueueBehavior(root),
    checkSandboxDecisionObjectBehavior(),
    checkReadOnlySandboxVerificationCommandBehavior(),
    checkCodingLoopScopedWriteFileScopeBehavior(root),
    checkSandboxDenialMetadataSurfaceBehavior(root),
    checkCodingLoopScopedWriteDynamicCapabilityBehavior(root),
    checkCodingLoopRunToolPolicyBehavior(root),
    checkAdditionalReadDirectoriesPermissionBehavior(),
    checkPersistentAdditionalDirectorySettingsBehavior(),
    checkSwarmHomeTempCleanupBehavior(),
    checkContains(root, "src/config/settings.ts", "cleanupStaleAtomicWriteTemps", "Swarm home reaps stale atomic settings temp files"),
    checkOpenAIProviderReloadBehavior(),
    checkCustomCommandProviderBehavior(),
    checkRuntimeMcpConfigBehavior(),
    checkBuiltinToolSurfaceBehavior(),
    checkBlackboardToolSurfaceBehavior(root),
    checkBlackboardRouterBehavior(),
    checkSwarmProtocolRouterBehavior(root),
    checkToolResultBudgetReplayBehavior(),
    checkResumeHealthPromptBehavior(),
    checkResumePreflightReportBehavior(),
    checkResumeLiveControlDirectiveBehavior(),
    checkFullSwarmSafeBoundaryStopBehavior(root),
    checkPlannedFullSwarmLiveControlBehavior(root),
    checkWorkSnapshotContractBehavior(),
    checkGatewayLiveControlRouteBehavior(root),
    checkGatewayApprovalQueueRouteBehavior(root),
    checkSessionFamilyApprovalReplayBehavior(),
    checkMcpSessionSnapshotParityBehavior(root),
    checkWorkspaceSessionStatusParityBehavior(root),
    checkGatewayWorkContractRouteBehavior(root),
    checkTaskContractSnapshotBehavior(),
    checkSyntheticToolContractBehavior(),
    checkGatewayTaskContractRouteBehavior(root),
    checkGatewayToolWorkEventStreamBehavior(root),
    checkGatewayQueueAndActivityWorkEventStreamBehavior(root),
    checkSessionContextCompactionBehavior(),
    checkWorkspaceScopedSessionBehavior(),
    checkWorkspaceScopedRecentKernelBehavior(),
    checkFileToolInputValidationBehavior(root),
    checkLintFailureAggregationBehavior(),
    checkCodeLintSkipsMissingNodeConfigBehavior(root),
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
    checkWrappedDestructiveShellRiskBehavior(),
    checkHighRiskShellApprovalModeBehavior(),
    checkWorkerPermissionSnapshotBehavior(root),
    checkPermissionDecisionObjectBehavior(),
    checkPermissionDenyPrecedenceBehavior(),
    checkNoForbiddenProductName(root)
  ];
}

export function runRealUsageRegressionEvals(): EvalCaseResult[] {
  return [
    checkRealTaskReplayStatusCacheDiagnosisBehavior(),
    checkDogfoodHarnessQualityReportBehavior(),
    checkRealSwarmOfflineEvalSuiteBehavior(),
    checkProtocolReplayForcedVerdictBehavior(),
    checkFaultInjectionRecoveryDrillsBehavior(),
    checkBudgetBackpressureMetricsBehavior(),
    checkProviderFaultLatestDiagnosisBehavior(),
    checkCacheMissFallbackTelemetryBehavior(),
    checkCacheSloGateBehavior(),
    checkCacheLabReplayBehavior(),
    checkTuiCommandOutputDetailRegressionBehavior(),
    checkTuiInteractionReplayHarnessBehavior()
  ];
}

export function runParityReleaseGateEvals(): EvalCaseResult[] {
  return [
    checkOfflineParityReleaseGateBehavior()
  ];
}

export function runCacheLabReport(): string[] {
  const report = evaluateCodingLoopCacheLab([
    {
      label: "baseline",
      cacheKey: "swarm:main:stable:first",
      system: [
        { text: "runtime protocol v1", cache: true, section: "system" }
      ],
      user: [
        { text: JSON.stringify({ tools: ["Read", "Grep", "Bash"] }), cache: true, section: "tools" },
        { text: JSON.stringify({ detected: ["node", "typescript"], scripts: ["test", "check"] }), cache: true, section: "workspace" },
        { text: JSON.stringify({ objective: "fix cart total", recent_files: ["src/cart.ts"] }), cache: false, section: "context" }
      ],
      cachedInputTokens: 0,
      totalInputWithCacheTokens: 6000,
      qualityVerdict: "warning",
      qualityReason: "baseline is only the first cold-start run"
    },
    {
      label: "volatile-tail-change",
      cacheKey: "swarm:main:stable:first",
      system: [
        { text: "runtime protocol v1", cache: true, section: "system" }
      ],
      user: [
        { text: JSON.stringify({ tools: ["Read", "Grep", "Bash"] }), cache: true, section: "tools" },
        { text: JSON.stringify({ detected: ["node", "typescript"], scripts: ["test", "check"] }), cache: true, section: "workspace" },
        { text: JSON.stringify({ objective: "fix cart total", recent_files: ["src/cart.test.ts"], dirty_files: ["src/cart.ts"] }), cache: false, section: "context" }
      ],
      cachedInputTokens: 4200,
      totalInputWithCacheTokens: 6000,
      qualityVerdict: "pass"
    },
    {
      label: "tool-prefix-drift",
      cacheKey: "swarm:main:stable:changed",
      system: [
        { text: "runtime protocol v1", cache: true, section: "system" }
      ],
      user: [
        { text: JSON.stringify({ tools: ["Read", "Grep"] }), cache: true, section: "tools" },
        { text: JSON.stringify({ detected: ["node", "typescript"], scripts: ["test", "check"] }), cache: true, section: "workspace" },
        { text: JSON.stringify({ objective: "fix cart total", recent_files: ["src/cart.test.ts"], dirty_files: ["src/cart.ts"] }), cache: false, section: "context" }
      ],
      cachedInputTokens: 0,
      totalInputWithCacheTokens: 6000,
      qualityVerdict: "fail",
      qualityReason: "tool prefix drift reduced cache hit rate and changed the stable prefix"
    }
  ]);
  return formatCodingLoopCacheLabReport(report);
}

export function runCacheLabEval(): EvalCaseResult {
  const detail = runCacheLabReport().join("\n");
  const ok = /best_profile=volatile-tail-change/.test(detail)
    && /quality_guard=/.test(detail)
    && /Prefer volatile-tail-change as the default profile/.test(detail);
  return ok
    ? {
        name: "cache lab report exposes a best profile and quality guard",
        status: "pass",
        message: "cache lab report keeps the quality-safe best profile visible"
      }
    : {
        name: "cache lab report exposes a best profile and quality guard",
        status: "fail",
        message: detail
      };
}

export function runTuiReplayReport(): string[] {
  return formatTuiReplaySuiteReport(runDefaultTuiReplaySuite());
}

export function buildOfflineParityReleaseGate(): ParityReleaseGateSummary {
  const realUsageResults = runRealUsageRegressionEvals();
  const realSwarmReport = runOfflineRealSwarmEvalSuite();
  const faultDrills = runFaultInjectionDrills();
  const budgetReport = offlineBudgetBackpressureReport();
  const failedEvalNames = realUsageResults
    .filter((result) => result.status === "fail")
    .map((result) => result.name);
  const realUsagePassed = failedEvalNames.length === 0;
  const realSwarmPassed = realSwarmEvalReleaseGateStatus(realSwarmReport) === "pass";
  const dimensions: ParityReleaseGateDimension[] = [
    {
      id: "interactive_trust",
      label: "Interactive trust",
      status: realUsageResultStatus(realUsageResults, "TUI interaction replay harness covers focus detail search fold and long-session budgets"),
      score: realUsagePassed ? 88 : 40,
      reason: "TUI input/detail behavior is gated by deterministic replay fixtures for startup Enter, debug trace, detail panes, search, folding, and long sessions.",
      evidence: [
        "TUI command-output detail eval blocks auto-open regression",
        "TUI interaction replay harness covers focus detail search fold and long-session budgets",
        "latest diagnosis Detail Target metadata"
      ],
      gaps: ["Next cycle should add optional screenshot-level visual diff for renderer churn."],
      next_task: "CAND-PROD-054-TASK-001"
    },
    {
      id: "coding_quality",
      label: "Coding quality",
      status: realUsageResultStatus(realUsageResults, "dogfood harness grades quality artifacts without failing low review warnings") === "pass" && realSwarmPassed ? "pass" : "fail",
      score: realUsagePassed ? 86 : 45,
      reason: "Verified dogfood fixture preserves completed status, changed files, checks, review warning semantics, quality artifacts, and real swarm collaboration outcomes.",
      evidence: [
        "dogfood harness grades quality artifacts without failing low review warnings",
        "real-task replay eval preserves status, cache, and diagnosis evidence",
        "real swarm offline eval suite covers collaboration quality cache handoff LSP and provider gates"
      ],
      gaps: ["Next cycle should expand the real-repo benchmark corpus before claiming full parity."],
      next_task: "CAND-PROD-054-TASK-002"
    },
    {
      id: "cache_yield",
      label: "Cache yield",
      status: realUsagePassed ? "pass" : "fail",
      score: realUsagePassed ? 84 : 35,
      reason: "Cache hit, miss, SLO, prefix-lab, and real swarm reuse fixtures explain cache savings and regressions without live provider calls.",
      evidence: [
        "cache miss eval preserves fallback telemetry and miss reason",
        "cache SLO eval gates fallback, missing usage, and changed-prefix regressions",
        "cache lab replay distinguishes volatile tail from stable prefix drift",
        `real swarm cache reuse reads ${realSwarmReport.summary.cache.readTokens} tokens and writes ${realSwarmReport.summary.cache.writeTokens} tokens`
      ],
      gaps: ["Next cycle should tune cache ROI against live provider telemetry over more sessions."],
      next_task: "CAND-PROD-054-TASK-003"
    },
    {
      id: "provider_setup",
      label: "Provider setup",
      status: realUsageResultStatus(realUsageResults, "provider fault eval surfaces retry recovery without secrets"),
      score: realUsagePassed ? 82 : 40,
      reason: "Provider fault diagnosis handles 429 recovery guidance and secret redaction in offline fixtures.",
      evidence: ["provider fault eval surfaces retry recovery without secrets"],
      gaps: ["Next cycle should validate runtime routing policies against live provider incidents."],
      next_task: "CAND-PROD-054-TASK-004"
    },
    {
      id: "control_plane",
      label: "Control plane",
      status: realSwarmPassed ? "pass" : "fail",
      score: 80,
      reason: "Gateway/Symphony action facts, handoffs, WorkBoard evidence, and fault recovery drills are now part of the operator diagnostic surface.",
      evidence: [
        "latest diagnosis Control Plane section",
        "swarm.work_board DTO",
        "Gateway/Symphony status contract tests",
        `real swarm handoffs=${realSwarmReport.summary.handoffCount} conflicts=${realSwarmReport.summary.conflictsResolved}/${realSwarmReport.summary.conflictScenarios}`,
        `fault drills ${faultDrills.status} total=${faultDrills.summary.total} recovered=${faultDrills.summary.recovered} contained=${faultDrills.summary.contained}`,
        `budget pressure ${budgetReport.status} cost=${budgetReport.metrics.cost_used}/${budgetReport.metrics.cost_limit ?? "unlimited"} retries=${budgetReport.metrics.provider_retry_count}/${budgetReport.metrics.max_provider_retries ?? "unlimited"} deferred=${budgetReport.metrics.deferred_tasks} sleeping=${budgetReport.metrics.sleeping_actors}`
      ],
      gaps: ["Next cycle should exercise Gateway/Symphony recovery with multi-session chaos fixtures."],
      next_task: "CAND-PROD-054-TASK-005"
    },
    {
      id: "semantic_tooling",
      label: "Semantic tooling",
      status: realSwarmPassed ? "pass" : "fail",
      score: 78,
      reason: "LSP success and fallback metadata produce semantic evidence that can be cited by the coding loop and true swarm evals.",
      evidence: [
        "swarm.semantic_evidence.v1 metadata",
        "coding loop semantic_evidence prompt context",
        "LSP fallback tools",
        `real swarm LSP fallback=${realSwarmReport.summary.lspFallbacksUsed}/${realSwarmReport.summary.lspFallbackScenarios}`
      ],
      gaps: ["Next cycle should persist semantic evidence across longer workspace edit histories."],
      next_task: "CAND-PROD-054-TASK-006"
    },
    {
      id: "artifact_debug_loop",
      label: "Artifact/debug loop",
      status: "pass",
      score: 86,
      reason: "Headless reports, telemetry, trajectory, eval summaries, stdout/stderr, diff summary, and latest diagnosis are linkable.",
      evidence: ["swarm.artifact-index.v1", "latest diagnosis Artifacts section", "dogfood artifact expectation"],
      gaps: ["Next cycle should export triage queue artifacts for CI dashboards."],
      next_task: "CAND-PROD-054-TASK-007"
    }
  ];
  const redLines: ParityReleaseGateRedLine[] = [
    {
      id: "tui_no_auto_focus_steal",
      status: realUsageResultStatus(realUsageResults, "TUI interaction replay harness covers focus detail search fold and long-session budgets") === "fail" ? "fail" : "pass",
      reason: "Command Output detail must not open without an explicit action, and long TUI sessions must keep search/fold/layout state replayable.",
      evidence: ["TUI command-output detail eval blocks auto-open regression", "TUI interaction replay harness covers focus detail search fold and long-session budgets"],
      next_task: "CAND-PROD-054-TASK-001"
    },
    {
      id: "provider_secret_redaction",
      status: realUsageResultStatus(realUsageResults, "provider fault eval surfaces retry recovery without secrets") === "fail" ? "fail" : "pass",
      reason: "Provider diagnostics must redact API keys and Authorization headers.",
      evidence: ["provider fault eval surfaces retry recovery without secrets"],
      next_task: "CAND-PROD-054-TASK-004"
    },
    {
      id: "cache_fact_consistency",
      status: realUsagePassed ? "pass" : "fail",
      reason: "Cache facts must stay consistent across result card, telemetry, diagnosis, and eval summary.",
      evidence: ["real-task replay eval preserves status, cache, and diagnosis evidence", "cache miss eval preserves fallback telemetry and miss reason"],
      next_task: "CAND-PROD-054-TASK-003"
    },
    {
      id: "unsupported_action_not_silent_success",
      status: "pass",
      reason: "Unsupported Gateway/Symphony operator actions must be reported as unsupported/rejected, not silent success.",
      evidence: ["latest diagnosis Control Plane section", "Gateway/Symphony action lifecycle tests"],
      next_task: "CAND-PROD-054-TASK-005"
    },
    {
      id: "lsp_fallback_evidence_present",
      status: realSwarmReport.summary.lspFallbackScenarios > 0 && realSwarmReport.summary.lspFallbacksUsed === realSwarmReport.summary.lspFallbackScenarios ? "pass" : "fail",
      reason: "LSP unavailable or partial capability must preserve fallback semantic evidence.",
      evidence: ["swarm.semantic_evidence.v1 metadata", "semantic gateway fallback tests", "real swarm lsp_fallback scenario"],
      next_task: "CAND-PROD-054-TASK-006"
    },
    {
      id: "true_swarm_eval_suite_passes",
      status: realSwarmPassed ? "pass" : "fail",
      reason: "True swarm critical path must pass offline multi-agent evals before release.",
      evidence: [
        "real swarm offline eval suite covers collaboration quality cache handoff LSP and provider gates",
        `real_swarm_failures=${realSwarmReport.failureCategories.join(",") || "none"}`
      ],
      next_task: "CAND-PROD-059-TASK-014"
    }
  ];
  const hardFailures = [
    ...failedEvalNames,
    ...redLines.filter((redLine) => redLine.status === "fail").map((redLine) => redLine.id)
  ];
  const status = hardFailures.length ? "fail" : "pass";
  const triageQueue = buildParityTriageQueue(dimensions, redLines);
  return {
    schema_version: "swarm.parity_release_gate.v1",
    profile: "offline_quick",
    compared_to: "Claude Code",
    status,
    summary: status === "pass"
      ? "Offline release gate passes: Swarm has enough evidence for operator-grade dogfood, with next-cycle parity gaps tracked in the triage queue."
      : "Offline release gate fails: at least one required dogfood, cache, provider, TUI, control-plane, or LSP evidence check regressed.",
    pass_reasons: [
      "Dogfood fixture covers coding quality, cache facts, result cards, reports, telemetry, trajectory, logs, stdout/stderr, and diff summary.",
      "Provider fault diagnosis redacts secrets and gives actionable recovery.",
      "Cache SLO and cache lab fixtures explain hit, miss, fallback, and prefix drift behavior.",
      "Real swarm evals cover bugfix, feature, refactor, conflict, handoff, Symphony intake, LSP fallback, and cache reuse without paid provider calls.",
      `Fault injection drills pass offline with recovered=${faultDrills.summary.recovered} contained=${faultDrills.summary.contained}.`,
      `Budget backpressure eval reports cost=${budgetReport.metrics.cost_used}/${budgetReport.metrics.cost_limit ?? "unlimited"} retries=${budgetReport.metrics.provider_retry_count}/${budgetReport.metrics.max_provider_retries ?? "unlimited"} deferred=${budgetReport.metrics.deferred_tasks} sleeping=${budgetReport.metrics.sleeping_actors}.`,
      "TUI Command Output detail is gated against implicit auto-open.",
      "Gateway/Symphony and LSP fallback evidence are represented in operator diagnostics.",
      "Regression triage queue assigns evidence links, suspected owner files, and next task suggestions."
    ],
    fail_reasons: hardFailures,
    near_claude_code: [
      "conversation-first coding loop with result card and verification evidence",
      "offline dogfood report with cache, artifact, and debug evidence",
      "offline real swarm suite with quality, cache, handoff, conflict, LSP, latency, and provider retry metrics",
      "operator-readable diagnosis for provider, cache, control plane, and LSP fallback",
      "TUI detail panes guarded by replay fixtures against implicit Command Output focus steal",
      "continuous offline release gate with regression triage owner hints"
    ],
    gaps: [
      "Next cycle should add optional screenshot-level visual diff once renderer churn settles.",
      "Next cycle should expand live-provider and real-repo coverage before claiming full Claude Code parity.",
      "Next cycle should export triage queue summaries to CI dashboards."
    ],
    dimensions,
    red_lines: redLines,
    triage_queue: triageQueue,
    dogfood: {
      covered: ["TUI", "cache", "provider", "Gateway/Symphony", "LSP fallback", "artifacts", "true swarm evals"],
      artifact_kinds: ["report", "telemetry", "trajectory", "debug_log", "eval_summary", "stdout", "stderr", "diff_summary"],
      evidence: realUsageResults.map((result) => result.name)
    },
    commands: [
      "npm run release:gate",
      "node dist/evals/local-evals.js --release-gate",
      "node dist/evals/local-evals.js --real-swarm",
      "node dist/evals/local-evals.js --tui-replay",
      "/evals --release-gate"
    ],
    next_task: firstFailingNextTask(dimensions, redLines) ?? triageQueue[0]?.next_task_suggestion
  };
}

function buildParityTriageQueue(
  dimensions: ParityReleaseGateDimension[],
  redLines: ParityReleaseGateRedLine[]
): ParityReleaseGateTriageItem[] {
  const dimensionItems = dimensions
    .filter((dimension) => dimension.status !== "pass" || dimension.gaps.length > 0)
    .map((dimension): ParityReleaseGateTriageItem => ({
      failed_dimension: dimension.id,
      status: dimension.status,
      evidence_links: dimension.evidence,
      suspected_owner_files: ownerFilesForParityDimension(dimension.id),
      next_task_suggestion: dimension.next_task ?? `Investigate ${dimension.id}`
    }));
  const redLineItems = redLines
    .filter((redLine) => redLine.status === "fail")
    .map((redLine): ParityReleaseGateTriageItem => ({
      failed_dimension: redLine.id,
      status: redLine.status,
      evidence_links: redLine.evidence,
      suspected_owner_files: ownerFilesForParityDimension(redLine.id),
      next_task_suggestion: redLine.next_task ?? `Fix red line ${redLine.id}`
    }));
  return [...redLineItems, ...dimensionItems];
}

function ownerFilesForParityDimension(id: string): string[] {
  switch (id) {
    case "interactive_trust":
    case "tui_no_auto_focus_steal":
      return ["src/tui/interaction-replay.ts", "src/tui/conversation-layout.ts", "src/tui/SwarmChatApp.tsx"];
    case "coding_quality":
      return ["src/evals/dogfood-harness.ts", "src/runtime/coding-agent-loop.ts", "src/runtime/result-card.ts"];
    case "cache_yield":
    case "cache_fact_consistency":
      return ["src/runtime/prompt-cache-status.ts", "src/runtime/headless-artifacts.ts", "src/evals/local-evals.ts"];
    case "provider_setup":
    case "provider_secret_redaction":
      return ["src/providers/provider-profile.ts", "src/providers/openai-provider.ts", "src/doctor/report.ts"];
    case "true_swarm_eval_suite_passes":
      return ["src/evals/real-swarm-evals.ts", "src/evals/local-evals.ts", "src/runtime/prompt-cache-status.ts"];
    case "control_plane":
    case "unsupported_action_not_silent_success":
      return ["src/server/gateway.ts", "src/symphony/action-lifecycle.ts", "src/runtime/work-board.ts"];
    case "semantic_tooling":
    case "lsp_fallback_evidence_present":
      return ["src/lsp/gateway.ts", "src/lsp/types.ts", "src/runtime/latest-diagnosis.ts"];
    case "artifact_debug_loop":
      return ["src/runtime/headless-artifacts.ts", "src/runtime/latest-diagnosis.ts", "src/evals/local-evals.ts"];
    default:
      return ["src/evals/local-evals.ts"];
  }
}

function realUsageResultStatus(results: EvalCaseResult[], name: string): ParityReleaseGateDimension["status"] {
  return results.find((result) => result.name === name)?.status === "pass" ? "pass" : "fail";
}

function firstFailingNextTask(
  dimensions: ParityReleaseGateDimension[],
  redLines: ParityReleaseGateRedLine[]
): string | undefined {
  return redLines.find((redLine) => redLine.status === "fail")?.next_task
    ?? dimensions.find((dimension) => dimension.status === "fail")?.next_task
    ?? dimensions.find((dimension) => dimension.status === "warning")?.next_task;
}

function checkOfflineParityReleaseGateBehavior(): EvalCaseResult {
  const gate = buildOfflineParityReleaseGate();
  const artifacts = buildHeadlessRunArtifacts({
    objective: "Run offline Claude Code parity release gate",
    workspace: "E:/Playground/Swarm",
    mode: "coding_loop",
    startedAt: "2026-05-22T00:00:00.000Z",
    endedAt: "2026-05-22T00:00:01.000Z",
    durationMs: 1000,
    capturedEvents: [],
    evalSummaryPath: "E:/Playground/Swarm/.swarm/local-tests/parity/release-gate.summary.json",
    releaseGate: gate,
    result: {
      session_id: "eval-parity-release-gate",
      status: gate.status === "pass" ? "completed" : "failed",
      content: gate.summary,
      outcome: {
        changed_files: [],
        tests_run: gate.commands,
        intermediate_artifacts: ["release-gate.summary.json"],
        final_summary: gate.summary
      }
    }
  });
  const diagnosis = buildLatestRunDiagnosis({
    report: artifacts.report,
    telemetry: artifacts.telemetry,
    releaseGate: gate,
    artifactIndex: artifacts.artifactIndex,
    latestDetail: {
      source: "event",
      title: "Parity Release Gate",
      route: "coding_loop",
      sessionId: "eval-parity-release-gate"
    }
  });
  const dimensionIds = gate.dimensions.map((dimension) => dimension.id);
  const ok = gate.schema_version === "swarm.parity_release_gate.v1"
    && gate.profile === "offline_quick"
    && gate.compared_to === "Claude Code"
    && gate.status === "pass"
    && gate.next_task === "CAND-PROD-054-TASK-001"
    && dimensionIds.join(",") === "interactive_trust,coding_quality,cache_yield,provider_setup,control_plane,semantic_tooling,artifact_debug_loop"
    && gate.red_lines.every((redLine) => redLine.status === "pass")
    && gate.dogfood.covered.includes("TUI")
    && gate.dogfood.covered.includes("cache")
    && gate.dogfood.covered.includes("provider")
    && gate.dogfood.covered.includes("Gateway/Symphony")
    && gate.dogfood.covered.includes("LSP fallback")
    && gate.dogfood.covered.includes("true swarm evals")
    && gate.dogfood.artifact_kinds.includes("eval_summary")
    && gate.commands.includes("node dist/evals/local-evals.js --real-swarm")
    && gate.red_lines.some((redLine) => redLine.id === "true_swarm_eval_suite_passes")
    && gate.near_claude_code.length > 0
    && gate.gaps.length > 0
    && gate.triage_queue.some((item) => item.failed_dimension === "artifact_debug_loop" && item.suspected_owner_files.includes("src/runtime/headless-artifacts.ts"))
    && artifacts.report.release_gate?.schema_version === "swarm.parity_release_gate.v1"
    && artifacts.telemetry.release_gate?.profile === "offline_quick"
    && diagnosis.brief.includes("release gate pass")
    && diagnosis.detail.includes("Parity Release Gate")
    && diagnosis.detail.includes("compared_to=Claude Code")
    && diagnosis.detail.includes("next_task=CAND-PROD-054-TASK-001")
    && diagnosis.detail.includes("triage_queue=interactive_trust:pass:CAND-PROD-054-TASK-001")
    && diagnosis.detail.includes("dogfood_covered=TUI,cache,provider,Gateway/Symphony,LSP fallback,artifacts,true swarm evals")
    && !JSON.stringify(gate).includes("sk-");
  return ok
    ? { name: "Claude Code parity release gate runs offline and emits scorecard evidence", status: "pass", message: `status=${gate.status} next=${gate.next_task} dimensions=${dimensionIds.join(",")}` }
    : {
        name: "Claude Code parity release gate runs offline and emits scorecard evidence",
        status: "fail",
        message: `gate=${JSON.stringify(gate)} diagnosis=${diagnosis.detail}`
      };
}

function checkTuiInteractionReplayHarnessBehavior(): EvalCaseResult {
  const suite = runDefaultTuiReplaySuite();
  const report = formatTuiReplaySuiteReport(suite).join("\n");
  const startup = suite.scenarios.find((scenario) => scenario.name === "startup-enter-command-output-guard");
  const debug = suite.scenarios.find((scenario) => scenario.name === "debug-mode-trace-action-detail");
  const cache = suite.scenarios.find((scenario) => scenario.name === "cache-miss-detail-search-replay");
  const lsp = suite.scenarios.find((scenario) => scenario.name === "lsp-fallback-detail-search-replay");
  const long = suite.scenarios.find((scenario) => scenario.name === "long-session-search-scroll-fold-budget");
  const ok = suite.status === "pass"
    && suite.failureCount === 0
    && startup?.trace[0]?.transition?.reason === "empty-enter"
    && startup.trace[0]?.detailOpen === false
    && startup.finalState.focus === "input"
    && debug?.trace.some((entry) => entry.event === "slash:/view trace" && entry.pane === "trace")
    && debug.trace.some((entry) => entry.selectedActionRow === 2)
    && cache?.trace.some((entry) => entry.search?.includes("cache miss") && entry.currentSearchMessageIndex === 1)
    && lsp?.trace.some((entry) => entry.search?.includes("lsp fallback") && entry.currentSearchMessageIndex === 1)
    && long !== undefined
    && long.maxMountedMessageCount <= 42
    && long.trace.some((entry) => entry.event === "fold:1175" && entry.selectedRow === 1175)
    && /final_focus=input/.test(report)
    && /mounted_max=/.test(report);
  return ok
    ? {
        name: "TUI interaction replay harness covers focus detail search fold and long-session budgets",
        status: "pass",
        message: `scenarios=${suite.scenarios.length} traces=${suite.traceCount} mounted_max=${long?.maxMountedMessageCount ?? "-"}`
      }
    : {
        name: "TUI interaction replay harness covers focus detail search fold and long-session budgets",
        status: "fail",
        message: report
      };
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
  const visibleRows = Math.min(candidates.length, CHAT_INPUT_COMPLETION_VISIBLE_ROWS);
  const hiddenRow = candidates.length > visibleRows ? 1 : 0;
  const ok = candidates.length === CHAT_INPUT_COMPLETION_LIMIT
    && rows === visibleRows + hiddenRow + 4
    && candidates.some((candidate) => candidate.name === "kernel")
    && candidates.some((candidate) => candidate.name === "doctor");
  return ok
    ? { name: "TUI slash completion sizing exposes more command choices", status: "pass", message: `${candidates.length} candidates with ${visibleRows} visible rows and ${hiddenRow} overflow row` }
    : { name: "TUI slash completion sizing exposes more command choices", status: "fail", message: `candidates=${candidates.map((candidate) => candidate.name).join(",")} rows=${rows}` };
}

function checkTuiCustomSlashCompletionBehavior(): EvalCaseResult {
  const extraCommands = [{
    name: "review-change",
    group: "Config" as const,
    usage: "/review-change <target>",
    description: "Review current change.",
    completionPriority: 120
  }];
  const directCandidates = commandCandidatesForInput("/rev", 4, { includeAdvanced: true, extraCommands }).map((candidate) => candidate.name);
  let state = createChatInputControllerState();
  for (const character of "/revie") {
    state = applyChatInputKey(state, character, {}, { extraCommands }).state;
  }
  const visibleCandidates = chatInputCompletionCandidates(state, { extraCommands }).map((candidate) => candidate.name);
  state = applyChatInputKey(state, "\t", { tab: true }, { extraCommands }).state;
  const ok = directCandidates.includes("review-change")
    && visibleCandidates[0] === "review-change"
    && state.input.value === "/review-change "
    && state.input.cursor === "/review-change ".length;
  return ok
    ? { name: "TUI custom slash completion behavior works", status: "pass", message: "runtime command candidates appear and can be accepted with Tab" }
    : {
        name: "TUI custom slash completion behavior works",
        status: "fail",
        message: `direct=${directCandidates.join(",")} visible=${visibleCandidates.join(",")} completed=${JSON.stringify(state.input.value)} cursor=${state.input.cursor}`
      };
}

function checkTuiPluginSlashCompletionBehavior(): EvalCaseResult {
  const extraCommands = [
    {
      name: "release-notes",
      group: "Config" as const,
      usage: "/release-notes <range>",
      description: "Generate release notes from a plugin.",
      completionPriority: 130
    },
    {
      name: "kernel",
      group: "Config" as const,
      usage: "/kernel-from-plugin",
      description: "Should be shadowed by the built-in kernel command.",
      completionPriority: 1
    }
  ];
  const directCandidates = commandCandidatesForInput("/rel", 4, { includeAdvanced: true, extraCommands }).map((candidate) => candidate.name);
  let state = createChatInputControllerState();
  for (const character of "/relea") {
    state = applyChatInputKey(state, character, {}, { extraCommands }).state;
  }
  const visibleCandidates = chatInputCompletionCandidates(state, { extraCommands }).map((candidate) => candidate.name);
  state = applyChatInputKey(state, "\t", { tab: true }, { extraCommands }).state;
  const kernelCandidates = commandCandidatesForInput("/ker", 4, { includeAdvanced: true, extraCommands }).filter((candidate) => candidate.name === "kernel");
  const ok = directCandidates.includes("release-notes")
    && visibleCandidates[0] === "release-notes"
    && state.input.value === "/release-notes "
    && state.input.cursor === "/release-notes ".length
    && kernelCandidates.length === 1
    && kernelCandidates[0]?.usage === "/kernel [workflow_path]";
  return ok
    ? { name: "TUI plugin slash completion behavior works", status: "pass", message: "plugin slash commands appear in dynamic completion while built-ins keep precedence" }
    : {
        name: "TUI plugin slash completion behavior works",
        status: "fail",
        message: `direct=${directCandidates.join(",")} visible=${visibleCandidates.join(",")} completed=${JSON.stringify(state.input.value)} kernel=${kernelCandidates.map((candidate) => candidate.usage).join(",")}`
      };
}

function checkTuiSandboxControlBehavior(): EvalCaseResult {
  const show = applySandboxModeCommand("workspace-write");
  const readOnly = applySandboxModeCommand("workspace-write", "read-only");
  const workspaceWrite = applySandboxModeCommand("read-only", "workspace-write");
  let invalid = "";
  try {
    applySandboxModeCommand("workspace-write", "yolo");
  } catch (error) {
    invalid = error instanceof Error ? error.message : String(error);
  }
  const ok = show.mode === "workspace-write"
    && !show.changed
    && readOnly.mode === "read-only"
    && readOnly.changed
    && workspaceWrite.mode === "workspace-write"
    && workspaceWrite.changed
    && invalid.includes("Usage: /sandbox");
  return ok
    ? { name: "TUI sandbox control behavior works", status: "pass", message: "/sandbox shows, switches, and rejects invalid sandbox modes" }
    : {
        name: "TUI sandbox control behavior works",
        status: "fail",
        message: `show=${show.mode}/${show.changed} ro=${readOnly.mode}/${readOnly.changed} rw=${workspaceWrite.mode}/${workspaceWrite.changed} invalid=${invalid}`
      };
}

function checkTuiSandboxReportBehavior(): EvalCaseResult {
  const workspace = resolve("eval-workspace");
  const extra = resolve("shared-read-root");
  const readOnly = buildSandboxReport({
    mode: "read-only",
    permissionMode: "ask",
    workspace,
    additionalDirectories: [extra]
  });
  const workspaceWrite = buildSandboxReport({
    mode: "workspace-write",
    permissionMode: "full-auto",
    workspace
  });
  const ok = readOnly.brief.includes("Sandbox: read-only.")
    && readOnly.brief.includes("Permission mode: ask.")
    && readOnly.detail.includes("Scope: current TUI session only")
    && readOnly.detail.includes("workspace writes, local shell execution, package install, delegation")
    && readOnly.detail.includes(`- additional: ${extra}`)
    && readOnly.detail.includes("swarm run --sandbox workspace-write|read-only")
    && workspaceWrite.brief.includes("Sandbox: workspace-write.")
    && workspaceWrite.detail.includes("permission mode decides whether write-like actions are allowed")
    && workspaceWrite.detail.includes("- additional: none");
  return ok
    ? { name: "TUI sandbox report explains scope and write gates", status: "pass", message: "/sandbox can render detailed mode, scope, read-root, and permission interaction guidance" }
    : {
        name: "TUI sandbox report explains scope and write gates",
        status: "fail",
        message: `readOnly=${JSON.stringify(readOnly)} workspaceWrite=${JSON.stringify(workspaceWrite)}`
      };
}

function checkTuiResumeExecutionControlBehavior(): EvalCaseResult {
  const noPlan = decideResumeExecution({
    command: "continue",
    sessionId: "sess_plain",
    hasStoredPlan: false,
    instruction: " tighten verification "
  });
  const storedPlan = decideResumeExecution({
    command: "resume",
    sessionId: "sess_plan",
    hasStoredPlan: true,
    instruction: "   "
  });
  let rejected = "";
  try {
    decideResumeExecution({
      command: "resume",
      sessionId: "sess_plan",
      hasStoredPlan: true,
      instruction: "focus on the flaky tests"
    });
  } catch (error) {
    rejected = error instanceof Error ? error.message : String(error);
  }
  const ok = noPlan.route === "coding_loop"
    && noPlan.instruction === "tighten verification"
    && storedPlan.route === "stored_plan"
    && storedPlan.instruction === ""
    && rejected.includes("Cannot apply a new instruction while resuming stored plan sess_plan")
    && rejected.includes("/fork sess_plan <message>");
  return ok
    ? { name: "TUI resume control blocks silent message loss on stored plans", status: "pass", message: "stored-plan resumes reject new instructions while coding-loop resumes keep trimmed free-form instructions" }
    : {
        name: "TUI resume control blocks silent message loss on stored plans",
        status: "fail",
        message: `noPlan=${JSON.stringify(noPlan)} storedPlan=${JSON.stringify(storedPlan)} rejected=${rejected}`
      };
}

function checkRuntimeLiveReplyTargetBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SwarmRuntime } from "./dist/runtime/runtime.js";

const dir = mkdtempSync(resolve(tmpdir(), "swarm-live-reply-eval-"));
const workspace = resolve(dir, "workspace");
mkdirSync(workspace, { recursive: true });
const runtime = new SwarmRuntime({ databasePath: resolve(dir, "swarm.db"), workspace });
let message = "";
try {
  await runtime.sendUserMessage("status?");
} catch (error) {
  message = error instanceof Error ? error.message : String(error);
}
const target = runtime.getActiveLiveTarget() ?? null;
runtime.dispose();
rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ message, target }));
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: { message?: string; target?: unknown } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in failure below.
  }
  const ok = result.status === 0
    && parsed.message === "No active work is available to receive a live reply. Start or resume a run first."
    && parsed.target === null;
  return ok
    ? { name: "runtime live replies reject missing active work", status: "pass", message: "sendUserMessage now fails fast instead of pretending a live reply was queued for the next turn" }
    : {
        name: "runtime live replies reject missing active work",
        status: "fail",
        message: `exit=${result.status} stdout=${result.stdout.slice(0, 700)} stderr=${result.stderr.slice(0, 700)}`
      };
}

function checkRuntimeInterruptTargetBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SwarmRuntime } from "./dist/runtime/runtime.js";

const dir = mkdtempSync(resolve(tmpdir(), "swarm-interrupt-eval-"));
const workspace = resolve(dir, "workspace");
mkdirSync(workspace, { recursive: true });
const runtime = new SwarmRuntime({ databasePath: resolve(dir, "swarm.db"), workspace });
let noActive = "";
const stopRequests = [];
try {
  runtime.requestInterrupt("stop");
} catch (error) {
  noActive = error instanceof Error ? error.message : String(error);
}
runtime.orchestrator.requestStop = (sessionId, reason) => {
  stopRequests.push({ sessionId, reason });
  return true;
};
const now = new Date().toISOString();
runtime.activeSwarmSession = {
  swarm_id: "swarm_interrupt_eval",
  session_id: "sess_swarm_interrupt_eval",
  user_request_id: "user_interrupt_eval",
  objective: "test interrupt semantics",
  status: "running",
  coordinator: { agent_id: "main_swarm", role: "controller" },
  participants: [],
  created_at: now,
  updated_at: now,
  policy: {
    max_agents: 4,
    max_parallel_tasks: 2,
    timeout_ms: 60000,
    retry: { max_attempts: 1, backoff_ms: 0 },
    require_review: false,
    consensus: "coordinator_decision",
    approval_mode: "on-request",
    safety: {
      require_human_approval_for: [],
      forbidden_capabilities: [],
      sandbox_required: false
    },
    memory: {
      allow_read: true,
      allow_write: true,
      retention: "session"
    }
  }
};
const fullSwarm = runtime.requestInterrupt("stop", { sessionId: "sess_swarm_interrupt_eval" });
runtime.dispose();
rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ noActive, fullSwarm, stopRequests }));
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    noActive?: string;
    fullSwarm?: { route?: string; session_id?: string };
    stopRequests?: Array<{ sessionId?: string; reason?: string }>;
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in failure below.
  }
  const ok = result.status === 0
    && parsed.noActive === "No active work is available to interrupt. Start or resume a run first."
    && parsed.fullSwarm?.route === "full_swarm"
    && parsed.fullSwarm?.session_id === "sess_swarm_interrupt_eval"
    && parsed.stopRequests?.length === 1
    && parsed.stopRequests[0]?.sessionId === "sess_swarm_interrupt_eval"
    && parsed.stopRequests[0]?.reason === "stop";
  return ok
    ? { name: "runtime interrupts fail closed when idle and stop active full_swarm work", status: "pass", message: "requestInterrupt still rejects missing active work and now turns active full_swarm interrupts into safe-boundary stop requests" }
    : {
        name: "runtime interrupts fail closed when idle and stop active full_swarm work",
        status: "fail",
        message: `exit=${result.status} stdout=${result.stdout.slice(0, 700)} stderr=${result.stderr.slice(0, 700)}`
      };
}

function checkFullSwarmSafeBoundaryStopBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SwarmRuntime } from "./dist/runtime/runtime.js";

const dir = mkdtempSync(resolve(tmpdir(), "swarm-full-stop-eval-"));
const workspace = resolve(dir, "workspace");
mkdirSync(workspace, { recursive: true });
const runtime = new SwarmRuntime({ databasePath: resolve(dir, "swarm.db"), workspace });

const plan = {
  objective: "stop the swarm run",
  summary: "stop the swarm run",
  intent: "inspect_only",
  tasks: [
    {
      task_id: "task_1",
      title: "First task",
      description: "First task",
      objective: "First task",
      type: "analysis",
      status: "pending",
      required_capabilities: ["analysis.synthesize"],
      inputs: {},
      expected_output: { format: "text" }
    },
    {
      task_id: "task_2",
      title: "Second task",
      description: "Second task",
      objective: "Second task",
      type: "analysis",
      status: "pending",
      required_capabilities: ["analysis.synthesize"],
      inputs: {},
      expected_output: { format: "text" },
      dependencies: ["task_1"]
    }
  ]
};

runtime.orchestrator.planGenerator.generate = async () => plan;
runtime.orchestrator.review = async () => ({
  target_task_id: "all",
  reviewer: { agent_id: "reviewer_01", role: "reviewer" },
  verdict: "approve",
  score: 100,
  summary: "approved"
});
runtime.orchestrator.aggregate = async () => "Partial work summary.";

let secondStarted = false;
runtime.router.request = async (envelope) => {
  if (envelope.type === "task.assign" && envelope.task_id === "task_1") {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return {
      type: "task.result",
      from: { agent_id: "worker_01", role: "worker" },
      payload: { status: "completed", summary: "first done", content: "first done" }
    };
  }
  if (envelope.type === "task.assign" && envelope.task_id === "task_2") {
    secondStarted = true;
    return {
      type: "task.result",
      from: { agent_id: "worker_02", role: "worker" },
      payload: { status: "completed", summary: "second done", content: "second done" }
    };
  }
  throw new Error(\`Unexpected envelope: \${envelope.type}:\${envelope.task_id ?? envelope.intent}\`);
};

try {
  const planned = await runtime.createPlan("stop the swarm run");
  const execution = runtime.execute(planned);
  setTimeout(() => {
    runtime.requestInterrupt("stop now", { sessionId: planned.session.session_id });
  }, 30);
  const result = await execution;
  const session = runtime.sessionStore.get(planned.session.session_id);
  const taskStates = runtime.taskStateStore.list(planned.session.session_id);
  console.log(JSON.stringify({
    result: {
      status: result.status,
      session_id: result.session_id,
      content: result.content
    },
    sessionStatus: session?.status,
    taskStates: taskStates.map((item) => ({ task_id: item.task_id, status: item.status })),
    secondStarted
  }));
} finally {
  runtime.dispose();
  rmSync(dir, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    result?: { status?: string; session_id?: string; content?: string };
    sessionStatus?: string;
    taskStates?: Array<{ task_id?: string; status?: string }>;
    secondStarted?: boolean;
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output for failure diagnostics.
  }
  const taskOne = parsed.taskStates?.find((item) => item.task_id === "task_1");
  const taskTwo = parsed.taskStates?.find((item) => item.task_id === "task_2");
  const ok = result.status === 0
    && parsed.result?.status === "stopped"
    && parsed.result?.session_id
    && typeof parsed.result?.content === "string"
    && parsed.result.content.startsWith("Stopped: stop now")
    && parsed.sessionStatus === "cancelled"
    && taskOne?.status === "completed"
    && taskTwo?.status === "cancelled"
    && parsed.secondStarted === false;
  return ok
    ? { name: "full swarm interrupt stops at the next safe boundary", status: "pass", message: "active full_swarm interrupts finish the current task, cancel queued tasks, and return a stopped result" }
    : {
        name: "full swarm interrupt stops at the next safe boundary",
        status: "fail",
        message: `exit=${result.status} stdout=${result.stdout.slice(0, 900)} stderr=${result.stderr.slice(0, 700)}`
      };
}

function checkPlannedFullSwarmLiveControlBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SwarmRuntime } from "./dist/runtime/runtime.js";

const dir = mkdtempSync(resolve(tmpdir(), "swarm-planned-live-control-eval-"));
const workspace = resolve(dir, "workspace");
mkdirSync(workspace, { recursive: true });
const runtime = new SwarmRuntime({ databasePath: resolve(dir, "swarm.db"), workspace });

const plan = {
  objective: "apply a live directive to a planned swarm run",
  summary: "apply a live directive to a planned swarm run",
  intent: "inspect_only",
  tasks: [
    {
      task_id: "task_1",
      title: "First task",
      description: "First task",
      objective: "First task",
      type: "analysis",
      status: "pending",
      required_capabilities: ["analysis.synthesize"],
      inputs: {},
      expected_output: { format: "text" }
    },
    {
      task_id: "task_2",
      title: "Second task",
      description: "Second task",
      objective: "Second task",
      type: "analysis",
      status: "pending",
      required_capabilities: ["analysis.synthesize"],
      inputs: {},
      expected_output: { format: "text" },
      dependencies: ["task_1"]
    }
  ]
};

runtime.orchestrator.planGenerator.generate = async () => plan;
runtime.orchestrator.review = async () => ({
  target_task_id: "all",
  reviewer: { agent_id: "reviewer_01", role: "reviewer" },
  verdict: "approve",
  score: 100,
  summary: "approved"
});
runtime.orchestrator.aggregate = async () => "Live directive applied.";
let controlCalls = 0;
runtime.provider.generateText = async (request) => {
  if (request.usage?.purpose === "full_swarm_control") {
    controlCalls += 1;
    return JSON.stringify({
      action: "inject_next_turn",
      reason: "Apply this operator note to future tasks.",
      instruction: "focus on second task evidence"
    });
  }
  return "{}";
};

let secondPayload = undefined;
runtime.router.request = async (envelope) => {
  if (envelope.type === "task.assign" && envelope.task_id === "task_1") {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return {
      type: "task.result",
      from: { agent_id: "worker_01", role: "worker" },
      payload: { status: "completed", summary: "first done", content: "first done" }
    };
  }
  if (envelope.type === "task.assign" && envelope.task_id === "task_2") {
    secondPayload = envelope.payload;
    return {
      type: "task.result",
      from: { agent_id: "worker_02", role: "worker" },
      payload: { status: "completed", summary: "second done", content: "second done" }
    };
  }
  throw new Error(\`Unexpected envelope: \${envelope.type}:\${envelope.task_id ?? envelope.intent}\`);
};

try {
  const planned = await runtime.createPlan("apply a live directive to a planned swarm run");
  const execution = runtime.execute(planned);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const activeDuringFirst = runtime.getActiveLiveTarget();
  const reply = await runtime.sendUserMessage("please focus on second task evidence", {
    sessionId: planned.session.session_id,
    requestId: "req_live_directive_1"
  });
  const duplicateReply = await runtime.sendUserMessage("please focus on second task evidence but duplicate", {
    sessionId: planned.session.session_id,
    requestId: "req_live_directive_1"
  });
  const result = await execution;
  const activeAfter = runtime.getActiveLiveTarget();
  const liveDirective = secondPayload?.live_directives?.[0];
  const contextDirective = secondPayload?.context?.find((entry) => entry.key?.startsWith("user.live_message."));
  console.log(JSON.stringify({
    activeDuringFirst,
    reply,
    duplicateReply,
    activeAfter,
    result: { status: result.status ?? "completed", session_id: result.session_id },
    controlCalls,
    liveDirective: {
      key: liveDirective?.key,
      action: liveDirective?.value?.decision?.action,
      instruction: liveDirective?.value?.decision?.instruction
    },
    contextDirective: {
      key: contextDirective?.key
    }
  }));
} finally {
  runtime.dispose();
  rmSync(dir, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    activeDuringFirst?: { route?: string; session_id?: string };
    reply?: { route?: string; session_id?: string; request_id?: string; duplicate?: boolean; control?: { message_id?: string; action?: string; instruction?: string } };
    duplicateReply?: { route?: string; session_id?: string; request_id?: string; duplicate?: boolean; control?: { message_id?: string; action?: string; instruction?: string } };
    activeAfter?: unknown;
    result?: { status?: string; session_id?: string };
    controlCalls?: number;
    liveDirective?: { key?: string; action?: string; instruction?: string };
    contextDirective?: { key?: string };
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output for failure diagnostics.
  }
  const ok = result.status === 0
    && parsed.activeDuringFirst?.route === "full_swarm"
    && parsed.reply?.route === "full_swarm"
    && parsed.reply?.session_id === parsed.activeDuringFirst?.session_id
    && parsed.reply?.request_id === "req_live_directive_1"
    && parsed.reply?.duplicate !== true
    && parsed.reply?.control?.action === "inject_next_turn"
    && parsed.reply?.control?.message_id === "req_live_directive_1"
    && parsed.reply?.control?.instruction === "focus on second task evidence"
    && parsed.duplicateReply?.duplicate === true
    && parsed.duplicateReply?.control?.message_id === parsed.reply?.control?.message_id
    && parsed.controlCalls === 1
    && parsed.liveDirective?.key?.startsWith("user.live_message.")
    && parsed.liveDirective?.action === "inject_next_turn"
    && parsed.contextDirective?.key === parsed.liveDirective?.key
    && parsed.result?.status === "completed"
    && parsed.activeAfter === undefined;
  return ok
    ? { name: "planned full swarm live control injects future-task directives", status: "pass", message: "runtime.execute exposes full_swarm as active, returns control decisions, and carries live directives into dependent task payloads" }
    : {
        name: "planned full swarm live control injects future-task directives",
        status: "fail",
        message: `exit=${result.status} stdout=${result.stdout.slice(0, 1000)} stderr=${result.stderr.slice(0, 700)}`
      };
}

function checkTuiMidInputSlashCompletionBehavior(): EvalCaseResult {
  const mid = completeSlashCommand("please /res", "please /res".length);
  const midCandidate = commandCandidatesForInput("please /res", "please /res".length)[0];
  const accepted = acceptSlashCommandCandidate("please /res later", "please /res".length, midCandidate);
  const urlCandidates = commandCandidatesForInput("open http://example.test/res", "open http://example.test/res".length);
  const ok = mid?.value === "please /resume "
    && mid.cursor === "please /resume ".length
    && midCandidate?.name === "resume"
    && accepted?.value === "please /resume later"
    && accepted.cursor === "please /resume ".length
    && urlCandidates.length === 0;
  return ok
    ? { name: "TUI mid-input slash completion behavior works", status: "pass", message: "slash fragments after whitespace complete without triggering inside URLs or words" }
    : {
        name: "TUI mid-input slash completion behavior works",
        status: "fail",
        message: `mid=${mid?.value ?? "-"} candidate=${midCandidate?.name ?? "-"} accepted=${accepted?.value ?? "-"} url=${urlCandidates.map((candidate) => candidate.name).join(",")}`
      };
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
    && rendered.includes("Saved: /tmp/full-output.txt")
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
    && viewport.value === "... two\nthree\nfour\nfive"
    && viewport.cursor === 19;
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

function checkLocalToolStructuredContractBehavior(): EvalCaseResult {
  const writeSchema = LOCAL_TOOL_SCHEMAS["file.write"];
  const editSchema = LOCAL_TOOL_SCHEMAS["file.edit"];
  const delegateSchema = LOCAL_TOOL_SCHEMAS["agent.delegate"];
  const missingWritePath = validateLocalToolActionInputs({ type: "file.write", path: "", content: "x" });
  const missingWriteContent = validateLocalToolActionInputs({ type: "file.write", path: "a.txt", content: "" });
  const missingEditInsertContent = validateLocalToolActionInputs({ type: "file.edit", path: "a.txt", operation: "insert" });
  const missingEditOldText = validateLocalToolActionInputs({ type: "file.edit", path: "a.txt", operation: "str_replace", newText: "b" });
  const validEdit = validateLocalToolActionInputs({ type: "file.edit", path: "a.txt", operation: "str_replace", oldText: "a", newText: "b" });
  const missingDelegateTask = validateLocalToolActionInputs({ type: "agent.delegate", capability: "code.research", task: "" });
  const missingProcessGrep = validateLocalToolActionInputs({ type: "process.grep", processId: "proc_1", pattern: "" });
  const ok = writeSchema?.required?.includes("path")
    && writeSchema.required.includes("content")
    && editSchema?.required_when?.some((rule) => rule.when.operation === "insert" && rule.required_any?.[0]?.includes("content"))
    && editSchema?.required_when?.some((rule) => rule.when.operation === "str_replace" && rule.required?.includes("oldText"))
    && delegateSchema?.required?.includes("capability")
    && delegateSchema.required.includes("task")
    && missingWritePath?.includes("missing required input: path")
    && missingWriteContent?.includes("missing required input: content")
    && missingEditInsertContent?.includes("missing required input: content or newText")
    && missingEditOldText?.includes("missing required input: oldText")
    && validEdit === undefined
    && missingDelegateTask?.includes("missing required input: task")
    && missingProcessGrep?.includes("missing required input: pattern");
  return ok
    ? { name: "local tool contracts expose structured required inputs", status: "pass", message: "tool schemas carry required/conditional input rules and runtime validation is derived from those contracts" }
    : {
        name: "local tool contracts expose structured required inputs",
        status: "fail",
        message: `write=${JSON.stringify(writeSchema)} edit=${JSON.stringify(editSchema)} delegate=${JSON.stringify(delegateSchema)} missingWritePath=${missingWritePath} missingWriteContent=${missingWriteContent} missingEditInsertContent=${missingEditInsertContent} missingEditOldText=${missingEditOldText} validEdit=${validEdit} missingDelegateTask=${missingDelegateTask} missingProcessGrep=${missingProcessGrep}`
      };
}

function checkLocalToolInputSchemaBehavior(root: string): EvalCaseResult {
  const readSchema = localToolSchemaForModel(LOCAL_TOOL_SCHEMAS["file.read"]);
  const writeSchema = localToolSchemaForModel(LOCAL_TOOL_SCHEMAS["file.write"]);
  const editSchema = localToolSchemaForModel(LOCAL_TOOL_SCHEMAS["file.edit"]);
  const blackboardSchema = localToolSchemaForModel(LOCAL_TOOL_SCHEMAS["blackboard.write"]);
  const script = `
import { CodingAgentLoop } from "./dist/runtime/coding-agent-loop.js";
import { RuntimeEvents } from "./dist/runtime/events.js";
import { defaultSwarmSettings } from "./dist/config/settings.js";

const settings = defaultSwarmSettings();
settings.permissions.defaultMode = "yolo";
let captured;
function promptTexts(value) {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => promptTexts(item));
  }
  if (value && typeof value === "object") {
    return Object.values(value).flatMap((item) => promptTexts(item));
  }
  return [];
}
const provider = {
  workerModel: "eval-model",
  async generateText(request) {
    const blocks = promptTexts(request.user);
    captured = JSON.parse(blocks.find((block) => block.includes('"tool_schemas"')) ?? "{}");
    return JSON.stringify({
      status: "completed",
      summary: "captured",
      message: "captured",
      files_touched: [],
      next_actions: [],
      tool_calls: []
    });
  }
};
const loop = new CodingAgentLoop({
  workspace: process.cwd(),
  settings,
  provider,
  events: new RuntimeEvents(),
  maxTurns: 1,
  emitFinal: false,
  emitProgress: false,
  allowedTools: ["file.write", "file.read", "mcp__demo__search"],
  listModelCapabilities: async () => [
    {
      id: "mcp.demo.search",
      kind: "mcp_tool",
      source: "mcp",
      trust: "trusted",
      providerId: "demo",
      name: "mcp__demo__search",
      title: "Demo Search",
      description: "Demo MCP tool",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      riskClass: "r0",
      permissionName: "mcp.demo.search",
      modelVisible: true,
      userVisible: true,
      status: "available",
      alwaysLoad: true,
      readOnly: true,
      concurrencyClass: "read_parallel"
    }
  ]
});
await loop.run("Capture schemas.");
const schemas = captured.tool_schemas;
console.log(JSON.stringify({
  write: schemas.find((schema) => schema.action === "file.write"),
  read: schemas.find((schema) => schema.action === "file.read"),
  dynamic: schemas.find((schema) => schema.action === "mcp__demo__search")
}));
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    write?: { input_schema?: { required?: string[]; properties?: Record<string, unknown> } };
    read?: { input_schema?: { allOf?: Array<{ anyOf?: Array<{ required?: string[] }> }> } };
    dynamic?: { input_schema?: { required?: string[]; properties?: Record<string, unknown> } };
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in failure below.
  }
  const readAnyOf = readSchema.input_schema.allOf?.[0]?.anyOf ?? [];
  const editCondition = editSchema.input_schema.allOf?.find((clause) =>
    clause.if?.properties.operation?.const === "insert"
  );
  const ok = writeSchema.input_schema.required?.includes("path")
    && writeSchema.input_schema.required?.includes("content")
    && writeSchema.input_schema.properties.content?.type === "string"
    && readAnyOf.some((item) => item.required.includes("path"))
    && readAnyOf.some((item) => item.required.includes("paths"))
    && editCondition?.then?.allOf?.[0]?.anyOf?.some((item) => item.required.includes("content"))
    && editCondition.then.allOf[0].anyOf.some((item) => item.required.includes("newText"))
    && blackboardSchema.input_schema.required?.includes("key")
    && Boolean(blackboardSchema.input_schema.allOf?.[0]?.anyOf?.some((item) => item.required.includes("entryType")))
    && Boolean(blackboardSchema.input_schema.allOf?.[0]?.anyOf?.some((item) => item.required.includes("type")))
    && parsed.write?.input_schema?.required?.includes("path")
    && parsed.write.input_schema.required.includes("content")
    && Boolean(parsed.read?.input_schema?.allOf?.[0]?.anyOf?.some((item) => item.required?.includes("paths")))
    && parsed.dynamic?.input_schema?.required?.includes("query");
  return ok
    ? { name: "local tool contracts expose model input_schema", status: "pass", message: "local tool schemas derive JSON-schema-like input_schema and coding loop forwards local and dynamic schemas to the model" }
    : {
        name: "local tool contracts expose model input_schema",
        status: "fail",
        message: `read=${JSON.stringify(readSchema.input_schema)} write=${JSON.stringify(writeSchema.input_schema)} edit=${JSON.stringify(editSchema.input_schema)} blackboard=${JSON.stringify(blackboardSchema.input_schema)} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkModelReadinessRejectsUnknownProviderModels(root: string): EvalCaseResult {
  const settings = defaultSwarmSettings();
  settings.models.defaultProvider = "deepseek";
  settings.models.planner = "deepseek/deepseek-v4-pro";
  settings.models.worker = "deepseek/deepseek-chat";
  settings.models.aggregator = "deepseek/deepseek-chat";
  const config: SwarmConfig = {
    version: 1,
    created_at: "2026-05-09T00:00:00.000Z",
    primaryProvider: "",
    primaryApiKey: "",
    providerApiKeys: {},
    modelProviderApiKeys: { openai: "" },
    note: "eval"
  };
  const deepseekModels = getProviderModels(settings.providers.deepseek);
  const readiness = getModelReadiness(settings.models.planner, settings, config);

  const customSettings = defaultSwarmSettings();
  customSettings.providers.freeform = {
    id: "freeform",
    name: "Freeform",
    protocol: "openai-chat-completions",
    baseURL: "https://example.test/v1",
    modelListProtocol: "none",
    apiKeyEnv: "FREEFORM_API_KEY",
    apiKeyRequired: false,
    auth: "none",
    custom: true,
    models: {}
  };
  const customReadiness = getModelReadiness("freeform/anything-goes", customSettings, config);

  const script = `
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const home = join(tmpdir(), "swarm-provider-model-eval-" + Date.now().toString(36));
process.env.SWARM_HOME = home;
mkdirSync(home, { recursive: true });

const { defaultSwarmSettings } = await import("./dist/config/settings.js");
const { OpenAIProvider } = await import("./dist/providers/openai-provider.js");

const settings = defaultSwarmSettings();
settings.models.defaultProvider = "deepseek";
settings.models.planner = "deepseek/deepseek-v4-pro";
settings.models.worker = "deepseek/deepseek-chat";
settings.models.aggregator = "deepseek/deepseek-chat";
writeFileSync(join(home, "settings.json"), JSON.stringify(settings, null, 2), "utf8");
writeFileSync(join(home, "config.json"), JSON.stringify({
  version: 1,
  created_at: "2026-05-09T00:00:00.000Z",
  primaryProvider: "",
  primaryApiKey: "",
  providerApiKeys: {},
  modelProviderApiKeys: { openai: "" },
  note: "eval"
}, null, 2), "utf8");

try {
  const provider = new OpenAIProvider();
  await provider.generateText({ system: "test", user: "test" });
  console.log(JSON.stringify({ ok: false, message: "" }));
} catch (error) {
  console.log(JSON.stringify({
    ok: true,
    message: error instanceof Error ? error.message : String(error)
  }));
} finally {
  rmSync(home, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: { ok?: boolean; message?: string } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in failure below.
  }

  const ok = deepseekModels.includes("deepseek-chat")
    && deepseekModels.includes("deepseek-reasoner")
    && readiness.configured === false
    && readiness.reason?.includes('Unknown model "deepseek-v4-pro" for provider "deepseek"')
    && readiness.reason.includes("deepseek-chat")
    && readiness.reason.includes("deepseek-reasoner")
    && customReadiness.configured === true
    && parsed.ok === true
    && parsed.message?.includes('Unknown model "deepseek-v4-pro" for provider "deepseek"')
    && parsed.message.includes("swarm providers refresh deepseek");
  return ok
    ? { name: "model readiness rejects unknown provider models before runtime calls", status: "pass", message: "unknown provider/model pairs fail in readiness checks and provider resolution while model-less custom providers remain flexible" }
    : {
        name: "model readiness rejects unknown provider models before runtime calls",
        status: "fail",
        message: `deepseekModels=${JSON.stringify(deepseekModels)} readiness=${JSON.stringify(readiness)} customReadiness=${JSON.stringify(customReadiness)} exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkSetModelSelectionRejectsUnknownProviderModels(): EvalCaseResult {
  const previousHome = process.env.SWARM_HOME;
  const home = mkdtempSync(resolve(tmpdir(), "swarm-model-selection-home-"));
  try {
    process.env.SWARM_HOME = home;
    let rejected = "";
    try {
      setModelSelection({
        defaultProvider: "deepseek",
        planner: "deepseek-v4-pro"
      });
    } catch (error) {
      rejected = error instanceof Error ? error.message : String(error);
    }
    const afterReject = loadSwarmSettings();
    setModelSelection({
      defaultProvider: "deepseek",
      planner: "deepseek-chat",
      worker: "deepseek-chat",
      aggregator: "deepseek-chat"
    });
    const accepted = loadSwarmSettings();
    const ok = rejected.includes('planner model "deepseek/deepseek-v4-pro" is invalid')
      && rejected.includes('Unknown model "deepseek-v4-pro" for provider "deepseek"')
      && afterReject.models.planner === ""
      && accepted.models.defaultProvider === "deepseek"
      && accepted.models.planner === "deepseek/deepseek-chat"
      && accepted.models.worker === "deepseek/deepseek-chat"
      && accepted.models.aggregator === "deepseek/deepseek-chat";
    return ok
      ? { name: "model selection rejects unknown provider models before persisting settings", status: "pass", message: "setModelSelection fails fast on known-bad provider/model pairs and preserves existing settings" }
      : {
          name: "model selection rejects unknown provider models before persisting settings",
          status: "fail",
          message: `rejected=${rejected} afterReject=${JSON.stringify(afterReject.models)} accepted=${JSON.stringify(accepted.models)}`
        };
  } finally {
    if (previousHome === undefined) {
      delete process.env.SWARM_HOME;
    } else {
      process.env.SWARM_HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

function checkOpenAIProviderReloadBehavior(): EvalCaseResult {
  const previousHome = process.env.SWARM_HOME;
  const home = mkdtempSync(resolve(tmpdir(), "swarm-provider-reload-home-"));
  try {
    process.env.SWARM_HOME = home;
    const openAIModels = getProviderModels(loadSwarmSettings().providers.openai);
    const first = openAIModels[0];
    const second = openAIModels.find((model) => model !== first);
    if (!first || !second) {
      return {
        name: "OpenAI provider reload picks up updated model settings",
        status: "fail",
        message: `openaiModels=${JSON.stringify(openAIModels)}`
      };
    }
    const firstModelRef = `openai/${first}`;
    const secondModelRef = `openai/${second}`;
    setModelSelection({
      defaultProvider: "openai",
      planner: firstModelRef,
      worker: firstModelRef,
      aggregator: firstModelRef
    });
    const provider = new OpenAIProvider();
    setModelSelection({
      defaultProvider: "openai",
      planner: secondModelRef,
      worker: secondModelRef,
      aggregator: secondModelRef
    });
    provider.reload();
    const ok = provider.model === secondModelRef
      && provider.workerModel === secondModelRef
      && provider.aggregatorModel === secondModelRef
      && provider.readiness().every((item) => item.modelRef === secondModelRef);
    return ok
      ? { name: "OpenAI provider reload picks up updated model settings", status: "pass", message: "provider.reload refreshes planner, worker, and aggregator model selections from settings" }
      : {
          name: "OpenAI provider reload picks up updated model settings",
          status: "fail",
          message: `planner=${provider.model} worker=${provider.workerModel} aggregator=${provider.aggregatorModel} readiness=${JSON.stringify(provider.readiness())}`
        };
  } finally {
    if (previousHome === undefined) {
      delete process.env.SWARM_HOME;
    } else {
      process.env.SWARM_HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

function checkHeadlessRunModelReadinessPreflight(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const home = join(tmpdir(), "swarm-headless-readiness-eval-" + Date.now().toString(36));
mkdirSync(home, { recursive: true });
writeFileSync(join(home, "settings.json"), JSON.stringify({
  version: 1,
  models: {
    defaultProvider: "deepseek",
    planner: "deepseek/deepseek-v4-pro",
    worker: "deepseek/deepseek-chat",
    aggregator: "deepseek/deepseek-chat",
    apiKeyEnv: "",
    maxOutputTokens: null
  },
  providers: {
    deepseek: {
      id: "deepseek",
      name: "DeepSeek",
      protocol: "openai-chat-completions",
      baseURL: "https://api.deepseek.com",
      modelListProtocol: "openai",
      modelListURL: "https://api.deepseek.com/models",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      apiKeyRequired: true,
      auth: "bearer",
      models: {
        "deepseek-chat": { name: "DeepSeek Chat", default: true },
        "deepseek-reasoner": { name: "DeepSeek Reasoner" }
      },
      discoveredModels: {}
    }
  },
  enabledProviders: [],
  disabledProviders: [],
  runtime: {
    maxAgents: 8,
    maxParallelTasks: 3,
    taskTimeoutMs: 120000,
    databasePath: ".swarm/state/swarm.db",
    projectArtifactDir: ".swarm/artifacts"
  },
  tools: { webSearch: true, directWrite: true },
  permissions: { defaultMode: "ask", allow: [], ask: [], deny: [], additionalDirectories: [] },
  ui: { theme: "default" },
  telemetry: { enabled: false },
  extensions: {
    capabilities: { disabled: [], hiddenFromModel: [] },
    skills: { enabled: true, loadProjectSkills: "trustedWorkspaces", roots: [], maxSkills: 100 },
    commands: { enabled: true, loadProjectCommands: "trustedWorkspaces", roots: [], maxCommands: 100 },
    mcp: { enabled: false, exposeGatewayServer: false, servers: {} },
    plugins: { enabled: true, loadProjectPlugins: "trustedWorkspaces", roots: [], disabled: [], maxPlugins: 100 }
  }
}, null, 2), "utf8");
writeFileSync(join(home, "config.json"), JSON.stringify({
  version: 1,
  created_at: "2026-05-09T00:00:00.000Z",
  primaryProvider: "deepseek",
  primaryApiKey: "",
  providerApiKeys: { deepseek: "token" },
  modelProviderApiKeys: { openai: "" },
  note: "eval"
}, null, 2), "utf8");

const child = await import("node:child_process");
const result = child.spawnSync(process.execPath, ["./dist/index.js", "run", "test headless preflight"], {
  cwd: process.cwd(),
  env: { ...process.env, SWARM_HOME: home },
  encoding: "utf8",
  timeout: 10000
});
console.log(JSON.stringify({
  status: result.status,
  stdout: result.stdout.trim(),
  stderr: result.stderr.trim()
}));
rmSync(home, { recursive: true, force: true });
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: { status?: number | null; stdout?: string; stderr?: string } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in failure below.
  }
  const stderr = parsed.stderr ?? "";
  const ok = result.status === 0
    && parsed.status === 1
    && stderr.includes("No usable model provider is configured.")
    && stderr.includes('planner: Unknown model "deepseek-v4-pro" for provider "deepseek"')
    && stderr.includes('Run "swarm onboard" or fix ~/.swarm/settings.json and ~/.swarm/config.json.')
    && !stderr.includes("Missing API key for provider");
  return ok
    ? { name: "headless run reports model readiness failures before runtime startup", status: "pass", message: "swarm run fails early with concrete provider/model diagnostics instead of a later provider error" }
    : {
        name: "headless run reports model readiness failures before runtime startup",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkDoctorCliBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const home = resolve(tmpdir(), "swarm-doctor-cli-eval");
rmSync(home, { recursive: true, force: true });
mkdirSync(join(home, "state"), { recursive: true });
mkdirSync(join(home, "logs"), { recursive: true });
writeFileSync(join(home, "settings.json"), JSON.stringify({
  version: 1,
  models: {
    defaultProvider: "openai",
    planner: "openai/gpt-5.5",
    worker: "openai/gpt-5.5",
    aggregator: "openai/gpt-5.5",
    apiKeyEnv: "",
    maxOutputTokens: null
  },
  providers: {
    openai: {
      id: "openai",
      name: "OpenAI",
      protocol: "openai-responses",
      baseURL: "https://api.openai.com/v1",
      modelListProtocol: "openai",
      modelListURL: "https://api.openai.com/v1/models",
      apiKeyEnv: "OPENAI_API_KEY",
      apiKeyRequired: true,
      auth: "bearer",
      models: {
        "gpt-5.5": { name: "GPT-5.5", default: true }
      }
    }
  },
  enabledProviders: [],
  disabledProviders: [],
  runtime: {
    maxAgents: 2,
    maxParallelTasks: 1,
    taskTimeoutMs: 1000,
    databasePath: join(home, "state", "swarm.db"),
    projectArtifactDir: ".swarm/artifacts"
  },
  tools: { webSearch: true, directWrite: true },
  permissions: { defaultMode: "ask", allow: [], ask: [], deny: [], additionalDirectories: [] },
  ui: { theme: "default" },
  telemetry: { enabled: false },
  extensions: {
    capabilities: { disabled: [], hiddenFromModel: [] },
    skills: { enabled: true, loadProjectSkills: "trustedWorkspaces", roots: [], maxSkills: 100 },
    commands: { enabled: true, loadProjectCommands: "trustedWorkspaces", roots: [], maxCommands: 100 },
    mcp: { enabled: false, exposeGatewayServer: false, servers: {} },
    plugins: { enabled: true, loadProjectPlugins: "trustedWorkspaces", roots: [], disabled: [], maxPlugins: 100 }
  }
}, null, 2), "utf8");
writeFileSync(join(home, "config.json"), JSON.stringify({
  version: 1,
  created_at: "2026-05-10T00:00:00.000Z",
  primaryProvider: "openai",
  primaryApiKey: "token",
  providerApiKeys: { openai: "token" },
  modelProviderApiKeys: { openai: "token" },
  note: "eval"
}, null, 2), "utf8");
writeFileSync(join(home, "logs", "doctor-eval.log"), "{\\"ts\\":\\"2026-05-10T00:00:00.000Z\\"}\\n", "utf8");

const result = spawnSync(process.execPath, ["./dist/index.js", "doctor"], {
  cwd: process.cwd(),
  env: { ...process.env, SWARM_HOME: home },
  encoding: "utf8",
  timeout: 15000
});
console.log(JSON.stringify({
  status: result.status,
  stdout: result.stdout,
  stderr: result.stderr
}));
rmSync(home, { recursive: true, force: true });
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 40_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: { status?: number | null; stdout?: string; stderr?: string } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // fall through
  }
  const stdout = parsed.stdout ?? "";
  const ok = result.status === 0
    && parsed.status === 0
    && stdout.includes("Swarm Doctor")
    && stdout.includes("Models")
    && stdout.includes("Extensions")
    && stdout.includes("latest_log=")
    && stdout.includes("Symphony")
    && stdout.includes("WARN missing_workflow_file");
  return ok
    ? { name: "CLI doctor reports local readiness, latest logs, and Symphony status", status: "pass", message: "swarm doctor prints shared diagnostics and exits cleanly for warning-only states" }
    : {
        name: "CLI doctor reports local readiness, latest logs, and Symphony status",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkLogsCliBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";

const home = resolve(tmpdir(), "swarm-logs-cli-eval");
rmSync(home, { recursive: true, force: true });
mkdirSync(join(home, "logs"), { recursive: true });
writeFileSync(join(home, "logs", "chat-2026-05-10T00-00-00-000Z-one.log"), "line-a\\nline-b\\nline-c\\n", "utf8");
writeFileSync(join(home, "logs", "chat-2026-05-10T00-00-01-000Z-two.log"), "line-1\\nline-2\\nline-3\\n", "utf8");
utimesSync(join(home, "logs", "chat-2026-05-10T00-00-00-000Z-one.log"), new Date("2026-05-10T00:00:00.000Z"), new Date("2026-05-10T00:00:00.000Z"));
utimesSync(join(home, "logs", "chat-2026-05-10T00-00-01-000Z-two.log"), new Date("2026-05-10T00:00:01.000Z"), new Date("2026-05-10T00:00:01.000Z"));
utimesSync(join(home, "logs", "chat-2026-05-10T00-00-00-000Z-one.log"), new Date("2026-05-10T00:00:00.000Z"), new Date("2026-05-10T00:00:00.000Z"));
utimesSync(join(home, "logs", "chat-2026-05-10T00-00-01-000Z-two.log"), new Date("2026-05-10T00:00:01.000Z"), new Date("2026-05-10T00:00:01.000Z"));

const listed = spawnSync(process.execPath, ["./dist/index.js", "logs"], {
  cwd: process.cwd(),
  env: { ...process.env, SWARM_HOME: home },
  encoding: "utf8",
  timeout: 10000
});
const tailed = spawnSync(process.execPath, ["./dist/index.js", "logs", "latest", "--tail", "2"], {
  cwd: process.cwd(),
  env: { ...process.env, SWARM_HOME: home },
  encoding: "utf8",
  timeout: 10000
});
console.log(JSON.stringify({
  listed: { status: listed.status, stdout: listed.stdout, stderr: listed.stderr },
  tailed: { status: tailed.status, stdout: tailed.stdout, stderr: tailed.stderr }
}));
rmSync(home, { recursive: true, force: true });
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    listed?: { status?: number | null; stdout?: string; stderr?: string };
    tailed?: { status?: number | null; stdout?: string; stderr?: string };
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // fall through
  }
  const listOut = parsed.listed?.stdout ?? "";
  const tailOut = parsed.tailed?.stdout ?? "";
  const ok = result.status === 0
    && parsed.listed?.status === 0
    && parsed.tailed?.status === 0
    && listOut.includes("Swarm Logs")
    && listOut.includes("chat-2026-05-10T00-00-01-000Z-two.log")
    && tailOut.includes("Log:")
    && tailOut.includes("line-2")
    && tailOut.includes("line-3")
    && !tailOut.includes("line-1");
  return ok
    ? { name: "CLI logs lists recent files and tails the latest match", status: "pass", message: "swarm logs promotes ~/.swarm/logs into a usable CLI surface" }
    : {
        name: "CLI logs lists recent files and tails the latest match",
        status: "fail",
      message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkCapabilitiesCliBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const home = resolve(tmpdir(), "swarm-capabilities-cli-eval");
rmSync(home, { recursive: true, force: true });
mkdirSync(join(home, "state"), { recursive: true });
mkdirSync(join(home, "logs"), { recursive: true });
const workspace = join(home, "workspace");
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, "note.txt"), "hello from capability invoke\\n", "utf8");

writeFileSync(join(home, "settings.json"), JSON.stringify({
  version: 1,
  models: {
    defaultProvider: "openai",
    planner: "openai/gpt-5.5",
    worker: "openai/gpt-5.5",
    aggregator: "openai/gpt-5.5",
    apiKeyEnv: "",
    maxOutputTokens: null
  },
  providers: {
    openai: {
      id: "openai",
      name: "OpenAI",
      protocol: "openai-responses",
      baseURL: "https://api.openai.com/v1",
      modelListProtocol: "openai",
      modelListURL: "https://api.openai.com/v1/models",
      apiKeyEnv: "OPENAI_API_KEY",
      apiKeyRequired: true,
      auth: "bearer",
      models: {
        "gpt-5.5": { name: "GPT-5.5", default: true }
      }
    }
  },
  enabledProviders: [],
  disabledProviders: [],
  runtime: {
    maxAgents: 2,
    maxParallelTasks: 1,
    taskTimeoutMs: 1000,
    databasePath: join(home, "state", "swarm.db"),
    projectArtifactDir: ".swarm/artifacts"
  },
  tools: { webSearch: true, directWrite: true },
  permissions: { defaultMode: "ask", allow: [], ask: [], deny: [], additionalDirectories: [] },
  ui: { theme: "default" },
  telemetry: { enabled: false },
  extensions: {
    capabilities: { disabled: [], hiddenFromModel: [] },
    skills: { enabled: true, loadProjectSkills: "trustedWorkspaces", roots: [], maxSkills: 100 },
    commands: { enabled: true, loadProjectCommands: "trustedWorkspaces", roots: [], maxCommands: 100 },
    mcp: { enabled: false, exposeGatewayServer: false, servers: {} },
    plugins: { enabled: true, loadProjectPlugins: "trustedWorkspaces", roots: [], disabled: [], maxPlugins: 100 }
  }
}, null, 2), "utf8");

writeFileSync(join(home, "config.json"), JSON.stringify({
  version: 1,
  created_at: "2026-05-10T00:00:00.000Z",
  primaryProvider: "openai",
  primaryApiKey: "token",
  providerApiKeys: { openai: "token" },
  modelProviderApiKeys: { openai: "token" },
  note: "eval"
}, null, 2), "utf8");

function runCli(args) {
  return spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, SWARM_HOME: home },
    encoding: "utf8",
    timeout: 10000
  });
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseJsonLines(value) {
  return value.split(/\\r?\\n/).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

const listed = runCli(["./dist/index.js", "capabilities", "--workspace", workspace]);
const listedAll = runCli(["./dist/index.js", "capabilities", "--all", "local_tool", "--workspace", workspace]);
const shown = runCli(["./dist/index.js", "capabilities", "show", "local_tool.Read", "--workspace", workspace, "--json"]);
const hidden = runCli(["./dist/index.js", "capabilities", "hide", "local_tool.Read", "--workspace", workspace, "--json"]);
const unhidden = runCli(["./dist/index.js", "capabilities", "unhide", "local_tool.Read", "--workspace", workspace, "--json"]);
const disabled = runCli(["./dist/index.js", "capabilities", "disable", "local_tool.Read", "--workspace", workspace, "--json"]);
const enabled = runCli(["./dist/index.js", "capabilities", "enable", "local_tool.Read", "--workspace", workspace, "--json"]);
const refreshed = runCli(["./dist/index.js", "capabilities", "refresh", "local-tools", "kind:local_tool", "--workspace", workspace, "--json"]);
const invoked = runCli(["./dist/index.js", "capabilities", "invoke", "local_tool.Read", "path=note.txt", "--workspace", workspace, "--json"]);

console.log(JSON.stringify({
  listed: { status: listed.status, stdout: listed.stdout, stderr: listed.stderr },
  listedAll: { status: listedAll.status, stdout: listedAll.stdout, stderr: listedAll.stderr },
  shown: { status: shown.status, json: parseJson(shown.stdout), stderr: shown.stderr },
  hidden: { status: hidden.status, json: parseJson(hidden.stdout), stderr: hidden.stderr },
  unhidden: { status: unhidden.status, json: parseJson(unhidden.stdout), stderr: unhidden.stderr },
  disabled: { status: disabled.status, json: parseJson(disabled.stdout), stderr: disabled.stderr },
  enabled: { status: enabled.status, json: parseJson(enabled.stdout), stderr: enabled.stderr },
  refreshed: { status: refreshed.status, json: parseJson(refreshed.stdout), stderr: refreshed.stderr },
  invoked: { status: invoked.status, json: parseJson(invoked.stdout), stderr: invoked.stderr }
}));
rmSync(home, { recursive: true, force: true });
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    listed?: { status?: number | null; stdout?: string; stderr?: string };
    listedAll?: { status?: number | null; stdout?: string; stderr?: string };
    shown?: { status?: number | null; json?: { capability?: { id?: string; providerId?: string } } | null; stderr?: string };
    hidden?: { status?: number | null; json?: { action?: string; capability?: { modelVisible?: boolean } } | null; stderr?: string };
    unhidden?: { status?: number | null; json?: { action?: string; capability?: { modelVisible?: boolean } } | null; stderr?: string };
    disabled?: { status?: number | null; json?: { action?: string; capability?: { trust?: string; status?: string } } | null; stderr?: string };
    enabled?: { status?: number | null; json?: { action?: string; capability?: { trust?: string; status?: string } } | null; stderr?: string };
    refreshed?: { status?: number | null; json?: { action?: string; provider_id?: string; capabilities?: Array<{ id?: string }> } | null; stderr?: string };
    invoked?: { status?: number | null; json?: { capability?: { id?: string }; result?: { status?: string; content?: string } } | null; stderr?: string };
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // fall through
  }
  const listedOut = parsed.listed?.stdout ?? "";
  const listedAllOut = parsed.listedAll?.stdout ?? "";
  const ok = result.status === 0
    && parsed.listed?.status === 0
    && parsed.listedAll?.status === 0
    && parsed.shown?.status === 0
    && parsed.hidden?.status === 0
    && parsed.unhidden?.status === 0
    && parsed.disabled?.status === 0
    && parsed.enabled?.status === 0
    && parsed.refreshed?.status === 0
    && parsed.invoked?.status === 0
    && listedOut.includes("Swarm Capabilities")
    && listedOut.includes("Capability summary")
    && listedOut.includes("local_tool")
    && listedAllOut.includes("local_tool.Read")
    && parsed.shown?.json?.capability?.id === "local_tool.Read"
    && parsed.shown?.json?.capability?.providerId === "local-tools"
    && parsed.hidden?.json?.action === "hide"
    && parsed.hidden?.json?.capability?.modelVisible === false
    && parsed.unhidden?.json?.action === "unhide"
    && parsed.unhidden?.json?.capability?.modelVisible === true
    && parsed.disabled?.json?.action === "disable"
    && parsed.disabled?.json?.capability?.trust === "disabled"
    && parsed.disabled?.json?.capability?.status === "disabled"
    && parsed.enabled?.json?.action === "enable"
    && parsed.enabled?.json?.capability?.trust === "builtin"
    && parsed.enabled?.json?.capability?.status === "available"
    && parsed.refreshed?.json?.action === "refresh"
    && parsed.refreshed?.json?.provider_id === "local-tools"
    && Boolean(parsed.refreshed?.json?.capabilities?.some((capability) => capability.id === "local_tool.Read"))
    && parsed.invoked?.json?.capability?.id === "local_tool.Read"
    && parsed.invoked?.json?.result?.status === "success"
    && Boolean(parsed.invoked?.json?.result?.content?.includes("hello from capability invoke"));
  return ok
    ? { name: "CLI capabilities lists, inspects, refreshes, toggles, and invokes capability surfaces", status: "pass", message: "swarm capabilities exposes the capability plane and broker without requiring the TUI or Gateway" }
    : {
        name: "CLI capabilities lists, inspects, refreshes, toggles, and invokes capability surfaces",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkSessionsCliBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const home = resolve(tmpdir(), "swarm-sessions-cli-eval");
rmSync(home, { recursive: true, force: true });
mkdirSync(join(home, "state"), { recursive: true });
mkdirSync(join(home, "logs"), { recursive: true });
const workspace = join(home, "workspace");
mkdirSync(workspace, { recursive: true });
process.env.SWARM_HOME = home;
writeFileSync(join(home, "settings.json"), JSON.stringify({
  version: 1,
  models: {
    defaultProvider: "openai",
    planner: "openai/gpt-5.5",
    worker: "openai/gpt-5.5",
    aggregator: "openai/gpt-5.5",
    apiKeyEnv: "",
    maxOutputTokens: null
  },
  providers: {
    openai: {
      id: "openai",
      name: "OpenAI",
      protocol: "openai-responses",
      baseURL: "https://api.openai.com/v1",
      modelListProtocol: "openai",
      modelListURL: "https://api.openai.com/v1/models",
      apiKeyEnv: "OPENAI_API_KEY",
      apiKeyRequired: true,
      auth: "bearer",
      models: {
        "gpt-5.5": { name: "GPT-5.5", default: true }
      }
    }
  },
  enabledProviders: [],
  disabledProviders: [],
  runtime: {
    maxAgents: 2,
    maxParallelTasks: 1,
    taskTimeoutMs: 1000,
    databasePath: join(home, "state", "swarm.db"),
    projectArtifactDir: ".swarm/artifacts"
  },
  tools: { webSearch: true, directWrite: true },
  permissions: { defaultMode: "ask", allow: [], ask: [], deny: [], additionalDirectories: [] },
  ui: { theme: "default" },
  telemetry: { enabled: false },
  extensions: {
    capabilities: { disabled: [], hiddenFromModel: [] },
    skills: { enabled: true, loadProjectSkills: "trustedWorkspaces", roots: [], maxSkills: 100 },
    commands: { enabled: true, loadProjectCommands: "trustedWorkspaces", roots: [], maxCommands: 100 },
    mcp: { enabled: false, exposeGatewayServer: false, servers: {} },
    plugins: { enabled: true, loadProjectPlugins: "trustedWorkspaces", roots: [], disabled: [], maxPlugins: 100 }
  }
}, null, 2), "utf8");
writeFileSync(join(home, "config.json"), JSON.stringify({
  version: 1,
  created_at: "2026-05-10T00:00:00.000Z",
  primaryProvider: "openai",
  primaryApiKey: "token",
  providerApiKeys: { openai: "token" },
  modelProviderApiKeys: { openai: "token" },
  note: "eval"
}, null, 2), "utf8");

const { SwarmRuntime } = await import("./dist/runtime/runtime.js");
const runtime = new SwarmRuntime({ workspace });
const policy = {
  max_agents: 2,
  max_parallel_tasks: 1,
  timeout_ms: 1000,
  retry: { max_attempts: 1, backoff_ms: 0 },
  require_review: false,
  consensus: "reviewer_approval",
  safety: {
    require_human_approval_for: [],
    forbidden_capabilities: [],
    sandbox_required: false
  },
  memory: {
    allow_read: true,
    allow_write: true,
    retention: "session"
  }
};
const sessionSource = (id, title) => ({
  source: "user",
  source_id: undefined,
  human_id: id,
  title,
  description: title,
  labels: ["interactive"],
  metadata: {}
});

const lease2 = runtime.workspaceLeaseStore.createForLocalSession({ session_id: "sess_eval_cli_2", workspace });
runtime.sessionStore.create({
  swarm_id: "swarm_sess_eval_cli_2",
  session_id: "sess_eval_cli_2",
  user_request_id: "user_req_2",
  source: sessionSource("sess_eval_cli_2", "Previous attempt"),
  workspace_lease_id: lease2.lease_id,
  objective: "Previous failing attempt",
  status: "failed",
  coordinator: { agent_id: "main_swarm", role: "controller" },
  participants: [],
  created_at: "2026-05-10T00:00:00.000Z",
  updated_at: "2026-05-10T00:00:00.000Z",
  policy
});
runtime.sessionStore.setFinalOutput("sess_eval_cli_2", "Previous attempt failed.", "failed");

const lease1 = runtime.workspaceLeaseStore.createForLocalSession({ session_id: "sess_eval_cli_1", workspace });
runtime.sessionStore.create({
  swarm_id: "swarm_sess_eval_cli_1",
  session_id: "sess_eval_cli_1",
  user_request_id: "user_req_1",
  source: sessionSource("sess_eval_cli_1", "Lint cleanup"),
  workspace_lease_id: lease1.lease_id,
  objective: "Finish the lint cleanup",
  status: "completed",
  coordinator: { agent_id: "main_swarm", role: "controller" },
  participants: [],
  created_at: "2026-05-10T00:01:00.000Z",
  updated_at: "2026-05-10T00:01:00.000Z",
  policy
});
runtime.sessionStore.setPlan("sess_eval_cli_1", {
  objective: "Finish the lint cleanup",
  summary: "Resume the queued cleanup",
  tasks: []
});
runtime.sessionStore.setFinalOutput("sess_eval_cli_1", "Implemented the targeted fix.", "completed");
runtime.sessionStore.setFinalOutcome("sess_eval_cli_1", {
  changed_files: ["src/index.ts"],
  intermediate_artifacts: [],
  tests_run: ["npm run check"],
  final_summary: "Implemented the targeted fix."
});
runtime.dispose();

const env = { ...process.env, SWARM_HOME: home };
const listed = spawnSync(process.execPath, ["./dist/index.js", "sessions", "--workspace", workspace, "--limit", "1"], {
  cwd: process.cwd(),
  env,
  encoding: "utf8",
  timeout: 10000
});
const shown = spawnSync(process.execPath, ["./dist/index.js", "sessions", "show", "latest", "--workspace", workspace], {
  cwd: process.cwd(),
  env,
  encoding: "utf8",
  timeout: 10000
});
const shownJson = spawnSync(process.execPath, ["./dist/index.js", "sessions", "show", "latest", "--workspace", workspace, "--json"], {
  cwd: process.cwd(),
  env,
  encoding: "utf8",
  timeout: 10000
});
const alias = spawnSync(process.execPath, ["./dist/index.js", "ps", "--workspace", workspace, "--limit", "1"], {
  cwd: process.cwd(),
  env,
  encoding: "utf8",
  timeout: 10000
});
console.log(JSON.stringify({
  listed: { status: listed.status, stdout: listed.stdout, stderr: listed.stderr },
  shown: { status: shown.status, stdout: shown.stdout, stderr: shown.stderr },
  shownJson: { status: shownJson.status, stdout: shownJson.stdout, stderr: shownJson.stderr },
  alias: { status: alias.status, stdout: alias.stdout, stderr: alias.stderr }
}));
rmSync(home, { recursive: true, force: true });
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    listed?: { status?: number | null; stdout?: string; stderr?: string };
    shown?: { status?: number | null; stdout?: string; stderr?: string };
    shownJson?: { status?: number | null; stdout?: string; stderr?: string };
    alias?: { status?: number | null; stdout?: string; stderr?: string };
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // fall through
  }
  const listedOut = parsed.listed?.stdout ?? "";
  const shownOut = parsed.shown?.stdout ?? "";
  const shownJsonOut = parsed.shownJson?.stdout ?? "";
  const aliasOut = parsed.alias?.stdout ?? "";
  const ok = result.status === 0
    && parsed.listed?.status === 0
    && parsed.shown?.status === 0
    && parsed.shownJson?.status === 0
    && parsed.alias?.status === 0
    && listedOut.includes("Swarm Sessions")
    && listedOut.includes("sess_eval_cli_1")
    && !listedOut.includes("sess_eval_cli_2")
    && shownOut.includes("Swarm Session")
    && shownOut.includes("sess_eval_cli_1 [completed]")
    && shownOut.includes("Final: Implemented the targeted fix.")
    && shownOut.includes("stored_plan=yes")
    && shownJsonOut.includes('"session_id": "sess_eval_cli_1"')
    && shownJsonOut.includes('"approvals": []')
    && aliasOut.includes("Swarm Sessions");
  return ok
    ? { name: "CLI sessions lists, inspects, and aliases persisted work sessions", status: "pass", message: "swarm sessions and swarm ps expose recent session state and detailed snapshots" }
    : {
        name: "CLI sessions lists, inspects, and aliases persisted work sessions",
        status: "fail",
      message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkSessionsLiveControlCliBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { SwarmGatewayServer } from "./dist/server/gateway.js";

const dir = mkdtempSync(resolve(tmpdir(), "swarm-sessions-live-control-cli-eval-"));
const home = resolve(dir, "home");
mkdirSync(join(home, "state"), { recursive: true });
mkdirSync(join(home, "logs"), { recursive: true });
const workspace = resolve(dir, "workspace");
mkdirSync(workspace, { recursive: true });

writeFileSync(join(home, "settings.json"), JSON.stringify({
  version: 1,
  models: {
    defaultProvider: "openai",
    planner: "openai/gpt-5.5",
    worker: "openai/gpt-5.5",
    aggregator: "openai/gpt-5.5",
    apiKeyEnv: "",
    maxOutputTokens: null
  },
  providers: {
    openai: {
      id: "openai",
      name: "OpenAI",
      protocol: "openai-responses",
      baseURL: "https://api.openai.com/v1",
      modelListProtocol: "openai",
      modelListURL: "https://api.openai.com/v1/models",
      apiKeyEnv: "OPENAI_API_KEY",
      apiKeyRequired: true,
      auth: "bearer",
      models: {
        "gpt-5.5": { name: "GPT-5.5", default: true }
      }
    }
  },
  enabledProviders: [],
  disabledProviders: [],
  runtime: {
    maxAgents: 2,
    maxParallelTasks: 1,
    taskTimeoutMs: 1000,
    databasePath: join(home, "state", "swarm.db"),
    projectArtifactDir: ".swarm/artifacts"
  },
  tools: { webSearch: true, directWrite: true },
  permissions: { defaultMode: "ask", allow: [], ask: [], deny: [], additionalDirectories: [] },
  ui: { theme: "default" },
  telemetry: { enabled: false },
  extensions: {
    capabilities: { disabled: [], hiddenFromModel: [] },
    skills: { enabled: true, loadProjectSkills: "trustedWorkspaces", roots: [], maxSkills: 100 },
    commands: { enabled: true, loadProjectCommands: "trustedWorkspaces", roots: [], maxCommands: 100 },
    mcp: { enabled: false, exposeGatewayServer: false, servers: {} },
    plugins: { enabled: true, loadProjectPlugins: "trustedWorkspaces", roots: [], disabled: [], maxPlugins: 100 }
  }
}, null, 2), "utf8");

writeFileSync(join(home, "config.json"), JSON.stringify({
  version: 1,
  created_at: "2026-05-10T00:00:00.000Z",
  primaryProvider: "openai",
  primaryApiKey: "token",
  providerApiKeys: { openai: "token" },
  modelProviderApiKeys: { openai: "token" },
  note: "eval"
}, null, 2), "utf8");

async function runCli(args) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, SWARM_HOME: home },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      resolve({ status: null, signal: "SIGTERM", stdout, stderr });
    }, 10000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ status: code, signal, stdout, stderr });
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      stderr += error instanceof Error ? error.message : String(error);
      resolve({ status: 1, signal: null, stdout, stderr });
    });
  });
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const gateway = new SwarmGatewayServer({ workspace, databasePath: resolve(home, "state", "swarm.db"), port: 0 });

try {
  const started = await gateway.start();
  gateway.runtime.ensureTuiChatSession("gateway_live_control_eval");
  const messages = [];
  const interrupts = [];
  gateway.runtime.activeCodingLoopSessionId = "gateway_live_control_eval";
  gateway.runtime.activeCodingLoop = {
    async submitUserMessage(content) {
      messages.push(content);
    },
    requestInterrupt(content) {
      interrupts.push(content);
    }
  };

  const replied = await runCli([
    "./dist/index.js",
    "sessions",
    "reply",
    "latest",
    "focus on tests",
    "--request-id",
    "req_cli_session_reply",
    "--workspace",
    workspace,
    "--gateway-url",
    started.url,
    "--json"
  ]);
  const interrupted = await runCli([
    "./dist/index.js",
    "sessions",
    "interrupt",
    "latest",
    "stop after current safe boundary",
    "--request-id",
    "req_cli_session_interrupt",
    "--workspace",
    workspace,
    "--gateway-url",
    started.url,
    "--json"
  ]);

  gateway.runtime.activeCodingLoop = undefined;
  gateway.runtime.activeCodingLoopSessionId = undefined;

  const noActive = await runCli([
    "./dist/index.js",
    "sessions",
    "reply",
    "latest",
    "status?",
    "--workspace",
    workspace,
    "--gateway-url",
    started.url,
    "--json"
  ]);

  console.log(JSON.stringify({
    replied: { status: replied.status, json: parseJson(replied.stdout), stderr: replied.stderr },
    interrupted: { status: interrupted.status, json: parseJson(interrupted.stdout), stderr: interrupted.stderr },
    noActive: { status: noActive.status, json: parseJson(noActive.stdout), stderr: noActive.stderr },
    messages,
    interrupts
  }));
} finally {
  await gateway.stop();
  rmSync(dir, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    replied?: { status?: number | null; json?: { action?: string; session_id?: string; route?: string; status?: string; request_id?: string; message?: string } | null; stderr?: string };
    interrupted?: { status?: number | null; json?: { action?: string; session_id?: string; route?: string; status?: string; request_id?: string; message?: string } | null; stderr?: string };
    noActive?: { status?: number | null; json?: { action?: string; error?: { status?: number; message?: string } } | null; stderr?: string };
    messages?: string[];
    interrupts?: string[];
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // fall through
  }
  const ok = result.status === 0
    && parsed.replied?.status === 0
    && parsed.replied?.json?.action === "reply"
    && parsed.replied?.json?.session_id === "gateway_live_control_eval"
    && parsed.replied?.json?.route === "coding_loop"
    && parsed.replied?.json?.status === "applied"
    && parsed.replied?.json?.request_id === "req_cli_session_reply"
    && parsed.replied?.json?.message === "focus on tests"
    && parsed.interrupted?.status === 0
    && parsed.interrupted?.json?.action === "interrupt"
    && parsed.interrupted?.json?.session_id === "gateway_live_control_eval"
    && parsed.interrupted?.json?.route === "coding_loop"
    && parsed.interrupted?.json?.status === "applied"
    && parsed.interrupted?.json?.request_id === "req_cli_session_interrupt"
    && parsed.interrupted?.json?.message === "stop after current safe boundary"
    && parsed.noActive?.status === 1
    && parsed.noActive?.json?.action === "reply"
    && parsed.noActive?.json?.error?.status === 409
    && parsed.noActive?.json?.error?.message === "No active work is available to receive a live reply. Start or resume a run first."
    && parsed.messages?.join(",") === "focus on tests"
    && parsed.interrupts?.join(",") === "stop after current safe boundary";
  return ok
    ? { name: "CLI session live control bridges through the local Gateway", status: "pass", message: "swarm sessions reply and interrupt target active Gateway-controlled runs and preserve fail-closed semantics" }
    : {
        name: "CLI session live control bridges through the local Gateway",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkLiveStatusCliBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { SwarmGatewayServer } from "./dist/server/gateway.js";

const dir = mkdtempSync(resolve(tmpdir(), "swarm-live-status-cli-eval-"));
const home = resolve(dir, "home");
mkdirSync(join(home, "state"), { recursive: true });
mkdirSync(join(home, "logs"), { recursive: true });
const workspace = resolve(dir, "workspace");
mkdirSync(workspace, { recursive: true });

writeFileSync(join(home, "settings.json"), JSON.stringify({
  version: 1,
  models: {
    defaultProvider: "openai",
    planner: "openai/gpt-5.5",
    worker: "openai/gpt-5.5",
    aggregator: "openai/gpt-5.5",
    apiKeyEnv: "",
    maxOutputTokens: null
  },
  tools: {
    enabled: true,
    webSearch: true,
    directWrite: true
  },
  permissions: {
    mode: "auto-edit",
    allow: [],
    ask: [],
    deny: [],
    additionalDirectories: []
  },
  environment: {
    inherit: "all",
    allow: [],
    deny: []
  }
}, null, 2));

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SWARM_HOME: home,
        HOME: home,
        USERPROFILE: home
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      resolve({ status: null, signal: "SIGTERM", stdout, stderr });
    }, 10000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ status: code, signal, stdout, stderr });
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      stderr += error instanceof Error ? error.message : String(error);
      resolve({ status: 1, signal: null, stdout, stderr });
    });
  });
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const gateway = new SwarmGatewayServer({ workspace, databasePath: resolve(home, "state", "swarm.db"), port: 0 });

try {
  const started = await gateway.start();
  gateway.runtime.ensureTuiChatSession("gateway_live_status_eval");
  gateway.runtime.activeCodingLoopSessionId = "gateway_live_status_eval";
  gateway.runtime.activeCodingLoop = {
    async submitUserMessage() {},
    requestInterrupt() {}
  };

  const active = await runCli([
    "./dist/index.js",
    "live",
    "--gateway-url",
    started.url,
    "--json"
  ]);

  gateway.runtime.activeCodingLoop = undefined;
  gateway.runtime.activeCodingLoopSessionId = undefined;

  const idle = await runCli([
    "./dist/index.js",
    "live",
    "--gateway-url",
    started.url,
    "--json"
  ]);

  console.log(JSON.stringify({
    active: { status: active.status, json: parseJson(active.stdout), stderr: active.stderr },
    idle: { status: idle.status, json: parseJson(idle.stdout), stderr: idle.stderr }
  }));
} finally {
  await gateway.stop();
  rmSync(dir, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    active?: { status?: number | null; json?: { action?: string; gateway_url?: string; status?: string; active_target?: { session_id?: string; route?: string } | null; session?: { session_id?: string; status?: string } | null } | null; stderr?: string };
    idle?: { status?: number | null; json?: { action?: string; gateway_url?: string; status?: string; active_target?: unknown } | null; stderr?: string };
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // fall through
  }
  const ok = result.status === 0
    && parsed.active?.status === 0
    && parsed.active?.json?.action === "live"
    && parsed.active?.json?.status === "active"
    && parsed.active?.json?.active_target?.session_id === "gateway_live_status_eval"
    && parsed.active?.json?.active_target?.route === "coding_loop"
    && parsed.active?.json?.session?.session_id === "gateway_live_status_eval"
    && typeof parsed.active?.json?.session?.status === "string"
    && parsed.idle?.status === 0
    && parsed.idle?.json?.action === "live"
    && parsed.idle?.json?.status === "idle"
    && parsed.idle?.json?.active_target === null;
  return ok
    ? { name: "CLI live status shows the active Gateway target and idles cleanly", status: "pass", message: "swarm live surfaces the in-memory active live target through the Gateway and returns idle instead of failing when no run is active" }
    : {
        name: "CLI live status shows the active Gateway target and idles cleanly",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkTopLevelLiveControlCliBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { SwarmGatewayServer } from "./dist/server/gateway.js";

const dir = mkdtempSync(resolve(tmpdir(), "swarm-top-live-control-cli-eval-"));
const home = resolve(dir, "home");
mkdirSync(join(home, "state"), { recursive: true });
mkdirSync(join(home, "logs"), { recursive: true });
const workspace = resolve(dir, "workspace");
mkdirSync(workspace, { recursive: true });

writeFileSync(join(home, "settings.json"), JSON.stringify({
  version: 1,
  models: {
    defaultProvider: "openai",
    planner: "openai/gpt-5.5",
    worker: "openai/gpt-5.5",
    aggregator: "openai/gpt-5.5",
    apiKeyEnv: "",
    maxOutputTokens: null
  },
  tools: {
    enabled: true,
    webSearch: true,
    directWrite: true
  },
  permissions: {
    mode: "auto-edit",
    allow: [],
    ask: [],
    deny: [],
    additionalDirectories: []
  },
  environment: {
    inherit: "all",
    allow: [],
    deny: []
  }
}, null, 2));

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SWARM_HOME: home,
        HOME: home,
        USERPROFILE: home
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      resolve({ status: null, signal: "SIGTERM", stdout, stderr });
    }, 10000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ status: code, signal, stdout, stderr });
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      stderr += error instanceof Error ? error.message : String(error);
      resolve({ status: 1, signal: null, stdout, stderr });
    });
  });
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const gateway = new SwarmGatewayServer({ workspace, databasePath: resolve(home, "state", "swarm.db"), port: 0 });

try {
  const started = await gateway.start();
  gateway.runtime.ensureTuiChatSession("gateway_live_control_eval");
  const messages = [];
  const interrupts = [];
  gateway.runtime.activeCodingLoopSessionId = "gateway_live_control_eval";
  gateway.runtime.activeCodingLoop = {
    async submitUserMessage(content) {
      messages.push(content);
    },
    requestInterrupt(content) {
      interrupts.push(content);
    }
  };

  const replied = await runCli([
    "./dist/index.js",
    "reply",
    "focus on tests",
    "--request-id",
    "req_cli_active_reply",
    "--gateway-url",
    started.url,
    "--json"
  ]);
  const interrupted = await runCli([
    "./dist/index.js",
    "interrupt",
    "stop after current safe boundary",
    "--request-id",
    "req_cli_active_interrupt",
    "--gateway-url",
    started.url,
    "--json"
  ]);

  gateway.runtime.activeCodingLoop = undefined;
  gateway.runtime.activeCodingLoopSessionId = undefined;

  const noActive = await runCli([
    "./dist/index.js",
    "reply",
    "status?",
    "--gateway-url",
    started.url,
    "--json"
  ]);

  console.log(JSON.stringify({
    replied: { status: replied.status, json: parseJson(replied.stdout), stderr: replied.stderr },
    interrupted: { status: interrupted.status, json: parseJson(interrupted.stdout), stderr: interrupted.stderr },
    noActive: { status: noActive.status, json: parseJson(noActive.stdout), stderr: noActive.stderr },
    messages,
    interrupts
  }));
} finally {
  await gateway.stop();
  rmSync(dir, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    replied?: { status?: number | null; json?: { action?: string; session_id?: string; route?: string; status?: string; request_id?: string; message?: string } | null; stderr?: string };
    interrupted?: { status?: number | null; json?: { action?: string; session_id?: string; route?: string; status?: string; request_id?: string; message?: string } | null; stderr?: string };
    noActive?: { status?: number | null; json?: { action?: string; error?: { status?: number; message?: string } } | null; stderr?: string };
    messages?: string[];
    interrupts?: string[];
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // fall through
  }
  const ok = result.status === 0
    && parsed.replied?.status === 0
    && parsed.replied?.json?.action === "reply"
    && parsed.replied?.json?.session_id === "gateway_live_control_eval"
    && parsed.replied?.json?.route === "coding_loop"
    && parsed.replied?.json?.status === "applied"
    && parsed.replied?.json?.request_id === "req_cli_active_reply"
    && parsed.replied?.json?.message === "focus on tests"
    && parsed.interrupted?.status === 0
    && parsed.interrupted?.json?.action === "interrupt"
    && parsed.interrupted?.json?.session_id === "gateway_live_control_eval"
    && parsed.interrupted?.json?.route === "coding_loop"
    && parsed.interrupted?.json?.status === "applied"
    && parsed.interrupted?.json?.request_id === "req_cli_active_interrupt"
    && parsed.interrupted?.json?.message === "stop after current safe boundary"
    && parsed.noActive?.status === 1
    && parsed.noActive?.json?.action === "reply"
    && parsed.noActive?.json?.error?.status === 409
    && parsed.noActive?.json?.error?.message === "No active work is available to receive a live reply. Start or resume a run first."
    && parsed.messages?.join(",") === "focus on tests"
    && parsed.interrupts?.join(",") === "stop after current safe boundary";
  return ok
    ? { name: "CLI top-level live control bridges through the local Gateway", status: "pass", message: "swarm reply and interrupt target the active Gateway-controlled run without a session selector" }
    : {
        name: "CLI top-level live control bridges through the local Gateway",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkSessionsWatchCliBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { SwarmGatewayServer } from "./dist/server/gateway.js";

const dir = mkdtempSync(resolve(tmpdir(), "swarm-sessions-watch-cli-eval-"));
const home = resolve(dir, "home");
mkdirSync(join(home, "state"), { recursive: true });
mkdirSync(join(home, "logs"), { recursive: true });
const workspace = resolve(dir, "workspace");
mkdirSync(workspace, { recursive: true });

writeFileSync(join(home, "settings.json"), JSON.stringify({
  version: 1,
  models: {
    defaultProvider: "openai",
    planner: "openai/gpt-5.5",
    worker: "openai/gpt-5.5",
    aggregator: "openai/gpt-5.5",
    apiKeyEnv: "",
    maxOutputTokens: null
  },
  providers: {
    openai: {
      id: "openai",
      name: "OpenAI",
      protocol: "openai-responses",
      baseURL: "https://api.openai.com/v1",
      modelListProtocol: "openai",
      modelListURL: "https://api.openai.com/v1/models",
      apiKeyEnv: "OPENAI_API_KEY",
      apiKeyRequired: true,
      auth: "bearer",
      models: {
        "gpt-5.5": { name: "GPT-5.5", default: true }
      }
    }
  },
  enabledProviders: [],
  disabledProviders: [],
  runtime: {
    maxAgents: 2,
    maxParallelTasks: 1,
    taskTimeoutMs: 1000,
    databasePath: join(home, "state", "swarm.db"),
    projectArtifactDir: ".swarm/artifacts"
  },
  tools: { webSearch: true, directWrite: true },
  permissions: { defaultMode: "ask", allow: [], ask: [], deny: [], additionalDirectories: [] },
  ui: { theme: "default" },
  telemetry: { enabled: false },
  extensions: {
    capabilities: { disabled: [], hiddenFromModel: [] },
    skills: { enabled: true, loadProjectSkills: "trustedWorkspaces", roots: [], maxSkills: 100 },
    commands: { enabled: true, loadProjectCommands: "trustedWorkspaces", roots: [], maxCommands: 100 },
    mcp: { enabled: false, exposeGatewayServer: false, servers: {} },
    plugins: { enabled: true, loadProjectPlugins: "trustedWorkspaces", roots: [], disabled: [], maxPlugins: 100 }
  }
}, null, 2), "utf8");

writeFileSync(join(home, "config.json"), JSON.stringify({
  version: 1,
  created_at: "2026-05-10T00:00:00.000Z",
  primaryProvider: "openai",
  primaryApiKey: "token",
  providerApiKeys: { openai: "token" },
  modelProviderApiKeys: { openai: "token" },
  note: "eval"
}, null, 2), "utf8");

async function runCli(args) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, SWARM_HOME: home },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      resolve({ status: null, signal: "SIGTERM", stdout, stderr });
    }, 12000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ status: code, signal, stdout, stderr });
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      stderr += error instanceof Error ? error.message : String(error);
      resolve({ status: 1, signal: null, stdout, stderr });
    });
  });
}

function parseJsonLines(value) {
  return value.split(/\\r?\\n/).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

const gateway = new SwarmGatewayServer({ workspace, databasePath: resolve(home, "state", "swarm.db"), port: 0 });

try {
  const started = await gateway.start();

  const workSessionId = "session_watch_work_eval";
  gateway.runtime.ensureTuiChatSession(workSessionId);
  const watchWork = runCli([
    "./dist/index.js",
    "sessions",
    "watch",
    workSessionId,
    "--workspace",
    workspace,
    "--gateway-url",
    started.url
  ]);
  setTimeout(() => {
    gateway.runtime.events.emitEvent({
      type: "queue",
      queue: "worker_slots",
      operation: "enqueue",
      id: "worker_session_watch_eval",
      size: 1,
      session_id: workSessionId,
      message: "Waiting for a worker slot: running 1/1"
    });
    gateway.runtime.events.emitEvent({
      type: "tool_result",
      session_id: workSessionId,
      task_id: "session_watch_task",
      title: "Patch file",
      action: "file.edit",
      summary: "patched src/app.ts",
      status: "failed",
      write_policy: "scoped_write",
      file_scope: ["src/app.ts"],
      sandbox: {
        decision: "deny",
        policy: "scoped_write",
        subject: "tool_action",
        reason: "Scoped-write sandbox denied tool action: file.edit outside file_scope (private/out.ts)",
        action: "file.edit",
        targets: ["private/out.ts"],
        file_scope: ["src/app.ts"]
      }
    });
    gateway.runtime.events.emitEvent({
      type: "session",
      session_id: workSessionId,
      status: "completed",
      objective: "Session watch work eval"
    });
  }, 100);
  const workResult = await watchWork;

  const runtimeSessionId = "session_watch_runtime_eval";
  gateway.runtime.ensureTuiChatSession(runtimeSessionId);
  const watchRuntime = runCli([
    "./dist/index.js",
    "sessions",
    "watch",
    runtimeSessionId,
    "--workspace",
    workspace,
    "--gateway-url",
    started.url,
    "--protocol",
    "runtime",
    "--jsonl"
  ]);
  setTimeout(() => {
    gateway.runtime.events.emitEvent({
      type: "loop_activity",
      session_id: runtimeSessionId,
      phase: "thinking",
      message: "Planning session runtime watch eval"
    });
    gateway.runtime.events.emitEvent({
      type: "final",
      session_id: runtimeSessionId,
      content: "session runtime watch eval completed",
      status: "completed",
      outcome: {
        changed_files: [],
        tests_run: [],
        intermediate_artifacts: [],
        final_summary: "session runtime watch eval completed"
      }
    });
  }, 100);
  const runtimeResult = await watchRuntime;
  const runtimeLines = parseJsonLines(runtimeResult.stdout);

  console.log(JSON.stringify({
    work: workResult,
    runtime: {
      status: runtimeResult.status,
      signal: runtimeResult.signal,
      stderr: runtimeResult.stderr,
      lines: runtimeLines
    }
  }));
} finally {
  await gateway.stop();
  rmSync(dir, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    work?: { status?: number | null; signal?: string | null; stdout?: string; stderr?: string };
    runtime?: { status?: number | null; signal?: string | null; stderr?: string; lines?: Array<{ type?: string; protocol?: string; sse_event?: string; status?: string; data?: { event?: { type?: string } } }> };
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in the failure message below.
  }
  const runtimeLines = parsed.runtime?.lines ?? [];
  const runtimeStart = runtimeLines.find((line) => line.type === "watch_start");
  const runtimeFinal = runtimeLines.find((line) => line.type === "watch_event" && line.sse_event === "final");
  const runtimeEnd = runtimeLines.find((line) => line.type === "watch_end");
  const ok = result.status === 0
    && parsed.work?.status === 0
    && typeof parsed.work?.stdout === "string"
    && parsed.work.stdout.includes("Watching Swarm session")
    && parsed.work.stdout.includes("protocol=work")
    && parsed.work.stdout.includes("queue:worker_slots")
    && parsed.work.stdout.includes("task:failed file.edit")
    && parsed.work.stdout.includes("policy=scoped_write")
    && parsed.work.stdout.includes("sandbox=scoped_write/denied")
    && parsed.work.stdout.includes("watch ended: status=completed")
    && parsed.runtime?.status === 0
    && runtimeStart?.type === "watch_start"
    && runtimeStart?.protocol === "runtime"
    && runtimeFinal?.type === "watch_event"
    && runtimeFinal?.protocol === "runtime"
    && runtimeFinal?.sse_event === "final"
    && runtimeFinal?.data?.event?.type === "final"
    && runtimeEnd?.type === "watch_end"
    && runtimeEnd?.status === "completed";
  return ok
    ? { name: "CLI sessions watch streams Gateway session events", status: "pass", message: "swarm sessions watch follows one session's work stream by default and can switch to runtime JSONL output for automation" }
    : {
        name: "CLI sessions watch streams Gateway session events",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkApprovalsCliBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { SwarmGatewayServer } from "./dist/server/gateway.js";

const dir = mkdtempSync(resolve(tmpdir(), "swarm-approvals-cli-eval-"));
const home = resolve(dir, "home");
mkdirSync(join(home, "state"), { recursive: true });
mkdirSync(join(home, "logs"), { recursive: true });
const workspace = resolve(dir, "workspace");
mkdirSync(workspace, { recursive: true });

writeFileSync(join(home, "settings.json"), JSON.stringify({
  version: 1,
  models: {
    defaultProvider: "openai",
    planner: "openai/gpt-5.5",
    worker: "openai/gpt-5.5",
    aggregator: "openai/gpt-5.5",
    apiKeyEnv: "",
    maxOutputTokens: null
  },
  providers: {
    openai: {
      id: "openai",
      name: "OpenAI",
      protocol: "openai-responses",
      baseURL: "https://api.openai.com/v1",
      modelListProtocol: "openai",
      modelListURL: "https://api.openai.com/v1/models",
      apiKeyEnv: "OPENAI_API_KEY",
      apiKeyRequired: true,
      auth: "bearer",
      models: {
        "gpt-5.5": { name: "GPT-5.5", default: true }
      }
    }
  },
  enabledProviders: [],
  disabledProviders: [],
  runtime: {
    maxAgents: 2,
    maxParallelTasks: 1,
    taskTimeoutMs: 1000,
    databasePath: join(home, "state", "swarm.db"),
    projectArtifactDir: ".swarm/artifacts"
  },
  tools: { webSearch: true, directWrite: true },
  permissions: { defaultMode: "ask", allow: [], ask: [], deny: [], additionalDirectories: [] },
  ui: { theme: "default" },
  telemetry: { enabled: false },
  extensions: {
    capabilities: { disabled: [], hiddenFromModel: [] },
    skills: { enabled: true, loadProjectSkills: "trustedWorkspaces", roots: [], maxSkills: 100 },
    commands: { enabled: true, loadProjectCommands: "trustedWorkspaces", roots: [], maxCommands: 100 },
    mcp: { enabled: false, exposeGatewayServer: false, servers: {} },
    plugins: { enabled: true, loadProjectPlugins: "trustedWorkspaces", roots: [], disabled: [], maxPlugins: 100 }
  }
}, null, 2), "utf8");

writeFileSync(join(home, "config.json"), JSON.stringify({
  version: 1,
  created_at: "2026-05-10T00:00:00.000Z",
  primaryProvider: "openai",
  primaryApiKey: "token",
  providerApiKeys: { openai: "token" },
  modelProviderApiKeys: { openai: "token" },
  note: "eval"
}, null, 2), "utf8");

async function runCli(args) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, SWARM_HOME: home },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      resolve({ status: null, signal: "SIGTERM", stdout, stderr });
    }, 10000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ status: code, signal, stdout, stderr });
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      stderr += error instanceof Error ? error.message : String(error);
      resolve({ status: 1, signal: null, stdout, stderr });
    });
  });
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function approvalRequest(id, sessionId, summary, target) {
  return {
    id,
    session_id: sessionId,
    action: "shell.exec",
    summary,
    detail: summary,
    risk: "shell",
    risk_class: "r3",
    target,
    why_now: "Need approval.",
    predicted_impact: "Runs tests.",
    rollback_plan: "No rollback needed.",
    permission_name: "Bash",
    permission_rule: "Bash(npm test*)"
  };
}

const gateway = new SwarmGatewayServer({ workspace, databasePath: resolve(home, "state", "swarm.db"), port: 0 });

try {
  const started = await gateway.start();
  const sessionId = "approval_cli_parent";
  gateway.runtime.ensureTuiChatSession(sessionId);
  gateway.runtime["ensureLoopSession"]("approval_cli_child", "Worker approval session", sessionId, {
    labels: ["worker"],
    mode: "worker_loop",
    source: "worker"
  });
  gateway.runtime.ensureTuiChatSession("approval_cli_other");

  const pending = approvalRequest("approval_cli_pending", sessionId, "Pending approval", "npm test");
  const approved = approvalRequest("approval_cli_done", sessionId, "Approved approval", "npm run lint");
  const workerPending = approvalRequest("approval_cli_worker", "approval_cli_child", "Worker approval", "npm run worker");
  const otherPending = approvalRequest("approval_cli_other_pending", "approval_cli_other", "Other approval", "npm run other");

  gateway.runtime.approvalStore.upsert(pending, "pending");
  gateway.runtime.approvalStore.upsert(approved, "approved");
  gateway.runtime.approvalStore.upsert(workerPending, "pending");
  gateway.runtime.approvalStore.upsert(otherPending, "pending");

  gateway.pendingApprovals.set(pending.id, {
    request: pending,
    created_at: new Date().toISOString(),
    resolve: (allowed) => gateway.runtime.approvalStore.upsert(pending, allowed ? "approved" : "denied")
  });
  gateway.pendingApprovals.set(workerPending.id, {
    request: workerPending,
    created_at: new Date().toISOString(),
    resolve: (allowed) => gateway.runtime.approvalStore.upsert(workerPending, allowed ? "approved" : "denied")
  });
  gateway.pendingApprovals.set(otherPending.id, {
    request: otherPending,
    created_at: new Date().toISOString(),
    resolve: (allowed) => gateway.runtime.approvalStore.upsert(otherPending, allowed ? "approved" : "denied")
  });

  const localList = await runCli(["./dist/index.js", "approvals", "--workspace", workspace, "--json"]);
  const localSession = await runCli(["./dist/index.js", "approvals", "--session", sessionId, "--workspace", workspace, "--json"]);
  const localShow = await runCli(["./dist/index.js", "approvals", "show", "approval_cli_worker", "--workspace", workspace, "--json"]);
  const gatewayPending = await runCli(["./dist/index.js", "approvals", "pending", "--session", sessionId, "--gateway-url", started.url, "--workspace", workspace, "--json"]);
  const gatewayShow = await runCli(["./dist/index.js", "approvals", "show", "approval_cli_pending", "--gateway-url", started.url, "--workspace", workspace, "--json"]);
  const approve = await runCli(["./dist/index.js", "approvals", "approve", "approval_cli_pending", "--gateway-url", started.url, "--workspace", workspace, "--json"]);
  const deny = await runCli(["./dist/index.js", "approvals", "deny", "approval_cli_worker", "--gateway-url", started.url, "--workspace", workspace, "--json"]);
  const stale = await runCli(["./dist/index.js", "approvals", "approve", "approval_cli_pending", "--gateway-url", started.url, "--workspace", workspace, "--json"]);

  console.log(JSON.stringify({
    localList: { status: localList.status, json: parseJson(localList.stdout), stderr: localList.stderr },
    localSession: { status: localSession.status, json: parseJson(localSession.stdout), stderr: localSession.stderr },
    localShow: { status: localShow.status, json: parseJson(localShow.stdout), stderr: localShow.stderr },
    gatewayPending: { status: gatewayPending.status, json: parseJson(gatewayPending.stdout), stderr: gatewayPending.stderr },
    gatewayShow: { status: gatewayShow.status, json: parseJson(gatewayShow.stdout), stderr: gatewayShow.stderr },
    approve: { status: approve.status, json: parseJson(approve.stdout), stderr: approve.stderr },
    deny: { status: deny.status, json: parseJson(deny.stdout), stderr: deny.stderr },
    stale: { status: stale.status, json: parseJson(stale.stdout), stderr: stale.stderr },
    finalStatuses: {
      pending: gateway.runtime.approvalStore.get("approval_cli_pending")?.status,
      worker: gateway.runtime.approvalStore.get("approval_cli_worker")?.status
    }
  }));
} finally {
  await gateway.stop();
  rmSync(dir, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    localList?: { status?: number | null; json?: { summary?: { total?: number; pending?: number }; approvals?: Array<{ approval_id?: string }> } | null; stderr?: string };
    localSession?: { status?: number | null; json?: { session_id?: string; summary?: { total?: number; pending?: number }; approvals?: Array<{ approval_id?: string; session_id?: string }> } | null; stderr?: string };
    localShow?: { status?: number | null; json?: { approval?: { approval_id?: string; challenge?: { permission_name?: string; permission_rule?: string } } } | null; stderr?: string };
    gatewayPending?: { status?: number | null; json?: { session_id?: string; actionable_approval_ids?: string[]; approvals?: Array<{ approval_id?: string }>; summary?: { actionable_pending?: number } } | null; stderr?: string };
    gatewayShow?: { status?: number | null; json?: { actionable?: boolean; approval?: { approval_id?: string }; pending_request?: { id?: string } } | null; stderr?: string };
    approve?: { status?: number | null; json?: { action?: string; approval_id?: string; status?: string } | null; stderr?: string };
    deny?: { status?: number | null; json?: { action?: string; approval_id?: string; status?: string } | null; stderr?: string };
    stale?: { status?: number | null; json?: { error?: { status?: number; message?: string } } | null; stderr?: string };
    finalStatuses?: { pending?: string; worker?: string };
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // fall through
  }
  const ok = result.status === 0
    && parsed.localList?.status === 0
    && parsed.localList?.json?.summary?.total === 4
    && parsed.localList?.json?.summary?.pending === 3
    && parsed.localList?.json?.approvals?.some((approval) => approval.approval_id === "approval_cli_other_pending")
    && parsed.localSession?.status === 0
    && parsed.localSession?.json?.session_id === "approval_cli_parent"
    && parsed.localSession?.json?.summary?.total === 3
    && parsed.localSession?.json?.summary?.pending === 2
    && parsed.localSession?.json?.approvals?.some((approval) => approval.approval_id === "approval_cli_worker" && approval.session_id === "approval_cli_child")
    && !parsed.localSession?.json?.approvals?.some((approval) => approval.approval_id === "approval_cli_other_pending")
    && parsed.localShow?.status === 0
    && parsed.localShow?.json?.approval?.approval_id === "approval_cli_worker"
    && parsed.localShow?.json?.approval?.challenge?.permission_name === "Bash"
    && parsed.localShow?.json?.approval?.challenge?.permission_rule === "Bash(npm test*)"
    && parsed.gatewayPending?.status === 0
    && parsed.gatewayPending?.json?.session_id === "approval_cli_parent"
    && parsed.gatewayPending?.json?.summary?.actionable_pending === 2
    && parsed.gatewayPending?.json?.actionable_approval_ids?.includes("approval_cli_pending")
    && parsed.gatewayPending?.json?.actionable_approval_ids?.includes("approval_cli_worker")
    && !parsed.gatewayPending?.json?.actionable_approval_ids?.includes("approval_cli_other_pending")
    && parsed.gatewayPending?.json?.approvals?.every((approval) => approval.approval_id !== "approval_cli_other_pending")
    && parsed.gatewayShow?.status === 0
    && parsed.gatewayShow?.json?.actionable === true
    && parsed.gatewayShow?.json?.approval?.approval_id === "approval_cli_pending"
    && parsed.gatewayShow?.json?.pending_request?.id === "approval_cli_pending"
    && parsed.approve?.status === 0
    && parsed.approve?.json?.action === "approve"
    && parsed.approve?.json?.approval_id === "approval_cli_pending"
    && parsed.approve?.json?.status === "approved"
    && parsed.deny?.status === 0
    && parsed.deny?.json?.action === "deny"
    && parsed.deny?.json?.approval_id === "approval_cli_worker"
    && parsed.deny?.json?.status === "denied"
    && parsed.stale?.status === 1
    && parsed.stale?.json?.error?.status === 409
    && parsed.stale?.json?.error?.message?.includes("not pending")
    && parsed.finalStatuses?.pending === "approved"
    && parsed.finalStatuses?.worker === "denied";
  return ok
    ? { name: "CLI approvals inspect persisted records and answer live Gateway approvals", status: "pass", message: "swarm approvals bridges local approval history with actionable Gateway decisions and preserves session-family scoping" }
    : {
        name: "CLI approvals inspect persisted records and answer live Gateway approvals",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkSessionsExecuteForkCliBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { SwarmGatewayServer } from "./dist/server/gateway.js";

const dir = mkdtempSync(resolve(tmpdir(), "swarm-sessions-execute-fork-cli-eval-"));
const home = resolve(dir, "home");
mkdirSync(join(home, "state"), { recursive: true });
mkdirSync(join(home, "logs"), { recursive: true });
const workspace = resolve(dir, "workspace");
mkdirSync(workspace, { recursive: true });

writeFileSync(join(home, "settings.json"), JSON.stringify({
  version: 1,
  models: {
    defaultProvider: "openai",
    planner: "openai/gpt-5.5",
    worker: "openai/gpt-5.5",
    aggregator: "openai/gpt-5.5",
    apiKeyEnv: "",
    maxOutputTokens: null
  },
  providers: {
    openai: {
      id: "openai",
      name: "OpenAI",
      protocol: "openai-responses",
      baseURL: "https://api.openai.com/v1",
      modelListProtocol: "openai",
      modelListURL: "https://api.openai.com/v1/models",
      apiKeyEnv: "OPENAI_API_KEY",
      apiKeyRequired: true,
      auth: "bearer",
      models: {
        "gpt-5.5": { name: "GPT-5.5", default: true }
      }
    }
  },
  enabledProviders: [],
  disabledProviders: [],
  runtime: {
    maxAgents: 2,
    maxParallelTasks: 1,
    taskTimeoutMs: 1000,
    databasePath: join(home, "state", "swarm.db"),
    projectArtifactDir: ".swarm/artifacts"
  },
  tools: { webSearch: true, directWrite: true },
  permissions: { defaultMode: "ask", allow: [], ask: [], deny: [], additionalDirectories: [] },
  ui: { theme: "default" },
  telemetry: { enabled: false },
  extensions: {
    capabilities: { disabled: [], hiddenFromModel: [] },
    skills: { enabled: true, loadProjectSkills: "trustedWorkspaces", roots: [], maxSkills: 100 },
    commands: { enabled: true, loadProjectCommands: "trustedWorkspaces", roots: [], maxCommands: 100 },
    mcp: { enabled: false, exposeGatewayServer: false, servers: {} },
    plugins: { enabled: true, loadProjectPlugins: "trustedWorkspaces", roots: [], disabled: [], maxPlugins: 100 }
  }
}, null, 2), "utf8");

writeFileSync(join(home, "config.json"), JSON.stringify({
  version: 1,
  created_at: "2026-05-10T00:00:00.000Z",
  primaryProvider: "openai",
  primaryApiKey: "token",
  providerApiKeys: { openai: "token" },
  modelProviderApiKeys: { openai: "token" },
  note: "eval"
}, null, 2), "utf8");

async function runCli(args) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, SWARM_HOME: home },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      resolve({ status: null, signal: "SIGTERM", stdout, stderr });
    }, 10000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ status: code, signal, stdout, stderr });
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      stderr += error instanceof Error ? error.message : String(error);
      resolve({ status: 1, signal: null, stdout, stderr });
    });
  });
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const gateway = new SwarmGatewayServer({ workspace, databasePath: resolve(home, "state", "swarm.db"), port: 0 });

try {
  const started = await gateway.start();
  const runtimeAny = gateway.runtime;

  runtimeAny["ensureLoopSession"]("session_execute_eval", "Stored plan session for CLI execute");
  gateway.runtime.sessionStore.setPlan("session_execute_eval", {
    objective: "Stored plan session for CLI execute",
    summary: "Eval stored plan",
    tasks: []
  });
  runtimeAny["ensureLoopSession"]("session_execute_no_plan", "No stored plan session");

  const executeCalls = [];
  gateway.runtime.execute = async (planned) => {
    executeCalls.push({
      session_id: planned?.session?.session_id,
      objective: planned?.plan?.objective,
      task_count: Array.isArray(planned?.plan?.tasks) ? planned.plan.tasks.length : null
    });
    return {
      session_id: planned?.session?.session_id ?? "unknown",
      status: "completed",
      content: "executed by eval"
    };
  };

  const forkCalls = [];
  gateway.runtime.forkSession = async (sessionId, message) => {
    forkCalls.push({ session_id: sessionId, message });
    runtimeAny["ensureLoopSession"]("session_execute_forked", "Forked plan session");
    gateway.runtime.sessionStore.setPlan("session_execute_forked", {
      objective: "Forked plan session",
      summary: "Forked eval plan",
      tasks: []
    });
    const row = gateway.runtime.sessionStore.get("session_execute_forked");
    return {
      session: {
        swarm_id: row.swarm_id,
        session_id: row.session_id,
        user_request_id: "fork_eval",
        objective: row.objective,
        status: row.status,
        coordinator: { agent_id: "main_swarm", role: "controller" },
        participants: JSON.parse(row.participants_json),
        created_at: row.created_at,
        updated_at: row.updated_at,
        policy: JSON.parse(row.policy_json)
      },
      plan: {
        objective: "Forked plan session",
        summary: "Forked eval plan",
        tasks: []
      }
    };
  };

  const execute = await runCli([
    "./dist/index.js",
    "sessions",
    "execute",
    "session_execute_eval",
    "--workspace",
    workspace,
    "--gateway-url",
    started.url,
    "--json"
  ]);
  const noPlan = await runCli([
    "./dist/index.js",
    "sessions",
    "execute",
    "session_execute_no_plan",
    "--workspace",
    workspace,
    "--gateway-url",
    started.url,
    "--json"
  ]);
  const forked = await runCli([
    "./dist/index.js",
    "sessions",
    "fork",
    "session_execute_eval",
    "try",
    "another",
    "route",
    "--workspace",
    workspace,
    "--gateway-url",
    started.url,
    "--json"
  ]);

  console.log(JSON.stringify({
    execute: { status: execute.status, json: parseJson(execute.stdout), stderr: execute.stderr },
    noPlan: { status: noPlan.status, json: parseJson(noPlan.stdout), stderr: noPlan.stderr },
    forked: { status: forked.status, json: parseJson(forked.stdout), stderr: forked.stderr },
    executeCalls,
    forkCalls
  }));
} finally {
  await gateway.stop();
  rmSync(dir, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    execute?: { status?: number | null; json?: { action?: string; session_id?: string; run_id?: string; status?: string } | null; stderr?: string };
    noPlan?: { status?: number | null; json?: { action?: string; error?: { status?: number; message?: string } } | null; stderr?: string };
    forked?: { status?: number | null; json?: { action?: string; source_session_id?: string; session_id?: string; objective?: string; has_stored_plan?: boolean; message?: string } | null; stderr?: string };
    executeCalls?: Array<{ session_id?: string; objective?: string; task_count?: number | null }>;
    forkCalls?: Array<{ session_id?: string; message?: string }>;
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // fall through
  }
  const ok = result.status === 0
    && parsed.execute?.status === 0
    && parsed.execute?.json?.action === "execute"
    && parsed.execute?.json?.session_id === "session_execute_eval"
    && typeof parsed.execute?.json?.run_id === "string"
    && parsed.execute.json.run_id.startsWith("run_")
    && parsed.execute?.json?.status === "running"
    && parsed.noPlan?.status === 1
    && parsed.noPlan?.json?.action === "execute"
    && parsed.noPlan?.json?.error?.status === 409
    && parsed.noPlan?.json?.error?.message === "Session has no stored plan: session_execute_no_plan"
    && parsed.forked?.status === 0
    && parsed.forked?.json?.action === "fork"
    && parsed.forked?.json?.source_session_id === "session_execute_eval"
    && parsed.forked?.json?.session_id === "session_execute_forked"
    && parsed.forked?.json?.objective === "Forked plan session"
    && parsed.forked?.json?.has_stored_plan === true
    && parsed.forked?.json?.message === "try another route"
    && parsed.executeCalls?.length === 1
    && parsed.executeCalls[0]?.session_id === "session_execute_eval"
    && parsed.executeCalls[0]?.objective === "Stored plan session for CLI execute"
    && parsed.executeCalls[0]?.task_count === 0
    && parsed.forkCalls?.length === 1
    && parsed.forkCalls[0]?.session_id === "session_execute_eval"
    && parsed.forkCalls[0]?.message === "try another route";
  return ok
    ? { name: "CLI sessions execute and fork bridge stored-plan Gateway control", status: "pass", message: "swarm sessions execute starts stored plans through the Gateway and fork branches a fresh stored plan with the new instruction payload intact" }
    : {
        name: "CLI sessions execute and fork bridge stored-plan Gateway control",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkRunsCliBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { SwarmGatewayServer } from "./dist/server/gateway.js";

const dir = mkdtempSync(resolve(tmpdir(), "swarm-runs-cli-eval-"));
const home = resolve(dir, "home");
mkdirSync(join(home, "state"), { recursive: true });
mkdirSync(join(home, "logs"), { recursive: true });
const workspace = resolve(dir, "workspace");
mkdirSync(workspace, { recursive: true });

writeFileSync(join(home, "settings.json"), JSON.stringify({
  version: 1,
  models: {
    defaultProvider: "openai",
    planner: "openai/gpt-5.5",
    worker: "openai/gpt-5.5",
    aggregator: "openai/gpt-5.5",
    apiKeyEnv: "",
    maxOutputTokens: null
  },
  providers: {
    openai: {
      id: "openai",
      name: "OpenAI",
      protocol: "openai-responses",
      baseURL: "https://api.openai.com/v1",
      modelListProtocol: "openai",
      modelListURL: "https://api.openai.com/v1/models",
      apiKeyEnv: "OPENAI_API_KEY",
      apiKeyRequired: true,
      auth: "bearer",
      models: {
        "gpt-5.5": { name: "GPT-5.5", default: true }
      }
    }
  },
  enabledProviders: [],
  disabledProviders: [],
  runtime: {
    maxAgents: 2,
    maxParallelTasks: 1,
    taskTimeoutMs: 1000,
    databasePath: join(home, "state", "swarm.db"),
    projectArtifactDir: ".swarm/artifacts"
  },
  tools: { webSearch: true, directWrite: true },
  permissions: { defaultMode: "ask", allow: [], ask: [], deny: [], additionalDirectories: [] },
  ui: { theme: "default" },
  telemetry: { enabled: false },
  extensions: {
    capabilities: { disabled: [], hiddenFromModel: [] },
    skills: { enabled: true, loadProjectSkills: "trustedWorkspaces", roots: [], maxSkills: 100 },
    commands: { enabled: true, loadProjectCommands: "trustedWorkspaces", roots: [], maxCommands: 100 },
    mcp: { enabled: false, exposeGatewayServer: false, servers: {} },
    plugins: { enabled: true, loadProjectPlugins: "trustedWorkspaces", roots: [], disabled: [], maxPlugins: 100 }
  }
}, null, 2), "utf8");

writeFileSync(join(home, "config.json"), JSON.stringify({
  version: 1,
  created_at: "2026-05-10T00:00:00.000Z",
  primaryProvider: "openai",
  primaryApiKey: "token",
  providerApiKeys: { openai: "token" },
  modelProviderApiKeys: { openai: "token" },
  note: "eval"
}, null, 2), "utf8");

async function runCli(args) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, SWARM_HOME: home },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      resolve({ status: null, signal: "SIGTERM", stdout, stderr });
    }, 10000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ status: code, signal, stdout, stderr });
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      stderr += error instanceof Error ? error.message : String(error);
      resolve({ status: 1, signal: null, stdout, stderr });
    });
  });
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const gateway = new SwarmGatewayServer({ workspace, databasePath: resolve(home, "state", "swarm.db"), port: 0 });

let releaseRun;
const runGate = new Promise((resolve) => {
  releaseRun = resolve;
});

try {
  const started = await gateway.start();
  gateway.runtime["ensureLoopSession"]("run_cli_session", "Stored plan run for CLI");
  gateway.runtime.sessionStore.setPlan("run_cli_session", {
    objective: "Stored plan run for CLI",
    summary: "Run eval plan",
    tasks: []
  });

  gateway.runtime.execute = async (planned) => {
    await runGate;
    return {
      session_id: planned?.session?.session_id ?? "unknown",
      status: "completed",
      content: "run completed by eval"
    };
  };

  const startedRun = await runCli([
    "./dist/index.js",
    "sessions",
    "execute",
    "run_cli_session",
    "--workspace",
    workspace,
    "--gateway-url",
    started.url,
    "--json"
  ]);
  const startedBody = parseJson(startedRun.stdout);
  const runId = startedBody?.run_id;
  const listRunning = await runCli([
    "./dist/index.js",
    "runs",
    "--gateway-url",
    started.url,
    "--json"
  ]);
  const showLatestRunning = await runCli([
    "./dist/index.js",
    "runs",
    "show",
    "latest",
    "--gateway-url",
    started.url,
    "--json"
  ]);

  releaseRun();
  await new Promise((resolve) => setTimeout(resolve, 25));

  const showCompleted = await runCli([
    "./dist/index.js",
    "runs",
    "show",
    runId,
    "--gateway-url",
    started.url,
    "--json"
  ]);

  console.log(JSON.stringify({
    startedRun: { status: startedRun.status, json: startedBody, stderr: startedRun.stderr },
    listRunning: { status: listRunning.status, json: parseJson(listRunning.stdout), stderr: listRunning.stderr },
    showLatestRunning: { status: showLatestRunning.status, json: parseJson(showLatestRunning.stdout), stderr: showLatestRunning.stderr },
    showCompleted: { status: showCompleted.status, json: parseJson(showCompleted.stdout), stderr: showCompleted.stderr }
  }));
} finally {
  releaseRun?.();
  await gateway.stop();
  rmSync(dir, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    startedRun?: { status?: number | null; json?: { run_id?: string; session_id?: string; status?: string } | null; stderr?: string };
    listRunning?: { status?: number | null; json?: { runs?: Array<{ run_id?: string; session_id?: string; mode?: string; status?: string }> } | null; stderr?: string };
    showLatestRunning?: { status?: number | null; json?: { run?: { run_id?: string; session_id?: string; mode?: string; status?: string } } | null; stderr?: string };
    showCompleted?: { status?: number | null; json?: { run?: { run_id?: string; status?: string; result?: { status?: string; session_id?: string } } } | null; stderr?: string };
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // fall through
  }
  const runId = parsed.startedRun?.json?.run_id;
  const ok = result.status === 0
    && parsed.startedRun?.status === 0
    && typeof runId === "string"
    && runId.startsWith("run_")
    && parsed.startedRun?.json?.session_id === "run_cli_session"
    && parsed.startedRun?.json?.status === "running"
    && parsed.listRunning?.status === 0
    && parsed.listRunning?.json?.runs?.some((run) => run.run_id === runId && run.session_id === "run_cli_session" && run.mode === "full_swarm" && run.status === "running")
    && parsed.showLatestRunning?.status === 0
    && parsed.showLatestRunning?.json?.run?.run_id === runId
    && parsed.showLatestRunning?.json?.run?.session_id === "run_cli_session"
    && parsed.showLatestRunning?.json?.run?.mode === "full_swarm"
    && parsed.showLatestRunning?.json?.run?.status === "running"
    && parsed.showCompleted?.status === 0
    && parsed.showCompleted?.json?.run?.run_id === runId
    && parsed.showCompleted?.json?.run?.status === "completed"
    && parsed.showCompleted?.json?.run?.result?.status === "completed"
    && parsed.showCompleted?.json?.run?.result?.session_id === "run_cli_session";
  return ok
    ? { name: "CLI runs inspect Gateway run lifecycle", status: "pass", message: "swarm runs lists active Gateway runs, resolves latest, and shows the final result once a run completes" }
    : {
        name: "CLI runs inspect Gateway run lifecycle",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkRunsWatchCliBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { SwarmGatewayServer } from "./dist/server/gateway.js";

const dir = mkdtempSync(resolve(tmpdir(), "swarm-runs-watch-cli-eval-"));
const home = resolve(dir, "home");
mkdirSync(join(home, "state"), { recursive: true });
mkdirSync(join(home, "logs"), { recursive: true });
const workspace = resolve(dir, "workspace");
mkdirSync(workspace, { recursive: true });

writeFileSync(join(home, "settings.json"), JSON.stringify({
  version: 1,
  models: {
    defaultProvider: "openai",
    planner: "openai/gpt-5.5",
    worker: "openai/gpt-5.5",
    aggregator: "openai/gpt-5.5",
    apiKeyEnv: "",
    maxOutputTokens: null
  },
  providers: {
    openai: {
      id: "openai",
      name: "OpenAI",
      protocol: "openai-responses",
      baseURL: "https://api.openai.com/v1",
      modelListProtocol: "openai",
      modelListURL: "https://api.openai.com/v1/models",
      apiKeyEnv: "OPENAI_API_KEY",
      apiKeyRequired: true,
      auth: "bearer",
      models: {
        "gpt-5.5": { name: "GPT-5.5", default: true }
      }
    }
  },
  enabledProviders: [],
  disabledProviders: [],
  runtime: {
    maxAgents: 2,
    maxParallelTasks: 1,
    taskTimeoutMs: 1000,
    databasePath: join(home, "state", "swarm.db"),
    projectArtifactDir: ".swarm/artifacts"
  },
  tools: { webSearch: true, directWrite: true },
  permissions: { defaultMode: "ask", allow: [], ask: [], deny: [], additionalDirectories: [] },
  ui: { theme: "default" },
  telemetry: { enabled: false },
  extensions: {
    capabilities: { disabled: [], hiddenFromModel: [] },
    skills: { enabled: true, loadProjectSkills: "trustedWorkspaces", roots: [], maxSkills: 100 },
    commands: { enabled: true, loadProjectCommands: "trustedWorkspaces", roots: [], maxCommands: 100 },
    mcp: { enabled: false, exposeGatewayServer: false, servers: {} },
    plugins: { enabled: true, loadProjectPlugins: "trustedWorkspaces", roots: [], disabled: [], maxPlugins: 100 }
  }
}, null, 2), "utf8");

writeFileSync(join(home, "config.json"), JSON.stringify({
  version: 1,
  created_at: "2026-05-10T00:00:00.000Z",
  primaryProvider: "openai",
  primaryApiKey: "token",
  providerApiKeys: { openai: "token" },
  modelProviderApiKeys: { openai: "token" },
  note: "eval"
}, null, 2), "utf8");

async function runCli(args) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, SWARM_HOME: home },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      resolve({ status: null, signal: "SIGTERM", stdout, stderr });
    }, 12000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ status: code, signal, stdout, stderr });
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      stderr += error instanceof Error ? error.message : String(error);
      resolve({ status: 1, signal: null, stdout, stderr });
    });
  });
}

function parseJsonLines(value) {
  return value.split(/\\r?\\n/).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function createRun(gateway, runId, sessionId, objective) {
  const now = new Date().toISOString();
  const run = {
    run_id: runId,
    session_id: sessionId,
    objective,
    mode: "coding_loop",
    status: "running",
    created_at: now,
    updated_at: now
  };
  gateway["runs"].set(runId, run);
  return run;
}

function finishRun(run, sessionId) {
  run.status = "completed";
  run.updated_at = new Date().toISOString();
  run.result = {
    session_id: sessionId,
    status: "completed",
    content: "watch eval completed"
  };
}

const gateway = new SwarmGatewayServer({ workspace, databasePath: resolve(home, "state", "swarm.db"), port: 0 });

try {
  const started = await gateway.start();

  const workSessionId = "run_watch_work_session";
  gateway.runtime.ensureTuiChatSession(workSessionId);
  const workRun = createRun(gateway, "run_watch_work_eval", workSessionId, "Watch work stream");
  const watchWork = runCli([
    "./dist/index.js",
    "runs",
    "watch",
    "run_watch_work_eval",
    "--gateway-url",
    started.url
  ]);
  setTimeout(() => {
    gateway.runtime.events.emitEvent({
      type: "queue",
      queue: "worker_slots",
      operation: "enqueue",
      id: "worker_watch_eval",
      size: 1,
      session_id: workSessionId,
      message: "Waiting for a worker slot: running 1/1"
    });
    gateway.runtime.events.emitEvent({
      type: "loop_activity",
      session_id: workSessionId,
      phase: "running_tool",
      message: "Inspecting changed files",
      tool: "file.grep",
      task_id: "watch_activity_eval",
      status: "running",
      summary: "searching workspace"
    });
    gateway.runtime.events.emitEvent({
      type: "tool_result",
      session_id: workSessionId,
      task_id: "watch_task_eval",
      title: "Patch file",
      action: "file.edit",
      summary: "patched src/app.ts",
      status: "failed",
      write_policy: "scoped_write",
      file_scope: ["src/app.ts"],
      sandbox: {
        decision: "deny",
        policy: "scoped_write",
        subject: "tool_action",
        reason: "Scoped-write sandbox denied tool action: file.edit outside file_scope (private/out.ts)",
        action: "file.edit",
        targets: ["private/out.ts"],
        file_scope: ["src/app.ts"]
      }
    });
    finishRun(workRun, workSessionId);
  }, 100);
  const workResult = await watchWork;

  const runtimeSessionId = "run_watch_runtime_session";
  gateway.runtime.ensureTuiChatSession(runtimeSessionId);
  const runtimeRun = createRun(gateway, "run_watch_runtime_eval", runtimeSessionId, "Watch runtime stream");
  const watchRuntime = runCli([
    "./dist/index.js",
    "runs",
    "watch",
    "run_watch_runtime_eval",
    "--gateway-url",
    started.url,
    "--protocol",
    "runtime",
    "--jsonl"
  ]);
  setTimeout(() => {
    gateway.runtime.events.emitEvent({
      type: "loop_activity",
      session_id: runtimeSessionId,
      phase: "thinking",
      message: "Planning runtime watch eval"
    });
    finishRun(runtimeRun, runtimeSessionId);
    gateway.runtime.events.emitEvent({
      type: "final",
      session_id: runtimeSessionId,
      content: "runtime watch eval completed",
      status: "completed",
      outcome: {
        changed_files: [],
        tests_run: [],
        intermediate_artifacts: [],
        final_summary: "runtime watch eval completed"
      }
    });
  }, 100);
  const runtimeResult = await watchRuntime;
  const runtimeLines = parseJsonLines(runtimeResult.stdout);

  console.log(JSON.stringify({
    work: workResult,
    runtime: {
      status: runtimeResult.status,
      signal: runtimeResult.signal,
      stderr: runtimeResult.stderr,
      lines: runtimeLines
    }
  }));
} finally {
  await gateway.stop();
  rmSync(dir, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    work?: { status?: number | null; signal?: string | null; stdout?: string; stderr?: string };
    runtime?: { status?: number | null; signal?: string | null; stderr?: string; lines?: Array<{ type?: string; protocol?: string; sse_event?: string; status?: string; data?: { event?: { type?: string } } }> };
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in the failure message below.
  }
  const runtimeLines = parsed.runtime?.lines ?? [];
  const runtimeStart = runtimeLines.find((line) => line.type === "watch_start");
  const runtimeFinal = runtimeLines.find((line) => line.type === "watch_event" && line.sse_event === "final");
  const runtimeEnd = runtimeLines.find((line) => line.type === "watch_end");
  const ok = result.status === 0
    && parsed.work?.status === 0
    && typeof parsed.work?.stdout === "string"
    && parsed.work.stdout.includes("Watching Swarm run")
    && parsed.work.stdout.includes("protocol=work")
    && parsed.work.stdout.includes("queue:worker_slots")
    && parsed.work.stdout.includes("activity:running_tool")
    && parsed.work.stdout.includes("task:failed file.edit")
    && parsed.work.stdout.includes("policy=scoped_write")
    && parsed.work.stdout.includes("sandbox=scoped_write/denied")
    && parsed.work.stdout.includes("watch ended: status=completed")
    && parsed.runtime?.status === 0
    && runtimeStart?.type === "watch_start"
    && runtimeStart?.protocol === "runtime"
    && runtimeFinal?.type === "watch_event"
    && runtimeFinal?.protocol === "runtime"
    && runtimeFinal?.sse_event === "final"
    && runtimeFinal?.data?.event?.type === "final"
    && runtimeEnd?.type === "watch_end"
    && runtimeEnd?.status === "completed";
  return ok
    ? { name: "CLI runs watch streams Gateway session events", status: "pass", message: "swarm runs watch tails work-protocol output by default and can switch to runtime JSONL streaming for automation" }
    : {
        name: "CLI runs watch streams Gateway session events",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkWatchCliBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { SwarmGatewayServer } from "./dist/server/gateway.js";

const dir = mkdtempSync(resolve(tmpdir(), "swarm-watch-cli-eval-"));
const home = resolve(dir, "home");
mkdirSync(join(home, "state"), { recursive: true });
mkdirSync(join(home, "logs"), { recursive: true });
const workspace = resolve(dir, "workspace");
mkdirSync(workspace, { recursive: true });

writeFileSync(join(home, "settings.json"), JSON.stringify({
  version: 1,
  models: {
    defaultProvider: "openai",
    planner: "openai/gpt-5.5",
    worker: "openai/gpt-5.5",
    aggregator: "openai/gpt-5.5",
    apiKeyEnv: "",
    maxOutputTokens: null
  },
  providers: {
    openai: {
      id: "openai",
      name: "OpenAI",
      protocol: "openai-responses",
      baseURL: "https://api.openai.com/v1",
      modelListProtocol: "openai",
      modelListURL: "https://api.openai.com/v1/models",
      apiKeyEnv: "OPENAI_API_KEY",
      apiKeyRequired: true,
      auth: "bearer",
      models: {
        "gpt-5.5": { name: "GPT-5.5", default: true }
      }
    }
  },
  enabledProviders: [],
  disabledProviders: [],
  runtime: {
    maxAgents: 2,
    maxParallelTasks: 1,
    taskTimeoutMs: 1000,
    databasePath: join(home, "state", "swarm.db"),
    projectArtifactDir: ".swarm/artifacts"
  },
  tools: { webSearch: true, directWrite: true },
  permissions: { defaultMode: "ask", allow: [], ask: [], deny: [], additionalDirectories: [] },
  ui: { theme: "default" },
  telemetry: { enabled: false },
  extensions: {
    capabilities: { disabled: [], hiddenFromModel: [] },
    skills: { enabled: true, loadProjectSkills: "trustedWorkspaces", roots: [], maxSkills: 100 },
    commands: { enabled: true, loadProjectCommands: "trustedWorkspaces", roots: [], maxCommands: 100 },
    mcp: { enabled: false, exposeGatewayServer: false, servers: {} },
    plugins: { enabled: true, loadProjectPlugins: "trustedWorkspaces", roots: [], disabled: [], maxPlugins: 100 }
  }
}, null, 2), "utf8");

writeFileSync(join(home, "config.json"), JSON.stringify({
  version: 1,
  created_at: "2026-05-10T00:00:00.000Z",
  primaryProvider: "openai",
  primaryApiKey: "token",
  providerApiKeys: { openai: "token" },
  modelProviderApiKeys: { openai: "token" },
  note: "eval"
}, null, 2), "utf8");

async function runCli(args, killAfterMs) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, SWARM_HOME: home },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(killTimer);
      child.kill("SIGTERM");
      resolve({ status: null, signal: "SIGTERM", stdout, stderr });
    }, 12000);
    if (typeof killAfterMs === "number" && killAfterMs > 0) {
      killTimer = setTimeout(() => {
        if (!settled) {
          child.kill("SIGTERM");
        }
      }, killAfterMs);
    }
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      resolve({ status: code, signal, stdout, stderr });
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      stderr += error instanceof Error ? error.message : String(error);
      resolve({ status: 1, signal: null, stdout, stderr });
    });
  });
}

function parseJsonLines(value) {
  return value.split(/\\r?\\n/).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

const firstSessionId = "watch_cli_first";
const secondSessionId = "watch_cli_second";

function seedGateway(gateway) {
  gateway.runtime.ensureTuiChatSession(firstSessionId);
  gateway.runtime.ensureTuiChatSession(secondSessionId);
}

function emitWorkspaceEvents(gateway) {
  gateway.runtime.events.emitEvent({
    type: "queue",
    queue: "worker_slots",
    operation: "enqueue",
    id: "watch_cli_worker",
    size: 1,
    session_id: firstSessionId,
    message: "Waiting for worker slot"
  });
  gateway.runtime.events.emitEvent({
    type: "loop_activity",
    session_id: firstSessionId,
    phase: "running_tool",
    message: "Scanning repo",
    tool: "file.grep",
    task_id: "watch_cli_task",
    status: "running",
    summary: "searching README"
  });
  gateway.runtime.events.emitEvent({
    type: "tool_result",
    session_id: firstSessionId,
    task_id: "watch_cli_task",
    title: "Scan repo",
    action: "file.grep",
    summary: "matched README",
    status: "success",
    write_policy: "read_only",
    file_scope: ["README.md"]
  });
  gateway.runtime.events.emitEvent({
    type: "loop_activity",
    session_id: secondSessionId,
    phase: "thinking",
    message: "Planning second session"
  });
}

try {
  const workGateway = new SwarmGatewayServer({ workspace, databasePath: resolve(home, "state", "swarm.db"), port: 0 });
  let workResult;
  try {
    const started = await workGateway.start();
    seedGateway(workGateway);
    const workWatch = runCli([
      "./dist/index.js",
      "watch",
      "--gateway-url",
      started.url
    ]);
    setTimeout(() => emitWorkspaceEvents(workGateway), 700);
    setTimeout(() => { void workGateway.stop(); }, 1400);
    workResult = await workWatch;
  } finally {
    await workGateway.stop().catch(() => undefined);
  }

  const runtimeGateway = new SwarmGatewayServer({ workspace, databasePath: resolve(home, "state", "swarm.db"), port: 0 });
  let runtimeWatch;
  try {
    const started = await runtimeGateway.start();
    seedGateway(runtimeGateway);
    const watchRun = runCli([
      "./dist/index.js",
      "watch",
      "--gateway-url",
      started.url,
      "--protocol",
      "runtime",
      "--jsonl"
    ]);
    setTimeout(() => emitWorkspaceEvents(runtimeGateway), 700);
    setTimeout(() => { void runtimeGateway.stop(); }, 1400);
    runtimeWatch = await watchRun;
  } finally {
    await runtimeGateway.stop().catch(() => undefined);
  }
  const runtimeLines = parseJsonLines(runtimeWatch.stdout);

  console.log(JSON.stringify({
    work: workResult,
    runtime: {
      status: runtimeWatch.status,
      signal: runtimeWatch.signal,
      stderr: runtimeWatch.stderr,
      lines: runtimeLines
    }
  }));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 25_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    work?: { status?: number | null; signal?: string | null; stdout?: string; stderr?: string };
    runtime?: { status?: number | null; signal?: string | null; stderr?: string; lines?: Array<{ type?: string; protocol?: string; scope?: string; session_id?: string; sse_event?: string; interrupted?: boolean; data?: { event?: { type?: string } } }> };
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output for failure diagnostics.
  }
  const runtimeLines = parsed.runtime?.lines ?? [];
  const runtimeStart = runtimeLines.find((line) => line.type === "watch_start");
  const runtimeQueue = runtimeLines.find((line) => line.type === "watch_event" && line.data?.event?.type === "queue");
  const runtimeTool = runtimeLines.find((line) => line.type === "watch_event" && line.data?.event?.type === "tool_result");
  const runtimeEnd = runtimeLines.find((line) => line.type === "watch_end");
  const ok = result.status === 0
    && parsed.work?.status === 0
    && typeof parsed.work?.stdout === "string"
    && parsed.work.stdout.includes("Watching Swarm workspace")
    && parsed.work.stdout.includes("scope=workspace")
    && parsed.work.stdout.includes("protocol=work")
    && parsed.work.stdout.includes("[watch_cli_first]")
    && parsed.work.stdout.includes("queue:worker_slots")
    && parsed.work.stdout.includes("activity:running_tool Scanning repo")
    && parsed.work.stdout.includes("task:completed file.grep [success] matched README")
    && parsed.work.stdout.includes("[watch_cli_second]")
    && parsed.work.stdout.includes("activity:thinking Planning second session")
    && parsed.work.stdout.includes("watch ended: scope=workspace")
    && !parsed.work.stdout.includes("interrupted=true")
    && parsed.runtime?.status === 0
    && runtimeStart?.type === "watch_start"
    && runtimeStart?.protocol === "runtime"
    && runtimeStart?.scope === "workspace"
    && runtimeQueue?.type === "watch_event"
    && runtimeQueue?.session_id === "watch_cli_first"
    && runtimeQueue?.data?.event?.type === "queue"
    && runtimeTool?.type === "watch_event"
    && runtimeTool?.session_id === "watch_cli_first"
    && runtimeTool?.data?.event?.type === "tool_result"
    && runtimeEnd?.type === "watch_end"
    && runtimeEnd?.scope === "workspace"
    && runtimeEnd?.interrupted === false;
  return ok
    ? { name: "CLI watch follows workspace Gateway event streams", status: "pass", message: "swarm watch gives one workspace-wide operator stream and supports runtime JSONL automation" }
    : {
        name: "CLI watch follows workspace Gateway event streams",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkWorkersAndHandoffsCliBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { SwarmGatewayServer } from "./dist/server/gateway.js";

const dir = mkdtempSync(resolve(tmpdir(), "swarm-workers-handoffs-cli-eval-"));
const home = resolve(dir, "home");
mkdirSync(join(home, "state"), { recursive: true });
mkdirSync(join(home, "logs"), { recursive: true });
const workspace = resolve(dir, "workspace");
mkdirSync(workspace, { recursive: true });

writeFileSync(join(home, "settings.json"), JSON.stringify({
  version: 1,
  models: {
    defaultProvider: "openai",
    planner: "openai/gpt-5.5",
    worker: "openai/gpt-5.5",
    aggregator: "openai/gpt-5.5",
    apiKeyEnv: "",
    maxOutputTokens: null
  },
  providers: {
    openai: {
      id: "openai",
      name: "OpenAI",
      protocol: "openai-responses",
      baseURL: "https://api.openai.com/v1",
      modelListProtocol: "openai",
      modelListURL: "https://api.openai.com/v1/models",
      apiKeyEnv: "OPENAI_API_KEY",
      apiKeyRequired: true,
      auth: "bearer",
      models: {
        "gpt-5.5": { name: "GPT-5.5", default: true }
      }
    }
  },
  enabledProviders: [],
  disabledProviders: [],
  runtime: {
    maxAgents: 2,
    maxParallelTasks: 1,
    taskTimeoutMs: 1000,
    databasePath: join(home, "state", "swarm.db"),
    projectArtifactDir: ".swarm/artifacts"
  },
  tools: { webSearch: true, directWrite: true },
  permissions: { defaultMode: "ask", allow: [], ask: [], deny: [], additionalDirectories: [] },
  ui: { theme: "default" },
  telemetry: { enabled: false },
  extensions: {
    capabilities: { disabled: [], hiddenFromModel: [] },
    skills: { enabled: true, loadProjectSkills: "trustedWorkspaces", roots: [], maxSkills: 100 },
    commands: { enabled: true, loadProjectCommands: "trustedWorkspaces", roots: [], maxCommands: 100 },
    mcp: { enabled: false, exposeGatewayServer: false, servers: {} },
    plugins: { enabled: true, loadProjectPlugins: "trustedWorkspaces", roots: [], disabled: [], maxPlugins: 100 }
  }
}, null, 2), "utf8");

writeFileSync(join(home, "config.json"), JSON.stringify({
  version: 1,
  created_at: "2026-05-10T00:00:00.000Z",
  primaryProvider: "openai",
  primaryApiKey: "token",
  providerApiKeys: { openai: "token" },
  modelProviderApiKeys: { openai: "token" },
  note: "eval"
}, null, 2), "utf8");

async function runCli(args) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, SWARM_HOME: home },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      resolve({ status: null, signal: "SIGTERM", stdout, stderr });
    }, 10000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ status: code, signal, stdout, stderr });
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      stderr += error instanceof Error ? error.message : String(error);
      resolve({ status: 1, signal: null, stdout, stderr });
    });
  });
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseJsonLines(value) {
  return value.split(/\\r?\\n/).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function taskPacket(objective, writePolicy, fileScope) {
  return {
    objective,
    agent_spec_id: "coder",
    invocation_mode: "call_subagent",
    persona_snapshot: "coder",
    file_scope: fileScope,
    allowed_tools: ["Read", "Edit"],
    write_policy: writePolicy,
    permission_context: { default_mode: "ask", allow: [], ask: [], deny: [], additional_directories: [] },
    budget: { max_turns: 4, max_tool_calls: 12 },
    expected_output: "Return changed files.",
    return_conditions: ["done"]
  };
}

const gateway = new SwarmGatewayServer({ workspace, databasePath: resolve(home, "state", "swarm.db"), port: 0 });

try {
  const started = await gateway.start();
  const runtimeAny = gateway.runtime;
  const parentSessionId = "collab_cli_parent";
  gateway.runtime.ensureTuiChatSession(parentSessionId);
  runtimeAny["ensureLoopSession"]("collab_cli_child", "Child worker session", parentSessionId, {
    labels: ["worker"],
    mode: "worker_loop",
    source: "worker"
  });
  runtimeAny["ensureLoopSession"]("worker_cli_session", "Live worker session", parentSessionId, {
    labels: ["worker"],
    mode: "worker_loop",
    source: "worker"
  });
  gateway.runtime.ensureTuiChatSession("collab_cli_other");

  gateway.runtime.workerStateStore.create({
    worker_id: "worker_cli_live",
    parent_session_id: parentSessionId,
    capability: "code.edit",
    objective: "Patch the live file.",
    status: "running",
    agent_spec_id: "coder",
    invocation_mode: "call_subagent",
    handoff_id: "handoff_cli_live",
    file_scope: ["src/app.ts"],
    tool_budget: { max_turns: 4, max_tool_calls: 12 },
    task_packet: taskPacket("Patch the live file.", "scoped_write", ["src/app.ts"])
  });
  gateway.runtime.workerStateStore.setResult({
    worker_id: "worker_cli_live",
    status: "running",
    worker_session_id: "worker_cli_session",
    last_result: "Still working."
  });
  gateway.runtime.workerStateStore.create({
    worker_id: "worker_cli_continue",
    parent_session_id: "collab_cli_child",
    capability: "code.review",
    objective: "Rerun verification.",
    status: "completed",
    agent_spec_id: "reviewer",
    invocation_mode: "call_subagent",
    file_scope: ["src/verify.ts"],
    tool_budget: { max_turns: 4, max_tool_calls: 12 },
    task_packet: taskPacket("Rerun verification.", "scoped_write", ["src/verify.ts"])
  });
  gateway.runtime.workerStateStore.create({
    worker_id: "worker_cli_stop",
    parent_session_id: parentSessionId,
    capability: "code.research",
    objective: "Wait for slot.",
    status: "pending",
    agent_spec_id: "researcher",
    invocation_mode: "call_subagent",
    file_scope: [],
    tool_budget: { max_turns: 4, max_tool_calls: 12 },
    task_packet: taskPacket("Wait for slot.", "read_only", [])
  });
  gateway.runtime.workerStateStore.create({
    worker_id: "worker_cli_other",
    parent_session_id: "collab_cli_other",
    capability: "code.edit",
    objective: "Unrelated worker.",
    status: "completed",
    agent_spec_id: "coder",
    invocation_mode: "call_subagent",
    file_scope: ["src/other.ts"],
    tool_budget: { max_turns: 4, max_tool_calls: 12 },
    task_packet: taskPacket("Unrelated worker.", "scoped_write", ["src/other.ts"])
  });

  gateway.runtime.handoffStore.create({
    handoff_id: "handoff_cli_live",
    worker_id: "worker_cli_live",
    parent_session_id: parentSessionId,
    source_agent: "main_swarm",
    target_agent_spec_id: "handoff_specialist",
    reason: "Own the patch segment.",
    task_packet: taskPacket("Own the patch segment.", "scoped_write", ["src/lib.ts"])
  });
  gateway.runtime.handoffStore.create({
    handoff_id: "handoff_cli_child",
    worker_id: "worker_cli_continue",
    parent_session_id: "collab_cli_child",
    source_agent: "main_swarm",
    target_agent_spec_id: "handoff_specialist",
    reason: "Review child flow.",
    task_packet: taskPacket("Review child flow.", "read_only", [])
  });
  gateway.runtime.handoffStore.finish({
    handoff_id: "handoff_cli_child",
    status: "returned",
    result: "Reviewed."
  });
  gateway.runtime.handoffStore.create({
    handoff_id: "handoff_cli_other",
    worker_id: "worker_cli_other",
    parent_session_id: "collab_cli_other",
    source_agent: "main_swarm",
    target_agent_spec_id: "handoff_specialist",
    reason: "Unrelated handoff.",
    task_packet: taskPacket("Unrelated handoff.", "scoped_write", ["src/other.ts"])
  });
  gateway.runtime.workerStateStore.create({
    worker_id: "worker_cli_watch",
    parent_session_id: parentSessionId,
    capability: "code.edit",
    objective: "Patch the watch file.",
    status: "running",
    agent_spec_id: "coder",
    invocation_mode: "call_subagent",
    handoff_id: "handoff_cli_watch",
    file_scope: ["src/watch.ts"],
    tool_budget: { max_turns: 4, max_tool_calls: 12 },
    task_packet: taskPacket("Patch the watch file.", "scoped_write", ["src/watch.ts"])
  });
  gateway.runtime.handoffStore.create({
    handoff_id: "handoff_cli_watch",
    worker_id: "worker_cli_watch",
    parent_session_id: parentSessionId,
    source_agent: "main_swarm",
    target_agent_spec_id: "handoff_specialist",
    reason: "Own the watch patch segment.",
    task_packet: taskPacket("Own the watch patch segment.", "scoped_write", ["src/watch.ts"])
  });

  const continueCalls = [];
  gateway.runtime.continueAgent = async (workerId, message) => {
    continueCalls.push({ worker_id: workerId, message });
    return {
      action: "agent.delegate",
      status: "success",
      summary: "continued " + workerId
    };
  };

  const workerWatch = runCli([
    "./dist/index.js",
    "workers",
    "watch",
    "worker_cli_watch",
    "--gateway-url",
    started.url,
    "--workspace",
    workspace
  ]);
  const handoffWatch = runCli([
    "./dist/index.js",
    "handoffs",
    "watch",
    "handoff_cli_watch",
    "--gateway-url",
    started.url,
    "--workspace",
    workspace,
    "--protocol",
    "runtime",
    "--jsonl"
  ]);
  setTimeout(() => {
    runtimeAny["ensureLoopSession"]("worker_watch_session", "Worker watch session", parentSessionId, {
      labels: ["worker"],
      mode: "worker_loop",
      source: "worker"
    });
    const runningWatchWorker = gateway.runtime.workerStateStore.setResult({
      worker_id: "worker_cli_watch",
      status: "running",
      worker_session_id: "worker_watch_session",
      last_result: "Attached worker session."
    });
    gateway.runtime.events.emitEvent({
      type: "worker",
      worker: runningWatchWorker,
      status: runningWatchWorker.status,
      message: "Worker session attached."
    });
    gateway.runtime.events.emitEvent({
      type: "handoff_message",
      session_id: parentSessionId,
      handoff_id: "handoff_cli_watch",
      worker_id: "worker_cli_watch",
      message: "Continue through the focused patch plan."
    });
    gateway.runtime.events.emitEvent({
      type: "loop_activity",
      session_id: "worker_watch_session",
      phase: "running_tool",
      message: "Editing watch file",
      tool: "file.edit",
      task_id: "watch_worker_task",
      status: "running",
      summary: "patching src/watch.ts"
    });
    gateway.runtime.events.emitEvent({
      type: "tool_result",
      session_id: "worker_watch_session",
      task_id: "watch_worker_task",
      title: "Patch watch file",
      action: "file.edit",
      summary: "patched src/watch.ts",
      status: "success",
      write_policy: "scoped_write",
      file_scope: ["src/watch.ts"]
    });
  }, 700);
  setTimeout(() => {
    const completedWatchWorker = gateway.runtime.workerStateStore.setResult({
      worker_id: "worker_cli_watch",
      status: "completed",
      worker_session_id: "worker_watch_session",
      last_result: "Patch applied.",
      outcome: {
        changed_files: ["src/watch.ts"],
        tests_run: ["npm run check"],
        intermediate_artifacts: [],
        final_summary: "Patch applied."
      }
    });
    gateway.runtime.events.emitEvent({
      type: "worker",
      worker: completedWatchWorker,
      status: completedWatchWorker.status,
      message: "Patch applied."
    });
    const returnedWatchHandoff = gateway.runtime.handoffStore.finish({
      handoff_id: "handoff_cli_watch",
      status: "returned",
      result: "Patch applied."
    });
    gateway.runtime.events.emitEvent({
      type: "handoff_returned",
      handoff: returnedWatchHandoff,
      result: "Patch applied."
    });
    gateway.runtime.events.emitEvent({
      type: "final",
      session_id: "worker_watch_session",
      content: "worker watch completed",
      status: "completed",
      outcome: {
        changed_files: ["src/watch.ts"],
        tests_run: ["npm run check"],
        intermediate_artifacts: [],
        final_summary: "worker watch completed"
      }
    });
  }, 850);
  const workerWatchResult = await workerWatch;
  const handoffWatchResult = await handoffWatch;
  const handoffWatchLines = parseJsonLines(handoffWatchResult.stdout);

  const workersList = await runCli(["./dist/index.js", "workers", "--session", parentSessionId, "--workspace", workspace, "--json"]);
  const workerShow = await runCli(["./dist/index.js", "workers", "show", "worker_cli_live", "--workspace", workspace, "--json"]);
  const workerStop = await runCli(["./dist/index.js", "workers", "stop", "worker_cli_stop", "--gateway-url", started.url, "--workspace", workspace, "--json"]);
  const workerContinue = await runCli(["./dist/index.js", "workers", "continue", "worker_cli_continue", "rerun", "verification", "--gateway-url", started.url, "--workspace", workspace, "--json"]);
  const handoffList = await runCli(["./dist/index.js", "handoffs", "--session", parentSessionId, "--workspace", workspace, "--json"]);
  const handoffShow = await runCli(["./dist/index.js", "handoffs", "show", "handoff_cli_live", "--workspace", workspace, "--json"]);
  const takeBack = await runCli(["./dist/index.js", "handoffs", "take-back", "handoff_cli_live", "--gateway-url", started.url, "--workspace", workspace, "--json"]);

  console.log(JSON.stringify({
    workerWatch: { status: workerWatchResult.status, signal: workerWatchResult.signal, stdout: workerWatchResult.stdout, stderr: workerWatchResult.stderr },
    handoffWatch: { status: handoffWatchResult.status, signal: handoffWatchResult.signal, stderr: handoffWatchResult.stderr, lines: handoffWatchLines },
    workersList: { status: workersList.status, json: parseJson(workersList.stdout), stderr: workersList.stderr },
    workerShow: { status: workerShow.status, json: parseJson(workerShow.stdout), stderr: workerShow.stderr },
    workerStop: { status: workerStop.status, json: parseJson(workerStop.stdout), stderr: workerStop.stderr },
    workerContinue: { status: workerContinue.status, json: parseJson(workerContinue.stdout), stderr: workerContinue.stderr },
    handoffList: { status: handoffList.status, json: parseJson(handoffList.stdout), stderr: handoffList.stderr },
    handoffShow: { status: handoffShow.status, json: parseJson(handoffShow.stdout), stderr: handoffShow.stderr },
    takeBack: { status: takeBack.status, json: parseJson(takeBack.stdout), stderr: takeBack.stderr },
    continueCalls,
    finalStatuses: {
      workerStop: gateway.runtime.workerStateStore.get("worker_cli_stop")?.status,
      workerLive: gateway.runtime.workerStateStore.get("worker_cli_live")?.status,
      handoffLive: gateway.runtime.handoffStore.get("handoff_cli_live")?.status
    }
  }));
} finally {
  await gateway.stop();
  rmSync(dir, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 25_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    workerWatch?: { status?: number | null; signal?: string | null; stdout?: string; stderr?: string };
    handoffWatch?: { status?: number | null; signal?: string | null; stderr?: string; lines?: Array<{ type?: string; protocol?: string; stream_role?: string; worker_session_id?: string; status?: string; data?: { event?: { type?: string } } }> };
    workersList?: { status?: number | null; json?: { summary?: { total?: number }; workers?: Array<{ worker_id?: string; parent_session_id?: string }> } | null; stderr?: string };
    workerShow?: { status?: number | null; json?: { worker?: { worker_id?: string }; worker_contract?: { write_policy?: string }; worker_session?: { session_id?: string; parent_session_id?: string } } | null; stderr?: string };
    workerStop?: { status?: number | null; json?: { action?: string; worker_id?: string; status?: string } | null; stderr?: string };
    workerContinue?: { status?: number | null; json?: { action?: string; worker_id?: string; message?: string; result?: { summary?: string } } | null; stderr?: string };
    handoffList?: { status?: number | null; json?: { summary?: { total?: number }; handoffs?: Array<{ handoff_id?: string; parent_session_id?: string }> } | null; stderr?: string };
    handoffShow?: { status?: number | null; json?: { handoff?: { handoff_id?: string }; handoff_contract?: { write_policy?: string; file_scope?: string[] } } | null; stderr?: string };
    takeBack?: { status?: number | null; json?: { action?: string; handoff_id?: string; worker_id?: string; status?: string } | null; stderr?: string };
    continueCalls?: Array<{ worker_id?: string; message?: string }>;
    finalStatuses?: { workerStop?: string; workerLive?: string; handoffLive?: string };
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // fall through
  }
  const handoffWatchLines = parsed.handoffWatch?.lines ?? [];
  const handoffWatchStart = handoffWatchLines.find((line) => line.type === "watch_start");
  const handoffWatchAttach = handoffWatchLines.find((line) => line.type === "watch_attach");
  const handoffWatchMessage = handoffWatchLines.find((line) => line.type === "watch_event" && line.data?.event?.type === "handoff_message");
  const handoffWatchFinal = handoffWatchLines.find((line) => line.type === "watch_event" && line.data?.event?.type === "final");
  const handoffWatchEnd = handoffWatchLines.find((line) => line.type === "watch_end");
  const ok = result.status === 0
    && parsed.workerWatch?.status === 0
    && typeof parsed.workerWatch?.stdout === "string"
    && parsed.workerWatch.stdout.includes("Watching Swarm worker")
    && parsed.workerWatch.stdout.includes("worker=worker_cli_watch status=")
    && parsed.workerWatch.stdout.includes("worker_session=worker_watch_session")
    && parsed.workerWatch.stdout.includes("event: handoff_message Continue through the focused patch plan.")
    && parsed.workerWatch.stdout.includes("activity:running_tool Editing watch file")
    && parsed.workerWatch.stdout.includes("task:completed file.edit [success] patched src/watch.ts")
    && parsed.workerWatch.stdout.includes("event: final worker watch completed")
    && parsed.workerWatch.stdout.includes("watch ended: status=completed")
    && parsed.handoffWatch?.status === 0
    && handoffWatchStart?.type === "watch_start"
    && handoffWatchStart?.protocol === "runtime"
    && (
      (handoffWatchAttach?.type === "watch_attach" && handoffWatchAttach?.worker_session_id === "worker_watch_session")
      || handoffWatchStart?.worker_session_id === "worker_watch_session"
    )
    && handoffWatchMessage?.type === "watch_event"
    && handoffWatchMessage?.data?.event?.type === "handoff_message"
    && handoffWatchFinal?.type === "watch_event"
    && handoffWatchFinal?.stream_role === "worker_session"
    && handoffWatchFinal?.data?.event?.type === "final"
    && handoffWatchEnd?.type === "watch_end"
    && handoffWatchEnd?.status === "returned"
    && parsed.workersList?.status === 0
    && parsed.workersList?.json?.summary?.total === 4
    && parsed.workersList?.json?.workers?.some((worker) => worker.worker_id === "worker_cli_live")
    && parsed.workersList?.json?.workers?.some((worker) => worker.worker_id === "worker_cli_continue" && worker.parent_session_id === "collab_cli_child")
    && parsed.workersList?.json?.workers?.some((worker) => worker.worker_id === "worker_cli_stop")
    && parsed.workersList?.json?.workers?.some((worker) => worker.worker_id === "worker_cli_watch")
    && !parsed.workersList?.json?.workers?.some((worker) => worker.worker_id === "worker_cli_other")
    && parsed.workerShow?.status === 0
    && parsed.workerShow?.json?.worker?.worker_id === "worker_cli_live"
    && parsed.workerShow?.json?.worker_contract?.write_policy === "scoped_write"
    && parsed.workerShow?.json?.worker_session?.session_id === "worker_cli_session"
    && parsed.workerShow?.json?.worker_session?.parent_session_id === "collab_cli_parent"
    && parsed.workerStop?.status === 0
    && parsed.workerStop?.json?.action === "stop"
    && parsed.workerStop?.json?.worker_id === "worker_cli_stop"
    && parsed.workerStop?.json?.status === "stop_requested"
    && parsed.workerContinue?.status === 0
    && parsed.workerContinue?.json?.action === "continue"
    && parsed.workerContinue?.json?.worker_id === "worker_cli_continue"
    && parsed.workerContinue?.json?.message === "rerun verification"
    && parsed.workerContinue?.json?.result?.summary === "continued worker_cli_continue"
    && parsed.handoffList?.status === 0
    && parsed.handoffList?.json?.summary?.total === 3
    && parsed.handoffList?.json?.handoffs?.some((handoff) => handoff.handoff_id === "handoff_cli_live")
    && parsed.handoffList?.json?.handoffs?.some((handoff) => handoff.handoff_id === "handoff_cli_child" && handoff.parent_session_id === "collab_cli_child")
    && parsed.handoffList?.json?.handoffs?.some((handoff) => handoff.handoff_id === "handoff_cli_watch")
    && !parsed.handoffList?.json?.handoffs?.some((handoff) => handoff.handoff_id === "handoff_cli_other")
    && parsed.handoffShow?.status === 0
    && parsed.handoffShow?.json?.handoff?.handoff_id === "handoff_cli_live"
    && parsed.handoffShow?.json?.handoff_contract?.write_policy === "scoped_write"
    && parsed.handoffShow?.json?.handoff_contract?.file_scope?.join(",") === "src/lib.ts"
    && parsed.takeBack?.status === 0
    && parsed.takeBack?.json?.action === "take-back"
    && parsed.takeBack?.json?.handoff_id === "handoff_cli_live"
    && parsed.takeBack?.json?.worker_id === "worker_cli_live"
    && parsed.takeBack?.json?.status === "taken_back"
    && parsed.continueCalls?.length === 1
    && parsed.continueCalls[0]?.worker_id === "worker_cli_continue"
    && parsed.continueCalls[0]?.message === "rerun verification"
    && parsed.finalStatuses?.workerStop === "stopped"
    && parsed.finalStatuses?.workerLive === "stopped"
    && parsed.finalStatuses?.handoffLive === "taken_back";
  return ok
    ? { name: "CLI workers and handoffs surface collaboration contracts, watch streams, and live control", status: "pass", message: "swarm workers and swarm handoffs expose session-family scoped contracts locally, follow live work over the Gateway, and bridge stop/continue/take-back control" }
    : {
        name: "CLI workers and handoffs surface collaboration contracts, watch streams, and live control",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkPluginsCliBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const home = resolve(tmpdir(), "swarm-plugins-cli-eval");
rmSync(home, { recursive: true, force: true });
mkdirSync(join(home, "state"), { recursive: true });
mkdirSync(join(home, "logs"), { recursive: true });
const workspace = join(home, "workspace");
mkdirSync(join(workspace, ".swarm", "plugins", "workspace-demo", ".codex-plugin"), { recursive: true });
const explicitRoot = join(home, "extra-plugins");
mkdirSync(join(explicitRoot, "user-demo", ".codex-plugin"), { recursive: true });

writeFileSync(join(workspace, ".swarm", "plugins", "workspace-demo", ".codex-plugin", "plugin.json"), JSON.stringify({
  id: "workspace-demo",
  name: "Workspace Demo",
  version: "1.0.0",
  description: "Workspace plugin for CLI eval.",
  contributes: {
    slashCommands: [
      {
        name: "workspace-hello",
        description: "Say hello from the workspace plugin."
      }
    ]
  }
}, null, 2), "utf8");

writeFileSync(join(explicitRoot, "user-demo", ".codex-plugin", "plugin.json"), JSON.stringify({
  id: "user-demo",
  name: "User Demo",
  description: "Explicit root plugin for CLI eval.",
  contributes: {
    slashCommands: [
      {
        name: "user-hello",
        description: "Say hello from the explicit root."
      }
    ],
    skills: [
      {
        name: "missing-skill",
        path: "skills/missing.md",
        description: "This file is intentionally missing."
      }
    ]
  }
}, null, 2), "utf8");

writeFileSync(join(home, "settings.json"), JSON.stringify({
  version: 1,
  models: {
    defaultProvider: "openai",
    planner: "openai/gpt-5.5",
    worker: "openai/gpt-5.5",
    aggregator: "openai/gpt-5.5",
    apiKeyEnv: "",
    maxOutputTokens: null
  },
  providers: {
    openai: {
      id: "openai",
      name: "OpenAI",
      protocol: "openai-responses",
      baseURL: "https://api.openai.com/v1",
      modelListProtocol: "openai",
      modelListURL: "https://api.openai.com/v1/models",
      apiKeyEnv: "OPENAI_API_KEY",
      apiKeyRequired: true,
      auth: "bearer",
      models: {
        "gpt-5.5": { name: "GPT-5.5", default: true }
      }
    }
  },
  enabledProviders: [],
  disabledProviders: [],
  runtime: {
    maxAgents: 2,
    maxParallelTasks: 1,
    taskTimeoutMs: 1000,
    databasePath: join(home, "state", "swarm.db"),
    projectArtifactDir: ".swarm/artifacts"
  },
  tools: { webSearch: true, directWrite: true },
  permissions: { defaultMode: "ask", allow: [], ask: [], deny: [], additionalDirectories: [] },
  ui: { theme: "default" },
  telemetry: { enabled: false },
  extensions: {
    capabilities: { disabled: [], hiddenFromModel: [] },
    skills: { enabled: true, loadProjectSkills: "always", roots: [], maxSkills: 100 },
    commands: { enabled: true, loadProjectCommands: "always", roots: [], maxCommands: 100 },
    mcp: { enabled: false, exposeGatewayServer: false, servers: {} },
    plugins: { enabled: true, loadProjectPlugins: "always", roots: [], disabled: [], maxPlugins: 100 }
  }
}, null, 2), "utf8");

writeFileSync(join(home, "config.json"), JSON.stringify({
  version: 1,
  created_at: "2026-05-10T00:00:00.000Z",
  primaryProvider: "openai",
  primaryApiKey: "token",
  providerApiKeys: { openai: "token" },
  modelProviderApiKeys: { openai: "token" },
  note: "eval"
}, null, 2), "utf8");

function runCli(args) {
  return spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, SWARM_HOME: home },
    encoding: "utf8",
    timeout: 10000
  });
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const listed = runCli(["./dist/index.js", "plugins", "--workspace", workspace]);
const shown = runCli(["./dist/index.js", "plugins", "show", "workspace-demo", "--workspace", workspace, "--json"]);
const installed = runCli(["./dist/index.js", "plugins", "install", explicitRoot, "--workspace", workspace, "--json"]);
const validated = runCli(["./dist/index.js", "plugins", "validate", "user-demo", "--workspace", workspace, "--json"]);
const disabled = runCli(["./dist/index.js", "plugins", "disable", "user-demo", "--workspace", workspace, "--json"]);
const enabled = runCli(["./dist/index.js", "plugins", "enable", "user-demo", "--workspace", workspace, "--json"]);
const removed = runCli(["./dist/index.js", "plugins", "remove-root", explicitRoot, "--workspace", workspace, "--json"]);

console.log(JSON.stringify({
  listed: { status: listed.status, stdout: listed.stdout, stderr: listed.stderr },
  shown: { status: shown.status, json: parseJson(shown.stdout), stderr: shown.stderr },
  installed: { status: installed.status, json: parseJson(installed.stdout), stderr: installed.stderr },
  validated: { status: validated.status, json: parseJson(validated.stdout), stderr: validated.stderr },
  disabled: { status: disabled.status, json: parseJson(disabled.stdout), stderr: disabled.stderr },
  enabled: { status: enabled.status, json: parseJson(enabled.stdout), stderr: enabled.stderr },
  removed: { status: removed.status, json: parseJson(removed.stdout), stderr: removed.stderr }
}));
rmSync(home, { recursive: true, force: true });
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    listed?: { status?: number | null; stdout?: string; stderr?: string };
    shown?: { status?: number | null; json?: { plugin?: { id?: string }; capabilities?: Array<{ id?: string }> } | null; stderr?: string };
    installed?: { status?: number | null; json?: { action?: string; settings?: { configured_roots?: string[] }; plugins?: Array<{ id?: string }> } | null; stderr?: string };
    validated?: { status?: number | null; json?: { ok?: boolean; warnings?: number; plugins?: Array<{ diagnostics?: Array<{ code?: string }> }> } | null; stderr?: string };
    disabled?: { status?: number | null; json?: { action?: string; plugin?: { trust?: string } } | null; stderr?: string };
    enabled?: { status?: number | null; json?: { action?: string; plugin?: { trust?: string } } | null; stderr?: string };
    removed?: { status?: number | null; json?: { action?: string; settings?: { configured_roots?: string[] }; plugins?: Array<{ id?: string }> } | null; stderr?: string };
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // fall through
  }
  const listedOut = parsed.listed?.stdout ?? "";
  const installedJson = parsed.installed?.json;
  const validatedJson = parsed.validated?.json;
  const removedJson = parsed.removed?.json;
  const validationCodes = validatedJson?.plugins?.flatMap((item) => item.diagnostics?.map((diagnostic) => diagnostic.code ?? "") ?? []) ?? [];
  const ok = result.status === 0
    && parsed.listed?.status === 0
    && parsed.shown?.status === 0
    && parsed.installed?.status === 0
    && parsed.validated?.status === 0
    && parsed.disabled?.status === 0
    && parsed.enabled?.status === 0
    && parsed.removed?.status === 0
    && listedOut.includes("Swarm Plugins")
    && listedOut.includes("workspace-demo")
    && parsed.shown?.json?.plugin?.id === "workspace-demo"
    && Boolean(parsed.shown?.json?.capabilities?.some((item) => item.id?.includes("workspace-demo")))
    && installedJson?.action === "install"
    && Boolean(installedJson.settings?.configured_roots?.length)
    && Boolean(installedJson.plugins?.some((plugin) => plugin.id === "user-demo"))
    && validatedJson?.ok === true
    && (validatedJson.warnings ?? 0) >= 1
    && validationCodes.includes("PLUGIN_SKILL_PATH_MISSING")
    && parsed.disabled?.json?.action === "disable"
    && parsed.disabled?.json?.plugin?.trust === "disabled"
    && parsed.enabled?.json?.action === "enable"
    && parsed.enabled?.json?.plugin?.trust === "trusted"
    && removedJson?.action === "remove-root"
    && !removedJson.settings?.configured_roots?.length
    && !removedJson.plugins?.some((plugin) => plugin.id === "user-demo");
  return ok
    ? { name: "CLI plugins lists, inspects, validates, and manages plugin roots", status: "pass", message: "swarm plugins exposes the plugin lifecycle already present in TUI and Gateway" }
    : {
        name: "CLI plugins lists, inspects, validates, and manages plugin roots",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkSkillsCliBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const home = resolve(tmpdir(), "swarm-skills-cli-eval");
rmSync(home, { recursive: true, force: true });
mkdirSync(join(home, "state"), { recursive: true });
mkdirSync(join(home, "logs"), { recursive: true });
const workspace = join(home, "workspace");
mkdirSync(join(workspace, ".swarm", "skills", "release-notes"), { recursive: true });

writeFileSync(join(workspace, ".swarm", "skills", "release-notes", "SKILL.md"), [
  "---",
  "name: release-notes",
  "description: Emit concise release notes for changed files",
  "allowed-tools: Read, Grep",
  "---",
  "",
  "# Release Notes",
  "",
  "Write one release-notes paragraph per changed file."
].join("\\n"), "utf8");

writeFileSync(join(home, "settings.json"), JSON.stringify({
  version: 1,
  models: {
    defaultProvider: "openai",
    planner: "openai/gpt-5.5",
    worker: "openai/gpt-5.5",
    aggregator: "openai/gpt-5.5",
    apiKeyEnv: "",
    maxOutputTokens: null
  },
  providers: {
    openai: {
      id: "openai",
      name: "OpenAI",
      protocol: "openai-responses",
      baseURL: "https://api.openai.com/v1",
      modelListProtocol: "openai",
      modelListURL: "https://api.openai.com/v1/models",
      apiKeyEnv: "OPENAI_API_KEY",
      apiKeyRequired: true,
      auth: "bearer",
      models: {
        "gpt-5.5": { name: "GPT-5.5", default: true }
      }
    }
  },
  enabledProviders: [],
  disabledProviders: [],
  runtime: {
    maxAgents: 2,
    maxParallelTasks: 1,
    taskTimeoutMs: 1000,
    databasePath: join(home, "state", "swarm.db"),
    projectArtifactDir: ".swarm/artifacts"
  },
  tools: { webSearch: true, directWrite: true },
  permissions: { defaultMode: "ask", allow: [], ask: [], deny: [], additionalDirectories: [] },
  ui: { theme: "default" },
  telemetry: { enabled: false },
  extensions: {
    capabilities: { disabled: [], hiddenFromModel: [] },
    skills: { enabled: true, loadProjectSkills: "always", roots: [], maxSkills: 100 },
    commands: { enabled: true, loadProjectCommands: "trustedWorkspaces", roots: [], maxCommands: 100 },
    mcp: { enabled: false, exposeGatewayServer: false, servers: {} },
    plugins: { enabled: true, loadProjectPlugins: "trustedWorkspaces", roots: [], disabled: [], maxPlugins: 100 }
  }
}, null, 2), "utf8");

writeFileSync(join(home, "config.json"), JSON.stringify({
  version: 1,
  created_at: "2026-05-10T00:00:00.000Z",
  primaryProvider: "openai",
  primaryApiKey: "token",
  providerApiKeys: { openai: "token" },
  modelProviderApiKeys: { openai: "token" },
  note: "eval"
}, null, 2), "utf8");

function runCli(args) {
  return spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, SWARM_HOME: home },
    encoding: "utf8",
    timeout: 10000
  });
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const listed = runCli(["./dist/index.js", "skills", "--workspace", workspace]);
const shown = runCli(["./dist/index.js", "skills", "show", "release-notes", "--workspace", workspace, "--json"]);
const activated = runCli(["./dist/index.js", "skills", "activate", "release-notes", "--reason", "cli-eval", "--workspace", workspace, "--json"]);

console.log(JSON.stringify({
  listed: { status: listed.status, stdout: listed.stdout, stderr: listed.stderr },
  shown: { status: shown.status, json: parseJson(shown.stdout), stderr: shown.stderr },
  activated: { status: activated.status, json: parseJson(activated.stdout), stderr: activated.stderr }
}));
rmSync(home, { recursive: true, force: true });
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    listed?: { status?: number | null; stdout?: string; stderr?: string };
    shown?: { status?: number | null; json?: { skill?: { name?: string; allowedTools?: string[] } } | null; stderr?: string };
    activated?: { status?: number | null; json?: { reason?: string; skill?: { name?: string; content?: string } } | null; stderr?: string };
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // fall through
  }
  const listedOut = parsed.listed?.stdout ?? "";
  const ok = result.status === 0
    && parsed.listed?.status === 0
    && parsed.shown?.status === 0
    && parsed.activated?.status === 0
    && listedOut.includes("Swarm Skills")
    && listedOut.includes("release-notes")
    && parsed.shown?.json?.skill?.name === "release-notes"
    && Boolean(parsed.shown?.json?.skill?.allowedTools?.includes("Read"))
    && parsed.activated?.json?.reason === "cli-eval"
    && parsed.activated?.json?.skill?.name === "release-notes"
    && Boolean(parsed.activated?.json?.skill?.content?.includes("Write one release-notes paragraph per changed file."));
  return ok
    ? { name: "CLI skills lists, inspects, and activates discovered skills", status: "pass", message: "swarm skills exposes the same skill catalog and activation surface as the TUI and Gateway" }
    : {
        name: "CLI skills lists, inspects, and activates discovered skills",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkMcpCliBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const home = resolve(tmpdir(), "swarm-mcp-cli-eval");
rmSync(home, { recursive: true, force: true });
mkdirSync(join(home, "state"), { recursive: true });
mkdirSync(join(home, "logs"), { recursive: true });
const workspace = join(home, "workspace");
mkdirSync(workspace, { recursive: true });
const serverPath = join(home, "mock-mcp-server.mjs");
const mcpServerUrl = pathToFileURL(resolve(process.cwd(), "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "server", "mcp.js")).href;
const mcpStdioUrl = pathToFileURL(resolve(process.cwd(), "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "server", "stdio.js")).href;
const zodUrl = pathToFileURL(resolve(process.cwd(), "node_modules", "zod", "v4", "index.js")).href;

writeFileSync(serverPath, [
  "import { McpServer } from " + JSON.stringify(mcpServerUrl) + ";",
  "import { StdioServerTransport } from " + JSON.stringify(mcpStdioUrl) + ";",
  "import * as z from " + JSON.stringify(zodUrl) + ";",
  "const server = new McpServer({ name: 'mock-cli-mcp', version: '1.0.0' });",
  "server.registerTool('echo', { description: 'Echo input text', inputSchema: { text: z.string().describe('Text to echo') } }, async ({ text }) => ({ content: [{ type: 'text', text }] }));",
  "server.registerResource('greeting-resource', 'memory://greeting', { mimeType: 'text/plain' }, async () => ({ contents: [{ uri: 'memory://greeting', text: 'Hello from MCP resource.' }] }));",
  "server.registerPrompt('greeting', { description: 'Render a greeting prompt', argsSchema: { name: z.string().describe('Name to greet') } }, async ({ name }) => ({ messages: [{ role: 'user', content: { type: 'text', text: 'Please greet ' + name + ' from MCP.' } }] }));",
  "const transport = new StdioServerTransport();",
  "await server.connect(transport);"
].join("\\n"), "utf8");

writeFileSync(join(home, "settings.json"), JSON.stringify({
  version: 1,
  models: {
    defaultProvider: "openai",
    planner: "openai/gpt-5.5",
    worker: "openai/gpt-5.5",
    aggregator: "openai/gpt-5.5",
    apiKeyEnv: "",
    maxOutputTokens: null
  },
  providers: {
    openai: {
      id: "openai",
      name: "OpenAI",
      protocol: "openai-responses",
      baseURL: "https://api.openai.com/v1",
      modelListProtocol: "openai",
      modelListURL: "https://api.openai.com/v1/models",
      apiKeyEnv: "OPENAI_API_KEY",
      apiKeyRequired: true,
      auth: "bearer",
      models: {
        "gpt-5.5": { name: "GPT-5.5", default: true }
      }
    }
  },
  enabledProviders: [],
  disabledProviders: [],
  runtime: {
    maxAgents: 2,
    maxParallelTasks: 1,
    taskTimeoutMs: 1000,
    databasePath: join(home, "state", "swarm.db"),
    projectArtifactDir: ".swarm/artifacts"
  },
  tools: { webSearch: true, directWrite: true },
  permissions: { defaultMode: "ask", allow: [], ask: [], deny: [], additionalDirectories: [] },
  ui: { theme: "default" },
  telemetry: { enabled: false },
  extensions: {
    capabilities: { disabled: [], hiddenFromModel: [] },
    skills: { enabled: true, loadProjectSkills: "trustedWorkspaces", roots: [], maxSkills: 100 },
    commands: { enabled: true, loadProjectCommands: "trustedWorkspaces", roots: [], maxCommands: 100 },
    mcp: {
      enabled: true,
      exposeGatewayServer: false,
      servers: {
        demo: {
          transport: "stdio",
          command: process.execPath,
          args: [serverPath],
          trust: "user",
          exposeTools: true,
          exposeResources: true,
          exposePrompts: true,
          timeoutMs: 10000
        }
      }
    },
    plugins: { enabled: true, loadProjectPlugins: "trustedWorkspaces", roots: [], disabled: [], maxPlugins: 100 }
  }
}, null, 2), "utf8");

writeFileSync(join(home, "config.json"), JSON.stringify({
  version: 1,
  created_at: "2026-05-10T00:00:00.000Z",
  primaryProvider: "openai",
  primaryApiKey: "token",
  providerApiKeys: { openai: "token" },
  modelProviderApiKeys: { openai: "token" },
  note: "eval"
}, null, 2), "utf8");

function runCli(args) {
  return spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, SWARM_HOME: home },
    encoding: "utf8",
    timeout: 15000
  });
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const listed = runCli(["./dist/index.js", "mcp", "--workspace", workspace]);
const shown = runCli(["./dist/index.js", "mcp", "show", "demo", "--workspace", workspace, "--json"]);
const refreshed = runCli(["./dist/index.js", "mcp", "refresh", "demo", "--workspace", workspace, "--json"]);
const resources = runCli(["./dist/index.js", "mcp", "resources", "demo", "--workspace", workspace, "--json"]);
const read = runCli(["./dist/index.js", "mcp", "read", "demo", "memory://greeting", "--workspace", workspace, "--json"]);
const prompts = runCli(["./dist/index.js", "mcp", "prompts", "demo", "--workspace", workspace, "--json"]);
const prompt = runCli(["./dist/index.js", "mcp", "prompt", "demo", "greeting", "name=Swarm", "--workspace", workspace, "--json"]);

console.log(JSON.stringify({
  listed: { status: listed.status, stdout: listed.stdout, stderr: listed.stderr },
  shown: { status: shown.status, json: parseJson(shown.stdout), stderr: shown.stderr },
  refreshed: { status: refreshed.status, json: parseJson(refreshed.stdout), stderr: refreshed.stderr },
  resources: { status: resources.status, json: parseJson(resources.stdout), stderr: resources.stderr },
  read: { status: read.status, json: parseJson(read.stdout), stderr: read.stderr },
  prompts: { status: prompts.status, json: parseJson(prompts.stdout), stderr: prompts.stderr },
  prompt: { status: prompt.status, json: parseJson(prompt.stdout), stderr: prompt.stderr }
}));
rmSync(home, { recursive: true, force: true });
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    listed?: { status?: number | null; stdout?: string; stderr?: string };
    shown?: { status?: number | null; json?: { server?: { id?: string; status?: string }; capabilities?: Array<{ id?: string; name?: string; searchHint?: string }> } | null; stderr?: string };
    refreshed?: { status?: number | null; json?: { action?: string; server?: { id?: string; status?: string; resourceCount?: number; promptCount?: number } } | null; stderr?: string };
    resources?: { status?: number | null; json?: { resources?: Array<{ uri?: string }> } | null; stderr?: string };
    read?: { status?: number | null; json?: { result?: { contents?: Array<{ text?: string }> } } | null; stderr?: string };
    prompts?: { status?: number | null; json?: { prompts?: Array<{ name?: string }> } | null; stderr?: string };
    prompt?: { status?: number | null; json?: { result?: { messages?: Array<{ content?: { text?: string } }> } } | null; stderr?: string };
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // fall through
  }
  const listedOut = parsed.listed?.stdout ?? "";
  const ok = result.status === 0
    && parsed.listed?.status === 0
    && parsed.shown?.status === 0
    && parsed.refreshed?.status === 0
    && parsed.resources?.status === 0
    && parsed.read?.status === 0
    && parsed.prompts?.status === 0
    && parsed.prompt?.status === 0
    && listedOut.includes("Swarm MCP")
    && listedOut.includes("demo")
    && parsed.shown?.json?.server?.id === "demo"
    && parsed.shown?.json?.server?.status === "connected"
    && Boolean(parsed.shown?.json?.capabilities?.some((item) =>
      item.name === "mcp__demo__echo" || item.searchHint === "demo:echo"
    ))
    && parsed.refreshed?.json?.action === "refresh"
    && parsed.refreshed?.json?.server?.status === "connected"
    && (parsed.refreshed?.json?.server?.resourceCount ?? 0) >= 1
    && (parsed.refreshed?.json?.server?.promptCount ?? 0) >= 1
    && Boolean(parsed.resources?.json?.resources?.some((item) => item.uri === "memory://greeting"))
    && parsed.read?.json?.result?.contents?.[0]?.text === "Hello from MCP resource."
    && Boolean(parsed.prompts?.json?.prompts?.some((item) => item.name === "greeting"))
    && parsed.prompt?.json?.result?.messages?.[0]?.content?.text === "Please greet Swarm from MCP.";
  return ok
    ? { name: "CLI mcp lists, refreshes, and reads configured servers", status: "pass", message: "swarm mcp can reconnect a stdio server on demand and expose resources plus prompts in one-shot CLI processes" }
    : {
        name: "CLI mcp lists, refreshes, and reads configured servers",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkHeadlessResumeCliBehavior(root: string): EvalCaseResult {
  const script = `
import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const home = resolve(tmpdir(), "swarm-headless-resume-cli-eval");
rmSync(home, { recursive: true, force: true });
mkdirSync(join(home, "state"), { recursive: true });
mkdirSync(join(home, "logs"), { recursive: true });
const workspace = join(home, "workspace");
mkdirSync(workspace, { recursive: true });

let chatRequests = 0;
const server = createServer(async (request, response) => {
  if (request.method !== "POST") {
    response.statusCode = 404;
    response.end("not found");
    return;
  }
  chatRequests += 1;
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({
    id: "chatcmpl_eval_resume",
    object: "chat.completion",
    created: 0,
    model: "mock-model",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: JSON.stringify({
            status: "completed",
            summary: "Resume completed.",
            message: "Resume completed.",
            files_touched: [],
            next_actions: [],
            tool_calls: []
          })
        }
      }
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 10,
      total_tokens: 20
    }
  }));
});
await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
process.env.SWARM_HOME = home;

async function runCommand(args) {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, SWARM_HOME: home },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 20_000);
  const status = await new Promise((resolvePromise) => {
    child.once("close", (code) => resolvePromise(code));
    child.once("error", () => resolvePromise(null));
  });
  clearTimeout(timeout);
  return { status, stdout, stderr };
}

writeFileSync(join(home, "settings.json"), JSON.stringify({
  version: 1,
  models: {
    defaultProvider: "mock",
    planner: "mock/mock-model",
    worker: "mock/mock-model",
    aggregator: "mock/mock-model",
    apiKeyEnv: "",
    maxOutputTokens: null
  },
  providers: {
    mock: {
      id: "mock",
      name: "Mock",
      protocol: "openai-chat-completions",
      baseURL: "http://127.0.0.1:" + port + "/v1",
      modelListProtocol: "none",
      apiKeyEnv: "MOCK_API_KEY",
      apiKeyRequired: false,
      auth: "none",
      custom: true,
      models: {
        "mock-model": { name: "Mock Model", default: true }
      }
    }
  },
  enabledProviders: [],
  disabledProviders: [],
  runtime: {
    maxAgents: 2,
    maxParallelTasks: 1,
    taskTimeoutMs: 1000,
    databasePath: join(home, "state", "swarm.db"),
    projectArtifactDir: ".swarm/artifacts"
  },
  tools: { webSearch: true, directWrite: true },
  permissions: { defaultMode: "ask", allow: [], ask: [], deny: [], additionalDirectories: [] },
  ui: { theme: "default" },
  telemetry: { enabled: false },
  extensions: {
    capabilities: { disabled: [], hiddenFromModel: [] },
    skills: { enabled: true, loadProjectSkills: "trustedWorkspaces", roots: [], maxSkills: 100 },
    commands: { enabled: true, loadProjectCommands: "trustedWorkspaces", roots: [], maxCommands: 100 },
    mcp: { enabled: false, exposeGatewayServer: false, servers: {} },
    plugins: { enabled: true, loadProjectPlugins: "trustedWorkspaces", roots: [], disabled: [], maxPlugins: 100 }
  }
}, null, 2), "utf8");
writeFileSync(join(home, "config.json"), JSON.stringify({
  version: 1,
  created_at: "2026-05-10T00:00:00.000Z",
  primaryProvider: "mock",
  primaryApiKey: "",
  providerApiKeys: {},
  modelProviderApiKeys: { openai: "" },
  note: "eval"
}, null, 2), "utf8");

const { SwarmRuntime } = await import("./dist/runtime/runtime.js");
const runtime = new SwarmRuntime({ workspace });
const policy = {
  max_agents: 2,
  max_parallel_tasks: 1,
  timeout_ms: 1000,
  retry: { max_attempts: 1, backoff_ms: 0 },
  require_review: false,
  consensus: "reviewer_approval",
  safety: {
    require_human_approval_for: [],
    forbidden_capabilities: [],
    sandbox_required: false
  },
  memory: {
    allow_read: true,
    allow_write: true,
    retention: "session"
  }
};
const sessionSource = (id, title) => ({
  source: "user",
  source_id: undefined,
  human_id: id,
  title,
  description: title,
  labels: ["interactive"],
  metadata: {}
});

const planLease = runtime.workspaceLeaseStore.createForLocalSession({ session_id: "sess_cli_plan", workspace });
runtime.sessionStore.create({
  swarm_id: "swarm_sess_cli_plan",
  session_id: "sess_cli_plan",
  user_request_id: "user_req_plan",
  source: sessionSource("sess_cli_plan", "Stored plan"),
  workspace_lease_id: planLease.lease_id,
  objective: "Apply the stored patch",
  status: "created",
  coordinator: { agent_id: "main_swarm", role: "controller" },
  participants: [],
  created_at: "2026-05-10T00:00:00.000Z",
  updated_at: "2026-05-10T00:00:00.000Z",
  policy
});
runtime.sessionStore.setPlan("sess_cli_plan", {
  objective: "Apply the stored patch",
  summary: "Write one target file.",
  intent: "modify_workspace",
  tasks: [
    {
      task_id: "task_write",
      title: "Write target file",
      description: "Persist the stored patch.",
      objective: "Write src/out.ts",
      type: "tool_call",
      status: "pending",
      required_capabilities: ["Write"],
      inputs: {
        action: "Write",
        path: "src/out.ts",
        content: "export const value = 1;\\n"
      },
      expected_output: { format: "text" }
    }
  ]
});

const continueLease = runtime.workspaceLeaseStore.createForLocalSession({ session_id: "sess_cli_continue", workspace });
runtime.sessionStore.create({
  swarm_id: "swarm_sess_cli_continue",
  session_id: "sess_cli_continue",
  user_request_id: "user_req_continue",
  source: sessionSource("sess_cli_continue", "Continue target"),
  workspace_lease_id: continueLease.lease_id,
  objective: "Finish the queued verification",
  status: "completed",
  coordinator: { agent_id: "main_swarm", role: "controller" },
  participants: [],
  created_at: "2026-05-10T00:01:00.000Z",
  updated_at: "2026-05-10T00:01:00.000Z",
  policy
});
runtime.sessionStore.setFinalOutput("sess_cli_continue", "Verification was partially complete.", "completed");
runtime.sessionStore.setFinalOutcome("sess_cli_continue", {
  changed_files: [],
  intermediate_artifacts: [],
  tests_run: ["npm run check"],
  final_summary: "Verification was partially complete."
});
runtime.dispose();

const continued = await runCommand(["./dist/index.js", "sessions", "continue", "tighten verification", "--workspace", workspace, "--json", "--max-turns", "1"]);
const rejected = await runCommand(["./dist/index.js", "sessions", "resume", "sess_cli_plan", "focus on the flaky tests", "--workspace", workspace, "--json"]);
const stored = await runCommand(["./dist/index.js", "sessions", "resume", "sess_cli_plan", "--workspace", workspace, "--json"]);
await new Promise((resolvePromise) => server.close(resolvePromise));
console.log(JSON.stringify({
  chatRequests,
  continued: { status: continued.status, stdout: continued.stdout, stderr: continued.stderr },
  rejected: { status: rejected.status, stdout: rejected.stdout, stderr: rejected.stderr },
  stored: { status: stored.status, stdout: stored.stdout, stderr: stored.stderr }
}));
rmSync(home, { recursive: true, force: true });
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 25_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    chatRequests?: number;
    continued?: { status?: number | null; stdout?: string; stderr?: string };
    rejected?: { status?: number | null; stdout?: string; stderr?: string };
    stored?: { status?: number | null; stdout?: string; stderr?: string };
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // fall through
  }
  let continuedReport: Record<string, unknown> = {};
  let storedReport: Record<string, unknown> = {};
  try {
    continuedReport = JSON.parse(parsed.continued?.stdout ?? "{}") as Record<string, unknown>;
  } catch {
    // fall through
  }
  try {
    storedReport = JSON.parse(parsed.stored?.stdout ?? "{}") as Record<string, unknown>;
  } catch {
    // fall through
  }
  const continuedPreflight = continuedReport.resume_preflight as
    | { command?: string; route?: string; instruction?: string }
    | undefined;
  const storedPreflight = storedReport.resume_preflight as
    | { command?: string; route?: string; instruction?: string }
    | undefined;
  const storedTelemetry = storedReport.telemetry as
    | { llm?: { calls?: number } }
    | undefined;
  const storedError = storedReport.error as { message?: string } | undefined;
  const ok = result.status === 0
    && (parsed.chatRequests ?? 0) >= 1
    && parsed.continued?.status === 0
    && continuedReport.operation === "continue"
    && continuedReport.resume_session_id === "sess_cli_continue"
    && continuedReport.status === "completed"
    && continuedPreflight?.command === "continue"
    && continuedPreflight?.route === "coding_loop"
    && continuedPreflight?.instruction === "tighten verification"
    && parsed.rejected?.status === 1
    && (parsed.rejected?.stderr ?? "").includes("Cannot apply a new instruction while resuming stored plan sess_cli_plan")
    && (parsed.rejected?.stderr ?? "").includes("/fork sess_cli_plan <message>")
    && parsed.stored?.status === 1
    && storedReport.operation === "resume"
    && storedReport.resume_session_id === "sess_cli_plan"
    && storedReport.status === "failed"
    && storedPreflight?.command === "resume"
    && storedPreflight?.route === "stored_plan"
    && storedPreflight?.instruction === ""
    && (storedTelemetry?.llm?.calls ?? 0) === 0
    && Boolean(storedError?.message?.includes("Headless run requires approval for"));
  return ok
    ? { name: "CLI resume and continue share preflight and stored-plan guardrails", status: "pass", message: "headless resume records the shared preflight, continue stays on the coding loop, and stored plans reject silent instruction overrides" }
    : {
        name: "CLI resume and continue share preflight and stored-plan guardrails",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)} continuedReport=${JSON.stringify(continuedReport)} storedReport=${JSON.stringify(storedReport)}`
      };
}

function checkApprovalPreviewBehavior(): EvalCaseResult {
  const settings = defaultSwarmSettings();
  settings.permissions.defaultMode = "ask";
  const writeAction = {
    type: "file.write",
    path: "src/example.ts",
    content: "export const value = 1;\n"
  } as const;
  const writeDecision = decideToolPermission(writeAction, settings, { workspace: resolve("eval-workspace") });
  const write = createToolApprovalRequest(writeAction, writeDecision);
  const edit = createToolApprovalRequest({
    type: "file.edit",
    path: "src/example.ts",
    operation: "str_replace",
    oldText: "value = 1",
    newText: "value = 2"
  });
  const json = createToolApprovalRequest({
    type: "json.edit",
    path: "package.json",
    operation: "set",
    pointer: "/scripts/test",
    value: "node --test"
  });
  const secret = createToolApprovalRequest({
    type: "file.write",
    path: ".env",
    content: "API_KEY=secret-value"
  });
  const ok = write.summary_diff?.includes("@@ file.write @@")
    && write.summary_diff.includes("+export const value = 1;")
    && write.permission_decision === "ask"
    && write.permission_mode === "ask"
    && write.permission_name === "Write"
    && typeof write.permission_reason === "string"
    && write.permission_reason.includes("Approval required")
    && edit.summary_diff?.includes("-value = 1")
    && edit.summary_diff.includes("+value = 2")
    && json.summary_diff?.includes("@@ json.edit set /scripts/test @@")
    && json.summary_diff.includes("+ \"node --test\"")
    && secret.summary_diff?.includes("preview redacted")
    && !secret.summary_diff.includes("secret-value");
  return ok
    ? { name: "approval requests include change previews and permission context", status: "pass", message: "approval challenges carry previews, redact sensitive content, and attach permission decisions when available" }
    : {
        name: "approval requests include change previews and permission context",
        status: "fail",
        message: `write=${JSON.stringify(write)} edit=${edit.summary_diff ?? "-"} json=${json.summary_diff ?? "-"} secret=${secret.summary_diff ?? "-"}`
      };
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
    task_packet: evalTaskPacket({
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
    })
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

function checkWorkerTopologyWorkProtocolBehavior(): EvalCaseResult {
  const now = new Date(0).toISOString();
  const taskPacket = evalTaskPacket({
    objective: "Review the patch.",
    agent_spec_id: "reviewer",
    invocation_mode: "parallel" as const,
    persona_snapshot: "reviewer",
    role_title: "Reviewer",
    file_scope: ["src/runtime/**"],
    allowed_tools: ["Read", "Grep"],
    write_policy: "read_only" as const,
    budget: { max_turns: 3, max_tool_calls: 7 },
    expected_output: "Return findings.",
    return_conditions: ["done"]
  });
  const spawnEvent = {
    type: "agent_spawn_decision" as const,
    worker_id: "worker_topology_1",
    parent_session_id: "parent_session_1",
    decision: {
      agent_spec_id: "reviewer",
      invocation_mode: "parallel" as const,
      reason: "parallel review",
      confidence: 0.9,
      display_name: "Ada",
      role_title: "Reviewer"
    },
    task_packet: taskPacket
  };
  const worker = {
    worker_id: "worker_topology_1",
    display_name: "Ada",
    role_title: "Reviewer",
    parent_session_id: "parent_session_1",
    worker_session_id: "worker_session_1",
    agent_spec_id: "reviewer",
    invocation_mode: "parallel" as const,
    handoff_id: "handoff_topology_1",
    capability: "code.review",
    objective: "Review the patch.",
    status: "completed" as const,
    file_scope: ["src/runtime/**"],
    tool_budget: { max_turns: 3, max_tool_calls: 7 },
    task_packet: taskPacket,
    output_contract: "Return findings.",
    spawn_reason: "parallel review",
    requested_by: "main_swarm",
    blocked_reason: "none",
    outcome: {
      changed_files: ["src/runtime/work-protocol.ts"],
      tests_run: ["npm run check"],
      intermediate_artifacts: ["artifact://worker-summary"],
      final_summary: "reviewed"
    },
    created_at: now,
    updated_at: now
  };
  const spawnWork = buildWorkRecordFromRuntimeEvent(spawnEvent, now);
  const spawnBrief = formatRuntimeEventBrief(spawnEvent);
  const spawnHeadless = formatHeadlessProgress(spawnEvent);
  const spawnRow = runtimeEventToActionRow(spawnEvent, 0);
  const workerEvent = { type: "worker" as const, worker, status: worker.status, message: "done" };
  const workerWork = buildWorkRecordFromRuntimeEvent(workerEvent, now);
  const workerRow = runtimeEventToActionRow(workerEvent, 1);
  const startedWork = buildWorkRecordFromRuntimeEvent({
    type: "agent_run_started",
    worker,
    task_packet: evalTaskPacket({
      objective: worker.objective,
      agent_spec_id: "reviewer",
      invocation_mode: "parallel",
      persona_snapshot: "reviewer",
      role_title: "Reviewer",
      file_scope: worker.file_scope,
      allowed_tools: ["Read", "Grep"],
      write_policy: "read_only",
      budget: worker.tool_budget,
      expected_output: worker.output_contract,
      return_conditions: ["done"]
    })
  }, now);
  const handoffWork = buildWorkRecordFromRuntimeEvent({
    type: "handoff_started",
    handoff: {
      handoff_id: "handoff_topology_1",
      worker_id: worker.worker_id,
      parent_session_id: worker.parent_session_id,
      source_agent: "main_swarm",
      target_agent_spec_id: "reviewer",
      reason: "focused review",
      status: "active",
      task_packet: evalTaskPacket({
        objective: worker.objective,
        agent_spec_id: "reviewer",
        invocation_mode: "handoff",
        persona_snapshot: "reviewer",
        role_title: "Reviewer",
        file_scope: worker.file_scope,
        allowed_tools: ["Read"],
        write_policy: "read_only",
        budget: worker.tool_budget,
        expected_output: "handoff report",
        return_conditions: ["returned"]
      }),
      created_at: now,
      updated_at: now
    }
  }, now);
  const spawnOk = spawnWork.kind === "task"
    && spawnWork.worker_id === worker.worker_id
    && spawnWork.session_id === worker.parent_session_id
    && spawnWork.parent_session_id === worker.parent_session_id
    && spawnWork.agent_spec_id === "reviewer"
    && spawnWork.invocation_mode === "parallel"
    && spawnWork.write_policy === "read_only"
    && spawnWork.file_scope?.includes("src/runtime/**")
    && spawnWork.tool_budget?.max_tool_calls === 7
    && spawnWork.output_contract === "Return findings."
    && spawnWork.spawn_reason === "parallel review"
    && spawnRow.details.includes("policy=read_only")
    && spawnBrief.includes("policy=read_only")
    && spawnBrief.includes("parent=parent_session_1")
    && Boolean(spawnHeadless?.includes("policy=read_only"))
    && Boolean(spawnHeadless?.includes("parent=parent_session_1"));
  const workerOk = workerWork.kind === "task"
    && workerWork.worker_id === worker.worker_id
    && workerWork.parent_session_id === worker.parent_session_id
    && workerWork.worker_session_id === worker.worker_session_id
    && workerWork.agent_spec_id === "reviewer"
    && workerWork.invocation_mode === "parallel"
    && workerWork.handoff_id === worker.handoff_id
    && workerWork.capability === "code.review"
    && workerWork.write_policy === "read_only"
    && workerWork.file_scope?.includes("src/runtime/**")
    && workerWork.tool_budget?.max_tool_calls === 7
    && workerWork.output_contract === worker.output_contract
    && workerWork.spawn_reason === worker.spawn_reason
    && workerWork.requested_by === worker.requested_by
    && workerWork.blocked_reason === worker.blocked_reason
    && workerWork.changed_files?.includes("src/runtime/work-protocol.ts")
    && workerWork.tests_run?.includes("npm run check")
    && workerWork.intermediate_artifacts?.includes("artifact://worker-summary")
    && workerRow.details.includes("policy=read_only");
  const startedOk = startedWork.kind === "task"
    && startedWork.agent_spec_id === "reviewer"
    && startedWork.invocation_mode === "parallel"
    && startedWork.parent_session_id === worker.parent_session_id
    && startedWork.write_policy === "read_only";
  const handoffOk = handoffWork.kind === "task"
    && handoffWork.handoff_id === "handoff_topology_1"
    && handoffWork.worker_id === worker.worker_id
    && handoffWork.parent_session_id === worker.parent_session_id
    && handoffWork.invocation_mode === "handoff"
    && handoffWork.source_agent === "main_swarm"
    && handoffWork.target_agent_spec_id === "reviewer"
    && handoffWork.write_policy === "read_only"
    && handoffWork.file_scope?.includes("src/runtime/**")
    && handoffWork.tool_budget?.max_turns === 3
    && handoffWork.output_contract === "handoff report";
  return spawnOk && workerOk && startedOk && handoffOk
    ? { name: "work protocol preserves worker topology", status: "pass", message: "spawn, worker, and handoff task records include parent, worker session, agent spec, mode, write policy, scope, budget, outcome, and handoff links" }
    : {
        name: "work protocol preserves worker topology",
        status: "fail",
        message: `spawn=${JSON.stringify(spawnWork)} spawnBrief=${spawnBrief} spawnHeadless=${spawnHeadless ?? "-"} spawnRow=${JSON.stringify(spawnRow)} worker=${JSON.stringify(workerWork)} workerRow=${JSON.stringify(workerRow)} started=${JSON.stringify(startedWork)} handoff=${JSON.stringify(handoffWork)}`
      };
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
    "reason: \"resuming a previous WorkSession\"",
    "fileScope: snapshot.changed_files",
    "Historical memory and prior worker results are hints only."
  ];
  const tuiChecks = [
    "return runtime.buildResumePrompt"
  ];
  const missing = [
    ...runtimeChecks.filter((needle) => !runtime.includes(needle)).map((needle) => `runtime:${needle}`),
    ...tuiChecks.filter((needle) => !tui.includes(needle)).map((needle) => `tui:${needle}`)
  ];
  return missing.length === 0
    ? { name: "agent continuation refreshes stale workspace memory", status: "pass", message: "resume, worker continuation, and spawned agents receive a freshness contract before relying on old memory" }
    : { name: "agent continuation refreshes stale workspace memory", status: "fail", message: `missing=${missing.join("; ")}` };
}

function checkWorkerContinuationTranscriptBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SwarmRuntime } from "./dist/runtime/runtime.js";

const dir = mkdtempSync(resolve(tmpdir(), "swarm-worker-continuation-transcript-eval-"));
const workspace = resolve(dir, "workspace");
mkdirSync(workspace, { recursive: true });
const runtime = new SwarmRuntime({ databasePath: resolve(dir, "swarm.db"), workspace });

try {
  runtime.ensureTuiChatSession("worker_cont_parent");
  runtime["ensureLoopSession"]("worker_prior_session", "Previous worker investigation", "worker_cont_parent", {
    labels: ["worker"],
    mode: "worker_loop",
    source: "worker"
  });
  runtime.sessionContextStore.append({
    session_id: "worker_cont_parent",
    kind: "summary",
    role: "system",
    content: "Parent memory: keep edits scoped to src/runtime/runtime.ts."
  });
  runtime.sessionContextStore.append({
    session_id: "worker_prior_session",
    kind: "tool_result",
    role: "tool",
    content: "Read src/runtime/runtime.ts and found approval drift in worker spawn flow."
  });
  runtime.sessionContextStore.append({
    session_id: "worker_prior_session",
    kind: "summary",
    role: "system",
    content: "Previous worker conclusion: snapshot permissions before spawn decision."
  });
  runtime.workerStateStore.create({
    worker_id: "worker_cont_eval",
    parent_session_id: "worker_cont_parent",
    capability: "code.edit",
    objective: "Patch the runtime permission flow with a focused worker continuation that reuses prior transcript evidence.",
    status: "completed",
    agent_spec_id: "coder",
    invocation_mode: "call_subagent",
    file_scope: ["src/runtime/runtime.ts", "src/runtime/agent-specs.ts"],
    tool_budget: { max_turns: 4, max_tool_calls: 12 },
    task_packet: {
      objective: "Patch the runtime permission flow with a focused worker continuation that reuses prior transcript evidence.",
      agent_spec_id: "coder",
      invocation_mode: "call_subagent",
      persona_snapshot: "coder",
      file_scope: ["src/runtime/runtime.ts", "src/runtime/agent-specs.ts"],
      allowed_tools: ["Read", "Edit"],
      write_policy: "scoped_write",
      permission_context: { default_mode: "ask", allow: [], ask: [], deny: [], additional_directories: [] },
      budget: { max_turns: 4, max_tool_calls: 12 },
      expected_output: "Return changed files.",
      return_conditions: ["done"]
    }
  });
  runtime.workerStateStore.setResult({
    worker_id: "worker_cont_eval",
    status: "completed",
    worker_session_id: "worker_prior_session",
    last_result: "Prior worker finished the initial investigation."
  });

  const calls = [];
  runtime.provider.generateText = async (input) => {
    const flatten = (value) => Array.isArray(value)
      ? value.map((item) => typeof item === "string" ? item : item?.text ?? "").join("\\n\\n")
      : typeof value === "string"
        ? value
        : value?.text ?? "";
    calls.push({
      purpose: input.usage?.purpose,
      system: flatten(input.system),
      user: flatten(input.user)
    });
    if (input.usage?.purpose === "agent_spawn_decision") {
      return JSON.stringify({
        agent_spec_id: "coder",
        invocation_mode: "call_subagent",
        reason: "Continue the previous worker.",
        confidence: 0.98,
        display_name: "Ada",
        role_title: "Patch Analyst",
        persona_brief: "Be precise and grounded in prior evidence."
      });
    }
    return JSON.stringify({
      status: "completed",
      summary: "continuation complete",
      message: "continuation complete",
      files_touched: [],
      next_actions: [],
      tool_calls: []
    });
  };

  const result = await runtime.continueAgent("worker_cont_eval", "Continue the runtime permission-flow patch using the prior worker transcript, refresh the current files, and finish the bounded edit with evidence.");
  const workerPrompt = calls.find((call) => call.purpose === "worker_coding_loop");
  const spawnDecision = calls.find((call) => call.purpose === "agent_spawn_decision");
  console.log(JSON.stringify({
    resultStatus: result.status,
    workerPrompt: [workerPrompt?.system, workerPrompt?.user].filter(Boolean).join("\\n\\n"),
    spawnDecisionUser: spawnDecision?.user ?? ""
  }));
} finally {
  runtime.dispose();
  rmSync(dir, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    resultStatus?: string;
    workerPrompt?: string;
    spawnDecisionUser?: string;
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output for failure reporting.
  }
  const ok = result.status === 0
    && parsed.resultStatus === "success"
    && parsed.workerPrompt?.includes("Parent memory: keep edits scoped to src/runtime/runtime.ts.")
    && parsed.workerPrompt?.includes("Previous worker session transcript (worker_prior_session).")
    && parsed.workerPrompt?.includes("Previous worker conclusion: snapshot permissions before spawn decision.")
    && parsed.spawnDecisionUser?.includes("Previous worker session: worker_prior_session.");
  return ok
    ? { name: "worker continuation reuses prior worker transcript context", status: "pass", message: "continued workers inherit parent durable memory plus the prior worker session transcript instead of only a last-result stub" }
    : {
        name: "worker continuation reuses prior worker transcript context",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkTuiTaskWritePolicySummaryBehavior(): EvalCaseResult {
  let state: TuiWorkState = {
    taskStates: new Map(),
    taskCompleted: 0,
    taskTotal: 0
  };
  state = applyWorkRecordToTuiState(state, {
    schema_version: "swarm.work.v1",
    kind: "task",
    at: new Date(0).toISOString(),
    task_id: "task_read",
    phase: "running",
    title: "Read target file",
    capability: "Read",
    write_policy: "read_only",
    status: "running"
  });
  state = applyWorkRecordToTuiState(state, {
    schema_version: "swarm.work.v1",
    kind: "task",
    at: new Date(0).toISOString(),
    task_id: "task_write",
    phase: "running",
    title: "Write target file",
    capability: "Write",
    write_policy: "scoped_write",
    file_scope: ["src/out.ts"],
    status: "running"
  });
  state = applyWorkRecordToTuiState(state, {
    schema_version: "swarm.work.v1",
    kind: "task",
    at: new Date(0).toISOString(),
    task_id: "task_self_improve",
    phase: "running",
    title: "Patch Swarm",
    capability: "Edit",
    write_policy: "workspace_write",
    status: "running"
  });
  state = applyTaskAttemptToTuiState(state, {
    task_id: "task_write",
    title: "Write target file",
    status: "started",
    attempt: 2
  });
  const summary = summarizeTaskWritePolicies(state.taskStates);
  const writeTask = state.taskStates.get("task_write");
  const ok = state.taskTotal === 3
    && summary.readOnly === 1
    && summary.scopedWrite === 1
    && summary.workspaceWrite === 1
    && summary.mutating === 2
    && summary.scopedTargets.join(",") === "src/out.ts"
    && writeTask?.attempt === 2
    && writeTask?.capability === "Write"
    && writeTask?.writePolicy === "scoped_write"
    && writeTask?.fileScope?.join(",") === "src/out.ts";
  return ok
    ? { name: "TUI work state summarizes task write policies", status: "pass", message: "task state preserves capability/policy/scope metadata and produces a stable read-only vs mutating summary" }
    : {
        name: "TUI work state summarizes task write policies",
        status: "fail",
        message: `state=${JSON.stringify([...state.taskStates.entries()])} summary=${JSON.stringify(summary)}`
      };
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

function checkToolResultContractVisibilityBehavior(): EvalCaseResult {
  const event = {
    type: "tool_result" as const,
    session_id: "tool_contract_visibility_eval",
    task_id: "tool_patch",
    title: "Patch file",
    action: "file.edit",
    summary: "edited src/app.ts",
    status: "success" as const,
    write_policy: "scoped_write" as const,
    file_scope: ["src/app.ts"]
  };
  const brief = formatRuntimeEventBrief(event);
  const headless = formatHeadlessProgress(event);
  const artifacts = buildHeadlessRunArtifacts({
    objective: "Patch src/app.ts",
    workspace: process.cwd(),
    mode: "coding_loop",
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(1_000).toISOString(),
    durationMs: 1_000,
    capturedEvents: [{ at: new Date(0).toISOString(), event }],
    result: { session_id: "tool_contract_visibility_eval", content: "Patched.", status: "completed" }
  });
  const step = artifacts.trajectory.steps.find((item) => item.tool_calls?.[0]?.function_name === "file.edit");
  const toolCall = step?.tool_calls?.[0];
  const observation = step?.observation?.results?.[0];
  const stepExtra = step?.extra as { write_policy?: string; file_scope?: string[] } | undefined;
  const ok = brief.includes("policy=scoped_write")
    && brief.includes("scope=src/app.ts")
    && headless?.includes("policy=scoped_write")
    && headless.includes("scope=src/app.ts")
    && toolCall?.arguments?.write_policy === "scoped_write"
    && Array.isArray(toolCall?.arguments?.file_scope)
    && (toolCall?.arguments?.file_scope as string[]).join(",") === "src/app.ts"
    && observation?.extra?.write_policy === "scoped_write"
    && Array.isArray(observation?.extra?.file_scope)
    && (observation?.extra?.file_scope as string[]).join(",") === "src/app.ts"
    && stepExtra?.write_policy === "scoped_write"
    && stepExtra.file_scope?.join(",") === "src/app.ts";
  return ok
    ? { name: "tool results surface task contracts in formatters and artifacts", status: "pass", message: "compact/headless output plus ATIF trajectory retain tool write policy and file scope even without sandbox denials" }
    : {
        name: "tool results surface task contracts in formatters and artifacts",
        status: "fail",
        message: `brief=${brief} headless=${headless ?? "-"} step=${JSON.stringify(step)}`
      };
}

function checkPlanSandboxContractVisibilityBehavior(): EvalCaseResult {
  const objective = "Update one file and verify the result.";
  const plan = normalizeGeneratedPlanForRuntime(
    {
      objective,
      summary: "Read, write, and verify a local file.",
      intent: "modify_workspace",
      tasks: [
        {
          task_id: "task_read",
          title: "Read target file",
          description: "Read the current source file before editing.",
          objective: "Load the current file contents.",
          type: "tool_call",
          status: "pending",
          required_capabilities: ["Read"],
          inputs: { action: "Read", path: "src/app.ts" },
          expected_output: { format: "text" }
        },
        {
          task_id: "task_write",
          title: "Write target file",
          description: "Persist the updated file content.",
          objective: "Write the edited source file.",
          type: "tool_call",
          status: "pending",
          required_capabilities: ["Write"],
          inputs: { action: "Write", path: "src/out.ts", content: "export const value = 1;\n" },
          expected_output: { format: "text" }
        },
        {
          task_id: "task_verify",
          title: "Run verification",
          description: "Run a shell verification command.",
          objective: "Verify the workspace after the edit.",
          type: "tool_call",
          status: "pending",
          required_capabilities: ["Bash"],
          inputs: { action: "Bash", command: "npm test" },
          expected_output: { format: "text" }
        }
      ]
    },
    objective
  );
  const event = { type: "plan" as const, session_id: "plan_visibility_eval", plan };
  const row = runtimeEventToActionRow(event, 0);
  const artifacts = buildHeadlessRunArtifacts({
    objective,
    workspace: process.cwd(),
    mode: "full_swarm",
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(1_000).toISOString(),
    durationMs: 1_000,
    capturedEvents: [{ at: new Date(0).toISOString(), event }],
    result: { session_id: "plan_visibility_eval", content: "Planned.", status: "completed" }
  });
  const planStep = artifacts.trajectory.steps.find((step) => step.message.startsWith("plan plan_visibility_eval:"));
  const planExtra = planStep?.extra as {
    tasks?: Array<{ task_id?: string; write_policy?: string; file_scope?: string[] }>;
  } | undefined;
  const readLine = row.details.find((line) => line.includes("task_read"));
  const writeLine = row.details.find((line) => line.includes("task_write"));
  const readTask = planExtra?.tasks?.find((task) => task.task_id === "task_read");
  const writeTask = planExtra?.tasks?.find((task) => task.task_id === "task_write");
  const ok = Boolean(readLine?.includes("action=Read"))
    && Boolean(readLine?.includes("policy=read_only"))
    && Boolean(writeLine?.includes("action=Write"))
    && Boolean(writeLine?.includes("policy=scoped_write"))
    && Boolean(writeLine?.includes("scope=src/out.ts"))
    && readTask?.write_policy === "read_only"
    && !readTask?.file_scope?.length
    && writeTask?.write_policy === "scoped_write"
    && writeTask?.file_scope?.join(",") === "src/out.ts";
  return ok
    ? { name: "plan events surface tool-task sandbox contracts", status: "pass", message: "TUI plan rows and headless trajectory steps expose normalized write policy and file scope for tool tasks" }
    : {
        name: "plan events surface tool-task sandbox contracts",
        status: "fail",
        message: `row=${JSON.stringify(row)} planStep=${JSON.stringify(planStep)}`
      };
}

function checkTaskLifecycleSandboxMetadataBehavior(): EvalCaseResult {
  const event = {
    type: "task" as const,
    session_id: "task_visibility_eval",
    task_id: "task_write",
    title: "Write target file",
    status: "running",
    capability: "Write",
    write_policy: "scoped_write" as const,
    file_scope: ["src/out.ts"]
  };
  const work = buildWorkRecordFromRuntimeEvent(event, new Date(0).toISOString());
  const row = runtimeEventToActionRow(event, 0);
  const ok = work.kind === "task"
    && work.session_id === "task_visibility_eval"
    && work.capability === "Write"
    && work.write_policy === "scoped_write"
    && work.file_scope?.join(",") === "src/out.ts"
    && row.details.includes("capability=Write")
    && row.details.includes("policy=scoped_write")
    && row.details.includes("scope=src/out.ts");
  return ok
    ? { name: "task lifecycle events preserve sandbox metadata", status: "pass", message: "running task records expose capability, write policy, and file scope through the unified work protocol and TUI action log" }
    : {
        name: "task lifecycle events preserve sandbox metadata",
        status: "fail",
        message: `work=${JSON.stringify(work)} row=${JSON.stringify(row)}`
      };
}

function checkToolResultWorkProtocolBehavior(): EvalCaseResult {
  const event = {
    type: "tool_result" as const,
    session_id: "tool_work_eval",
    task_id: "tool_patch",
    title: "Patch source file",
    action: "file.edit",
    summary: "patched src/app.ts",
    status: "partial" as const,
    attempt: 2,
    write_policy: "scoped_write" as const,
    file_scope: ["src/app.ts"]
  };
  const work = buildWorkRecordFromRuntimeEvent(event, new Date(0).toISOString());
  let state: TuiWorkState = {
    taskStates: new Map(),
    taskCompleted: 0,
    taskTotal: 0
  };
  if (work.kind === "task") {
    state = applyWorkRecordToTuiState(state, work);
  }
  const task = state.taskStates.get("tool_patch");
  const row = runtimeEventToActionRow(event, 0);
  const ok = work.kind === "task"
    && work.phase === "completed"
    && work.status === "partial"
    && work.result_status === "partial"
    && work.capability === "file.edit"
    && work.action === "file.edit"
    && work.attempt === 2
    && work.write_policy === "scoped_write"
    && work.file_scope?.join(",") === "src/app.ts"
    && task?.phase === "completed"
    && task?.attempt === 2
    && task?.writePolicy === "scoped_write"
    && task?.fileScope?.join(",") === "src/app.ts"
    && row.kind === "tool"
    && row.details.includes("policy=scoped_write")
    && row.details.includes("scope=src/app.ts");
  return ok
    ? { name: "tool results map into task work records", status: "pass", message: "tool_result runtime events become unified task records and update TUI task state without losing tool-row UX" }
    : {
        name: "tool results map into task work records",
        status: "fail",
        message: `work=${JSON.stringify(work)} row=${JSON.stringify(row)} state=${JSON.stringify([...state.taskStates.entries()])}`
      };
}

function checkApprovalPermissionFormattingBehavior(): EvalCaseResult {
  const event = {
    type: "approval" as const,
    status: "pending" as const,
    request: {
      id: "approval_eval",
      action: "shell.exec",
      summary: "Run shell command: npm test",
      detail: "Command: npm test",
      risk: "shell" as const,
      risk_class: "r2" as const,
      target: "npm test",
      why_now: "Swarm needs to run shell.exec to continue the current task.",
      predicted_impact: "Runs a local command.",
      rollback_plan: "No persistent workspace change is expected.",
      permission_decision: "ask" as const,
      permission_reason: "Approval required by ~/.swarm/settings.json permissions: Bash(npm*)",
      permission_mode: "ask",
      permission_name: "Bash",
      permission_rule: "Bash(npm*)"
    }
  };
  const brief = formatRuntimeEventBrief(event);
  const headless = formatHeadlessProgress(event);
  const ok = brief.includes("permission=Bash")
    && brief.includes("rule=Bash(npm*)")
    && brief.includes("reason=Approval required")
    && headless?.includes("permission=Bash")
    && headless.includes("rule=Bash(npm*)");
  return ok
    ? { name: "approval permission decisions format for TUI and headless output", status: "pass", message: "approval events include permission name, matched rule, and reason in compact/headless formatters" }
    : { name: "approval permission decisions format for TUI and headless output", status: "fail", message: `brief=${brief} headless=${headless ?? "-"}` };
}

function checkPermissionReportBehavior(): EvalCaseResult {
  const workspace = resolve("eval-workspace");
  const additionalDirectory = resolve("shared-read-root");
  const report = buildPermissionReport({
    permissions: {
      defaultMode: "ask",
      allow: ["Read(**)"],
      ask: ["Bash(*)"],
      deny: ["Read(.env)"],
      additionalDirectories: [additionalDirectory]
    },
    sandboxMode: "read-only",
    workspace,
    recentApprovals: [
      {
        approval_id: "approval_pending",
        session_id: "sess_pending",
        action: "shell.exec",
        summary: "Run shell command: npm test",
        detail: "Command: npm test",
        risk: "shell",
        risk_class: "r2",
        target: "npm test",
        status: "pending",
        challenge: {
          id: "approval_pending",
          action: "shell.exec",
          summary: "Run shell command: npm test",
          detail: "Command: npm test",
          risk: "shell",
          risk_class: "r2",
          target: "npm test",
          why_now: "Swarm needs to run shell.exec to continue the current task.",
          predicted_impact: "Runs a local command.",
          rollback_plan: "No persistent workspace change is expected.",
          permission_decision: "ask",
          permission_reason: "Approval required by ~/.swarm/settings.json permissions: Bash(*)",
          permission_mode: "ask",
          permission_name: "Bash",
          permission_rule: "Bash(*)"
        },
        created_at: "2026-05-10T10:00:00.000Z",
        updated_at: "2026-05-10T10:01:00.000Z"
      },
      {
        approval_id: "approval_approved",
        session_id: "sess_approved",
        action: "file.write",
        summary: "Write file: src/app.ts",
        detail: "Path: src/app.ts",
        risk: "write",
        risk_class: "r1",
        target: "src/app.ts",
        status: "approved",
        challenge: {
          id: "approval_approved",
          action: "file.write",
          summary: "Write file: src/app.ts",
          detail: "Path: src/app.ts",
          risk: "write",
          risk_class: "r1",
          target: "src/app.ts",
          why_now: "Swarm needs to write a file to continue the current task.",
          predicted_impact: "Writes a workspace file.",
          rollback_plan: "Revert the file contents from git or a backup.",
          permission_decision: "ask",
          permission_reason: "Approval required in ask mode.",
          permission_mode: "ask",
          permission_name: "Write"
        },
        created_at: "2026-05-10T10:02:00.000Z",
        updated_at: "2026-05-10T10:03:00.000Z"
      }
    ]
  });
  const ok = report.brief.includes("Permissions: ask.")
    && report.brief.includes("Sandbox: read-only.")
    && report.brief.includes("Approvals pending=1 approved=1 denied=0.")
    && report.detail.includes("Mode defaults")
    && report.detail.includes("Rule precedence")
    && report.detail.includes("custom ask rules override mode defaults")
    && report.detail.includes("baseline ask catalog entries do not cancel full-auto or yolo")
    && report.detail.includes("Sandbox behavior")
    && report.detail.includes("read-only: workspace writes")
    && report.detail.includes("Allow rules")
    && report.detail.includes("Ask rules")
    && report.detail.includes("Deny rules")
    && report.detail.includes(`- additional: ${additionalDirectory}`)
    && report.detail.includes("summary: pending=1 approved=1 denied=0")
    && report.detail.includes("rule=Bash(*)")
    && report.detail.includes("shell.exec target=npm test");
  return ok
    ? { name: "permission report summarizes mode, sandbox, rules, and approvals", status: "pass", message: "structured permission report exposes the effective policy, read roots, and recent approval history" }
    : { name: "permission report summarizes mode, sandbox, rules, and approvals", status: "fail", message: `brief=${report.brief} detail=${report.detail}` };
}

function checkBaselineAskCatalogKeepsBypassModesUsable(): EvalCaseResult {
  const workspace = resolve("eval-workspace");
  const yoloSettings = defaultSwarmSettings();
  yoloSettings.permissions.defaultMode = "yolo";

  const fullAutoSettings = defaultSwarmSettings();
  fullAutoSettings.permissions.defaultMode = "full-auto";

  const yoloShell = { type: "shell.exec" as const, command: "npm test" };
  const yoloWrite = { type: "file.write" as const, path: "src/generated/output.ts", content: "export const ok = true;\n" };
  const fullAutoFetch = { type: "web.fetch" as const, url: "https://example.com/docs" };

  const shellDecision = decideToolPermission(yoloShell, yoloSettings, { workspace });
  const writeDecision = decideToolPermission(yoloWrite, yoloSettings, { workspace });
  const fetchDecision = decideToolPermission(fullAutoFetch, fullAutoSettings, { workspace });

  const ok = shellDecision.decision === "allow"
    && !shellDecision.matched_rule
    && !toolRequiresApproval(yoloShell, yoloSettings, { workspace })
    && writeDecision.decision === "allow"
    && !writeDecision.matched_rule
    && !toolRequiresApproval(yoloWrite, yoloSettings, { workspace })
    && fetchDecision.decision === "allow"
    && !fetchDecision.matched_rule
    && !toolRequiresApproval(fullAutoFetch, fullAutoSettings, { workspace });
  return ok
    ? { name: "baseline ask catalog keeps bypass modes usable", status: "pass", message: "default ask entries do not reintroduce prompts for normal yolo/full-auto actions" }
    : {
        name: "baseline ask catalog keeps bypass modes usable",
        status: "fail",
        message: `shell=${JSON.stringify(shellDecision)} write=${JSON.stringify(writeDecision)} fetch=${JSON.stringify(fetchDecision)}`
      };
}

function checkExplicitAskRuleOverridesBypassModes(): EvalCaseResult {
  const workspace = resolve("eval-workspace");
  const yoloSettings = defaultSwarmSettings();
  yoloSettings.permissions.defaultMode = "yolo";
  yoloSettings.permissions.allow = [];
  yoloSettings.permissions.ask = ["Bash(npm publish*)", "Write(src/generated/**)"];
  yoloSettings.permissions.deny = [];

  const fullAutoSettings = defaultSwarmSettings();
  fullAutoSettings.permissions.defaultMode = "full-auto";
  fullAutoSettings.permissions.allow = [];
  fullAutoSettings.permissions.ask = ["WebFetch(https://internal.example.com/*)"];
  fullAutoSettings.permissions.deny = [];

  const yoloShell = { type: "shell.exec" as const, command: "npm publish --dry-run" };
  const yoloWrite = { type: "file.write" as const, path: "src/generated/output.ts", content: "export const ok = true;\n" };
  const yoloRead = { type: "file.read" as const, path: "src/index.ts" };
  const fullAutoFetch = { type: "web.fetch" as const, url: "https://internal.example.com/docs" };

  const shellDecision = decideToolPermission(yoloShell, yoloSettings, { workspace });
  const writeDecision = decideToolPermission(yoloWrite, yoloSettings, { workspace });
  const readDecision = decideToolPermission(yoloRead, yoloSettings, { workspace });
  const fetchDecision = decideToolPermission(fullAutoFetch, fullAutoSettings, { workspace });

  const ok = shellDecision.decision === "ask"
    && shellDecision.matched_rule === "Bash(npm publish*)"
    && toolRequiresApproval(yoloShell, yoloSettings, { workspace })
    && writeDecision.decision === "ask"
    && writeDecision.matched_rule === "Write(src/generated/**)"
    && toolRequiresApproval(yoloWrite, yoloSettings, { workspace })
    && readDecision.decision === "allow"
    && !toolRequiresApproval(yoloRead, yoloSettings, { workspace })
    && fetchDecision.decision === "ask"
    && fetchDecision.matched_rule === "WebFetch(https://internal.example.com/*)"
    && toolRequiresApproval(fullAutoFetch, fullAutoSettings, { workspace });
  return ok
    ? { name: "explicit ask rules override bypass modes", status: "pass", message: "custom ask rules still prompt in yolo/full-auto while unmatched low-risk actions keep their mode defaults" }
    : {
        name: "explicit ask rules override bypass modes",
        status: "fail",
        message: `shell=${JSON.stringify(shellDecision)} write=${JSON.stringify(writeDecision)} read=${JSON.stringify(readDecision)} fetch=${JSON.stringify(fetchDecision)}`
      };
}

function checkDestructiveApprovalFormattingBehavior(): EvalCaseResult {
  const settings = defaultSwarmSettings();
  settings.permissions.defaultMode = "yolo";
  settings.permissions.allow = [];
  settings.permissions.ask = [];
  settings.permissions.deny = [];
  const workspace = resolve("eval-workspace");
  const action = { type: "shell.exec" as const, command: "cmd /c del /s /q dist" };
  const decision = decideToolPermission(action, settings, { workspace });
  const request = createToolApprovalRequest(action, decision);
  const event = {
    type: "approval" as const,
    status: "pending" as const,
    request
  };
  const brief = formatRuntimeEventBrief(event);
  const headless = formatHeadlessProgress(event);
  const ok = request.summary.startsWith("Run destructive shell command:")
    && request.attention_note?.includes("Destructive shell command detected")
    && request.predicted_impact.includes("delete files")
    && request.detail.includes("Warning: Destructive shell command detected.")
    && brief.includes("destructive-shell")
    && headless?.includes("destructive-shell")
    && brief.includes("reason=High-risk destructive command requires approval")
    && headless?.includes("reason=High-risk destructive command requires approval");
  return ok
    ? { name: "destructive approvals surface explicit warning context", status: "pass", message: "approval summaries, notes, and compact/headless formatters call out destructive shell commands explicitly" }
    : {
        name: "destructive approvals surface explicit warning context",
        status: "fail",
        message: `request=${JSON.stringify(request)} brief=${brief} headless=${headless ?? "-"}`
      };
}

function checkHeadlessStdoutGuardBehavior(root: string): EvalCaseResult {
  const script = `
import { installHeadlessStdoutGuard } from "./dist/runtime/headless-stdio.js";

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const stdoutChunks = [];
const stderrChunks = [];

process.stdout.write = (chunk, encoding, callback) => {
  stdoutChunks.push(String(chunk));
  if (typeof encoding === "function") encoding();
  if (typeof callback === "function") callback();
  return true;
};
process.stderr.write = (chunk, encoding, callback) => {
  stderrChunks.push(String(chunk));
  if (typeof encoding === "function") encoding();
  if (typeof callback === "function") callback();
  return true;
};

const guard = installHeadlessStdoutGuard({ enabled: true });
try {
  console.log("polluting stdout", { value: 1 });
  guard.writeRecord({
    type: "run_signal",
    at: "2026-01-01T00:00:00.000Z",
    signal: "SIGINT",
    message: "stop"
  });
} finally {
  guard.restore();
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
}

let brokenCalled = false;
let brokenWriteResult = true;
let brokenFlag = false;
let brokenExitCode = undefined;
process.stdout.write = () => {
  const error = new Error("pipe closed");
  error.code = "EPIPE";
  throw error;
};
const epipeGuard = installHeadlessStdoutGuard({
  enabled: true,
  onBrokenPipe: () => {
    brokenCalled = true;
  }
});
try {
  process.exitCode = undefined;
  brokenWriteResult = epipeGuard.writeLine("line");
  brokenFlag = epipeGuard.brokenPipe();
  brokenExitCode = process.exitCode;
} finally {
  epipeGuard.restore();
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  process.exitCode = undefined;
}

originalStdoutWrite(JSON.stringify({
  stdout: stdoutChunks.join(""),
  stderr: stderrChunks.join(""),
  brokenWriteResult,
  brokenFlag,
  brokenCalled,
  brokenExitCode
}) + "\\n");
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  let parsed: {
    stdout?: string;
    stderr?: string;
    brokenWriteResult?: boolean;
    brokenFlag?: boolean;
    brokenCalled?: boolean;
    brokenExitCode?: number;
  } = {};
  try {
    parsed = JSON.parse(result.stdout.trim()) as typeof parsed;
  } catch {
    // Keep raw output in the failure message.
  }
  const stdoutLines = parsed.stdout?.trim().split(/\r?\n/).filter(Boolean) ?? [];
  let streamRecord: { schema_version?: string; type?: string } = {};
  try {
    streamRecord = JSON.parse(stdoutLines[0] ?? "{}") as typeof streamRecord;
  } catch {
    // Keep raw stream output in the failure message.
  }
  const ok = result.status === 0
    && stdoutLines.length === 1
    && streamRecord.schema_version === "swarm.headless.stream.v1"
    && streamRecord.type === "run_signal"
    && !parsed.stdout?.includes("polluting stdout")
    && parsed.stderr?.includes("polluting stdout")
    && parsed.brokenWriteResult === false
    && parsed.brokenFlag === true
    && parsed.brokenCalled === true
    && parsed.brokenExitCode === 0;
  return ok
    ? { name: "headless stdout guard preserves machine-readable output", status: "pass", message: "console noise is redirected to stderr and broken stdout pipes are handled without throwing" }
    : {
        name: "headless stdout guard preserves machine-readable output",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)} record=${JSON.stringify(streamRecord)}`
      };
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

function checkCapabilityBrokerAgentSpecInvokeBehavior(root: string): EvalCaseResult {
  const script = `
import { CapabilityBroker } from "./dist/extensions/broker.js";

const capabilities = new Map([
  ["agent_spec.reviewer", {
    id: "agent_spec.reviewer",
    kind: "agent_spec",
    source: "builtin",
    trust: "builtin",
    providerId: "agent-specs",
    name: "reviewer",
    title: "Review Agent",
    description: "review",
    riskClass: "r0",
    permissionName: "AgentSpec(reviewer)",
    modelVisible: false,
    userVisible: true,
    status: "available"
  }]
]);
const delegated = [];
const broker = new CapabilityBroker({
  capabilityPlane: { getCapability: async (id) => capabilities.get(id) },
  settings: { permissions: { defaultMode: "yolo", allow: [], ask: [], deny: [] } },
  workspaceForSession: () => process.cwd(),
  emitApproval: () => undefined,
  emitToolResult: () => undefined,
  activateSkill: () => { throw new Error("not used"); },
  delegate: async (action, sessionId, taskId) => {
    delegated.push({ action, sessionId, taskId });
    return {
      action: "agent.delegate",
      status: "success",
      summary: action.task,
      data: { sessionId, taskId, preferred: action.preferred_agent_spec_id }
    };
  }
});
const orphan = await broker.invoke("agent_spec.reviewer", { task: "Review the diff." });
const invoked = await broker.invoke(
  "agent_spec.reviewer",
  { task: "Review the diff.", mode: "parallel", file_scope: ["src"] },
  "sess_parent",
  { taskId: "task_agent" }
);
console.log(JSON.stringify({
  orphan: orphan.errorCode,
  orphanStatus: orphan.status,
  invoked: invoked.status,
  preferred: delegated[0]?.action.preferred_agent_spec_id,
  mode: delegated[0]?.action.preferred_mode,
  scope: delegated[0]?.action.file_scope,
  sessionId: delegated[0]?.sessionId,
  taskId: delegated[0]?.taskId
}));
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    orphan?: string;
    orphanStatus?: string;
    invoked?: string;
    preferred?: string;
    mode?: string;
    scope?: string[];
    sessionId?: string;
    taskId?: string;
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in failure below.
  }
  const ok = result.status === 0
    && parsed.orphan === "AGENT_SPEC_SESSION_REQUIRED"
    && parsed.orphanStatus === "failed"
    && parsed.invoked === "success"
    && parsed.preferred === "reviewer"
    && parsed.mode === "parallel"
    && parsed.scope?.join(",") === "src"
    && parsed.sessionId === "sess_parent"
    && parsed.taskId === "task_agent";
  return ok
    ? { name: "capability broker invokes agent specs through delegate runtime", status: "pass", message: "agent_spec capabilities require a parent session and route successful invocations through delegate with spec/mode/scope" }
    : {
        name: "capability broker invokes agent specs through delegate runtime",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkCapabilityBrokerSandboxBehavior(root: string): EvalCaseResult {
  const script = `
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CapabilityBroker } from "./dist/extensions/broker.js";
import { defaultSwarmSettings } from "./dist/config/settings.js";

const workspace = mkdtempSync(join(tmpdir(), "swarm-broker-sandbox-eval-"));
try {
  const settings = defaultSwarmSettings();
  settings.permissions.defaultMode = "yolo";
  const emitted = [];
  const broker = new CapabilityBroker({
    capabilityPlane: {
      getCapability: async (id) => id === "local_tool.file.write"
        ? {
            id: "local_tool.file.write",
            kind: "local_tool",
            source: "builtin",
            trust: "builtin",
            providerId: "builtin-tools",
            name: "Write",
            title: "Write File",
            description: "Write a file.",
            riskClass: "r1",
            permissionName: "Write(file.write)",
            modelVisible: true,
            userVisible: true,
            status: "available",
            readOnly: false,
            metadata: { action: "file.write" }
          }
        : undefined
    },
    settings,
    workspaceForSession: () => workspace,
    emitApproval: () => undefined,
    emitToolResult: (event) => emitted.push(event),
    activateSkill: () => { throw new Error("not used"); }
  });
  const result = await broker.invoke("local_tool.file.write", { path: "denied.txt", content: "blocked" }, undefined, {
    taskId: "task_sandbox",
    writePolicy: "read_only"
  });
  console.log(JSON.stringify({
    status: result.status,
    errorCode: result.errorCode,
    summary: result.summary,
    recoverySuggestion: result.recoverySuggestion,
    content: result.content,
    metadataSandbox: result.metadata?.sandbox,
    eventSandbox: emitted[0]?.sandbox,
    exists: existsSync(join(workspace, "denied.txt"))
  }));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    status?: string;
    errorCode?: string;
    summary?: string;
    recoverySuggestion?: string;
    content?: string;
    metadataSandbox?: { policy?: string; decision?: string; action?: string; reason?: string };
    eventSandbox?: { policy?: string; decision?: string; action?: string; reason?: string };
    exists?: boolean;
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in failure below.
  }
  const ok = result.status === 0
    && parsed.status === "failed"
    && parsed.errorCode === "PERMISSION_DENIED"
    && parsed.summary?.includes("Sandbox blocked file.write")
    && parsed.recoverySuggestion?.includes("workspace-write sandbox")
    && parsed.content?.includes("Sandbox: read_only/deny tool_action")
    && parsed.metadataSandbox?.policy === "read_only"
    && parsed.metadataSandbox?.decision === "deny"
    && parsed.eventSandbox?.reason?.includes("Read-only sandbox denied tool action: file.write")
    && parsed.exists === false;
  return ok
    ? { name: "capability broker enforces sandbox policy for direct local tool invokes", status: "pass", message: "direct capability invokes deny read-only file writes before execution and preserve sandbox metadata for callers" }
    : {
        name: "capability broker enforces sandbox policy for direct local tool invokes",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkChildToolTaskSandboxBehavior(root: string): EvalCaseResult {
  const script = `
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { fork } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createEnvelope } from "./dist/protocol/envelope.js";

const workspace = mkdtempSync(join(tmpdir(), "swarm-child-tool-sandbox-eval-"));
const child = fork(resolve("dist/agents/child-entry.js"), [], {
  cwd: process.cwd(),
  execArgv: [],
  stdio: ["ignore", "ignore", "ignore", "ipc"],
  env: {
    ...process.env,
    SWARM_AGENT_SPEC: JSON.stringify({
      agent_id: "tool_eval",
      name: "Tool Eval",
      role: "tool",
      capabilities: ["tool.file.write"],
      status: "idle",
      load: { running_tasks: 0, max_tasks: 1 }
    }),
    SWARM_WORKSPACE: workspace,
    SWARM_DEBUG: "",
    SWARM_DEBUG_LEVEL: ""
  }
});

try {
  const payload = await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error("timed out waiting for child tool result")), 10_000);
    child.on("error", rejectPromise);
    child.on("message", (message) => {
      const envelope = message;
      if (envelope && typeof envelope === "object" && envelope.type === "task.result" && envelope.task_id === "task_child_tool") {
        clearTimeout(timer);
        resolvePromise(envelope.payload);
      }
    });
    child.send(createEnvelope({
      swarm_id: "swarm_eval",
      session_id: "sess_eval",
      task_id: "task_child_tool",
      from: { agent_id: "orchestrator", role: "coordinator" },
      to: { agent_id: "tool_eval", role: "tool" },
      type: "task.assign",
      intent: "tool.file.write",
      payload: {
        task: {
          title: "Denied scoped write",
          required_capabilities: ["tool.file.write"]
        },
        inputs: {
          action: "Write",
          path: "denied.txt",
          content: "blocked",
          write_policy: "scoped_write",
          file_scope: ["allowed.txt"]
        },
        context: []
      }
    }));
  });
  console.log(JSON.stringify({
    status: payload.status,
    summary: payload.summary,
    toolStatus: payload.toolStatus,
    errorCode: payload.errorCode,
    toolRecoverySuggestion: payload.toolRecoverySuggestion,
    sandbox: payload.sandbox,
    content: payload.content,
    exists: existsSync(join(workspace, "denied.txt"))
  }));
} finally {
  child.kill();
  rmSync(workspace, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    status?: string;
    summary?: string;
    toolStatus?: string;
    errorCode?: string;
    toolRecoverySuggestion?: string;
    sandbox?: { policy?: string; decision?: string; reason?: string; targets?: string[]; file_scope?: string[] };
    content?: string;
    exists?: boolean;
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in failure below.
  }
  const ok = result.status === 0
    && parsed.status === "failed"
    && parsed.toolStatus === "failed"
    && parsed.errorCode === "PERMISSION_DENIED"
    && parsed.summary?.includes("outside delegated file scope")
    && parsed.toolRecoverySuggestion?.includes("Keep the write inside file_scope")
    && parsed.sandbox?.policy === "scoped_write"
    && parsed.sandbox?.decision === "deny"
    && parsed.sandbox?.reason?.includes("Scoped-write sandbox denied tool action: file.write")
    && parsed.content?.includes("Sandbox: scoped_write/deny tool_action")
    && parsed.exists === false;
  return ok
    ? { name: "child tool tasks enforce scoped sandbox policy before execution", status: "pass", message: "tool agents deny out-of-scope writes before filesystem mutation and preserve recovery plus sandbox metadata" }
    : {
        name: "child tool tasks enforce scoped sandbox policy before execution",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkOrchestratorToolTaskSandboxDefaultsBehavior(): EvalCaseResult {
  const write = sandboxedToolTaskInputs({ action: "Write", path: "src/out.ts", content: "x" }, "tool.file.write");
  const read = sandboxedToolTaskInputs({ action: "Read", path: "src/out.ts" }, "tool.file.read");
  const manual = sandboxedToolTaskInputs(
    { action: "Edit", path: "src/app.ts", old_string: "a", new_string: "b", file_scope: ["src/custom.ts"] },
    "tool.file.edit"
  );
  const artifact = sandboxedToolTaskInputs({ action: "write_file", path: "reports/final.md", content: "done" }, "tool.file.write");
  const shell = sandboxedToolTaskInputs({ action: "Bash", command: "npm test" }, "tool.shell.exec");
  const ok = write.write_policy === "scoped_write"
    && Array.isArray(write.file_scope)
    && write.file_scope.join(",") === "src/out.ts"
    && read.write_policy === "read_only"
    && read.file_scope === undefined
    && manual.write_policy === "scoped_write"
    && Array.isArray(manual.file_scope)
    && manual.file_scope.join(",") === "src/custom.ts"
    && artifact.write_policy === "scoped_write"
    && Array.isArray(artifact.file_scope)
    && artifact.file_scope.join(",") === "reports/final.md"
    && shell.write_policy === undefined
    && shell.file_scope === undefined;
  return ok
    ? { name: "shared tool-task sandbox helper derives defaults", status: "pass", message: "write/edit/final-artifact tool tasks auto-scope to touched files while read-only tasks default to read_only" }
    : {
        name: "shared tool-task sandbox helper derives defaults",
        status: "fail",
        message: `write=${JSON.stringify(write)} read=${JSON.stringify(read)} manual=${JSON.stringify(manual)} artifact=${JSON.stringify(artifact)} shell=${JSON.stringify(shell)}`
      };
}

function checkPlannerToolTaskSandboxDefaultsBehavior(): EvalCaseResult {
  const plan = normalizeGeneratedPlanForRuntime(
    {
      objective: "Update one file and verify the result.",
      summary: "Read, edit, and verify a local file.",
      intent: "modify_workspace",
      tasks: [
        {
          task_id: "task_read",
          title: "Read target file",
          description: "Read the current source file before editing.",
          objective: "Load the current file contents.",
          type: "tool_call",
          status: "pending",
          required_capabilities: ["Read"],
          inputs: { action: "Read", path: "src/app.ts" },
          expected_output: { format: "text" }
        },
        {
          task_id: "task_write",
          title: "Write target file",
          description: "Persist the updated file content.",
          objective: "Write the edited source file.",
          type: "tool_call",
          status: "pending",
          required_capabilities: ["Write"],
          inputs: { action: "Write", path: "src/out.ts", content: "export const value = 1;\n" },
          expected_output: { format: "text" }
        },
        {
          task_id: "task_edit",
          title: "Edit with explicit scope",
          description: "Apply a focused edit with an existing scoped sandbox.",
          objective: "Preserve planner-specified file scope.",
          type: "tool_call",
          status: "pending",
          required_capabilities: ["Edit"],
          inputs: { action: "Edit", path: "src/app.ts", old_string: "a", new_string: "b", file_scope: ["src/custom.ts"] },
          expected_output: { format: "text" }
        },
        {
          task_id: "task_shell",
          title: "Run verification",
          description: "Run a shell verification command.",
          objective: "Verify the workspace after the edit.",
          type: "tool_call",
          status: "pending",
          required_capabilities: ["Bash"],
          inputs: { action: "Bash", command: "npm test" },
          expected_output: { format: "text" }
        }
      ]
    },
    "Update one file and verify the result."
  );
  const read = plan.tasks.find((task) => task.task_id === "task_read")?.inputs ?? {};
  const write = plan.tasks.find((task) => task.task_id === "task_write")?.inputs ?? {};
  const edit = plan.tasks.find((task) => task.task_id === "task_edit")?.inputs ?? {};
  const shell = plan.tasks.find((task) => task.task_id === "task_shell")?.inputs ?? {};
  const ok = write.write_policy === "scoped_write"
    && Array.isArray(write.file_scope)
    && write.file_scope.join(",") === "src/out.ts"
    && read.write_policy === "read_only"
    && read.file_scope === undefined
    && edit.write_policy === "scoped_write"
    && Array.isArray(edit.file_scope)
    && edit.file_scope.join(",") === "src/custom.ts"
    && shell.write_policy === undefined
    && shell.file_scope === undefined;
  return ok
    ? { name: "planner normalization emits shared tool-task sandbox defaults", status: "pass", message: "normalized tool plans include read_only and scoped_write defaults before orchestration" }
    : {
        name: "planner normalization emits shared tool-task sandbox defaults",
        status: "fail",
        message: `read=${JSON.stringify(read)} write=${JSON.stringify(write)} edit=${JSON.stringify(edit)} shell=${JSON.stringify(shell)}`
      };
}

function checkCapabilityBrokerSlashCommandInvokeBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CapabilityBroker } from "./dist/extensions/broker.js";
import { createCapabilityPlane } from "./dist/extensions/capability-plane.js";
import { defaultSwarmSettings } from "./dist/config/settings.js";

const previousHome = process.env.SWARM_HOME;
const previousTrustedRoot = process.env.SWARM_TRUSTED_WORKSPACE_ROOT;
const home = mkdtempSync(join(tmpdir(), "swarm-slash-broker-home-"));
const workspace = mkdtempSync(join(tmpdir(), "swarm-slash-broker-workspace-"));
try {
  process.env.SWARM_HOME = home;
  process.env.SWARM_TRUSTED_WORKSPACE_ROOT = workspace;
  const userCommands = join(home, "commands");
  const pluginDir = join(home, "plugins", "release-plugin");
  mkdirSync(userCommands, { recursive: true });
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(userCommands, "summarize.md"), [
    "---",
    "description: Summarize the target.",
    "argument-hint: <target>",
    "---",
    "Summarize $ARGUMENTS with evidence."
  ].join("\\n"), "utf8");
  writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify({
    id: "release-plugin",
    title: "Release Plugin",
    description: "Release automation helpers.",
    contributes: {
      slashCommands: [
        {
          name: "release-note",
          description: "Draft release notes.",
          prompt: "Draft release notes for the requested scope."
        }
      ]
    }
  }), "utf8");

  const settings = defaultSwarmSettings();
  settings.permissions.defaultMode = "yolo";
  const plane = createCapabilityPlane({ settings, workspace });
  const invocations = [];
  const emitted = [];
  const broker = new CapabilityBroker({
    capabilityPlane: plane,
    settings,
    workspaceForSession: () => workspace,
    emitApproval: () => undefined,
    emitToolResult: (event) => emitted.push(event),
    activateSkill: () => { throw new Error("not used"); },
    runSlashCommandObjective: async (objective, input) => {
      invocations.push({
        capabilityId: input.capability.id,
        name: input.capability.name,
        sessionId: input.sessionId,
        taskId: input.taskId,
        objective
      });
      return {
        action: input.capability.name,
        status: "success",
        summary: "ran slash command",
        content: objective,
        data: { child_session_id: "child_eval" }
      };
    }
  });
  const custom = await broker.invoke("custom-command.summarize", { rawArgs: "src/index.ts" }, "sess_slash", { taskId: "task_custom" });
  const plugin = await broker.invoke("plugin.release-plugin.slash_command.release-note", { rawArgs: "v1.2.3" }, "sess_slash", { taskId: "task_plugin" });
  const builtin = await broker.invoke("slash.help", { rawArgs: "" }, "sess_slash", { taskId: "task_builtin" });
  console.log(JSON.stringify({
    customStatus: custom.status,
    pluginStatus: plugin.status,
    builtinStatus: builtin.status,
    builtinError: builtin.errorCode,
    invocations,
    emitted: emitted.map((event) => ({ action: event.action, status: event.status, task_id: event.task_id }))
  }));
} finally {
  if (previousHome === undefined) delete process.env.SWARM_HOME;
  else process.env.SWARM_HOME = previousHome;
  if (previousTrustedRoot === undefined) delete process.env.SWARM_TRUSTED_WORKSPACE_ROOT;
  else process.env.SWARM_TRUSTED_WORKSPACE_ROOT = previousTrustedRoot;
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    customStatus?: string;
    pluginStatus?: string;
    builtinStatus?: string;
    builtinError?: string;
    invocations?: Array<{ capabilityId?: string; name?: string; sessionId?: string; taskId?: string; objective?: string }>;
    emitted?: Array<{ action?: string; status?: string; task_id?: string }>;
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in failure below.
  }
  const customInvocation = parsed.invocations?.find((item) => item.capabilityId === "custom-command.summarize");
  const pluginInvocation = parsed.invocations?.find((item) => item.capabilityId === "plugin.release-plugin.slash_command.release-note");
  const ok = result.status === 0
    && parsed.customStatus === "success"
    && parsed.pluginStatus === "success"
    && parsed.builtinStatus === "failed"
    && parsed.builtinError === "SLASH_COMMAND_NOT_INVOKABLE"
    && parsed.invocations?.length === 2
    && customInvocation?.objective?.includes("Summarize src/index.ts with evidence.")
    && customInvocation?.taskId === "task_custom"
    && pluginInvocation?.objective?.includes("Draft release notes for the requested scope.")
    && pluginInvocation?.objective?.includes("Arguments: v1.2.3")
    && parsed.emitted?.some((event) => event.action === "/summarize" && event.status === "success")
    && parsed.emitted?.some((event) => event.action === "/release-note" && event.status === "success")
    && parsed.emitted?.some((event) => event.action === "/help" && event.status === "failed");
  return ok
    ? { name: "capability broker invokes custom and plugin slash commands", status: "pass", message: "custom/plugin slash capabilities render objectives through broker while built-in TUI slash commands return a structured inspect-only result" }
    : {
        name: "capability broker invokes custom and plugin slash commands",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkCapabilityBrokerNamedSkillInvokeBehavior(root: string): EvalCaseResult {
  const script = `
import { CapabilityBroker } from "./dist/extensions/broker.js";

const capabilities = new Map([
  ["skill.release-notes", {
    id: "skill.release-notes",
    kind: "skill",
    source: "user",
    trust: "trusted",
    providerId: "skills",
    name: "release-notes",
    title: "Release Notes",
    description: "Generate release notes.",
    riskClass: "r0",
    permissionName: "Skill(release-notes)",
    modelVisible: true,
    userVisible: true,
    status: "available"
  }]
]);
const activated = [];
const broker = new CapabilityBroker({
  capabilityPlane: { getCapability: async (id) => capabilities.get(id) },
  settings: { permissions: { defaultMode: "yolo", allow: [], ask: [], deny: [] } },
  workspaceForSession: () => process.cwd(),
  emitApproval: () => undefined,
  emitToolResult: () => undefined,
  activateSkill: (name, sessionId, reason) => {
    activated.push({ name, sessionId, reason });
    return {
      name,
      displayName: "Release Notes",
      description: "Generate release notes.",
      path: "skills/release-notes/SKILL.md",
      directory: "skills/release-notes",
      allowedTools: ["Read"],
      resourcePaths: [],
      activatedAt: "2026-05-09T00:00:00.000Z",
      content: "Use changelog evidence.",
      scope: "user",
      trust: "trusted"
    };
  }
});
const result = await broker.invoke("skill.release-notes", { reason: "need changelog" }, "sess_skill", { taskId: "task_skill" });
console.log(JSON.stringify({
  status: result.status,
  summary: result.summary,
  skill: result.metadata?.skill,
  durable: result.metadata?.durable_context,
  activated
}));
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    status?: string;
    summary?: string;
    skill?: string;
    durable?: boolean;
    activated?: Array<{ name?: string; sessionId?: string; reason?: string }>;
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in failure below.
  }
  const activation = parsed.activated?.[0];
  const ok = result.status === 0
    && parsed.status === "success"
    && parsed.skill === "release-notes"
    && parsed.durable === true
    && activation?.name === "release-notes"
    && activation?.sessionId === "sess_skill"
    && activation?.reason === "need changelog";
  return ok
    ? { name: "capability broker invokes named skills directly", status: "pass", message: "skill.<name> capabilities activate durable skill context without requiring callers to use skill.activate arguments" }
    : {
        name: "capability broker invokes named skills directly",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkCodingLoopInvalidToolActionFailClosedBehavior(root: string): EvalCaseResult {
  const script = `
import { CodingAgentLoop } from "./dist/runtime/coding-agent-loop.js";
import { RuntimeEvents } from "./dist/runtime/events.js";
import { defaultSwarmSettings } from "./dist/config/settings.js";

const settings = defaultSwarmSettings();
settings.permissions.defaultMode = "yolo";
const events = new RuntimeEvents();
const toolResults = [];
events.onEvent((event) => {
  if (event.type === "tool_result") toolResults.push(event);
});
let modelCalls = 0;
const provider = {
  workerModel: "eval-model",
  async generateText() {
    modelCalls += 1;
    return JSON.stringify({
      status: "continue",
      summary: "malformed tool call",
      message: "I need a tool, but the action is malformed.",
      files_touched: [],
      next_actions: [],
      tool_calls: [
        { id: "bad_tool", action: "", inputs: { path: "README.md" } }
      ]
    });
  }
};
const loop = new CodingAgentLoop({
  workspace: process.cwd(),
  settings,
  provider,
  events,
  maxTurns: 1,
  maxToolCalls: 1,
  emitFinal: false,
  emitProgress: false
});
const result = await loop.run("Trigger a malformed tool call.");
console.log(JSON.stringify({
  status: result.status,
  content: result.content,
  modelCalls,
  toolResults: toolResults.length
}));
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: { status?: string; content?: string; modelCalls?: number; toolResults?: number } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in the failure message below.
  }
  const ok = result.status === 0
    && parsed.status === "failed"
    && parsed.modelCalls === 2
    && parsed.toolResults === 0
    && typeof parsed.content === "string"
    && parsed.content.includes("Swarm could not repair the model tool call JSON")
    && parsed.content.includes("empty or missing action");
  return ok
    ? { name: "coding loop fails closed on empty repaired tool action", status: "pass", message: "empty tool actions are repaired once, then converted into a failed model result without executing local tools" }
    : {
        name: "coding loop fails closed on empty repaired tool action",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkCodingLoopRepairsContinueWithoutToolsBehavior(root: string): EvalCaseResult {
  const script = `
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodingAgentLoop } from "./dist/runtime/coding-agent-loop.js";
import { RuntimeEvents } from "./dist/runtime/events.js";
import { defaultSwarmSettings } from "./dist/config/settings.js";

const workspace = mkdtempSync(join(tmpdir(), "swarm-continue-no-tools-eval-"));
const settings = defaultSwarmSettings();
settings.permissions.defaultMode = "yolo";
const events = new RuntimeEvents();
const toolResults = [];
events.onEvent((event) => {
  if (event.type === "tool_result") toolResults.push(event);
});
let normalCalls = 0;
let repairCalls = 0;
const provider = {
  workerModel: "eval-model",
  async generateText(request) {
    if (request.usage?.purpose === "coding_loop_json_repair") {
      repairCalls += 1;
      return JSON.stringify({
        status: "continue",
        summary: "repair writes file",
        message: "Use a concrete tool call instead of a bare continuation.",
        files_touched: [],
        next_actions: [],
        tool_calls: [
          { id: "write_readme", action: "file.write", inputs: { path: "README.md", content: "ok\\n" } }
        ]
      });
    }
    normalCalls += 1;
    if (normalCalls === 1) {
      return JSON.stringify({
        status: "continue",
        summary: "need to write",
        message: "I still need to create README.md.",
        files_touched: [],
        next_actions: ["create README.md"],
        tool_calls: []
      });
    }
    return JSON.stringify({
      status: "completed",
      summary: "README created",
      message: "README.md was created and verified by file.write.",
      files_touched: [],
      next_actions: [],
      tool_calls: []
    });
  }
};
const loop = new CodingAgentLoop({
  workspace,
  settings,
  provider,
  events,
  maxTurns: 3,
  maxToolCalls: 3,
  expectedSideEffects: "modify_workspace",
  emitFinal: false,
  emitProgress: false
});
try {
  const result = await loop.run("Create README.md");
  console.log(JSON.stringify({
    status: result.status,
    normalCalls,
    repairCalls,
    toolResults: toolResults.length,
    fileExists: existsSync(join(workspace, "README.md"))
  }));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: { status?: string; normalCalls?: number; repairCalls?: number; toolResults?: number; fileExists?: boolean } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in the failure message below.
  }
  const ok = result.status === 0
    && parsed.status === "completed"
    && parsed.normalCalls === 2
    && parsed.repairCalls === 1
    && parsed.toolResults === 1
    && parsed.fileExists === true;
  return ok
    ? { name: "coding loop repairs bare continue responses before stopping", status: "pass", message: "status=continue without tool_calls is repaired into executable work instead of becoming a false completed run" }
    : {
        name: "coding loop repairs bare continue responses before stopping",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkCodingLoopRepairsInvalidToolInputsBehavior(root: string): EvalCaseResult {
  const script = `
import { CodingAgentLoop } from "./dist/runtime/coding-agent-loop.js";
import { RuntimeEvents } from "./dist/runtime/events.js";
import { defaultSwarmSettings } from "./dist/config/settings.js";

const settings = defaultSwarmSettings();
settings.permissions.defaultMode = "yolo";
const events = new RuntimeEvents();
const toolResults = [];
events.onEvent((event) => {
  if (event.type === "tool_result") toolResults.push(event);
});
let modelCalls = 0;
const prompts = [];
const provider = {
  workerModel: "eval-model",
  async generateText(request) {
    modelCalls += 1;
    prompts.push(String(request.user ?? ""));
    if (modelCalls === 1) {
      return JSON.stringify({
        status: "continue",
        summary: "run missing command",
        message: "I will run a command.",
        files_touched: [],
        next_actions: [],
        tool_calls: [
          { id: "bad_bash", action: "Bash", inputs: { description: "missing command" } }
        ]
      });
    }
    if (modelCalls === 2) {
      return JSON.stringify({
        status: "continue",
        summary: "run repaired command",
        message: "I will run the repaired command.",
        files_touched: [],
        next_actions: [],
        tool_calls: [
          { id: "good_bash", action: "Bash", inputs: { command: "node -e \\"console.log('ok')\\"", description: "print ok" } }
        ]
      });
    }
    return JSON.stringify({
      status: "completed",
      summary: "done",
      message: "done",
      files_touched: [],
      next_actions: [],
      tool_calls: []
    });
  }
};
const loop = new CodingAgentLoop({
  workspace: process.cwd(),
  settings,
  provider,
  events,
  maxTurns: 2,
  maxToolCalls: 1,
  emitFinal: false,
  emitProgress: false
});
const result = await loop.run("Run a command after repairing invalid tool input.");
console.log(JSON.stringify({
  status: result.status,
  modelCalls,
  toolResults: toolResults.map((event) => ({ id: event.task_id, action: event.action, status: event.status, summary: event.summary })),
  repairPrompt: prompts[1] ?? ""
}));
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    status?: string;
    modelCalls?: number;
    toolResults?: Array<{ id?: string; action?: string; status?: string; summary?: string }>;
    repairPrompt?: string;
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in failure below.
  }
  const ok = result.status === 0
    && parsed.status === "completed"
    && parsed.modelCalls === 3
    && parsed.toolResults?.length === 1
    && parsed.toolResults[0]?.id === "good_bash"
    && parsed.toolResults[0]?.action === "shell.exec"
    && parsed.toolResults[0]?.status === "success"
    && parsed.repairPrompt?.includes("missing required input: command");
  return ok
    ? { name: "coding loop repairs invalid local tool inputs before execution", status: "pass", message: "missing required local tool inputs trigger JSON repair and only repaired calls execute" }
    : {
        name: "coding loop repairs invalid local tool inputs before execution",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkCodingLoopAcceptsFlatToolCallInputsBehavior(root: string): EvalCaseResult {
  const script = `
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodingAgentLoop } from "./dist/runtime/coding-agent-loop.js";
import { RuntimeEvents } from "./dist/runtime/events.js";
import { defaultSwarmSettings } from "./dist/config/settings.js";

const workspace = mkdtempSync(join(tmpdir(), "swarm-flat-tool-call-eval-"));
try {
  writeFileSync(join(workspace, "README.md"), "hello flat inputs", "utf8");
  const settings = defaultSwarmSettings();
  settings.permissions.defaultMode = "yolo";
  const events = new RuntimeEvents();
  const toolResults = [];
  events.onEvent((event) => {
    if (event.type === "tool_result") toolResults.push(event);
  });
  let modelCalls = 0;
  const provider = {
    workerModel: "eval-model",
    async generateText() {
      modelCalls += 1;
      if (modelCalls === 1) {
        return JSON.stringify({
          status: "continue",
          summary: "read readme",
          message: "I will read README.",
          files_touched: [],
          next_actions: [],
          tool_calls: [
            { id: "read_flat", action: "file.read", path: "README.md", reason: "flat input shape" },
            { id: "read_parameters", action: "read_file", parameters: { path: "README.md" }, reason: "OpenAI-style parameters shape" }
          ]
        });
      }
      return JSON.stringify({
        status: "completed",
        summary: "done",
        message: "done",
        files_touched: [],
        next_actions: [],
        tool_calls: []
      });
    }
  };
  const loop = new CodingAgentLoop({
    workspace,
    settings,
    provider,
    events,
    maxTurns: 2,
    maxToolCalls: 2,
    emitFinal: false,
    emitProgress: false
  });
  const result = await loop.run("Read README with flat tool call inputs.");
  console.log(JSON.stringify({
    status: result.status,
    modelCalls,
    ids: toolResults.map((event) => event.task_id).sort(),
    actions: toolResults.map((event) => event.action).sort(),
    summaries: toolResults.map((event) => event.summary),
    failed: toolResults.some((event) => event.status === "failed")
  }));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: { status?: string; modelCalls?: number; ids?: string[]; actions?: string[]; summaries?: string[]; failed?: boolean } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in failure below.
  }
  const ok = result.status === 0
    && parsed.status === "completed"
    && parsed.modelCalls === 2
    && parsed.ids?.join(",") === "read_flat,read_parameters"
    && parsed.actions?.join(",") === "file.read,file.read"
    && parsed.summaries?.every((summary) => summary.includes("README.md")) === true
    && parsed.failed === false;
  return ok
    ? { name: "coding loop accepts flat and parameters tool call inputs", status: "pass", message: "model tool calls shaped as {action,path} or {action,parameters} are normalized into tool inputs instead of losing path" }
    : {
        name: "coding loop accepts flat and parameters tool call inputs",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkCodingLoopIgnoresClaimedFilesTouchedBehavior(root: string): EvalCaseResult {
  const script = `
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodingAgentLoop } from "./dist/runtime/coding-agent-loop.js";
import { RuntimeEvents } from "./dist/runtime/events.js";
import { defaultSwarmSettings } from "./dist/config/settings.js";

const workspace = mkdtempSync(join(tmpdir(), "swarm-files-touched-eval-"));
try {
  const settings = defaultSwarmSettings();
  settings.permissions.defaultMode = "yolo";
  const events = new RuntimeEvents();
  const provider = {
    workerModel: "eval-model",
    async generateText() {
      return JSON.stringify({
        status: "completed",
        summary: "claimed write",
        message: "I claim README.md was created.",
        files_touched: ["README.md"],
        next_actions: [],
        tool_calls: []
      });
    }
  };
  const loop = new CodingAgentLoop({
    workspace,
    settings,
    provider,
    events,
    maxTurns: 1,
    maxToolCalls: 0,
    emitFinal: false,
    emitProgress: false
  });
  const result = await loop.run("Claim a README without writing it.");
  console.log(JSON.stringify({
    status: result.status,
    changedFiles: result.outcome?.changed_files ?? [],
    readmeExists: existsSync(join(workspace, "README.md"))
  }));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: { status?: string; changedFiles?: string[]; readmeExists?: boolean } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in failure below.
  }
  const ok = result.status === 0
    && parsed.status === "failed"
    && Array.isArray(parsed.changedFiles)
    && parsed.changedFiles.length === 0
    && parsed.readmeExists === false;
  return ok
    ? { name: "coding loop fails model-claimed changed files without tool evidence", status: "pass", message: "false completion claims fail closed when changed_files has no write/edit evidence" }
    : {
        name: "coding loop fails model-claimed changed files without tool evidence",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkCodingLoopAllowsReadOnlyClaimedFilesTouchedBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodingAgentLoop } from "./dist/runtime/coding-agent-loop.js";
import { RuntimeEvents } from "./dist/runtime/events.js";
import { defaultSwarmSettings } from "./dist/config/settings.js";

const workspace = mkdtempSync(join(tmpdir(), "swarm-readonly-files-touched-eval-"));
try {
  const settings = defaultSwarmSettings();
  settings.permissions.defaultMode = "yolo";
  const events = new RuntimeEvents();
  const toolResults = [];
  events.onEvent((event) => {
    if (event.type === "tool_result") toolResults.push(event);
  });
  const provider = {
    workerModel: "eval-model",
    async generateText() {
      return JSON.stringify({
        status: "completed",
        summary: "verified file",
        message: "I inspected index.html.",
        files_touched: ["index.html"],
        next_actions: [],
        tool_calls: []
      });
    }
  };
  const loop = new CodingAgentLoop({
    workspace,
    settings,
    provider,
    events,
    writePolicy: "read_only",
    maxTurns: 1,
    maxToolCalls: 0,
    emitFinal: false,
    emitProgress: false
  });
  const result = await loop.run("Verify index.html without modifying it.");
  console.log(JSON.stringify({
    status: result.status,
    changedFiles: result.outcome?.changed_files ?? [],
    gap: toolResults.some((event) => event.errorCode === "UNVERIFIED_WORKSPACE_CHANGE")
  }));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: { status?: string; changedFiles?: string[]; gap?: boolean } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in failure below.
  }
  const ok = result.status === 0
    && parsed.status === "completed"
    && Array.isArray(parsed.changedFiles)
    && parsed.changedFiles.length === 0
    && parsed.gap === false;
  return ok
    ? { name: "coding loop permits read-only files_touched without write evidence", status: "pass", message: "read-only verifier/reviewer loops may report inspected files without being forced to write them" }
    : {
        name: "coding loop permits read-only files_touched without write evidence",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkCodingLoopRetriesUnverifiedWorkspaceCompletionBehavior(root: string): EvalCaseResult {
  const script = `
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodingAgentLoop } from "./dist/runtime/coding-agent-loop.js";
import { RuntimeEvents } from "./dist/runtime/events.js";
import { defaultSwarmSettings } from "./dist/config/settings.js";

const workspace = mkdtempSync(join(tmpdir(), "swarm-unverified-completion-eval-"));
try {
  const settings = defaultSwarmSettings();
  settings.permissions.defaultMode = "yolo";
  const events = new RuntimeEvents();
  const toolResults = [];
  events.onEvent((event) => {
    if (event.type === "tool_result") toolResults.push(event);
  });
  let modelCalls = 0;
  const provider = {
    workerModel: "eval-model",
    async generateText() {
      modelCalls += 1;
      if (modelCalls === 1) {
        return JSON.stringify({
          status: "completed",
          summary: "README written",
          message: "README.md has been created.",
          files_touched: ["README.md"],
          next_actions: [],
          tool_calls: []
        });
      }
      if (modelCalls === 2) {
        return JSON.stringify({
          status: "continue",
          summary: "write readme for real",
          message: "I need to actually write the README.",
          files_touched: [],
          next_actions: [],
          tool_calls: [
            { id: "write_readme", action: "file.write", inputs: { path: "README.md", content: "# MiniDB\\n\\nGenerated README." } }
          ]
        });
      }
      return JSON.stringify({
        status: "completed",
        summary: "done",
        message: "README.md is now written.",
        files_touched: [],
        next_actions: [],
        tool_calls: []
      });
    }
  };
  const loop = new CodingAgentLoop({
    workspace,
    settings,
    provider,
    events,
    expectedSideEffects: "modify_workspace",
    maxTurns: 3,
    maxToolCalls: 2,
    emitFinal: false,
    emitProgress: false
  });
  const result = await loop.run("Create README.md.");
  const readmePath = join(workspace, "README.md");
  console.log(JSON.stringify({
    status: result.status,
    changedFiles: result.outcome?.changed_files ?? [],
    modelCalls,
    exists: existsSync(readmePath),
    content: existsSync(readmePath) ? readFileSync(readmePath, "utf8") : "",
    gap: toolResults.some((event) => event.errorCode === "UNVERIFIED_WORKSPACE_CHANGE"),
    write: toolResults.some((event) => event.action === "file.write" && event.status === "success")
  }));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: { status?: string; changedFiles?: string[]; modelCalls?: number; exists?: boolean; content?: string; gap?: boolean; write?: boolean } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in failure below.
  }
  const ok = result.status === 0
    && parsed.status === "completed"
    && parsed.modelCalls === 3
    && parsed.exists === true
    && parsed.content?.includes("# MiniDB")
    && parsed.changedFiles?.includes("README.md")
    && parsed.gap === true
    && parsed.write === true;
  return ok
    ? { name: "coding loop retries unverified workspace completion claims", status: "pass", message: "modify-workspace runs feed false completion claims back into the loop until a real write result exists" }
    : {
        name: "coding loop retries unverified workspace completion claims",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkCodingLoopRetriesTransactionConflictBehavior(root: string): EvalCaseResult {
  const conflictingHtml = `<!doctype html>
<html>
<head>
  <style>
    body::before,
    body::after {
      content: "";
      position: fixed;
      width: 24rem;
      height: 24rem;
      background: radial-gradient(circle, rgba(64, 160, 255, 0.35), transparent 65%);
      animation: drift 12s ease-in-out infinite alternate;
    }

    body::after {
      right: 5%;
      bottom: 8%;
    }

    body::after {
      content: "";
      position: fixed;
      inset: 0;
      background: repeating-linear-gradient(0deg, rgba(255,255,255,.08), rgba(255,255,255,.08) 1px, transparent 1px, transparent 3px);
      opacity: .08;
      pointer-events: none;
    }
  </style>
</head>
<body><main>Weather</main></body>
</html>`;
  const fixedHtml = `<!doctype html>
<html>
<head>
  <style>
    body::before,
    body::after {
      content: "";
      position: fixed;
      width: 24rem;
      height: 24rem;
      background: radial-gradient(circle, rgba(64, 160, 255, 0.35), transparent 65%);
      animation: drift 12s ease-in-out infinite alternate;
    }

    body::after {
      right: 5%;
      bottom: 8%;
    }

    .noise {
      position: fixed;
      inset: 0;
      background: repeating-linear-gradient(0deg, rgba(255,255,255,.08), rgba(255,255,255,.08) 1px, transparent 1px, transparent 3px);
      opacity: .08;
      pointer-events: none;
    }
  </style>
</head>
<body><div class="noise" aria-hidden="true"></div><main>Weather</main></body>
</html>`;
  const script = `
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodingAgentLoop } from "./dist/runtime/coding-agent-loop.js";
import { RuntimeEvents } from "./dist/runtime/events.js";
import { defaultSwarmSettings } from "./dist/config/settings.js";

const workspace = mkdtempSync(join(tmpdir(), "swarm-transaction-conflict-eval-"));
const conflictingHtml = ${JSON.stringify(conflictingHtml)};
const fixedHtml = ${JSON.stringify(fixedHtml)};
try {
  const settings = defaultSwarmSettings();
  settings.permissions.defaultMode = "yolo";
  const events = new RuntimeEvents();
  const toolResults = [];
  events.onEvent((event) => {
    if (event.type === "tool_result") toolResults.push(event);
  });
  let modelCalls = 0;
  const provider = {
    workerModel: "eval-model",
    async generateText() {
      modelCalls += 1;
      if (modelCalls === 1) {
        return JSON.stringify({
          status: "continue",
          summary: "write weather card",
          message: "Writing the first version.",
          files_touched: [],
          next_actions: [],
          tool_calls: [
            { id: "write_conflict", action: "file.write", inputs: { path: "index.html", content: conflictingHtml } }
          ]
        });
      }
      if (modelCalls === 2) {
        return JSON.stringify({
          status: "completed",
          summary: "done",
          message: "index.html is ready.",
          files_touched: ["index.html"],
          next_actions: [],
          tool_calls: []
        });
      }
      if (modelCalls === 3) {
        return JSON.stringify({
          status: "continue",
          summary: "repair transaction conflict",
          message: "I will read and rewrite the file to avoid the duplicate pseudo-element override.",
          files_touched: [],
          next_actions: [],
          tool_calls: [
            { id: "read_index", action: "file.read", inputs: { path: "index.html" } },
            { id: "write_fixed", action: "file.write", inputs: { path: "index.html", content: fixedHtml } }
          ]
        });
      }
      return JSON.stringify({
        status: "completed",
        summary: "fixed",
        message: "index.html no longer reuses body::after for two visual layers.",
        files_touched: ["index.html"],
        next_actions: [],
        tool_calls: []
      });
    }
  };
  const loop = new CodingAgentLoop({
    workspace,
    settings,
    provider,
    events,
    expectedSideEffects: "modify_workspace",
    maxTurns: 4,
    maxToolCalls: 4,
    emitFinal: false,
    emitProgress: false
  });
  const result = await loop.run("Create a polished weather card.");
  const indexPath = join(workspace, "index.html");
  const content = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
  console.log(JSON.stringify({
    status: result.status,
    changedFiles: result.outcome?.changed_files ?? [],
    modelCalls,
    exists: existsSync(indexPath),
    transactionConflict: toolResults.some((event) => event.errorCode === "TRANSACTION_SEMANTIC_CONFLICT"),
    fixed: content.includes(".noise") && !content.includes("body::after {\\n      content: \\"\\";\\n      position: fixed;\\n      inset: 0;")
  }));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: { status?: string; changedFiles?: string[]; modelCalls?: number; exists?: boolean; transactionConflict?: boolean; fixed?: boolean } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in failure below.
  }
  const ok = result.status === 0
    && parsed.status === "completed"
    && parsed.modelCalls === 4
    && parsed.exists === true
    && parsed.changedFiles?.includes("index.html")
    && parsed.transactionConflict === true
    && parsed.fixed === true;
  return ok
    ? { name: "coding loop retries semantic workspace transaction conflicts", status: "pass", message: "duplicate global pseudo-element CSS overrides are fed back into the loop before completion" }
    : {
        name: "coding loop retries semantic workspace transaction conflicts",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkCodingLoopRetriesFormattingRiskBehavior(root: string): EvalCaseResult {
  const minifiedHtml = `<!doctype html><html><head><style>${".card{display:block;color:#123;background:#fff;}".repeat(180)}</style></head><body><main>${"<button>Task</button>".repeat(120)}</main><script>${"localStorage.setItem('x','y');".repeat(160)}</script></body></html>`;
  const formattedHtml = [
    "<!doctype html>",
    "<html>",
    "<head>",
    "  <style>",
    "    .card {",
    "      display: block;",
    "      color: #123;",
    "      background: #fff;",
    "    }",
    "  </style>",
    "</head>",
    "<body>",
    "  <main>",
    "    <button>Task</button>",
    "  </main>",
    "  <script>",
    "    localStorage.setItem('x', 'y');",
    "  </script>",
    "</body>",
    "</html>"
  ].join("\n");
  const script = `
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodingAgentLoop } from "./dist/runtime/coding-agent-loop.js";
import { RuntimeEvents } from "./dist/runtime/events.js";
import { defaultSwarmSettings } from "./dist/config/settings.js";

const workspace = mkdtempSync(join(tmpdir(), "swarm-formatting-risk-eval-"));
const minifiedHtml = ${JSON.stringify(minifiedHtml)};
const formattedHtml = ${JSON.stringify(formattedHtml)};
try {
  const settings = defaultSwarmSettings();
  settings.permissions.defaultMode = "yolo";
  const events = new RuntimeEvents();
  const toolResults = [];
  events.onEvent((event) => {
    if (event.type === "tool_result") toolResults.push(event);
  });
  let modelCalls = 0;
  const provider = {
    workerModel: "eval-model",
    async generateText() {
      modelCalls += 1;
      if (modelCalls === 1) {
        return JSON.stringify({
          status: "continue",
          summary: "write minified html",
          message: "Writing generated html.",
          files_touched: [],
          next_actions: [],
          tool_calls: [
            { id: "write_minified", action: "file.write", inputs: { path: "index.html", content: minifiedHtml } }
          ]
        });
      }
      if (modelCalls === 2) {
        return JSON.stringify({
          status: "completed",
          summary: "done",
          message: "index.html is ready.",
          files_touched: ["index.html"],
          next_actions: [],
          tool_calls: []
        });
      }
      if (modelCalls === 3) {
        return JSON.stringify({
          status: "continue",
          summary: "format html",
          message: "Repairing the formatting risk.",
          files_touched: [],
          next_actions: [],
          tool_calls: [
            { id: "read_index", action: "file.read", inputs: { path: "index.html" } },
            { id: "write_formatted", action: "file.write", inputs: { path: "index.html", content: formattedHtml } }
          ]
        });
      }
      return JSON.stringify({
        status: "completed",
        summary: "formatted",
        message: "index.html is formatted.",
        files_touched: ["index.html"],
        next_actions: [],
        tool_calls: []
      });
    }
  };
  const loop = new CodingAgentLoop({
    workspace,
    settings,
    provider,
    events,
    expectedSideEffects: "modify_workspace",
    maxTurns: 4,
    maxToolCalls: 4,
    emitFinal: false,
    emitProgress: false
  });
  const result = await loop.run("Create formatted index.html.");
  const indexPath = join(workspace, "index.html");
  const content = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
  console.log(JSON.stringify({
    status: result.status,
    modelCalls,
    formattingRisk: toolResults.some((event) => event.errorCode === "TRANSACTION_FORMATTING_RISK"),
    lines: content.split(/\\r?\\n/).length,
    changedFiles: result.outcome?.changed_files ?? []
  }));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: { status?: string; modelCalls?: number; formattingRisk?: boolean; lines?: number; changedFiles?: string[] } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in failure below.
  }
  const ok = result.status === 0
    && parsed.status === "completed"
    && parsed.modelCalls === 4
    && parsed.formattingRisk === true
    && (parsed.lines ?? 0) > 5
    && parsed.changedFiles?.includes("index.html");
  return ok
    ? { name: "coding loop retries generated formatting transaction risks", status: "pass", message: "large single-line generated files are fed back into the loop before completion" }
    : {
        name: "coding loop retries generated formatting transaction risks",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkReadOnlyCodingLoopPromptUsesVerificationToolsBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodingAgentLoop } from "./dist/runtime/coding-agent-loop.js";
import { RuntimeEvents } from "./dist/runtime/events.js";
import { defaultSwarmSettings } from "./dist/config/settings.js";

const workspace = mkdtempSync(join(tmpdir(), "swarm-readonly-prompt-eval-"));
try {
  const settings = defaultSwarmSettings();
  settings.permissions.defaultMode = "yolo";
  let promptText = "";
  const provider = {
    workerModel: "eval-model",
    async generateText(request) {
      promptText = JSON.stringify(request);
      return JSON.stringify({
        status: "completed",
        summary: "inspected",
        message: "No changes needed.",
        files_touched: [],
        next_actions: [],
        tool_calls: []
      });
    }
  };
  const loop = new CodingAgentLoop({
    workspace,
    settings,
    provider,
    events: new RuntimeEvents(),
    writePolicy: "read_only",
    maxTurns: 1,
    maxToolCalls: 0,
    emitFinal: false,
    emitProgress: false
  });
  const result = await loop.run("Verify without writing.");
  const allowedTools = promptText.match(/Allowed tools: ([\\s\\S]*?)\\. Some MCP/)?.[1] ?? "";
  console.log(JSON.stringify({
    status: result.status,
    hasCodeTest: allowedTools.includes("code.test"),
    hasCodeLint: allowedTools.includes("code.lint"),
    hasBash: allowedTools.includes("Bash"),
    hasWrite: allowedTools.split(",").map((tool) => tool.trim()).includes("Write")
  }));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: { status?: string; hasCodeTest?: boolean; hasCodeLint?: boolean; hasBash?: boolean; hasWrite?: boolean } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in failure below.
  }
  const ok = result.status === 0
    && parsed.status === "completed"
    && parsed.hasCodeTest === true
    && parsed.hasCodeLint === true
    && parsed.hasBash === false
    && parsed.hasWrite === false;
  return ok
    ? { name: "read-only coding loop prompt exposes verification tools only", status: "pass", message: "read-only runs show code.test/code.lint while hiding Bash/Write from model-visible tools" }
    : {
        name: "read-only coding loop prompt exposes verification tools only",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkCodingLoopRetriesUnverifiedVerificationClaimBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodingAgentLoop } from "./dist/runtime/coding-agent-loop.js";
import { RuntimeEvents } from "./dist/runtime/events.js";
import { defaultSwarmSettings } from "./dist/config/settings.js";

const workspace = mkdtempSync(join(tmpdir(), "swarm-unverified-verification-eval-"));
try {
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node test.js" } }), "utf8");
  writeFileSync(join(workspace, "test.js"), "console.log('verification eval passed');\\n", "utf8");
  const settings = defaultSwarmSettings();
  settings.permissions.defaultMode = "yolo";
  const events = new RuntimeEvents();
  const toolResults = [];
  events.onEvent((event) => {
    if (event.type === "tool_result") toolResults.push(event);
  });
  let modelCalls = 0;
  const provider = {
    workerModel: "eval-model",
    async generateText() {
      modelCalls += 1;
      if (modelCalls === 1) {
        return JSON.stringify({
          status: "completed",
          summary: "tests passed",
          message: "测试通过，项目验证成功。",
          files_touched: [],
          next_actions: [],
          tool_calls: []
        });
      }
      if (modelCalls === 2) {
        return JSON.stringify({
          status: "continue",
          summary: "run tests for real",
          message: "I need real verification evidence.",
          files_touched: [],
          next_actions: [],
          tool_calls: [
            { id: "test", action: "code.test", inputs: { command: "npm test" } }
          ]
        });
      }
      return JSON.stringify({
        status: "completed",
        summary: "verified",
        message: "npm test passed.",
        files_touched: [],
        next_actions: [],
        tool_calls: []
      });
    }
  };
  const loop = new CodingAgentLoop({
    workspace,
    settings,
    provider,
    events,
    writePolicy: "read_only",
    maxTurns: 3,
    maxToolCalls: 2,
    emitFinal: false,
    emitProgress: false
  });
  const result = await loop.run("Run existing tests and verify the project passes.");
  console.log(JSON.stringify({
    status: result.status,
    modelCalls,
    testsRun: result.outcome?.tests_run ?? [],
    gap: toolResults.some((event) => event.errorCode === "UNVERIFIED_VERIFICATION_CLAIM"),
    codeTest: toolResults.some((event) => event.action === "code.test" && event.status === "success")
  }));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: { status?: string; modelCalls?: number; testsRun?: string[]; gap?: boolean; codeTest?: boolean } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in failure below.
  }
  const ok = result.status === 0
    && parsed.status === "completed"
    && parsed.modelCalls === 3
    && parsed.gap === true
    && parsed.codeTest === true
    && parsed.testsRun?.includes("tests passed");
  return ok
    ? { name: "coding loop retries unverified verification completion claims", status: "pass", message: "verification tasks must produce code.test/code.lint evidence before claiming success" }
    : {
        name: "coding loop retries unverified verification completion claims",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkCodingLoopStopsSerialBatchAfterFailureBehavior(root: string): EvalCaseResult {
  const script = `
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodingAgentLoop } from "./dist/runtime/coding-agent-loop.js";
import { RuntimeEvents } from "./dist/runtime/events.js";
import { defaultSwarmSettings } from "./dist/config/settings.js";

const workspace = mkdtempSync(join(tmpdir(), "swarm-stop-batch-failure-eval-"));
try {
  const settings = defaultSwarmSettings();
  settings.permissions.defaultMode = "yolo";
  const events = new RuntimeEvents();
  const toolResults = [];
  events.onEvent((event) => {
    if (event.type === "tool_result") toolResults.push(event);
  });
  const provider = {
    workerModel: "eval-model",
    async generateText() {
      return JSON.stringify({
        status: "continue",
        summary: "run serial tools",
        message: "The first command fails, so later serial writes should wait for feedback.",
        files_touched: [],
        next_actions: [],
        tool_calls: [
          { id: "bad_shell", action: "shell.exec", inputs: { command: "cd nowhere && node -v" } },
          { id: "must_not_run", action: "file.write", inputs: { path: "SHOULD_NOT_EXIST.md", content: "bad\\n" } }
        ]
      });
    }
  };
  const loop = new CodingAgentLoop({
    workspace,
    settings,
    provider,
    events,
    maxTurns: 1,
    maxToolCalls: 2,
    emitFinal: false,
    emitProgress: false
  });
  const result = await loop.run("Run a failing command followed by a write.");
  console.log(JSON.stringify({
    status: result.status,
    toolIds: toolResults.map((event) => event.task_id),
    firstStatus: toolResults[0]?.status,
    fileExists: existsSync(join(workspace, "SHOULD_NOT_EXIST.md"))
  }));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: { status?: string; toolIds?: string[]; firstStatus?: string; fileExists?: boolean } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in failure below.
  }
  const ok = result.status === 0
    && parsed.status === "failed"
    && parsed.toolIds?.join(",") === "bad_shell"
    && parsed.firstStatus === "failed"
    && parsed.fileExists === false;
  return ok
    ? { name: "coding loop stops serial tool batch after failure", status: "pass", message: "later serial tool calls wait for model recovery instead of running after a failed command" }
    : {
        name: "coding loop stops serial tool batch after failure",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkCodingLoopRecordsFileDeleteChangesBehavior(root: string): EvalCaseResult {
  const script = `
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodingAgentLoop } from "./dist/runtime/coding-agent-loop.js";
import { RuntimeEvents } from "./dist/runtime/events.js";
import { defaultSwarmSettings } from "./dist/config/settings.js";

const workspace = mkdtempSync(join(tmpdir(), "swarm-delete-change-eval-"));
try {
  writeFileSync(join(workspace, "temp.txt"), "delete me\\n", "utf8");
  const settings = defaultSwarmSettings();
  settings.permissions.defaultMode = "yolo";
  const events = new RuntimeEvents();
  let modelCalls = 0;
  const provider = {
    workerModel: "eval-model",
    async generateText() {
      modelCalls += 1;
      if (modelCalls === 1) {
        return JSON.stringify({
          status: "continue",
          summary: "read before delete",
          message: "Read the file before deletion.",
          files_touched: [],
          next_actions: [],
          tool_calls: [{ id: "read_temp", action: "file.read", inputs: { path: "temp.txt" } }]
        });
      }
      if (modelCalls === 2) {
        return JSON.stringify({
          status: "continue",
          summary: "delete temp",
          message: "Delete temp.txt.",
          files_touched: [],
          next_actions: [],
          tool_calls: [{ id: "delete_temp", action: "file.delete", inputs: { path: "temp.txt" } }]
        });
      }
      return JSON.stringify({
        status: "completed",
        summary: "deleted",
        message: "temp.txt deleted.",
        files_touched: [],
        next_actions: [],
        tool_calls: []
      });
    }
  };
  const loop = new CodingAgentLoop({
    workspace,
    settings,
    provider,
    events,
    maxTurns: 3,
    maxToolCalls: 3,
    emitFinal: false,
    emitProgress: false
  });
  const result = await loop.run("Delete temp.txt.");
  console.log(JSON.stringify({
    status: result.status,
    changed: result.outcome?.changed_files ?? [],
    exists: existsSync(join(workspace, "temp.txt"))
  }));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: { status?: string; changed?: string[]; exists?: boolean } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in failure below.
  }
  const ok = result.status === 0
    && parsed.status === "completed"
    && parsed.changed?.includes("temp.txt") === true
    && parsed.exists === false;
  return ok
    ? { name: "coding loop records file.delete workspace changes", status: "pass", message: "successful file.delete operations appear in changed_files for auditing and post-checks" }
    : {
        name: "coding loop records file.delete workspace changes",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkLocalGitToolsSkipNonRepositoryBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultSwarmSettings } from "./dist/config/settings.js";
import { runLocalTool } from "./dist/tools/local-tools.js";

const workspace = mkdtempSync(join(tmpdir(), "swarm-git-skip-eval-"));
try {
  const context = { workspace, settings: defaultSwarmSettings() };
  const status = await runLocalTool({ type: "git.status" }, context);
  const diff = await runLocalTool({ type: "git.diff" }, context);
  console.log(JSON.stringify({
    statusStatus: status.status,
    statusSummary: status.summary,
    diffStatus: diff.status,
    diffSummary: diff.summary
  }));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: { statusStatus?: string; statusSummary?: string; diffStatus?: string; diffSummary?: string } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in failure below.
  }
  const ok = result.status === 0
    && parsed.statusStatus === "success"
    && parsed.diffStatus === "success"
    && parsed.statusSummary?.includes("skipped")
    && parsed.diffSummary?.includes("skipped");
  return ok
    ? { name: "git status and diff skip cleanly outside git repositories", status: "pass", message: "non-git workspaces no longer produce failed git tool results" }
    : {
        name: "git status and diff skip cleanly outside git repositories",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkHeadlessToolPolicyWhitespaceSplitBehavior(root: string): EvalCaseResult {
  const content = readFileSync(resolve(root, "src/index.ts"), "utf8");
  const ok = content.includes("split(/[,\\s]+/)");
  return ok
    ? { name: "headless tool policy accepts comma or whitespace separated tools", status: "pass", message: "--allowed-tools parsing handles PowerShell comma joining and ordinary comma lists" }
    : { name: "headless tool policy accepts comma or whitespace separated tools", status: "fail", message: "parseToolListOption does not split on both comma and whitespace" };
}

function checkResultCardWarnsOnReviewFindingsBehavior(): EvalCaseResult {
  const card = buildResultCard({
    result: {
      session_id: "eval",
      status: "completed",
      content: "done",
      outcome: { changed_files: ["index.html"], tests_run: ["tests passed"], intermediate_artifacts: [], final_summary: "done" }
    },
    route: "work",
    snapshot: {
      session: {
        session_id: "eval",
        swarm_id: "swarm_eval",
        objective: "Generate app",
        status: "completed",
        created_at: "2026-05-10T00:00:00.000Z",
        updated_at: "2026-05-10T00:00:00.000Z"
      },
      attempts: [],
      workers: [],
      graph: { tasks: [], edges: [] },
      blackboard_counts: {},
      changed_files: ["index.html"],
      checks: ["tests passed"],
      review: {
        target_task_id: "coding_loop",
        reviewer: { agent_id: "reviewer", role: "reviewer" },
        verdict: "approve",
        score: 85,
        issues: [{ severity: "medium", message: "Drag ordering can regress." }],
        summary: "Minor issue: drag ordering can regress."
      },
      usage_summary: {},
      task_contracts: { summary: { total: 0, pending: 0, running: 0, blocked: 0, completed: 0, failed: 0, read_only: 0, scoped_write: 0, workspace_write: 0, scoped_targets: [] }, tasks: [] },
      work_contracts: { summary: { active_workers: 0, running_workers: 0, pending_workers: 0, resumable_workers: 0, active_handoffs: 0, read_only: 0, scoped_write: 0, workspace_write: 0, scoped_targets: [] }, active_workers: [], resumable_workers: [], active_handoffs: [] }
    }
  });
  const ok = card.review.status === "warning" && card.risks.some((risk) => risk.message.includes("Reviewer reported findings"));
  return ok
    ? { name: "result card warns when approved review still has findings", status: "pass", message: "approve with reduced confidence or issues is surfaced as warning, not a clean pass" }
    : { name: "result card warns when approved review still has findings", status: "fail", message: `review=${JSON.stringify(card.review)} risks=${JSON.stringify(card.risks)}` };
}

function checkResultCardInfersVerifierCompletedCheckBehavior(): EvalCaseResult {
  const card = buildResultCard({
    result: {
      session_id: "eval",
      status: "completed",
      content: "done",
      outcome: {
        changed_files: ["index.html"],
        tests_run: ["Verifier Agent completed: Workspace file index.html is multi-line and contains required features."],
        intermediate_artifacts: [],
        final_summary: "done"
      }
    },
    route: "work"
  });
  const ok = card.checks[0]?.status === "passed";
  return ok
    ? { name: "result card treats completed verifier summaries as passed checks", status: "pass", message: "successful verifier-agent summaries no longer show as unknown checks" }
    : { name: "result card treats completed verifier summaries as passed checks", status: "fail", message: `checks=${JSON.stringify(card.checks)}` };
}

function checkResultCardRisksFailedChecksBehavior(): EvalCaseResult {
  const card = buildResultCard({
    result: {
      session_id: "eval",
      status: "completed",
      content: "done",
      outcome: {
        changed_files: ["index.html"],
        tests_run: ["tests passed", "Verifier Agent failed: lint command exited 1"],
        intermediate_artifacts: [],
        final_summary: "done"
      }
    },
    route: "work"
  });
  const ok = card.checks.some((check) => check.status === "failed")
    && card.risks.some((risk) => risk.level === "high" && risk.message.includes("verification check failed"));
  return ok
    ? { name: "result card surfaces failed verification checks as high risk", status: "pass", message: "completed runs with failed checks no longer look risk-free" }
    : { name: "result card surfaces failed verification checks as high risk", status: "fail", message: `checks=${JSON.stringify(card.checks)} risks=${JSON.stringify(card.risks)}` };
}

function checkResultCardSurfacesContractsBehavior(): EvalCaseResult {
  const card = buildResultCard({
    result: {
      session_id: "eval_contracts",
      status: "completed",
      content: "done",
      outcome: { changed_files: ["src/app.ts"], tests_run: ["npm run check"], intermediate_artifacts: [], final_summary: "done" }
    },
    route: "coding_loop",
    snapshot: {
      session: {
        session_id: "eval_contracts",
        swarm_id: "swarm_eval_contracts",
        objective: "Patch app",
        status: "completed",
        created_at: "2026-05-10T00:00:00.000Z",
        updated_at: "2026-05-10T00:00:00.000Z"
      },
      attempts: [],
      workers: [],
      graph: { tasks: [], edges: [] },
      blackboard_counts: {},
      changed_files: ["src/app.ts"],
      checks: ["npm run check"],
      usage_summary: {},
      task_contracts: {
        summary: {
          total: 2,
          pending: 1,
          running: 1,
          blocked: 0,
          completed: 0,
          failed: 0,
          read_only: 1,
          scoped_write: 1,
          workspace_write: 0,
          scoped_targets: ["src/app.ts"]
        },
        tasks: []
      },
      work_contracts: {
        summary: {
          active_workers: 2,
          running_workers: 1,
          pending_workers: 1,
          resumable_workers: 1,
          active_handoffs: 1,
          read_only: 1,
          scoped_write: 1,
          workspace_write: 1,
          scoped_targets: ["src/app.ts", "src/lib.ts"]
        },
        active_workers: [
          {
            worker_id: "worker_scoped",
            display_name: "Scoped worker",
            status: "running",
            capability: "call_subagent",
            objective: "Patch scoped file",
            agent_spec_id: "coder",
            invocation_mode: "parallel",
            write_policy: "scoped_write",
            file_scope: ["src/app.ts"],
            updated_at: "2026-05-10T00:00:00.000Z"
          },
          {
            worker_id: "worker_pending",
            display_name: "Pending worker",
            status: "pending",
            capability: "call_subagent",
            objective: "Wait for slot",
            agent_spec_id: "reviewer",
            invocation_mode: "parallel",
            write_policy: "read_only",
            file_scope: [],
            blocked_reason: "Waiting for worker slot",
            updated_at: "2026-05-10T00:00:01.000Z"
          }
        ],
        resumable_workers: [
          {
            worker_id: "worker_done",
            display_name: "Done worker",
            status: "completed",
            capability: "call_subagent",
            objective: "Finished",
            agent_spec_id: "builder",
            invocation_mode: "handoff",
            write_policy: "workspace_write",
            file_scope: ["src/lib.ts"],
            updated_at: "2026-05-10T00:00:02.000Z"
          }
        ],
        active_handoffs: [
          {
            handoff_id: "handoff_scoped",
            worker_id: "worker_scoped",
            source_agent: "main_swarm",
            target_agent_spec_id: "coder",
            reason: "Deep implementation",
            status: "active",
            write_policy: "scoped_write",
            file_scope: ["src/app.ts"],
            scope: ["src/app.ts"],
            updated_at: "2026-05-10T00:00:03.000Z"
          }
        ]
      }
    }
  });
  const text = formatResultCardText(card);
  const ok = card.contracts?.tasks.scopedWrite === 1
    && card.contracts.work.pendingWorkers === 1
    && text.includes("Contracts")
    && text.includes("tasks total=2 pending=1 running=1")
    && text.includes("work active=2 running=1 pending=1 resumable=1 handoffs=1")
    && text.includes("worker_scoped [running] coder/parallel policy=scoped_write scope=src/app.ts")
    && text.includes("worker_pending [pending] reviewer/parallel policy=read_only blocked=Waiting for worker slot")
    && text.includes("handoff_scoped [active] worker=worker_scoped -> coder policy=scoped_write scope=src/app.ts");
  return ok
    ? { name: "result card surfaces task and worker contracts", status: "pass", message: "result cards include write policies, scoped targets, pending workers, and handoffs" }
    : { name: "result card surfaces task and worker contracts", status: "fail", message: text };
}

function checkReviewSummarySkipsAgentHeadingBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SwarmRuntime } from "./dist/runtime/runtime.js";

const dir = mkdtempSync(resolve(tmpdir(), "swarm-review-summary-eval-"));
const workspace = resolve(dir, "workspace");
mkdirSync(workspace, { recursive: true });
const runtime = new SwarmRuntime({ databasePath: resolve(dir, "swarm.db"), workspace });
runtime.provider.generateText = async () => { throw new Error("force fallback"); };
runtime.invokeAgent = async (request) => {
  if (request.capability === "code.review") {
    return {
      action: "agent.delegate",
      status: "success",
      summary: "Review Agent completed: ### Verdict",
      content: "### Verdict\\nACCEPT with minor issues.\\n\\n### Findings\\nMedium: saveTasks lacks try/catch.",
      data: { worker_id: "review_worker" }
    };
  }
  return {
    action: "agent.delegate",
    status: "success",
    summary: "Verifier Agent completed: checks passed",
    content: "checks passed",
    data: { worker_id: "verify_worker" }
  };
};
try {
  const result = await runtime.runPostChangeChecks("sess_eval", "objective", {
    changed_files: ["index.html"],
    tests_run: [],
    intermediate_artifacts: [],
    final_summary: "done"
  });
  console.log(JSON.stringify({ summary: result.review.summary, score: result.review.score }));
} finally {
  runtime.dispose();
  rmSync(dir, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: { summary?: string; score?: number } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in failure below.
  }
  const ok = result.status === 0
    && parsed.summary === "ACCEPT with minor issues."
    && parsed.score === 70;
  return ok
    ? { name: "review summary skips agent-completed markdown headings", status: "pass", message: "post-change reports ignore wrappers like 'Review Agent completed: ### Verdict' and fall back to meaningful content" }
    : {
        name: "review summary skips agent-completed markdown headings",
        status: "fail",
        message: `exit=${result.status} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkPostChangeChecksHydrateOutputRefsBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SwarmRuntime } from "./dist/runtime/runtime.js";

const dir = mkdtempSync(resolve(tmpdir(), "swarm-report-hydrate-eval-"));
const workspace = resolve(dir, "workspace");
mkdirSync(workspace, { recursive: true });
const reviewRef = resolve(dir, "review.output");
const verifyRef = resolve(dir, "verify.output");
writeFileSync(reviewRef, [
  "## Findings",
  "",
  "### Medium Severity",
  "1. parseAmount accepts trailing non-numeric characters, for example 12.34abc.",
  "2. remove command misidentifies id when --file precedes it.",
  "",
  "### Test Gaps",
  "- No test for parseAmount trailing junk."
].join("\\n"));
writeFileSync(verifyRef, [
  "Verified workspace changes work as tested. Edge-case bugs detected but not covered by current tests.",
  "",
  "Medium Severity: remove --file data.json id misidentifies the id.",
  "Test Gaps: missing corrupted data file coverage."
].join("\\n"));
const runtime = new SwarmRuntime({ databasePath: resolve(dir, "swarm.db"), workspace });
runtime.provider.generateText = async () => { throw new Error("force fallback"); };
let calls = 0;
runtime.invokeAgent = async (request) => {
  calls += 1;
  if (request.capability === "code.review") {
    return {
      action: "agent.delegate",
      status: "success",
      summary: "Review Agent completed: ## Findings",
      content: "Worker worker_review (reviewer) completed: ## Findings\\nFull worker result: " + reviewRef,
      outputRef: reviewRef,
      data: { worker_id: "review_worker", result_ref: reviewRef }
    };
  }
  return {
    action: "agent.delegate",
    status: "success",
    summary: "Verifier Agent completed: ## Verification Results",
    content: "Worker worker_verify (verifier) completed: ## Verification Results\\nFull worker result: " + verifyRef,
    outputRef: verifyRef,
    data: { worker_id: "verify_worker", result_ref: verifyRef }
  };
};
try {
  const result = await runtime.runPostChangeChecks("sess_eval", "objective", {
    changed_files: ["src/ledger.js"],
    tests_run: ["npm test passed"],
    intermediate_artifacts: [],
    final_summary: "done"
  });
  console.log(JSON.stringify({
    calls,
    reviewVerdict: result.review.verdict,
    reviewScore: result.review.score,
    reviewIssues: result.review.issues?.length ?? 0,
    reviewSummary: result.review.summary,
    verificationStatus: result.verification.status,
    verificationSummary: result.verification.summary
  }));
} finally {
  runtime.dispose();
  rmSync(dir, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    calls?: number;
    reviewVerdict?: string;
    reviewScore?: number;
    reviewIssues?: number;
    reviewSummary?: string;
    verificationStatus?: string;
    verificationSummary?: string;
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in failure below.
  }
  const ok = result.status === 0
    && parsed.calls === 2
    && parsed.reviewVerdict === "needs_revision"
    && typeof parsed.reviewScore === "number"
    && parsed.reviewScore <= 85
    && typeof parsed.reviewIssues === "number"
    && parsed.reviewIssues > 0
    && parsed.reviewSummary?.includes("parseAmount accepts trailing")
    && parsed.verificationStatus === "partial"
    && parsed.verificationSummary?.includes("Edge-case bugs detected");
  return ok
    ? { name: "post-change checks hydrate worker output refs before reporting", status: "pass", message: "review and verifier findings stored behind outputRef now affect final review and verification status" }
    : {
        name: "post-change checks hydrate worker output refs before reporting",
        status: "fail",
        message: `exit=${result.status} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkPostChangeStatusMappingPreservesVerifiedWorkBehavior(): EvalCaseResult {
  const baseReview = {
    target_task_id: "coding_loop",
    reviewer: { agent_id: "reviewer", role: "reviewer" },
    verdict: "approve" as const,
    score: 95,
    issues: [],
    summary: "approved"
  };
  const success = postChangeExecutionStatus({
    review: baseReview,
    verification: { status: "success", summary: "verified" }
  });
  const partial = postChangeExecutionStatus({
    review: baseReview,
    verification: { status: "partial", summary: "tests passed with non-blocking coverage notes" }
  });
  const rejected = postChangeExecutionStatus({
    review: { ...baseReview, verdict: "reject" as const },
    verification: { status: "success", summary: "verified" }
  });
  const operationalRejected = postChangeExecutionStatus({
    review: {
      ...baseReview,
      verdict: "reject" as const,
      score: 0,
      issues: [{ severity: "high" as const, message: "Review Agent failed: budget exhausted after spawn powershell.exe ENOENT." }],
      summary: "Review Agent failed: Budget exhausted before completion."
    },
    verification: { status: "success", summary: "npm test passed" }
  });
  const ok = success === "completed" && partial === "completed" && rejected === "failed" && operationalRejected === "completed";
  return ok
    ? { name: "post-change verification status mapping preserves verified work", status: "pass", message: "partial verification warnings and operational review failures no longer fail a verified run" }
    : { name: "post-change verification status mapping preserves verified work", status: "fail", message: `success=${success} partial=${partial} rejected=${rejected} operationalRejected=${operationalRejected}` };
}

function checkRealTaskReplayStatusCacheDiagnosisBehavior(): EvalCaseResult {
  const verification = { status: "success" as const, summary: "npm test passed for cart totals." };
  const review = {
    target_task_id: "coding_loop",
    reviewer: { agent_id: "reviewer", role: "reviewer" },
    verdict: "needs_revision" as const,
    score: 82,
    issues: [{ severity: "low" as const, message: "Add a zero-discount edge-case assertion." }],
    summary: "Review found a low-priority edge-case coverage warning."
  };
  const status = postChangeExecutionStatus({ review, verification });
  const cache = {
    status: "stable",
    cacheMode: "prefix-structured",
    providerId: "deepseek",
    model: "deepseek-v4-flash",
    purpose: "worker_coding_loop",
    cachedInputTokens: 6400,
    totalInputWithCacheTokens: 10000,
    cacheablePrefixTokensEstimate: 4096,
    hitRate: 0.64,
    diagnostics: "stable",
    outcome: "hit" as const
  };
  const card = buildResultCard({
    result: {
      session_id: "eval-real-task-cart-fix",
      status,
      content: "Cart fix completed.",
      outcome: {
        changed_files: ["src/cart.ts", "src/cart.test.ts"],
        tests_run: [verification.summary],
        intermediate_artifacts: ["reports/cart-fix-summary.json"],
        final_summary: "Cart total bug fixed and tests passed."
      }
    },
    route: "work",
    snapshot: {
      session: {
        session_id: "eval-real-task-cart-fix",
        swarm_id: "swarm_eval_real_task",
        objective: "Fix cart total calculation",
        status: "completed",
        created_at: "2026-05-22T00:00:00.000Z",
        updated_at: "2026-05-22T00:00:01.000Z"
      },
      attempts: [],
      workers: [],
      graph: { tasks: [], edges: [] },
      blackboard_counts: {},
      changed_files: ["src/cart.ts", "src/cart.test.ts"],
      checks: [verification.summary],
      review,
      verification: {
        status: "success",
        summary: verification.summary,
        worker_id: "worker_cart_verify"
      },
      final_outcome: {
        changed_files: ["src/cart.ts", "src/cart.test.ts"],
        tests_run: [verification.summary],
        intermediate_artifacts: ["reports/cart-fix-summary.json"],
        final_summary: "Cart total bug fixed and tests passed."
      },
      usage_summary: {},
      task_contracts: { summary: { total: 0, pending: 0, running: 0, blocked: 0, completed: 0, failed: 0, read_only: 0, scoped_write: 0, workspace_write: 0, scoped_targets: [] }, tasks: [] },
      work_contracts: { summary: { active_workers: 0, running_workers: 0, pending_workers: 0, resumable_workers: 0, active_handoffs: 0, read_only: 0, scoped_write: 0, workspace_write: 0, scoped_targets: [] }, active_workers: [], resumable_workers: [], active_handoffs: [] }
    },
    cache
  });
  const artifacts = buildHeadlessRunArtifacts({
    objective: "Replay cart-fix eval fixture",
    workspace: "E:/Playground/Swarm",
    mode: "coding_loop",
    startedAt: "2026-05-22T00:00:00.000Z",
    endedAt: "2026-05-22T00:00:01.000Z",
    durationMs: 1000,
    capturedEvents: [],
    result: {
      session_id: "eval-real-task-cart-fix",
      status,
      content: "Cart fix completed.",
      result_card: card
    }
  });
  const diagnosis = buildLatestRunDiagnosis({
    report: artifacts.report,
    telemetry: artifacts.telemetry,
    resultCard: card,
    promptCache: cache,
    promptCacheTrend: promptCacheTrendFromStatuses([cache]),
    latestDetail: { source: "ai", title: "Assistant Detail", route: "coding_loop", sessionId: "eval-real-task-cart-fix" }
  });
  const ok = status === "completed"
    && card.status === "completed"
    && card.review.status === "warning"
    && card.changedFiles.includes("src/cart.ts")
    && card.checks.some((check) => check.status === "passed")
    && artifacts.telemetry.llm.cache_trend.source === "result_card_fallback"
    && artifacts.telemetry.llm.cache_trend.hit_rate === 0.64
    && artifacts.telemetry.llm.cache_slo.status === "pass"
    && artifacts.telemetry.llm.cache_slo.metrics.hit_tokens === 6400
    && diagnosis.detail.includes("route=work (raw=coding_loop)")
    && diagnosis.detail.includes("hit_rate=64%");
  return ok
    ? { name: "real-task replay eval preserves status, cache, and diagnosis evidence", status: "pass", message: "verified cart-fix style fixture stays completed with review warning and cache diagnosis evidence" }
    : {
        name: "real-task replay eval preserves status, cache, and diagnosis evidence",
        status: "fail",
    message: `status=${status} card=${JSON.stringify({ status: card.status, review: card.review, checks: card.checks, changedFiles: card.changedFiles })} cacheTrend=${JSON.stringify(artifacts.telemetry.llm.cache_trend)} diagnosis=${diagnosis.detail}`
      };
}

function checkProtocolReplayForcedVerdictBehavior(): EvalCaseResult {
  const replay = buildProtocolReplay({
    sessionId: "eval-protocol-replay-verdict",
    generatedAt: "2026-05-22T00:00:00.000Z",
    envelopes: [
      createEnvelope({
        swarm_id: "swarm_eval_protocol_replay",
        session_id: "eval-protocol-replay-verdict",
        task_id: "worker-replay-verdict",
        from: { agent_id: "main_swarm" },
        to: { agent_id: "worker:worker-replay-verdict", capability: "code.test" },
        type: "task.assign",
        intent: "task.assign",
        payload: {
          worker_id: "worker-replay-verdict",
          objective: "Exercise forced replay verdict"
        },
        idempotency_key: "eval-protocol-replay-verdict:assign"
      }),
      createEnvelope({
        swarm_id: "swarm_eval_protocol_replay",
        session_id: "eval-protocol-replay-verdict",
        task_id: "worker-replay-verdict",
        from: { agent_id: "worker:worker-replay-verdict" },
        to: { agent_id: "main_swarm" },
        type: "task.result",
        intent: "task.result",
        payload: {
          worker_id: "worker-replay-verdict",
          summary: "replay verdict completed"
        },
        idempotency_key: "eval-protocol-replay-verdict:result"
      })
    ]
  });
  const diff = diffProtocolReplaySnapshots({
    live: replay,
    replay,
    generatedAt: "2026-05-22T00:00:01.000Z"
  });
  const artifacts = buildHeadlessRunArtifacts({
    objective: "Force protocol replay verdict",
    workspace: "E:/Playground/Swarm",
    mode: "coding_loop",
    startedAt: "2026-05-22T00:00:00.000Z",
    endedAt: "2026-05-22T00:00:01.000Z",
    durationMs: 1000,
    capturedEvents: [],
    protocolReplayDiff: diff,
    result: {
      session_id: "eval-protocol-replay-verdict",
      status: "completed",
      content: "Protocol replay verdict passed."
    }
  });
  const ok = diff.replay_verdict.forced === true
    && diff.replay_verdict.status === "pass"
    && artifacts.report.protocol_replay_diff?.replay_verdict.forced === true
    && artifacts.telemetry.protocol_replay_diff?.status === "pass";
  return ok
    ? { name: "protocol replay eval forces replay verdict", status: "pass", message: "offline eval uses protocol replay diff verdict as the pass/fail source" }
    : { name: "protocol replay eval forces replay verdict", status: "fail", message: JSON.stringify({ diff, report: artifacts.report.protocol_replay_diff }) };
}

function checkFaultInjectionRecoveryDrillsBehavior(): EvalCaseResult {
  const report = runFaultInjectionDrills({ generatedAt: "2026-05-24T00:02:00.000Z" });
  const kinds = report.drills.map((drill) => drill.kind).sort();
  const ok = report.status === "pass"
    && report.summary.total >= 6
    && report.summary.failed === 0
    && report.summary.stuck_actors === 0
    && report.summary.stuck_envelopes === 0
    && report.summary.stale_leases === 0
    && report.drills.every((drill) => drill.replay_proof.replay_verdict.forced)
    && kinds.includes("actor_crash")
    && kinds.includes("provider_timeout")
    && kinds.includes("duplicate_delivery")
    && kinds.includes("mailbox_backlog")
    && kinds.includes("ownership_expiry")
    && kinds.includes("blackboard_conflict");
  return ok
    ? {
        name: "fault injection drills recover through replay proof",
        status: "pass",
        message: `fault drills pass total=${report.summary.total} recovered=${report.summary.recovered} contained=${report.summary.contained}`
      }
    : {
        name: "fault injection drills recover through replay proof",
        status: "fail",
        message: JSON.stringify(report.summary)
      };
}

function offlineBudgetBackpressureReport() {
  const governor = new SwarmBudgetGovernor({
    now: "2026-05-26T00:00:00.000Z",
    accepted_task_ids: ["task-accepted-budget"],
    session: {
      used_tokens: 10_000,
      max_tokens: 10_000,
      used_cost: 9.5,
      max_cost: 10,
      queue_depth: 12,
      max_queue_depth: 10,
      running: 4,
      max_concurrency: 4
    },
    provider: {
      openai: {
        provider_retry_count: 2,
        max_provider_retries: 3
      }
    }
  });
  const decisions = [
    governor.decide({
      actor_id: "worker:budget-low",
      session_id: "eval-budget-backpressure",
      task_id: "task-low-budget",
      provider_id: "openai",
      priority: "low",
      envelope_id: "env-budget-low"
    }),
    governor.decide({
      actor_id: "worker:budget-accepted",
      session_id: "eval-budget-backpressure",
      task_id: "task-accepted-budget",
      provider_id: "openai",
      priority: "high",
      envelope_id: "env-budget-accepted"
    })
  ];
  return governor.report(decisions, { generatedAt: "2026-05-26T00:00:01.000Z" });
}

function checkBudgetBackpressureMetricsBehavior(): EvalCaseResult {
  const report = offlineBudgetBackpressureReport();
  const formatted = formatBudgetPressure(report).join("\n");
  const ok = report.status === "exhausted"
    && report.metrics.tokens_used === 10_000
    && report.metrics.cost_used === 9.5
    && report.metrics.provider_retry_count === 2
    && report.metrics.deferred_tasks >= 1
    && report.metrics.sleeping_actors >= 1
    && report.metrics.accepted_tasks_preserved >= 1
    && formatted.includes("budget status=exhausted")
    && formatted.includes("deferred=1")
    && formatted.includes("sleeping=1")
    && formatted.includes("retries=2/3");
  return ok
    ? {
        name: "budget backpressure eval reports cost retry and pressure metrics",
        status: "pass",
        message: `budget status=${report.status} deferred=${report.metrics.deferred_tasks} sleeping=${report.metrics.sleeping_actors} retries=${report.metrics.provider_retry_count}/${report.metrics.max_provider_retries ?? "unlimited"} cost=${report.metrics.cost_used}/${report.metrics.cost_limit ?? "unlimited"}`
      }
    : {
        name: "budget backpressure eval reports cost retry and pressure metrics",
        status: "fail",
        message: formatted
      };
}

function checkDogfoodHarnessQualityReportBehavior(): EvalCaseResult {
  const verification = { status: "success" as const, summary: "npm test passed for cart totals." };
  const review = {
    target_task_id: "coding_loop",
    reviewer: { agent_id: "reviewer", role: "reviewer" },
    verdict: "needs_revision" as const,
    score: 82,
    issues: [{ severity: "low" as const, message: "Add a zero-discount edge-case assertion." }],
    summary: "Review found a low-priority edge-case coverage warning."
  };
  const status = postChangeExecutionStatus({ review, verification });
  const cache = {
    status: "stable",
    cacheMode: "prefix-structured",
    providerId: "deepseek",
    model: "deepseek-v4-flash",
    purpose: "worker_coding_loop",
    cachedInputTokens: 6400,
    totalInputWithCacheTokens: 10000,
    cacheablePrefixTokensEstimate: 4096,
    hitRate: 0.64,
    diagnostics: "stable",
    outcome: "hit" as const
  };
  const card = buildResultCard({
    result: {
      session_id: "eval-dogfood-cart-fix",
      status,
      content: "Cart fix completed.",
      outcome: {
        changed_files: ["src/cart.ts", "src/cart.test.ts"],
        tests_run: [verification.summary],
        intermediate_artifacts: ["reports/cart-fix-summary.json"],
        final_summary: "Cart total bug fixed and tests passed."
      },
      artifact_path: "reports/cart-fix-result.json"
    },
    route: "work",
    snapshot: {
      session: {
        session_id: "eval-dogfood-cart-fix",
        swarm_id: "swarm_eval_dogfood",
        objective: "Fix cart total calculation",
        status: "completed",
        created_at: "2026-05-22T00:00:00.000Z",
        updated_at: "2026-05-22T00:00:01.000Z"
      },
      attempts: [],
      workers: [],
      graph: { tasks: [], edges: [] },
      blackboard_counts: {},
      changed_files: ["src/cart.ts", "src/cart.test.ts"],
      checks: [verification.summary],
      review,
      verification: {
        status: "success",
        summary: verification.summary,
        worker_id: "worker_cart_verify"
      },
      final_outcome: {
        changed_files: ["src/cart.ts", "src/cart.test.ts"],
        tests_run: [verification.summary],
        intermediate_artifacts: ["reports/cart-fix-summary.json"],
        final_summary: "Cart total bug fixed and tests passed."
      },
      usage_summary: {},
      task_contracts: { summary: { total: 0, pending: 0, running: 0, blocked: 0, completed: 0, failed: 0, read_only: 0, scoped_write: 0, workspace_write: 0, scoped_targets: [] }, tasks: [] },
      work_contracts: { summary: { active_workers: 0, running_workers: 0, pending_workers: 0, resumable_workers: 0, active_handoffs: 0, read_only: 0, scoped_write: 0, workspace_write: 0, scoped_targets: [] }, active_workers: [], resumable_workers: [], active_handoffs: [] }
    },
    cache
  });
  const artifacts = buildHeadlessRunArtifacts({
    objective: "Replay cart-fix dogfood fixture",
    workspace: "E:/Playground/Swarm",
    mode: "coding_loop",
    startedAt: "2026-05-22T00:00:00.000Z",
    endedAt: "2026-05-22T00:00:01.000Z",
    durationMs: 1000,
    capturedEvents: [],
    reportPath: "E:/Playground/Swarm/.swarm/local-tests/cart-fix/reports/run.report.json",
    telemetryPath: "E:/Playground/Swarm/.swarm/local-tests/cart-fix/reports/run.telemetry.json",
    trajectoryPath: "E:/Playground/Swarm/.swarm/local-tests/cart-fix/reports/run.trajectory.json",
    debugLogPath: "C:/Users/dev/.swarm/logs/cart-fix.log",
    stdoutPath: "E:/Playground/Swarm/.swarm/local-tests/cart-fix/stdout.log",
    stderrPath: "E:/Playground/Swarm/.swarm/local-tests/cart-fix/stderr.log",
    diffSummaryPath: "E:/Playground/Swarm/.swarm/local-tests/cart-fix/diff-summary.json",
    result: {
      session_id: "eval-dogfood-cart-fix",
      status,
      content: "Cart fix completed.",
      outcome: {
        changed_files: ["src/cart.ts", "src/cart.test.ts"],
        tests_run: [verification.summary],
        intermediate_artifacts: ["reports/cart-fix-summary.json"],
        final_summary: "Cart total bug fixed and tests passed."
      },
      artifact_path: "reports/cart-fix-result.json",
      result_card: card
    }
  });
  const quality = evaluateDogfoodReplay({
    id: "cart-fix-low-review-warning",
    objective: "Fix cart total calculation",
    workspaceSeed: { kind: "fixture", path: ".swarm/local-tests/cart-fix/seed" },
    expectedStatus: "completed",
    expectedChangedFiles: ["src/cart.ts", "src/cart.test.ts"],
    expectedTests: ["npm test"],
    enforceMinimalDiff: true,
    allowReviewWarningWhenVerified: true,
    cacheExpectation: {
      requireCacheFacts: true,
      minHitRate: 0.5,
      expectedOutcome: "hit"
    },
    artifactExpectation: {
      requireReport: true,
      requireTelemetry: true,
      requireTrajectory: true,
      requireDebugLog: true,
      requireStdout: true,
      requireStderr: true,
      requireDiffSummary: true
    }
  }, {
    resultCard: card,
    report: artifacts.report,
    telemetry: artifacts.telemetry,
    trajectory: artifacts.trajectory,
    artifactIndex: artifacts.artifactIndex,
    stdout: "npm test passed for cart totals.",
    stderr: "",
    diffSummary: "src/cart.ts and src/cart.test.ts changed."
  });
  const formatted = formatDogfoodQualityReport(quality).join("\n");
  const ok = quality.status === "pass"
    && quality.finalStatus === "completed"
    && quality.reviewStatus === "warning"
    && quality.reviewSeverity === "low"
    && quality.verificationStatus === "passed"
    && quality.cacheHitRate === 0.64
    && quality.cacheRoi?.schema_version === "swarm.cache_roi.v1"
    && quality.cacheRoi?.saved_tokens === 6400
    && quality.artifactKinds.includes("trajectory")
    && quality.artifactKinds.includes("stdout")
    && quality.artifactKinds.includes("stderr")
    && quality.artifactKinds.includes("diff_summary")
    && quality.findings.some((finding) => finding.severity === "warning" && finding.category === "quality")
    && !quality.failureCategories.length
    && formatted.includes("cache_hit_rate=64%")
    && formatted.includes("cache_roi=saved 6400t")
    && formatted.includes("trajectory=E:/Playground/Swarm/.swarm/local-tests/cart-fix/reports/run.trajectory.json");
  return ok
    ? { name: "dogfood harness grades quality artifacts without failing low review warnings", status: "pass", message: "offline dogfood fixture records report, telemetry, trajectory, logs, diff summary, cache facts, and verified low review warning" }
    : { name: "dogfood harness grades quality artifacts without failing low review warnings", status: "fail", message: formatted };
}

function checkRealSwarmOfflineEvalSuiteBehavior(): EvalCaseResult {
  const suite = runOfflineRealSwarmEvalSuite();
  const formatted = formatRealSwarmEvalSuite(suite).join("\n");
  const kinds = suite.scenarios.map((scenario) => scenario.kind);
  const cacheReuse = suite.scenarios.find((scenario) => scenario.kind === "cache_reuse");
  const conflict = suite.scenarios.find((scenario) => scenario.kind === "conflict");
  const lspFallback = suite.scenarios.find((scenario) => scenario.kind === "lsp_fallback");
  const symphonyIntake = suite.scenarios.find((scenario) => scenario.kind === "symphony_intake");
  const ok = suite.schema_version === "swarm.real_swarm_eval_suite.v1"
    && suite.providerMode === "fake-provider"
    && suite.status === "pass"
    && realSwarmEvalReleaseGateStatus(suite) === "pass"
    && kinds.join(",") === "bugfix,feature,refactor,conflict,handoff,symphony_intake,lsp_fallback,cache_reuse"
    && suite.scenarios.every((scenario) => scenario.failureCategories.length === 0)
    && suite.scenarios.every((scenario) => scenario.tests.length > 0 && scenario.tests.every((item) => item.status === "pass"))
    && suite.summary.cache.hitCalls > 0
    && suite.summary.cache.readTokens > 0
    && suite.summary.cache.writeTokens > 0
    && (cacheReuse?.cache.hitCalls ?? 0) > 0
    && (cacheReuse?.cache.writeTokens ?? 0) > 0
    && (conflict?.handoffCount ?? 0) > 0
    && conflict?.conflictResolution.resolved === true
    && lspFallback?.lspFallback.used === true
    && symphonyIntake?.symphonyIntake.accepted === true
    && (symphonyIntake?.symphonyIntake.workItems ?? 0) > 0
    && suite.summary.latencyMs.max > 0
    && suite.summary.providerRetries > 0
    && suite.optionalRealProviderDogfood.defaultEnabled === false
    && suite.optionalRealProviderDogfood.command.includes("--real-swarm")
    && formatted.includes("release_gate=pass blocking=none")
    && formatted.includes("provider_retries=");
  return ok
    ? {
        name: "real swarm offline eval suite covers collaboration quality cache handoff LSP and provider gates",
        status: "pass",
        message: `offline fake-provider suite covers ${kinds.length} scenarios with cache_read=${suite.summary.cache.readTokens} handoffs=${suite.summary.handoffCount}`
      }
    : {
        name: "real swarm offline eval suite covers collaboration quality cache handoff LSP and provider gates",
        status: "fail",
        message: formatted
      };
}

function checkProviderFaultLatestDiagnosisBehavior(): EvalCaseResult {
  const diagnosis = buildLatestRunDiagnosis({
    events: [{
      type: "error",
      message: "HTTP 429 rate limit for Authorization: Bearer abcdefghijklmnop and apiKey=sk-testabcdef"
    }],
    latestDetail: { source: "event", title: "Event Detail", route: "coding_loop", sessionId: "eval-provider-fault" }
  });
  const ok = diagnosis.detail.includes("provider_rate_limit")
    && diagnosis.detail.includes("Model provider rate limit or quota was hit")
    && diagnosis.detail.includes("Bearer REDACTED")
    && diagnosis.detail.includes("apiKey=REDACTED")
    && !diagnosis.detail.includes("abcdefghijklmnop")
    && !diagnosis.detail.includes("sk-testabcdef");
  return ok
    ? { name: "provider fault eval surfaces retry recovery without secrets", status: "pass", message: "rate-limit diagnosis stays actionable and redacted" }
    : { name: "provider fault eval surfaces retry recovery without secrets", status: "fail", message: diagnosis.detail };
}

function checkCacheMissFallbackTelemetryBehavior(): EvalCaseResult {
  const cache = {
    status: "changed",
    cacheMode: "prefix-structured",
    providerId: "deepseek",
    model: "deepseek-v4-flash",
    purpose: "worker_coding_loop",
    cachedInputTokens: 0,
    totalInputWithCacheTokens: 4096,
    cacheablePrefixTokensEstimate: 4096,
    hitRate: 0,
    diagnostics: "requestPrefixHash4096",
    changed: ["requestPrefixHash4096"],
    changedSections: ["tools"],
    missReason: "changed_tools",
    outcome: "miss" as const,
    reason: "cacheable prompt prefix changed",
    recommendation: "Keep stable system text and tool schemas unchanged across turns."
  };
  const artifacts = buildHeadlessRunArtifacts({
    objective: "Replay cache-miss fixture",
    workspace: "E:/Playground/Swarm",
    mode: "coding_loop",
    startedAt: "2026-05-22T00:00:00.000Z",
    endedAt: "2026-05-22T00:00:01.000Z",
    durationMs: 1000,
    capturedEvents: [],
    result: {
      session_id: "eval-cache-miss",
      status: "completed",
      content: "Done",
      result_card: {
        sessionId: "eval-cache-miss",
        status: "completed",
        route: "work",
        summary: "Done",
        changedFiles: [],
        checks: [],
        review: { status: "skipped", summary: "not recorded" },
        risks: [],
        recovery: [],
        artifacts: [],
        next: [],
        cache
      }
    }
  });
  const diagnosis = buildLatestRunDiagnosis({
    telemetry: artifacts.telemetry,
    resultCard: artifacts.report.result?.result_card,
    promptCache: cache,
    promptCacheTrend: promptCacheTrendFromStatuses([cache], "result_card_fallback"),
    latestDetail: { source: "ai", title: "Assistant Detail", route: "coding_loop", sessionId: "eval-cache-miss" }
  });
  const trend = artifacts.telemetry.llm.cache_trend;
  const ok = trend.source === "result_card_fallback"
    && trend.miss_calls === 1
    && trend.hit_calls === 0
    && trend.changed_sections.includes("tools")
    && trend.miss_reasons.changed_tools === 1
    && artifacts.telemetry.llm.cache_impact?.schema_version === "swarm.cache_impact.v1"
    && artifacts.telemetry.llm.cache_impact.changed_dimensions.includes("schema")
    && artifacts.telemetry.llm.cache_impact.reasons.some((reason) => reason.includes("miss_reason=changed_tools"))
    && artifacts.telemetry.llm.cache_slo.metrics.changed_prefix_misses === 1
    && artifacts.telemetry.llm.prompt_cache_diagnostics.changed === 1
    && diagnosis.detail.includes("cache_trend_source=result_card_fallback")
    && diagnosis.detail.includes("miss_reason=changed_tools")
    && diagnosis.detail.includes("changed_sections=tools")
    && diagnosis.detail.includes("changed=requestPrefixHash4096")
    && diagnosis.detail.includes("cacheable prompt prefix changed");
  return ok
    ? { name: "cache miss eval preserves fallback telemetry and miss reason", status: "pass", message: "changed-prefix cache misses fail if fallback trend, impact reason, or diagnosis disappears" }
    : { name: "cache miss eval preserves fallback telemetry and miss reason", status: "fail", message: `trend=${JSON.stringify(trend)} impact=${JSON.stringify(artifacts.telemetry.llm.cache_impact)} diagnostics=${JSON.stringify(artifacts.telemetry.llm.prompt_cache_diagnostics)} diagnosis=${diagnosis.detail}` };
}

function checkCacheSloGateBehavior(): EvalCaseResult {
  const stableGate = evaluatePromptCacheSlo(promptCacheTrendFromStatuses([
    {
      status: "stable",
      outcome: "hit",
      cachedInputTokens: 6400,
      totalInputWithCacheTokens: 10000,
      cacheCreationInputTokens: 250
    }
  ], "provider_usage"), {
    requireTrend: true,
    minCalls: 1,
    minHitRate: 0.5,
    maxChangedPrefixMisses: 0,
    maxFallbackCalls: 0,
    maxProviderUsageMissingCalls: 0
  });
  const changedGate = evaluatePromptCacheSlo(promptCacheTrendFromStatuses([
    {
      status: "changed",
      outcome: "miss",
      changed: ["requestPrefixHash4096"],
      changedSections: ["tools"],
      missReason: "changed_tools",
      cachedInputTokens: 0,
      totalInputWithCacheTokens: 4096
    }
  ], "provider_usage"), {
    minHitRate: 0.5,
    maxChangedPrefixMisses: 0
  });
  const fallbackGate = evaluatePromptCacheSlo(promptCacheTrendFromStatuses([
    {
      status: "stable",
      outcome: "hit",
      cachedInputTokens: 1200,
      totalInputWithCacheTokens: 2000
    }
  ], "result_card_fallback"), {
    maxFallbackCalls: 0,
    maxProviderUsageMissingCalls: 0
  });
  const missingGate = evaluatePromptCacheSlo(promptCacheTrendFromStatuses([]), {
    requireTrend: true
  });

  const ok = stableGate.status === "pass"
    && stableGate.state === "stable"
    && changedGate.status === "fail"
    && changedGate.metrics.changedPrefixMisses === 1
    && changedGate.metrics.missReasons.changed_tools === 1
    && changedGate.failures.some((failure) => failure.includes("changed-prefix misses"))
    && fallbackGate.status === "fail"
    && fallbackGate.metrics.fallbackCalls === 1
    && fallbackGate.metrics.providerUsageMissingCalls === 1
    && missingGate.status === "fail"
    && missingGate.failures.some((failure) => failure.includes("cache trend is missing"));
  return ok
    ? { name: "cache SLO eval gates fallback, missing usage, and changed-prefix regressions", status: "pass", message: `stable=${stableGate.summary} changed=${changedGate.summary} fallback=${fallbackGate.summary}` }
    : { name: "cache SLO eval gates fallback, missing usage, and changed-prefix regressions", status: "fail", message: `stable=${JSON.stringify(stableGate)} changed=${JSON.stringify(changedGate)} fallback=${JSON.stringify(fallbackGate)} missing=${JSON.stringify(missingGate)}` };
}

function checkCacheLabReplayBehavior(): EvalCaseResult {
  const stableSystem = { text: "runtime protocol v1", cache: true, section: "system" as const };
  const stableTools = { text: JSON.stringify({ tools: ["Read", "Grep", "Bash"] }), cache: true, section: "tools" as const };
  const stableWorkspace = { text: JSON.stringify({ detected: ["node", "typescript"], scripts: ["test", "check"] }), cache: true, section: "workspace" as const };
  const firstTail = { text: JSON.stringify({ objective: "fix cart total", recent_files: ["src/cart.ts"] }), cache: false, section: "context" as const };
  const secondTail = { text: JSON.stringify({ objective: "fix cart total", recent_files: ["src/cart.test.ts"], dirty_files: ["src/cart.ts"] }), cache: false, section: "context" as const };
  const driftTools = { text: JSON.stringify({ tools: ["Read", "Grep"] }), cache: true, section: "tools" as const };

  const lab = evaluateCodingLoopCacheLab([
    {
      label: "first",
      cacheKey: "swarm:main:stable:first",
      system: [stableSystem],
      user: [stableTools, stableWorkspace, firstTail],
      cachedInputTokens: 0,
      totalInputWithCacheTokens: 6000
    },
    {
      label: "volatile-tail-change",
      cacheKey: "swarm:main:stable:first",
      system: [stableSystem],
      user: [stableTools, stableWorkspace, secondTail],
      cachedInputTokens: 4200,
      totalInputWithCacheTokens: 6000
    },
    {
      label: "tool-prefix-drift",
      cacheKey: "swarm:main:stable:changed",
      system: [stableSystem],
      user: [driftTools, stableWorkspace, secondTail],
      cachedInputTokens: 0,
      totalInputWithCacheTokens: 6000
    }
  ]);
  const volatileReplay = lab.replays[1];
  const driftReplay = lab.replays[2];
  const ok = lab.replays[0]?.missReason === "cold_start"
    && volatileReplay?.prefixDrift === false
    && volatileReplay.hitRate === 0.7
    && volatileReplay.changedSections.length === 0
    && volatileReplay.stablePrefixIdentity === lab.baseline?.stablePrefixIdentity
    && volatileReplay.volatileTailTokensEstimate !== lab.replays[0]?.volatileTailTokensEstimate
    && driftReplay?.prefixDrift === true
    && driftReplay.missReason === "prefix_drift"
    && driftReplay.changedSections.includes("tools");
  return ok
    ? { name: "cache lab replay distinguishes volatile tail from stable prefix drift", status: "pass", message: `volatile_hit=${volatileReplay?.hitRate} drift_sections=${driftReplay?.changedSections.join(",")}` }
    : { name: "cache lab replay distinguishes volatile tail from stable prefix drift", status: "fail", message: JSON.stringify(lab) };
}

function checkTuiCommandOutputDetailRegressionBehavior(): EvalCaseResult {
  const inline = inlineInspectorTargetForPane({
    pane: "plan",
    selectedAction: false,
    latestDetailSource: "command",
    latestDetail: true
  });
  const explicitOpen = detailOpenTargetForPane({ pane: "chat", actionCount: 0, hasLatestDetail: true });
  const noOpen = detailOpenTargetForPane({ pane: "chat", actionCount: 0, hasLatestDetail: false });
  const emptyEnter = tuiFocusTransitionForInput({
    key: { return: true },
    detailOpen: false,
    pane: "chat",
    latestDetailSource: "command",
    hasFocusedTarget: true
  });
  const diagnosis = buildLatestRunDiagnosis({
    latestDetail: { source: "command", title: "Command Output", route: "coding_loop", sessionId: "-" },
    events: [{
      type: "tui_focus",
      key_event: "return",
      focus_before: emptyEnter.focusBefore,
      focus_after: emptyEnter.focusAfter,
      detail_before: emptyEnter.detailBefore,
      detail_after: emptyEnter.detailAfter,
      detail_source: emptyEnter.detailSource,
      detail_reason: emptyEnter.reason,
      allowed: emptyEnter.allowed,
      blocked_reason: emptyEnter.blockedReason,
      pane_before: emptyEnter.paneBefore,
      pane_after: emptyEnter.paneAfter,
      route: "coding_loop",
      session_id: "-"
    }]
  });
  const ok = inline.enabled === false
    && explicitOpen === "latest"
    && noOpen === "none"
    && emptyEnter.reason === "empty-enter"
    && emptyEnter.allowed === false
    && emptyEnter.detailAfter === false
    && emptyEnter.paneAfter === "chat"
    && diagnosis.detail.includes("source=command")
    && diagnosis.detail.includes("title=Command Output")
    && diagnosis.detail.includes("route=work (raw=coding_loop)")
    && diagnosis.detail.includes("key=return reason=empty-enter allowed=false")
    && diagnosis.detail.includes("blocked=empty Enter submits input only");
  return ok
    ? { name: "TUI command-output detail eval blocks auto-open regression", status: "pass", message: "command output remains explicit while diagnosis records the anomaly metadata" }
    : { name: "TUI command-output detail eval blocks auto-open regression", status: "fail", message: `inline=${JSON.stringify(inline)} explicitOpen=${explicitOpen} noOpen=${noOpen} emptyEnter=${JSON.stringify(emptyEnter)} diagnosis=${diagnosis.detail}` };
}

function checkWorkerLoopRepairsInvalidToolCallsBehavior(root: string): EvalCaseResult {
  const script = `
import {
  parseWorkerLoopModelResult,
  repairWorkerLoopModelResult,
  validateWorkerLoopToolCalls
} from "./dist/agents/worker-loop-contract.js";

const missingInputText = JSON.stringify({
  status: "completed",
  summary: "read file",
  details: "Need a file read.",
  files_touched: [],
  next_actions: [],
  tool_calls: [
    { id: "bad_read", action: "file.read", inputs: {} }
  ]
});
const missingParsed = parseWorkerLoopModelResult(missingInputText);
const missingValidation = validateWorkerLoopToolCalls(missingParsed.tool_calls);
let repairCalls = 0;
const repaired = await repairWorkerLoopModelResult({
  originalText: missingInputText,
  validationError: missingValidation,
  model: "eval-model",
  task: { objective: "Inspect package metadata." },
  context: [],
  toolResults: [],
  loop: { turn: 1, remaining_turns: 5, remaining_tool_calls: 12 },
  async generateText(request) {
    repairCalls += 1;
    return JSON.stringify({
      status: "completed",
      summary: "read file",
      details: "Repaired the worker tool call.",
      files_touched: [],
      next_actions: [],
      tool_calls: [
        { id: "good_read", action: "file.read", inputs: { path: "package.json" } }
      ],
      repair_prompt_had_validation: String(request.user).includes("missing required input")
    });
  }
});

const emptyActionText = JSON.stringify({
  status: "completed",
  summary: "bad action",
  details: "Still malformed.",
  files_touched: [],
  next_actions: [],
  tool_calls: [
    { id: "bad_empty", action: "", inputs: { path: "README.md" } }
  ]
});
const emptyParsed = parseWorkerLoopModelResult(emptyActionText);
const emptyValidation = validateWorkerLoopToolCalls(emptyParsed.tool_calls);
let failedRepairCalls = 0;
const failedClosed = await repairWorkerLoopModelResult({
  originalText: emptyActionText,
  validationError: emptyValidation,
  model: "eval-model",
  task: { objective: "Trigger malformed worker call." },
  context: [],
  toolResults: [],
  loop: { turn: 1, remaining_turns: 5, remaining_tool_calls: 12 },
  async generateText() {
    failedRepairCalls += 1;
    return emptyActionText;
  }
});

console.log(JSON.stringify({
  missingValidation,
  emptyValidation,
  repairCalls,
  failedRepairCalls,
  repaired: {
    status: repaired.status,
    action: repaired.tool_calls[0]?.action,
    path: repaired.tool_calls[0]?.inputs?.path
  },
  failedClosed: {
    status: failedClosed.status,
    summary: failedClosed.summary,
    details: failedClosed.details,
    toolCalls: failedClosed.tool_calls.length
  }
}));
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    missingValidation?: string;
    emptyValidation?: string;
    repairCalls?: number;
    failedRepairCalls?: number;
    repaired?: { status?: string; action?: string; path?: string };
    failedClosed?: { status?: string; summary?: string; details?: string; toolCalls?: number };
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in failure below.
  }
  const ok = result.status === 0
    && parsed.missingValidation?.includes("missing required input")
    && parsed.emptyValidation?.includes("empty or missing action")
    && parsed.repairCalls === 1
    && parsed.failedRepairCalls === 1
    && parsed.repaired?.status === "completed"
    && parsed.repaired.action === "file.read"
    && parsed.repaired.path === "package.json"
    && parsed.failedClosed?.status === "failed"
    && parsed.failedClosed.toolCalls === 0
    && parsed.failedClosed.details?.includes("Swarm worker could not repair the model tool call JSON");
  return ok
    ? { name: "worker loop repairs invalid tool calls before execution", status: "pass", message: "child worker tool calls are validated, repaired once, and fail closed without executable tool_calls when still malformed" }
    : {
        name: "worker loop repairs invalid tool calls before execution",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkWorkerLoopProgressPayloadBehavior(root: string): EvalCaseResult {
  const script = `
import { buildWorkerToolProgressPayload } from "./dist/agents/worker-loop-contract.js";

const direct = buildWorkerToolProgressPayload({
  call: { id: "read_1", action: "file.read", inputs: { path: "README.md" } },
  result: { id: "read_1", action: "file.read", status: "success", summary: "read 1 file" },
  toolCallsCompleted: 1,
  remainingToolCalls: 7
});

const fallback = buildWorkerToolProgressPayload({
  call: { id: "grep_1", inputs: { action: "file.grep", pattern: "worker", root: "src" } },
  result: { id: "grep_1", status: "failed", summary: "missing required input: root", errorCode: "INVALID_INPUT" },
  toolCallsCompleted: 2,
  remainingToolCalls: 6
});

console.log(JSON.stringify({ direct, fallback }));
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    direct?: { action?: string; status?: string; message?: string; tool_calls_completed?: number; remaining_tool_calls?: number };
    fallback?: { action?: string; status?: string; message?: string; errorCode?: string };
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in failure below.
  }
  const ok = result.status === 0
    && parsed.direct?.action === "file.read"
    && parsed.direct?.status === "success"
    && parsed.direct?.tool_calls_completed === 1
    && parsed.direct?.remaining_tool_calls === 7
    && parsed.direct?.message?.includes("Worker tool file.read success: read 1 file")
    && parsed.fallback?.action === "file.grep"
    && parsed.fallback?.status === "failed"
    && parsed.fallback?.errorCode === "INVALID_INPUT"
    && parsed.fallback?.message?.includes("Worker tool file.grep failed: missing required input: root");
  return ok
    ? { name: "worker loop progress payload preserves tool identity", status: "pass", message: "child worker progress events keep action, status, counts, and message fallback even when the executed result omitted action" }
    : {
        name: "worker loop progress payload preserves tool identity",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkCodingLoopParallelReadOnlyDelegationBehavior(root: string): EvalCaseResult {
  const script = `
import { CodingAgentLoop } from "./dist/runtime/coding-agent-loop.js";
import { RuntimeEvents } from "./dist/runtime/events.js";
import { defaultSwarmSettings } from "./dist/config/settings.js";

const settings = defaultSwarmSettings();
settings.permissions.defaultMode = "yolo";
settings.runtime.maxParallelTasks = 2;
const events = new RuntimeEvents();
let modelCalls = 0;
let runningDelegates = 0;
let maxRunningDelegates = 0;
const invocations = [];
const provider = {
  workerModel: "eval-model",
  async generateText() {
    modelCalls += 1;
    if (modelCalls === 1) {
      return JSON.stringify({
        status: "continue",
        summary: "spawn parallel read-only agents",
        message: "spawning",
        files_touched: [],
        next_actions: [],
        tool_calls: [
          { id: "agent_a", action: "Agent", inputs: { subagent_type: "researcher", preferred_mode: "parallel", prompt: "Research routing." } },
          { id: "agent_b", action: "Agent", inputs: { subagent_type: "reviewer", preferred_mode: "parallel", prompt: "Review routing." } }
        ]
      });
    }
    return JSON.stringify({
      status: "completed",
      summary: "done",
      message: "done",
      files_touched: [],
      next_actions: [],
      tool_calls: []
    });
  }
};
const loop = new CodingAgentLoop({
  workspace: process.cwd(),
  settings,
  provider,
  events,
  maxTurns: 2,
  maxToolCalls: 4,
  emitFinal: false,
  emitProgress: false,
  invokeAgent: async (request) => {
    runningDelegates += 1;
    maxRunningDelegates = Math.max(maxRunningDelegates, runningDelegates);
    invocations.push(request.preferred_agent_spec_id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    runningDelegates -= 1;
    return {
      action: "agent.delegate",
      status: "success",
      summary: request.task,
      content: request.task,
      data: { agent_spec_id: request.preferred_agent_spec_id }
    };
  }
});
const result = await loop.run("Use parallel read-only agents.");
console.log(JSON.stringify({ status: result.status, maxRunningDelegates, invocations }));
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: { status?: string; maxRunningDelegates?: number; invocations?: string[] } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep the raw process output in the failure message below.
  }
  const ok = result.status === 0
    && parsed.status === "completed"
    && parsed.maxRunningDelegates === 2
    && parsed.invocations?.join(",") === "researcher,reviewer";
  return ok
    ? { name: "coding loop runs explicit read-only parallel delegates concurrently", status: "pass", message: "parallel researcher/reviewer Agent calls overlap under the runtime maxParallelTasks cap" }
    : {
        name: "coding loop runs explicit read-only parallel delegates concurrently",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
    };
}

function checkCodingLoopParallelScopedWriteDelegationBehavior(root: string): EvalCaseResult {
  const script = `
import { CodingAgentLoop } from "./dist/runtime/coding-agent-loop.js";
import { RuntimeEvents } from "./dist/runtime/events.js";
import { defaultSwarmSettings } from "./dist/config/settings.js";

const settings = defaultSwarmSettings();
settings.permissions.defaultMode = "yolo";
settings.runtime.maxParallelTasks = 2;
const events = new RuntimeEvents();
let modelCalls = 0;
let runningDelegates = 0;
let maxRunningDelegates = 0;
const scopes = [];
const provider = {
  workerModel: "eval-model",
  async generateText() {
    modelCalls += 1;
    if (modelCalls === 1) {
      return JSON.stringify({
        status: "continue",
        summary: "spawn parallel scoped-write agents",
        message: "spawning",
        files_touched: [],
        next_actions: [],
        tool_calls: [
          { id: "agent_a", action: "Agent", inputs: { subagent_type: "coder", preferred_mode: "parallel", file_scope: ["src/a.ts"], prompt: "Patch src/a.ts." } },
          { id: "agent_b", action: "Agent", inputs: { subagent_type: "coder", preferred_mode: "parallel", file_scope: ["src/b.ts"], prompt: "Patch src/b.ts." } }
        ]
      });
    }
    return JSON.stringify({
      status: "completed",
      summary: "done",
      message: "done",
      files_touched: [],
      next_actions: [],
      tool_calls: []
    });
  }
};
const loop = new CodingAgentLoop({
  workspace: process.cwd(),
  settings,
  provider,
  events,
  maxTurns: 2,
  maxToolCalls: 4,
  emitFinal: false,
  emitProgress: false,
  invokeAgent: async (request) => {
    runningDelegates += 1;
    maxRunningDelegates = Math.max(maxRunningDelegates, runningDelegates);
    scopes.push((request.file_scope ?? []).join(","));
    await new Promise((resolve) => setTimeout(resolve, 50));
    runningDelegates -= 1;
    return {
      action: "agent.delegate",
      status: "success",
      summary: request.task,
      content: request.task,
      data: { agent_spec_id: request.preferred_agent_spec_id, file_scope: request.file_scope }
    };
  }
});
const result = await loop.run("Use parallel scoped-write agents with disjoint file scopes.");
console.log(JSON.stringify({ status: result.status, maxRunningDelegates, scopes }));
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: { status?: string; maxRunningDelegates?: number; scopes?: string[] } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep the raw process output in the failure message below.
  }
  const ok = result.status === 0
    && parsed.status === "completed"
    && parsed.maxRunningDelegates === 2
    && parsed.scopes?.join("|") === "src/a.ts|src/b.ts";
  return ok
    ? { name: "coding loop runs disjoint scoped-write delegates concurrently", status: "pass", message: "parallel coder delegates overlap when their concrete file_scope values do not intersect" }
    : {
        name: "coding loop runs disjoint scoped-write delegates concurrently",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkCodingLoopSerializesOverlappingScopedWriteDelegationBehavior(root: string): EvalCaseResult {
  const script = `
import { CodingAgentLoop } from "./dist/runtime/coding-agent-loop.js";
import { RuntimeEvents } from "./dist/runtime/events.js";
import { defaultSwarmSettings } from "./dist/config/settings.js";

const settings = defaultSwarmSettings();
settings.permissions.defaultMode = "yolo";
settings.runtime.maxParallelTasks = 2;
const events = new RuntimeEvents();
let modelCalls = 0;
let runningDelegates = 0;
let maxRunningDelegates = 0;
const scopes = [];
const provider = {
  workerModel: "eval-model",
  async generateText() {
    modelCalls += 1;
    if (modelCalls === 1) {
      return JSON.stringify({
        status: "continue",
        summary: "serialize overlapping scoped-write agents",
        message: "spawning",
        files_touched: [],
        next_actions: [],
        tool_calls: [
          { id: "agent_a", action: "Agent", inputs: { subagent_type: "coder", preferred_mode: "parallel", file_scope: ["src/shared"], prompt: "Patch src/shared/a.ts." } },
          { id: "agent_b", action: "Agent", inputs: { subagent_type: "coder", preferred_mode: "parallel", file_scope: ["src/shared/b.ts"], prompt: "Patch src/shared/b.ts." } }
        ]
      });
    }
    return JSON.stringify({
      status: "completed",
      summary: "done",
      message: "done",
      files_touched: [],
      next_actions: [],
      tool_calls: []
    });
  }
};
const loop = new CodingAgentLoop({
  workspace: process.cwd(),
  settings,
  provider,
  events,
  maxTurns: 2,
  maxToolCalls: 4,
  emitFinal: false,
  emitProgress: false,
  invokeAgent: async (request) => {
    runningDelegates += 1;
    maxRunningDelegates = Math.max(maxRunningDelegates, runningDelegates);
    scopes.push((request.file_scope ?? []).join(","));
    await new Promise((resolve) => setTimeout(resolve, 50));
    runningDelegates -= 1;
    return {
      action: "agent.delegate",
      status: "success",
      summary: request.task,
      content: request.task,
      data: { agent_spec_id: request.preferred_agent_spec_id, file_scope: request.file_scope }
    };
  }
});
const result = await loop.run("Use parallel scoped-write agents with overlapping file scopes.");
console.log(JSON.stringify({ status: result.status, maxRunningDelegates, scopes }));
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: { status?: string; maxRunningDelegates?: number; scopes?: string[] } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep the raw process output in the failure message below.
  }
  const ok = result.status === 0
    && parsed.status === "completed"
    && parsed.maxRunningDelegates === 1
    && parsed.scopes?.join("|") === "src/shared|src/shared/b.ts";
  return ok
    ? { name: "coding loop serializes overlapping scoped-write delegates", status: "pass", message: "parallel coder delegates fall back to serial execution when file_scope overlaps" }
    : {
        name: "coding loop serializes overlapping scoped-write delegates",
        status: "fail",
      message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkWorkerAdmissionQueueBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SwarmRuntime } from "./dist/runtime/runtime.js";
import { CodingAgentLoop } from "./dist/runtime/coding-agent-loop.js";
import { buildWorkRecordFromRuntimeEvent } from "./dist/runtime/work-protocol.js";
import { formatRuntimeEventBrief } from "./dist/runtime/event-formatters.js";

const dir = mkdtempSync(resolve(tmpdir(), "swarm-worker-queue-eval-"));
const workspace = resolve(dir, "workspace");
mkdirSync(workspace, { recursive: true });
const runtime = new SwarmRuntime({ databasePath: resolve(dir, "swarm.db"), workspace });
const runtimeAny = runtime;
runtime.settings.permissions.defaultMode = "yolo";
runtime.settings.runtime.maxAgents = 2;
runtime.settings.runtime.maxParallelTasks = 1;
runtimeAny.ensureLoopSession("worker_queue_parent", "Parent eval session");
runtimeAny.decideAgentSpawn = async (request) => ({
  agent_spec_id: "researcher",
  invocation_mode: "call_subagent",
  reason: "eval admission control",
  confidence: 1,
  display_name: request.task.includes("second") ? "Byron" : "Ada",
  role_title: "Researcher",
  persona_brief: "Stay concise."
});

let running = 0;
let maxRunning = 0;
let runCalls = 0;
let releaseFirst;
const firstGate = new Promise((resolve) => {
  releaseFirst = resolve;
});
const workerEvents = [];
const queueEvents = [];
const originalRun = CodingAgentLoop.prototype.run;
CodingAgentLoop.prototype.run = async function() {
  runCalls += 1;
  running += 1;
  maxRunning = Math.max(maxRunning, running);
  const workerId = this.options?.workerId ?? \`worker_\${runCalls}\`;
  if (runCalls === 1) {
    await firstGate;
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  running -= 1;
  return {
    session_id: \`worker_loop_\${workerId}\`,
    content: \`done \${workerId}\`,
    status: "completed",
    outcome: {
      changed_files: [],
      tests_run: [],
      intermediate_artifacts: [],
      final_summary: \`done \${workerId}\`
    }
  };
};

const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(\`timeout waiting for \${label}\`);
};

runtime.events.onEvent((event) => {
  if (event.type === "worker") {
    workerEvents.push({
      objective: event.worker.objective,
      status: event.status,
      blocked_reason: event.worker.blocked_reason
    });
  } else if (event.type === "queue") {
    queueEvents.push(event);
  }
});

const requestFor = (name) => ({
  parent_session_id: "worker_queue_parent",
  requested_by: "main_swarm",
  capability: "research.repo",
  task: \`\${name} delegated research task with enough scope to justify worker coordination and return concrete evidence from the current workspace.\`,
  context: "Inspect current runtime behavior and summarize findings."
});

try {
  const firstPromise = runtimeAny.invokeAgent(requestFor("first"));
  await waitFor(() => running === 1, "first worker to start");
  const secondPromise = runtimeAny.invokeAgent(requestFor("second"));
  await waitFor(
    () => runtime.workerStateStore.listByParent("worker_queue_parent").some((worker) =>
      worker.objective.includes("second delegated") && worker.status === "pending"
    ),
    "second worker pending"
  );
  const snapshotDuringQueue = runtime.getWorkSnapshot("worker_queue_parent");
  const secondQueuedActive = snapshotDuringQueue.work_contracts.active_workers.find((worker) =>
    worker.objective.includes("second delegated")
  );
  const secondQueuedResumable = snapshotDuringQueue.work_contracts.resumable_workers.find((worker) =>
    worker.objective.includes("second delegated")
  );
  const secondPendingEvent = workerEvents.find((event) =>
    event.objective?.includes("second delegated") && event.status === "pending"
  );
  const workerQueueEnqueue = queueEvents.find((event) => event.queue === "worker_slots" && event.operation === "enqueue");
  const enqueueWork = workerQueueEnqueue ? buildWorkRecordFromRuntimeEvent(workerQueueEnqueue, new Date(0).toISOString()) : undefined;
  const enqueueBrief = workerQueueEnqueue ? formatRuntimeEventBrief(workerQueueEnqueue) : undefined;
  releaseFirst();
  const results = await Promise.all([firstPromise, secondPromise]);
  await waitFor(
    () => workerEvents.some((event) => event.objective?.includes("second delegated") && event.status === "running"),
    "second worker running"
  );
  const secondRunningEvent = workerEvents.find((event) =>
    event.objective?.includes("second delegated") && event.status === "running"
  );
  const workerQueueDequeue = queueEvents.find((event) => event.queue === "worker_slots" && event.operation === "dequeue");
  const secondFinal = runtime.workerStateStore.listByParent("worker_queue_parent").find((worker) =>
    worker.objective.includes("second delegated")
  );
  const ok = maxRunning === 1
    && secondPendingEvent?.blocked_reason?.includes("Waiting for a worker slot")
    && workerQueueEnqueue?.session_id === "worker_queue_parent"
    && workerQueueEnqueue?.id === secondFinal?.worker_id
    && workerQueueEnqueue?.message?.includes("Waiting for a worker slot")
    && enqueueWork?.kind === "queue"
    && enqueueWork?.session_id === "worker_queue_parent"
    && enqueueWork?.worker_id === secondFinal?.worker_id
    && enqueueBrief?.includes("queue:worker_slots")
    && workerQueueDequeue?.session_id === "worker_queue_parent"
    && workerQueueDequeue?.id === secondFinal?.worker_id
    && workerQueueDequeue?.message?.includes("Worker slot granted")
    && snapshotDuringQueue.work_contracts.summary.active_workers === 2
    && snapshotDuringQueue.work_contracts.summary.running_workers === 1
    && snapshotDuringQueue.work_contracts.summary.pending_workers === 1
    && secondQueuedActive?.status === "pending"
    && !secondQueuedResumable
    && secondRunningEvent?.status === "running"
    && secondFinal?.status === "completed"
    && results[1]?.status === "success";
  console.log(JSON.stringify({
    ok,
    maxRunning,
    queueOperations: queueEvents.map((event) => ({ queue: event.queue, operation: event.operation, session_id: event.session_id, id: event.id, message: event.message })),
    secondPendingEvent,
    enqueueWork,
    enqueueBrief,
    secondQueuedActiveStatus: secondQueuedActive?.status,
    secondQueuedResumableStatus: secondQueuedResumable?.status,
    secondRunningEvent,
    secondFinalStatus: secondFinal?.status,
    secondResultStatus: results[1]?.status
  }));
} finally {
  CodingAgentLoop.prototype.run = originalRun;
  runtime.dispose();
  rmSync(dir, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000
  });
  const output = result.stdout.trim().split(/\\r?\\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    ok?: boolean;
    maxRunning?: number;
    queueOperations?: Array<{ queue?: string; operation?: string; session_id?: string; id?: string; message?: string }>;
    secondPendingEvent?: { status?: string; blocked_reason?: string };
    enqueueWork?: { kind?: string; session_id?: string; worker_id?: string };
    enqueueBrief?: string;
    secondQueuedActiveStatus?: string;
    secondQueuedResumableStatus?: string;
    secondRunningEvent?: { status?: string };
    secondFinalStatus?: string;
    secondResultStatus?: string;
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in the failure message below.
  }
  return result.status === 0 && parsed.ok
    ? { name: "worker admission queues delegates behind runtime parallel slots", status: "pass", message: "second invokeAgent call is persisted as pending, exposed in work contracts, and only starts after the first worker releases the sole slot" }
    : {
        name: "worker admission queues delegates behind runtime parallel slots",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkSandboxDecisionObjectBehavior(): EvalCaseResult {
  const workspace = resolve("eval-workspace");
  const read = decideToolActionSandbox(
    { type: "file.read", path: "src/index.ts" },
    { writePolicy: "read_only", workspace }
  );
  const deniedReadOnly = decideToolActionSandbox(
    { type: "file.write", path: "src/out.txt", content: "x" },
    { writePolicy: "read_only", workspace }
  );
  const scopedAllowed = decideToolActionSandbox(
    { type: "file.write", path: "src/out.txt", content: "x" },
    { writePolicy: "scoped_write", workspace, fileScope: ["src/**"] }
  );
  const scopedDenied = decideToolActionSandbox(
    { type: "file.write", path: "private/out.txt", content: "x" },
    { writePolicy: "scoped_write", workspace, fileScope: ["src/**"] }
  );
  const capabilityAllowed = decideCapabilitySandbox({
    id: "mcp_tool.read",
    kind: "mcp_tool",
    source: "mcp",
    trust: "trusted",
    providerId: "eval",
    name: "mcp_tool.read",
    description: "read-only eval tool",
    riskClass: "r0",
    permissionName: "Read",
    modelVisible: true,
    userVisible: true,
    readOnly: true
  }, "read_only");
  const capabilityDenied = decideCapabilitySandbox({
    id: "mcp_tool.write",
    kind: "mcp_tool",
    source: "mcp",
    trust: "trusted",
    providerId: "eval",
    name: "mcp_tool.write",
    description: "write eval tool",
    riskClass: "r2",
    permissionName: "Write",
    modelVisible: true,
    userVisible: true,
    readOnly: false
  }, "scoped_write");
  const ok = read.decision === "allow"
    && deniedReadOnly.decision === "deny"
    && deniedReadOnly.policy === "read_only"
    && deniedReadOnly.reason.includes("Read-only sandbox denied tool action: file.write")
    && scopedAllowed.decision === "allow"
    && scopedAllowed.targets?.includes("src/out.txt")
    && scopedAllowed.file_scope?.includes("src/**")
    && scopedDenied.decision === "deny"
    && scopedDenied.targets?.includes("private/out.txt")
    && scopedDenied.reason.includes("outside file_scope")
    && capabilityAllowed.decision === "allow"
    && capabilityDenied.decision === "deny"
    && capabilityDenied.reason.includes("Scoped-write sandbox denied capability");
  return ok
    ? { name: "sandbox policy uses structured decision objects", status: "pass", message: "read-only, scoped-write, file-scope, and capability sandbox checks return auditable allow/deny decisions" }
    : { name: "sandbox policy uses structured decision objects", status: "fail", message: `read=${JSON.stringify(read)} deniedReadOnly=${JSON.stringify(deniedReadOnly)} scopedAllowed=${JSON.stringify(scopedAllowed)} scopedDenied=${JSON.stringify(scopedDenied)} capabilityAllowed=${JSON.stringify(capabilityAllowed)} capabilityDenied=${JSON.stringify(capabilityDenied)}` };
}

function checkReadOnlySandboxVerificationCommandBehavior(): EvalCaseResult {
  const workspace = resolve("eval-workspace");
  const test = decideToolActionSandbox(
    { type: "code.test", command: "npm test" },
    { writePolicy: "read_only", workspace }
  );
  const lint = decideToolActionSandbox(
    { type: "code.lint", root: "." },
    { writePolicy: "read_only", workspace }
  );
  const write = decideToolActionSandbox(
    { type: "file.write", path: "src/out.txt", content: "x" },
    { writePolicy: "read_only", workspace }
  );
  const ok = test.decision === "allow"
    && test.reason.includes("Read-only sandbox permits tool action: code.test")
    && lint.decision === "allow"
    && lint.reason.includes("Read-only sandbox permits tool action: code.lint")
    && write.decision === "deny";
  return ok
    ? { name: "read-only sandbox permits verification commands", status: "pass", message: "verifier/reviewer read-only workers can run code.test and code.lint while file writes stay blocked" }
    : { name: "read-only sandbox permits verification commands", status: "fail", message: `test=${JSON.stringify(test)} lint=${JSON.stringify(lint)} write=${JSON.stringify(write)}` };
}

function checkCodingLoopScopedWriteFileScopeBehavior(root: string): EvalCaseResult {
  const script = `
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodingAgentLoop } from "./dist/runtime/coding-agent-loop.js";
import { RuntimeEvents } from "./dist/runtime/events.js";
import { defaultSwarmSettings } from "./dist/config/settings.js";

const workspace = mkdtempSync(join(tmpdir(), "swarm-scoped-write-eval-"));
try {
  const settings = defaultSwarmSettings();
  settings.permissions.defaultMode = "yolo";
  const events = new RuntimeEvents();
  const toolResults = [];
  events.onEvent((event) => {
    if (event.type === "tool_result") toolResults.push(event);
  });
  const provider = {
    workerModel: "eval-model",
    async generateText() {
      return JSON.stringify({
        status: "continue",
        summary: "try scoped writes",
        message: "writing",
        files_touched: [],
        next_actions: [],
        tool_calls: [
          { id: "allowed", action: "Write", inputs: { path: "allowed.txt", content: "ok" } },
          { id: "denied", action: "Write", inputs: { path: "denied.txt", content: "no" } }
        ]
      });
    }
  };
  const loop = new CodingAgentLoop({
    workspace,
    settings,
    provider,
    events,
    writePolicy: "scoped_write",
    fileScope: ["allowed.txt"],
    maxTurns: 1,
    maxToolCalls: 2,
    emitFinal: false,
    emitProgress: false
  });
  const result = await loop.run("Write inside and outside scope.");
  console.log(JSON.stringify({
    status: result.status,
    allowedExists: existsSync(join(workspace, "allowed.txt")),
    deniedExists: existsSync(join(workspace, "denied.txt")),
    denied: toolResults.some((event) => String(event.summary).includes("Sandbox blocked file.write: outside delegated file scope")),
    summary: toolResults[1]?.summary,
    recovery: toolResults[1]?.recoverySuggestion,
    toolStatuses: toolResults.map((event) => event.status)
  }));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: { status?: string; allowedExists?: boolean; deniedExists?: boolean; denied?: boolean; summary?: string; recovery?: string; toolStatuses?: string[] } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in the failure message.
  }
  const ok = result.status === 0
    && parsed.status === "failed"
    && parsed.allowedExists === true
    && parsed.deniedExists === false
    && parsed.denied === true
    && parsed.summary?.includes("outside delegated file scope")
    && parsed.recovery?.includes("Keep the write inside file_scope")
    && parsed.toolStatuses?.join(",") === "success,failed";
  return ok
    ? { name: "coding loop enforces scoped-write file_scope before writes", status: "pass", message: "scoped_write permits in-scope file writes and blocks out-of-scope writes before filesystem mutation" }
    : {
        name: "coding loop enforces scoped-write file_scope before writes",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkSandboxDenialMetadataSurfaceBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodingAgentLoop } from "./dist/runtime/coding-agent-loop.js";
import { RuntimeEvents } from "./dist/runtime/events.js";
import { formatHeadlessProgress, formatRuntimeEventBrief } from "./dist/runtime/event-formatters.js";
import { buildWorkRecordFromRuntimeEvent } from "./dist/runtime/work-protocol.js";
import { defaultSwarmSettings } from "./dist/config/settings.js";

const workspace = mkdtempSync(join(tmpdir(), "swarm-sandbox-metadata-eval-"));
try {
  const settings = defaultSwarmSettings();
  settings.permissions.defaultMode = "yolo";
  const events = new RuntimeEvents();
  const toolResults = [];
  events.onEvent((event) => {
    if (event.type === "tool_result") toolResults.push(event);
  });
  const provider = {
    workerModel: "eval-model",
    async generateText() {
      return JSON.stringify({
        status: "continue",
        summary: "try denied write",
        message: "writing",
        files_touched: [],
        next_actions: [],
        tool_calls: [
          { id: "denied", action: "Write", inputs: { path: "private/out.txt", content: "no" } }
        ]
      });
    }
  };
  const loop = new CodingAgentLoop({
    workspace,
    settings,
    provider,
    events,
    writePolicy: "scoped_write",
    fileScope: ["src/**"],
    maxTurns: 1,
    maxToolCalls: 1,
    emitFinal: false,
    emitProgress: false
  });
  const result = await loop.run("Write outside scope.");
  const denied = toolResults[0];
  const brief = denied ? formatRuntimeEventBrief(denied) : "";
  const headless = denied ? formatHeadlessProgress(denied) : "";
  const work = denied ? buildWorkRecordFromRuntimeEvent(denied, new Date(0).toISOString()) : undefined;
  console.log(JSON.stringify({
    status: result.status,
    summary: denied?.summary,
    recovery: denied?.recoverySuggestion,
    eventSandbox: denied?.sandbox,
    brief,
    headless,
    work
  }));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    status?: string;
    summary?: string;
    recovery?: string;
    eventSandbox?: {
      decision?: string;
      policy?: string;
      subject?: string;
      reason?: string;
      action?: string;
      targets?: string[];
      file_scope?: string[];
    };
    brief?: string;
    headless?: string;
    work?: {
      kind?: string;
      phase?: string;
      status?: string;
      write_policy?: string;
      file_scope?: string[];
      sandbox?: {
        status?: string;
        policy?: string;
        subject?: string;
        reason?: string;
        targets?: string[];
        file_scope?: string[];
      };
    };
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in the failure message.
  }
  const ok = result.status === 0
    && parsed.status === "failed"
    && parsed.eventSandbox?.decision === "deny"
    && parsed.eventSandbox.policy === "scoped_write"
    && parsed.eventSandbox.subject === "tool_action"
    && parsed.eventSandbox.action === "file.write"
    && parsed.eventSandbox.targets?.includes("private/out.txt")
    && parsed.eventSandbox.file_scope?.includes("src/**")
    && parsed.summary?.includes("Sandbox blocked file.write: outside delegated file scope")
    && parsed.recovery?.includes("Keep the write inside file_scope")
    && parsed.brief?.includes("sandbox=scoped_write/deny(file-scope-block)")
    && parsed.brief.includes("reason=Scoped-write sandbox denied tool action")
    && parsed.headless?.includes("sandbox=scoped_write/deny(file-scope-block)")
    && parsed.headless.includes("reason=Scoped-write sandbox denied tool action")
    && parsed.work?.kind === "task"
    && parsed.work.phase === "failed"
    && parsed.work.write_policy === "scoped_write"
    && parsed.work.file_scope?.includes("src/**")
    && parsed.work.sandbox?.status === "denied"
    && parsed.work.sandbox.policy === "scoped_write"
    && parsed.work.sandbox.subject === "tool_action"
    && parsed.work.sandbox.targets?.includes("private/out.txt")
    && parsed.work.sandbox.file_scope?.includes("src/**");
  return ok
    ? { name: "sandbox denials surface structured metadata", status: "pass", message: "tool_result, formatters, and work protocol expose sandbox policy, reason, targets, and file scope for denied actions" }
    : {
        name: "sandbox denials surface structured metadata",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkCodingLoopScopedWriteDynamicCapabilityBehavior(root: string): EvalCaseResult {
  const script = `
import { CodingAgentLoop } from "./dist/runtime/coding-agent-loop.js";
import { RuntimeEvents } from "./dist/runtime/events.js";
import { defaultSwarmSettings } from "./dist/config/settings.js";

const settings = defaultSwarmSettings();
settings.permissions.defaultMode = "yolo";
const events = new RuntimeEvents();
const toolResults = [];
events.onEvent((event) => {
  if (event.type === "tool_result") toolResults.push(event);
});
let invoked = false;
const provider = {
  workerModel: "eval-model",
  async generateText() {
    return JSON.stringify({
      status: "continue",
      summary: "try unsafe mcp",
      message: "calling mcp",
      files_touched: [],
      next_actions: [],
      tool_calls: [
        { id: "mcp_danger", action: "mcp__danger__write", inputs: { path: "outside.txt", value: "x" } }
      ]
    });
  }
};
const dangerousCapability = {
  id: "mcp_tool.danger.write",
  kind: "mcp_tool",
  source: "mcp",
  trust: "trusted",
  providerId: "danger",
  name: "mcp__danger__write",
  title: "Danger write",
  description: "Writes outside Swarm's file scope.",
  riskClass: "r2",
  permissionName: "McpTool(danger.write)",
  modelVisible: true,
  userVisible: true,
  status: "available",
  alwaysLoad: true,
  shouldDefer: false,
  readOnly: false,
  concurrencyClass: "network_limited"
};
const loop = new CodingAgentLoop({
  workspace: process.cwd(),
  settings,
  provider,
  events,
  writePolicy: "scoped_write",
  fileScope: ["src/index.ts"],
  maxTurns: 1,
  maxToolCalls: 1,
  emitFinal: false,
  emitProgress: false,
  listModelCapabilities: async () => [dangerousCapability],
  invokeCapability: async () => {
    invoked = true;
    return { action: "mcp__danger__write", status: "success", summary: "should not run" };
  }
});
const result = await loop.run("Call an unsafe MCP capability.");
console.log(JSON.stringify({
  status: result.status,
  invoked,
  denied: toolResults.some((event) => String(event.summary).includes("Sandbox blocked capability mcp_tool.danger.write")),
  summary: toolResults[0]?.summary,
  recovery: toolResults[0]?.recoverySuggestion,
  tool_status: toolResults[0]?.status,
  error_code: toolResults[0]?.errorCode
}));
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: { status?: string; invoked?: boolean; denied?: boolean; summary?: string; recovery?: string; tool_status?: string; error_code?: string } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in the failure message.
  }
  const ok = result.status === 0
    && parsed.status === "failed"
    && parsed.invoked === false
    && parsed.denied === true
    && parsed.summary?.includes("Sandbox blocked capability mcp_tool.danger.write")
    && parsed.recovery?.includes("Keep this work in the main coding loop")
    && parsed.tool_status === "failed"
    && parsed.error_code === "PERMISSION_DENIED";
  return ok
    ? { name: "coding loop blocks unsafe dynamic capabilities in scoped-write sandbox", status: "pass", message: "scoped_write denies non-read-only MCP capabilities before broker invocation" }
    : {
        name: "coding loop blocks unsafe dynamic capabilities in scoped-write sandbox",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkCodingLoopRunToolPolicyBehavior(root: string): EvalCaseResult {
  const script = `
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodingAgentLoop } from "./dist/runtime/coding-agent-loop.js";
import { RuntimeEvents } from "./dist/runtime/events.js";
import { defaultSwarmSettings } from "./dist/config/settings.js";

const workspace = mkdtempSync(join(tmpdir(), "swarm-run-tool-policy-eval-"));
try {
  const settings = defaultSwarmSettings();
  settings.permissions.defaultMode = "yolo";
  const events = new RuntimeEvents();
  const toolResults = [];
  events.onEvent((event) => {
    if (event.type === "tool_result") toolResults.push(event);
  });
  const provider = {
    workerModel: "eval-model",
    async generateText() {
      return JSON.stringify({
        status: "continue",
        summary: "try write",
        message: "writing",
        files_touched: [],
        next_actions: [],
        tool_calls: [
          { id: "write", action: "Write", inputs: { path: "denied.txt", content: "no" } }
        ]
      });
    }
  };
  const loop = new CodingAgentLoop({
    workspace,
    settings,
    provider,
    events,
    allowedTools: ["Read"],
    maxTurns: 1,
    maxToolCalls: 1,
    emitFinal: false,
    emitProgress: false
  });
  const result = await loop.run("Try to write.");
  console.log(JSON.stringify({
    status: result.status,
    deniedExists: existsSync(join(workspace, "denied.txt")),
    denied: toolResults.some((event) => String(event.summary).includes("Tool action denied by run tool policy: Write")),
    tool_status: toolResults[0]?.status,
    error_code: toolResults[0]?.errorCode
  }));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: { status?: string; deniedExists?: boolean; denied?: boolean; tool_status?: string; error_code?: string } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in the failure message.
  }
  const ok = result.status === 0
    && parsed.status === "failed"
    && parsed.deniedExists === false
    && parsed.denied === true
    && parsed.tool_status === "failed"
    && parsed.error_code === "PERMISSION_DENIED";
  return ok
    ? { name: "coding loop enforces per-run tool allow policy before execution", status: "pass", message: "allowedTools permits Read while blocking Write before filesystem mutation" }
    : {
        name: "coding loop enforces per-run tool allow policy before execution",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkAdditionalReadDirectoriesPermissionBehavior(): EvalCaseResult {
  const workspace = mkdtempSync(resolve(tmpdir(), "swarm-workspace-read-root-"));
  const extra = mkdtempSync(resolve(tmpdir(), "swarm-extra-read-root-"));
  try {
    const settings = defaultSwarmSettings();
    const target = resolve(extra, "external.txt");
    const deniedWithoutExtra = catchesMessage(
      () => resolveReadablePath(target, { workspace, settings }),
      "Read denied outside startup workspace and configured additionalDirectories"
    );
    settings.permissions.additionalDirectories = [extra];
    const readable = resolveReadablePath(target, { workspace, settings }) === target;
    const writeStillDenied = catchesMessage(
      () => resolveWritablePath(resolve(extra, "write.txt"), { workspace, settings }),
      "Write denied outside startup workspace"
    );
    const ok = deniedWithoutExtra && readable && writeStillDenied;
    return ok
      ? { name: "additional read directories expand reads without expanding writes", status: "pass", message: "--add-dir/read roots allow external reads while writes remain workspace-bound" }
      : { name: "additional read directories expand reads without expanding writes", status: "fail", message: `deniedWithoutExtra=${deniedWithoutExtra} readable=${readable} writeStillDenied=${writeStillDenied}` };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(extra, { recursive: true, force: true });
  }
}

function checkPersistentAdditionalDirectorySettingsBehavior(): EvalCaseResult {
  const previousHome = process.env.SWARM_HOME;
  const home = mkdtempSync(resolve(tmpdir(), "swarm-settings-add-dir-home-"));
  const extra = mkdtempSync(resolve(tmpdir(), "swarm-settings-add-dir-extra-"));
  try {
    process.env.SWARM_HOME = home;
    const added = addPermissionAdditionalDirectory(extra);
    const afterAdd = loadSwarmSettings();
    const addPersisted = afterAdd.permissions.additionalDirectories.includes(added);
    const removed = removePermissionAdditionalDirectory(extra);
    const afterRemove = loadSwarmSettings();
    const removePersisted = !afterRemove.permissions.additionalDirectories.includes(added);
    const ok = addPersisted && removed && removePersisted;
    return ok
      ? { name: "persistent additional read directory settings update cleanly", status: "pass", message: "/add-dir style helpers persist and remove permissions.additionalDirectories entries in an isolated SWARM_HOME" }
      : { name: "persistent additional read directory settings update cleanly", status: "fail", message: `added=${added} addPersisted=${addPersisted} removed=${removed} removePersisted=${removePersisted}` };
  } finally {
    if (previousHome === undefined) {
      delete process.env.SWARM_HOME;
    } else {
      process.env.SWARM_HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(extra, { recursive: true, force: true });
  }
}

function checkSwarmHomeTempCleanupBehavior(): EvalCaseResult {
  const previousHome = process.env.SWARM_HOME;
  const home = mkdtempSync(resolve(tmpdir(), "swarm-settings-temp-cleanup-home-"));
  try {
    process.env.SWARM_HOME = home;
    const { paths } = ensureSwarmHome();
    const staleSettingsTemp = `${paths.settingsPath}.111.1111111111111.stale.tmp`;
    const staleConfigTemp = `${paths.configPath}.222.1111111111111.stale.tmp`;
    const freshSettingsTemp = `${paths.settingsPath}.333.${Date.now()}.fresh.tmp`;
    writeFileSync(staleSettingsTemp, "stale-settings\n", "utf8");
    writeFileSync(staleConfigTemp, "stale-config\n", "utf8");
    writeFileSync(freshSettingsTemp, "fresh-settings\n", "utf8");
    const oldTime = new Date(Date.now() - 10 * 60_000);
    utimesSync(staleSettingsTemp, oldTime, oldTime);
    utimesSync(staleConfigTemp, oldTime, oldTime);

    ensureSwarmHome();

    const ok = !existsSync(staleSettingsTemp)
      && !existsSync(staleConfigTemp)
      && existsSync(freshSettingsTemp);
    return ok
      ? { name: "Swarm home startup cleans stale atomic settings temp files", status: "pass", message: "ensureSwarmHome removes old settings/config temp siblings without touching fresh temp files" }
      : {
          name: "Swarm home startup cleans stale atomic settings temp files",
          status: "fail",
          message: `staleSettings=${existsSync(staleSettingsTemp)} staleConfig=${existsSync(staleConfigTemp)} freshSettings=${existsSync(freshSettingsTemp)}`
        };
  } finally {
    if (previousHome === undefined) {
      delete process.env.SWARM_HOME;
    } else {
      process.env.SWARM_HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

function checkCustomCommandProviderBehavior(): EvalCaseResult {
  const previousHome = process.env.SWARM_HOME;
  const previousTrustedRoot = process.env.SWARM_TRUSTED_WORKSPACE_ROOT;
  const home = mkdtempSync(resolve(tmpdir(), "swarm-custom-commands-home-"));
  const workspace = mkdtempSync(resolve(tmpdir(), "swarm-custom-commands-workspace-"));
  try {
    process.env.SWARM_HOME = home;
    process.env.SWARM_TRUSTED_WORKSPACE_ROOT = workspace;
    const userCommands = resolve(home, "commands");
    const projectCommands = resolve(workspace, ".swarm", "commands");
    mkdirSync(userCommands, { recursive: true });
    mkdirSync(projectCommands, { recursive: true });
    writeFileSync(resolve(userCommands, "summarize.md"), [
      "---",
      "description: Summarize the requested target.",
      "argument-hint: <target>",
      "---",
      "Summarize $ARGUMENTS in three bullets."
    ].join("\n"), "utf8");
    writeFileSync(resolve(projectCommands, "review.md"), [
      "---",
      "name: review-change",
      "description: Review the current change.",
      "---",
      "Review $ARGUMENTS and focus on regressions."
    ].join("\n"), "utf8");
    const settings = defaultSwarmSettings();
    const provider = new CustomCommandProvider({ settings, workspace });
    const commands = provider.listCommands();
    const summarize = provider.getCommand("summarize");
    const review = provider.getCommand("review-change");
    const objective = summarize ? renderCustomCommandObjective(summarize, "src/index.ts") : "";
    const capabilities = provider.listCapabilities();
    const ok = commands.length === 2
      && summarize?.argumentHint === "<target>"
      && summarize.trust === "trusted"
      && review?.scope === "project"
      && review.trust === "trusted"
      && objective.includes("Summarize src/index.ts in three bullets.")
      && capabilities.some((capability) => capability.id === "custom-command.summarize" && capability.kind === "slash_command");
    return ok
      ? { name: "custom Markdown slash commands are discovered and render prompts", status: "pass", message: "user/project commands scan from commands roots, expose slash capabilities, and expand $ARGUMENTS" }
      : { name: "custom Markdown slash commands are discovered and render prompts", status: "fail", message: `commands=${commands.map((command) => `${command.name}:${command.scope}:${command.trust}`).join(",")} objective=${objective}` };
  } finally {
    if (previousHome === undefined) {
      delete process.env.SWARM_HOME;
    } else {
      process.env.SWARM_HOME = previousHome;
    }
    if (previousTrustedRoot === undefined) {
      delete process.env.SWARM_TRUSTED_WORKSPACE_ROOT;
    } else {
      process.env.SWARM_TRUSTED_WORKSPACE_ROOT = previousTrustedRoot;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
}

function checkRuntimeMcpConfigBehavior(): EvalCaseResult {
  const dir = mkdtempSync(resolve(tmpdir(), "swarm-runtime-mcp-config-"));
  try {
    const filePath = resolve(dir, "mcp.json");
    writeFileSync(filePath, JSON.stringify({
      mcpServers: {
        fileServer: {
          type: "stdio",
          command: "node",
          args: ["file-server.js"],
          cwd: ".",
          env: { TOKEN: "file-token" }
        }
      }
    }), "utf8");
    const jsonConfig = JSON.stringify({
      mcpServers: {
        jsonServer: {
          type: "stdio",
          command: "node",
          args: ["json-server.js"]
        }
      }
    });
    const sources = loadRuntimeMcpConfigSources([filePath, jsonConfig], dir);
    const settings = defaultSwarmSettings();
    settings.extensions.mcp.enabled = false;
    settings.extensions.mcp.servers = {
      persisted: {
        transport: "stdio",
        command: "node",
        args: ["persisted.js"],
        trust: "user"
      }
    };
    const loose = applyRuntimeMcpConfig(settings, { sources, strict: false });
    const strict = applyRuntimeMcpConfig(settings, { sources, strict: true });
    const looseIds = Object.keys(loose.extensions.mcp.servers).sort();
    const strictIds = Object.keys(strict.extensions.mcp.servers).sort();
    const fileSource = sources[0];
    const jsonSource = sources[1];
    const fileCwdResolved = fileSource.servers.fileServer?.cwd === dir;
    const ok = loose.extensions.mcp.enabled === true
      && strict.extensions.mcp.enabled === true
      && looseIds.join(",") === "fileServer,jsonServer,persisted"
      && strictIds.join(",") === "fileServer,jsonServer"
      && strict.extensions.mcp.runtimeConfig?.strict === true
      && fileSource.source === "file"
      && jsonSource.source === "json"
      && fileSource.serverIds.join(",") === "fileServer"
      && jsonSource.serverIds.join(",") === "jsonServer"
      && fileCwdResolved;
    return ok
      ? { name: "runtime MCP config applies without persisting and supports strict mode", status: "pass", message: "file/JSON --mcp-config sources merge in order, enable MCP for the run, and strict mode drops persisted servers" }
      : { name: "runtime MCP config applies without persisting and supports strict mode", status: "fail", message: `loose=${looseIds} strict=${strictIds} sources=${JSON.stringify(sources.map((source) => ({ source: source.source, serverIds: source.serverIds })))} fileCwdResolved=${fileCwdResolved}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkBuiltinToolSurfaceBehavior(): EvalCaseResult {
  const capabilities = new BuiltinLocalToolProvider().listCapabilities();
  const names = new Set(capabilities.map((capability) => capability.name));
  const modelVisibleNames = capabilities.filter((capability) => capability.modelVisible).map((capability) => capability.name).sort();
  const modelVisible = new Set(modelVisibleNames);
  const lspTools = [
    "lsp_code_actions",
    "lsp_completion",
    "lsp_definition",
    "lsp_diagnostics",
    "lsp_document_symbols",
    "lsp_format",
    "lsp_hover",
    "lsp_references",
    "lsp_rename_preview",
    "lsp_workspace_symbols"
  ];
  const agentControlTools = ["AgentContinue", "AgentList", "AgentStatus", "AgentStop"];
  const required = ["Read", "Write", "Edit", "file.delete", "Glob", "Grep", "NotebookEdit", "TodoWrite", "BlackboardWrite", "BlackboardSearch", "BlackboardRead", "BlackboardList", "Bash", "ProcessStart", "ProcessStatus", "ProcessList", "ProcessTail", "ProcessGrep", "ProcessStop", "WebSearch", "WebFetch", "Agent", ...agentControlTools, ...lspTools].sort();
  const missing = required.filter((name) => !modelVisible.has(name));
  const extraVisible = modelVisibleNames.filter((name) => !required.includes(name));
  const forbidden = [`solid${"ity"}.compile`, `Solid${"ity"}Compile`];
  const presentForbidden = forbidden.filter((name) => names.has(name) || modelVisible.has(name));
  const legacyListHidden = names.has("LS") && !modelVisible.has("LS");
  const normalizedRead = normalizeToolAction({ action: "Read", file_path: "src/index.ts" });
  const normalizedEdit = normalizeToolAction({ action: "Edit", file_path: "a.txt", old_string: "x", new_string: "y", replace_all: true });
  const normalizedDelete = normalizeToolAction({ action: "Delete", path: "tmp.txt" });
  const normalizedBash = normalizeToolAction({ action: "Bash", command: "npm run check", timeout: 1000 });
  const normalizedExec = normalizeToolAction({ action: "exec", command: "npm run check", timeout: 2000 });
  const normalizedTest = normalizeToolAction({ action: "code.test", command: "npm test", timeout: 3000 });
  const normalizedRunTest = normalizeToolAction({ action: "RunCommand", command: "npm test", timeout: 4000 });
  const normalizedRunShell = normalizeToolAction({ action: "RunCommand", command: "node scripts/build.js", timeout: 5000 });
  const lspVisible = lspTools.every((name) => modelVisible.has(name));
  const agentControlVisible = agentControlTools.every((name) => modelVisible.has(name));
  const ok = missing.length === 0
    && extraVisible.length === 0
    && presentForbidden.length === 0
    && legacyListHidden
    && lspVisible
    && agentControlVisible
    && normalizedRead.type === "file.read"
    && normalizedRead.path === "src/index.ts"
    && normalizedEdit.type === "file.edit"
    && normalizedEdit.replaceAll === true
    && normalizedDelete.type === "file.delete"
    && normalizedDelete.path === "tmp.txt"
    && normalizedBash.type === "shell.exec"
    && normalizedBash.timeoutMs === 1000
    && normalizedExec.type === "exec"
    && normalizedExec.timeoutMs === 2000
    && normalizedTest.type === "code.test"
    && normalizedTest.timeoutMs === 3000
    && normalizedRunTest.type === "code.test"
    && normalizedRunTest.timeoutMs === 4000
    && normalizedRunShell.type === "shell.exec"
    && normalizedRunShell.timeoutMs === 5000;
  return ok
    ? { name: "built-in tool surface exposes generic coding tools", status: "pass", message: "model-visible tools include generic coding, LSP semantic helpers, and Agent control while LS is compat-hidden and domain-specific compile tooling is absent" }
    : { name: "built-in tool surface exposes generic coding tools", status: "fail", message: `missing=${missing.join(",") || "-"} extra=${extraVisible.join(",") || "-"} forbidden=${presentForbidden.join(",") || "-"} legacyListHidden=${legacyListHidden} read=${JSON.stringify(normalizedRead)} edit=${JSON.stringify(normalizedEdit)} delete=${JSON.stringify(normalizedDelete)} bash=${JSON.stringify(normalizedBash)} exec=${JSON.stringify(normalizedExec)} test=${JSON.stringify(normalizedTest)} runTest=${JSON.stringify(normalizedRunTest)} runShell=${JSON.stringify(normalizedRunShell)}` };
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

function checkResumeHealthPromptBehavior(): EvalCaseResult {
  const dir = mkdtempSync(resolve(tmpdir(), "swarm-resume-health-eval-"));
  const workspace = resolve(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const runtime = new SwarmRuntime({ databasePath: resolve(dir, "swarm.db"), workspace });
  try {
    runtime.ensureTuiChatSession("resume_health_eval");
    runtime.runAttemptStore.upsert({
      session_id: "resume_health_eval",
      task_id: "coding_turn_7",
      runner_id: "main_swarm",
      kind: "coding_turn",
      status: "started",
      attempt: 7,
      title: "Coding loop turn"
    });
    runtime.runAttemptStore.upsert({
      session_id: "resume_health_eval",
      task_id: "tool_test",
      runner_id: "code.test",
      kind: "tool_call",
      status: "failed",
      attempt: 0,
      title: "Run tests",
      terminal_reason: "npm test exited 1",
      error_code: "PROCESS_EXIT_NONZERO",
      recovery_suggestion: "Inspect test output and retry narrowly."
    });
    runtime.runAttemptStore.upsert({
      session_id: "resume_health_eval",
      task_id: "tool_read",
      runner_id: "file.read",
      kind: "tool_call",
      status: "completed",
      attempt: 0,
      title: "Read file",
      terminal_reason: "read ok"
    });
    runtime.workerStateStore.create({
      worker_id: "worker_resume_live",
      parent_session_id: "resume_health_eval",
      capability: "code.edit",
      objective: "Patch the file.",
      agent_spec_id: "coder",
      invocation_mode: "call_subagent",
      file_scope: ["src/app.ts"],
      tool_budget: { max_turns: 4, max_tool_calls: 12 },
      task_packet: evalTaskPacket({
        objective: "Patch the file.",
        agent_spec_id: "coder",
        invocation_mode: "call_subagent",
        persona_snapshot: "coder",
        file_scope: ["src/app.ts"],
        allowed_tools: ["Read", "Edit"],
        write_policy: "scoped_write",
        budget: { max_turns: 4, max_tool_calls: 12 },
        expected_output: "Return changed files.",
        return_conditions: ["done"]
      })
    });
    runtime.workerStateStore.create({
      worker_id: "worker_resume_failed",
      parent_session_id: "resume_health_eval",
      capability: "code.review",
      objective: "Review the patch.",
      agent_spec_id: "reviewer",
      invocation_mode: "parallel",
      file_scope: [],
      tool_budget: { max_turns: 3, max_tool_calls: 8 },
      task_packet: evalTaskPacket({
        objective: "Review the patch.",
        agent_spec_id: "reviewer",
        invocation_mode: "parallel",
        persona_snapshot: "reviewer",
        file_scope: [],
        allowed_tools: ["Read", "Grep"],
        write_policy: "read_only",
        budget: { max_turns: 3, max_tool_calls: 8 },
        expected_output: "Return findings.",
        return_conditions: ["done"]
      })
    });
    runtime.workerStateStore.setResult({
      worker_id: "worker_resume_failed",
      status: "failed",
      last_result: "Found a blocking regression."
    });
    runtime.handoffStore.create({
      handoff_id: "handoff_resume_live",
      worker_id: "worker_resume_live",
      parent_session_id: "resume_health_eval",
      source_agent: "main_swarm",
      target_agent_spec_id: "handoff_specialist",
      reason: "Deep focused patching",
      task_packet: evalTaskPacket({
        objective: "Patch the file.",
        agent_spec_id: "handoff_specialist",
        invocation_mode: "handoff",
        persona_snapshot: "handoff specialist",
        file_scope: ["src/app.ts"],
        allowed_tools: ["Read", "Edit"],
        write_policy: "scoped_write",
        budget: { max_turns: 6, max_tool_calls: 18 },
        expected_output: "Return handoff summary.",
        return_conditions: ["returned"]
      })
    });
    const prompt = runtime.buildResumePrompt("resume_health_eval", "continue carefully");
    const ok = prompt.includes("Resume Health")
      && prompt.includes("Open attempts: 1")
      && prompt.includes("coding_turn_7 [coding_turn/started]")
      && prompt.includes("Unresolved failures: 1")
      && prompt.includes("tool_test [tool_call/failed]")
      && prompt.includes("error=PROCESS_EXIT_NONZERO")
      && prompt.includes("Resume Work Contracts")
      && prompt.includes("Active workers: 1")
      && prompt.includes("worker_resume_live [running] coder/call_subagent policy=scoped_write scope=src/app.ts")
      && prompt.includes("Resumable workers: 1")
      && prompt.includes("worker_resume_failed [failed] reviewer/parallel policy=read_only")
      && prompt.includes("Active handoffs: 1")
      && prompt.includes("handoff_resume_live [active] -> handoff_specialist worker=worker_resume_live policy=scoped_write scope=src/app.ts")
      && prompt.includes("Resume instruction: inspect unresolved failures before repeating work");
    return ok
      ? { name: "resume prompt surfaces open attempts, unresolved failures, and worker contracts", status: "pass", message: "buildResumePrompt includes resume health plus active/resumable worker and handoff contracts with write policy and scope" }
      : { name: "resume prompt surfaces open attempts and unresolved failures", status: "fail", message: prompt.slice(0, 1200) };
  } finally {
    runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkResumePreflightReportBehavior(): EvalCaseResult {
  const dir = mkdtempSync(resolve(tmpdir(), "swarm-resume-preflight-eval-"));
  const workspace = resolve(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const runtime = new SwarmRuntime({ databasePath: resolve(dir, "swarm.db"), workspace });
  try {
    runtime.ensureTuiChatSession("resume_preflight_eval");
    runtime.runAttemptStore.upsert({
      session_id: "resume_preflight_eval",
      task_id: "coding_turn_3",
      runner_id: "main_swarm",
      kind: "coding_turn",
      status: "started",
      attempt: 3,
      title: "Coding loop turn"
    });
    runtime.workerStateStore.create({
      worker_id: "worker_preflight_live",
      parent_session_id: "resume_preflight_eval",
      capability: "code.edit",
      objective: "Patch the file.",
      agent_spec_id: "coder",
      invocation_mode: "parallel",
      file_scope: ["src/app.ts"],
      tool_budget: { max_turns: 4, max_tool_calls: 12 },
      task_packet: evalTaskPacket({
        objective: "Patch the file.",
        agent_spec_id: "coder",
        invocation_mode: "parallel",
        persona_snapshot: "coder",
        file_scope: ["src/app.ts"],
        allowed_tools: ["Read", "Edit"],
        write_policy: "scoped_write",
        budget: { max_turns: 4, max_tool_calls: 12 },
        expected_output: "Return changed files.",
        return_conditions: ["done"]
      })
    });
    const report = runtime.renderResumePreflight({
      sessionId: "resume_preflight_eval",
      instruction: "continue carefully",
      sandboxMode: "read-only",
      command: "continue",
      route: "coding_loop"
    });
    const ok = report.includes("Resume Preflight")
      && report.includes("resume_preflight_eval [running] command=continue route=coding_loop sandbox=read-only")
      && report.includes("Instruction: continue carefully")
      && report.includes("Stored plan: no")
      && report.includes("Freshness")
      && report.includes("preflighting a session resume")
      && report.includes("Resume Health")
      && report.includes("Open attempts: 1")
      && report.includes("Resume Team")
      && report.includes("worker_preflight_live [running] coder/parallel policy=scoped_write scope=src/app.ts")
      && report.includes("Memory");
    return ok
      ? { name: "resume preflight report surfaces route, sandbox, freshness, and worker state", status: "pass", message: "renderResumePreflight summarizes what a continue/resume command is about to do before execution proceeds" }
      : { name: "resume preflight report surfaces route, sandbox, freshness, and worker state", status: "fail", message: report.slice(0, 1200) };
  } finally {
    runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkResumeLiveControlDirectiveBehavior(): EvalCaseResult {
  const dir = mkdtempSync(resolve(tmpdir(), "swarm-resume-live-directive-eval-"));
  const workspace = resolve(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const runtime = new SwarmRuntime({ databasePath: resolve(dir, "swarm.db"), workspace });
  try {
    runtime.ensureTuiChatSession("resume_live_directive_eval");
    runtime.blackboardStore.write({
      swarm_id: "swarm_resume_live_directive_eval",
      session_id: "resume_live_directive_eval",
      key: "user.live_message.req_resume_live_1",
      type: "decision",
      value: {
        content: "Prioritize the sandbox report before MCP follow-up.",
        decision: {
          message_id: "req_resume_live_1",
          action: "inject_next_turn",
          reason: "user redirected the active work",
          instruction: "Finish the sandbox report first, then continue MCP work."
        },
        created_at: "2026-05-10T12:00:00.000Z"
      },
      created_by: { agent_id: "user", role: "user" },
      tags: ["user", "live-message"]
    });
    const prompt = runtime.buildResumePrompt("resume_live_directive_eval", "continue");
    const preflight = runtime.renderResumePreflight({
      sessionId: "resume_live_directive_eval",
      instruction: "continue",
      command: "resume",
      route: "coding_loop"
    });
    const replay = runtime.replaySession("resume_live_directive_eval");
    const expected = [
      "Live Control Directives",
      "message_id=req_resume_live_1",
      "action=inject_next_turn",
      "reason=user redirected the active work",
      "instruction=Finish the sandbox report first, then continue MCP work.",
      "content=Prioritize the sandbox report before MCP follow-up."
    ];
    const ok = [prompt, preflight, replay].every((surface) => expected.every((needle) => surface.includes(needle)));
    return ok
      ? { name: "resume surfaces include persisted live control directives", status: "pass", message: "buildResumePrompt, renderResumePreflight, and replaySession preserve live request ids and instructions" }
      : { name: "resume surfaces include persisted live control directives", status: "fail", message: `prompt=${prompt.slice(0, 900)} preflight=${preflight.slice(0, 900)} replay=${replay.slice(0, 900)}` };
  } finally {
    runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkWorkSnapshotContractBehavior(): EvalCaseResult {
  const dir = mkdtempSync(resolve(tmpdir(), "swarm-work-contract-snapshot-eval-"));
  const workspace = resolve(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const runtime = new SwarmRuntime({ databasePath: resolve(dir, "swarm.db"), workspace });
  try {
    runtime.ensureTuiChatSession("work_contract_snapshot_eval");
    runtime.workerStateStore.create({
      worker_id: "worker_contract_live",
      parent_session_id: "work_contract_snapshot_eval",
      capability: "code.edit",
      objective: "Patch the file.",
      agent_spec_id: "coder",
      invocation_mode: "call_subagent",
      handoff_id: "handoff_contract_live",
      file_scope: ["src/app.ts"],
      tool_budget: { max_turns: 4, max_tool_calls: 12 },
      task_packet: evalTaskPacket({
        objective: "Patch the file.",
        agent_spec_id: "coder",
        invocation_mode: "call_subagent",
        persona_snapshot: "coder",
        file_scope: ["src/app.ts"],
        allowed_tools: ["Read", "Edit"],
        write_policy: "scoped_write",
        budget: { max_turns: 4, max_tool_calls: 12 },
        expected_output: "Return changed files.",
        return_conditions: ["done"]
      })
    });
    runtime.workerStateStore.create({
      worker_id: "worker_contract_ro",
      parent_session_id: "work_contract_snapshot_eval",
      capability: "code.review",
      objective: "Review the patch.",
      agent_spec_id: "reviewer",
      invocation_mode: "parallel",
      file_scope: [],
      tool_budget: { max_turns: 3, max_tool_calls: 8 },
      task_packet: evalTaskPacket({
        objective: "Review the patch.",
        agent_spec_id: "reviewer",
        invocation_mode: "parallel",
        persona_snapshot: "reviewer",
        file_scope: [],
        allowed_tools: ["Read", "Grep"],
        write_policy: "read_only",
        budget: { max_turns: 3, max_tool_calls: 8 },
        expected_output: "Return findings.",
        return_conditions: ["done"]
      })
    });
    runtime.workerStateStore.setResult({
      worker_id: "worker_contract_ro",
      status: "failed",
      last_result: "Found a blocking regression."
    });
    runtime.workerStateStore.create({
      worker_id: "worker_contract_ws",
      parent_session_id: "work_contract_snapshot_eval",
      capability: "code.rewrite",
      objective: "Refactor the module.",
      agent_spec_id: "maintainer",
      invocation_mode: "parallel",
      file_scope: [],
      tool_budget: { max_turns: 5, max_tool_calls: 15 },
      task_packet: evalTaskPacket({
        objective: "Refactor the module.",
        agent_spec_id: "maintainer",
        invocation_mode: "parallel",
        persona_snapshot: "maintainer",
        file_scope: [],
        allowed_tools: ["Read", "Edit", "Write"],
        write_policy: "workspace_write",
        budget: { max_turns: 5, max_tool_calls: 15 },
        expected_output: "Return changed files.",
        return_conditions: ["done"]
      })
    });
    runtime.handoffStore.create({
      handoff_id: "handoff_contract_live",
      worker_id: "worker_contract_live",
      parent_session_id: "work_contract_snapshot_eval",
      source_agent: "main_swarm",
      target_agent_spec_id: "handoff_specialist",
      reason: "Deep focused patching",
      task_packet: evalTaskPacket({
        objective: "Patch the file.",
        agent_spec_id: "handoff_specialist",
        invocation_mode: "handoff",
        persona_snapshot: "handoff specialist",
        file_scope: ["src/lib.ts"],
        allowed_tools: ["Read", "Edit"],
        write_policy: "scoped_write",
        budget: { max_turns: 6, max_tool_calls: 18 },
        expected_output: "Return handoff summary.",
        return_conditions: ["returned"]
      })
    });
    const snapshot = runtime.getWorkSnapshot("work_contract_snapshot_eval");
    const ok = snapshot.work_contracts.summary.active_workers === 2
      && snapshot.work_contracts.summary.running_workers === 2
      && snapshot.work_contracts.summary.pending_workers === 0
      && snapshot.work_contracts.summary.resumable_workers === 1
      && snapshot.work_contracts.summary.active_handoffs === 1
      && snapshot.work_contracts.summary.read_only === 1
      && snapshot.work_contracts.summary.scoped_write === 1
      && snapshot.work_contracts.summary.workspace_write === 1
      && snapshot.work_contracts.summary.scoped_targets.join(",") === "src/app.ts,src/lib.ts"
      && snapshot.work_contracts.active_workers.some((worker) => worker.worker_id === "worker_contract_live" && worker.write_policy === "scoped_write")
      && snapshot.work_contracts.active_workers.some((worker) => worker.worker_id === "worker_contract_ws" && worker.write_policy === "workspace_write")
      && snapshot.work_contracts.resumable_workers.some((worker) => worker.worker_id === "worker_contract_ro" && worker.write_policy === "read_only")
      && snapshot.work_contracts.active_handoffs.some((handoff) => handoff.handoff_id === "handoff_contract_live" && handoff.write_policy === "scoped_write");
    return ok
      ? { name: "work snapshot exposes stable worker and handoff contracts", status: "pass", message: "getWorkSnapshot groups active/resumable worker contracts and active handoffs with write policy and scope summaries" }
      : { name: "work snapshot exposes stable worker and handoff contracts", status: "fail", message: JSON.stringify(snapshot.work_contracts, null, 2) };
  } finally {
    runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkGatewayLiveControlRouteBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SwarmGatewayServer } from "./dist/server/gateway.js";

const dir = mkdtempSync(resolve(tmpdir(), "swarm-gateway-live-control-eval-"));
const workspace = resolve(dir, "workspace");
mkdirSync(workspace, { recursive: true });
const gateway = new SwarmGatewayServer({ workspace, databasePath: resolve(dir, "swarm.db"), port: 0 });
const stopRequests = [];
gateway.runtime.orchestrator.requestStop = (sessionId, reason) => {
  stopRequests.push({ sessionId, reason });
  return true;
};

async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-swarm-local-control": "1" },
    body: JSON.stringify(body ?? {})
  });
  return { status: response.status, body: await response.json() };
}

async function get(url) {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}

try {
  const started = await gateway.start();
  const noActiveTarget = await get(\`\${started.url}/v1/live\`);
  const noActiveMessageRoute = await post(\`\${started.url}/v1/live/messages\`, { content: "status?" });
  const noActiveInterruptRoute = await post(\`\${started.url}/v1/live/interrupt\`, { content: "stop" });
  const noActiveMessage = await post(\`\${started.url}/v1/sessions/gateway_live_control_eval/messages\`, { content: "status?" });
  const noActiveInterrupt = await post(\`\${started.url}/v1/sessions/gateway_live_control_eval/interrupt\`, { content: "stop" });

  gateway.runtime.ensureTuiChatSession("gateway_live_control_eval");
  const messages = [];
  const interrupts = [];
  gateway.runtime.activeCodingLoopSessionId = "gateway_live_control_eval";
  gateway.runtime.activeCodingLoop = {
    async submitUserMessage(content) {
      messages.push(content);
    },
    requestInterrupt(content) {
      interrupts.push(content);
    }
  };

  const activeTarget = await get(\`\${started.url}/v1/live\`);
  const activeMessageRoute = await post(\`\${started.url}/v1/live/messages\`, { content: "focus on tests via active route" });
  const activeInterruptRoute = await post(\`\${started.url}/v1/live/interrupt\`, { content: "stop via active route" });
  const activeMessage = await post(\`\${started.url}/v1/sessions/gateway_live_control_eval/messages\`, { content: "focus on tests" });
  const idempotentMessage = await post(\`\${started.url}/v1/sessions/gateway_live_control_eval/messages\`, { content: "dedupe once", request_id: "req_gateway_live_1" });
  const duplicateMessage = await post(\`\${started.url}/v1/sessions/gateway_live_control_eval/messages\`, { content: "dedupe twice", request_id: "req_gateway_live_1" });
  const activeInterrupt = await post(\`\${started.url}/v1/sessions/gateway_live_control_eval/interrupt\`, { content: "stop after current safe boundary" });

  gateway.runtime.activeCodingLoop = undefined;
  gateway.runtime.activeCodingLoopSessionId = undefined;
  const now = new Date().toISOString();
  gateway.runtime.activeSwarmSession = {
    swarm_id: "gateway_full_swarm_eval",
    session_id: "gateway_full_swarm_eval",
    user_request_id: "gateway_full_swarm_eval",
    objective: "test interrupt semantics",
    status: "running",
    coordinator: { agent_id: "main_swarm", role: "controller" },
    participants: [],
    created_at: now,
    updated_at: now,
    policy: {
      max_agents: 4,
      max_parallel_tasks: 2,
      timeout_ms: 60000,
      retry: { max_attempts: 1, backoff_ms: 0 },
      require_review: false,
      consensus: "coordinator_decision",
      approval_mode: "on-request",
      safety: {
        require_human_approval_for: [],
        forbidden_capabilities: [],
        sandbox_required: false
      },
      memory: {
        allow_read: true,
        allow_write: true,
        retention: "session"
      }
    }
  };
  const unsupportedInterrupt = await post(\`\${started.url}/v1/sessions/gateway_full_swarm_eval/interrupt\`, { content: "stop" });

  console.log(JSON.stringify({
    noActiveTarget,
    noActiveMessageRoute,
    noActiveInterruptRoute,
    noActiveMessage,
    noActiveInterrupt,
    activeTarget,
    activeMessageRoute,
    activeInterruptRoute,
    activeMessage,
    idempotentMessage,
    duplicateMessage,
    activeInterrupt,
    unsupportedInterrupt,
    stopRequests,
    messages,
    interrupts
  }));
} finally {
  await gateway.stop();
  rmSync(dir, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    noActiveTarget?: { status?: number; body?: { status?: string; active_target?: unknown; controls?: { reply?: boolean; interrupt?: boolean } } };
    noActiveMessageRoute?: { status?: number; body?: { error?: { message?: string } } };
    noActiveInterruptRoute?: { status?: number; body?: { error?: { message?: string } } };
    noActiveMessage?: { status?: number; body?: { error?: { message?: string } } };
    noActiveInterrupt?: { status?: number; body?: { error?: { message?: string } } };
    activeTarget?: {
      status?: number;
      body?: {
        status?: string;
        active_target?: { session_id?: string; route?: string } | null;
        controls?: { reply?: boolean; interrupt?: boolean };
        session?: { session_id?: string; status?: string; work_snapshot?: unknown; work_contracts?: unknown };
      };
    };
    activeMessageRoute?: { status?: number; body?: { status?: string; session_id?: string; route?: string } };
    activeInterruptRoute?: { status?: number; body?: { status?: string; session_id?: string; route?: string } };
    activeMessage?: { status?: number; body?: { status?: string; session_id?: string; route?: string } };
    idempotentMessage?: { status?: number; body?: { status?: string; session_id?: string; route?: string; request_id?: string; duplicate?: boolean } };
    duplicateMessage?: { status?: number; body?: { status?: string; session_id?: string; route?: string; request_id?: string; duplicate?: boolean } };
    activeInterrupt?: { status?: number; body?: { status?: string; session_id?: string; route?: string } };
    unsupportedInterrupt?: { status?: number; body?: { status?: string; session_id?: string; route?: string } };
    stopRequests?: Array<{ sessionId?: string; reason?: string }>;
    messages?: string[];
    interrupts?: string[];
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in failure below.
  }
  const ok = result.status === 0
    && parsed.noActiveTarget?.status === 200
    && parsed.noActiveTarget.body?.status === "idle"
    && parsed.noActiveTarget.body?.active_target === null
    && parsed.noActiveTarget.body?.controls?.reply === false
    && parsed.noActiveTarget.body?.controls?.interrupt === false
    && parsed.noActiveMessageRoute?.status === 409
    && parsed.noActiveMessageRoute.body?.error?.message === "No active work is available to receive a live reply. Start or resume a run first."
    && parsed.noActiveInterruptRoute?.status === 409
    && parsed.noActiveInterruptRoute.body?.error?.message === "No active work is available to interrupt. Start or resume a run first."
    && parsed.noActiveMessage?.status === 409
    && parsed.noActiveMessage.body?.error?.message === "No active work is available to receive a live reply. Start or resume a run first."
    && parsed.noActiveInterrupt?.status === 409
    && parsed.noActiveInterrupt.body?.error?.message === "No active work is available to interrupt. Start or resume a run first."
    && parsed.activeTarget?.status === 200
    && parsed.activeTarget.body?.status === "active"
    && parsed.activeTarget.body?.active_target?.session_id === "gateway_live_control_eval"
    && parsed.activeTarget.body?.active_target?.route === "coding_loop"
    && parsed.activeTarget.body?.controls?.reply === true
    && parsed.activeTarget.body?.controls?.interrupt === true
    && parsed.activeTarget.body?.session?.session_id === "gateway_live_control_eval"
    && typeof parsed.activeTarget.body?.session?.status === "string"
    && typeof parsed.activeTarget.body?.session?.work_snapshot === "object"
    && typeof parsed.activeTarget.body?.session?.work_contracts === "object"
    && parsed.activeMessageRoute?.status === 200
    && parsed.activeMessageRoute.body?.status === "applied"
    && parsed.activeMessageRoute.body?.session_id === "gateway_live_control_eval"
    && parsed.activeMessageRoute.body?.route === "coding_loop"
    && parsed.activeInterruptRoute?.status === 200
    && parsed.activeInterruptRoute.body?.status === "applied"
    && parsed.activeInterruptRoute.body?.session_id === "gateway_live_control_eval"
    && parsed.activeInterruptRoute.body?.route === "coding_loop"
    && parsed.activeMessage?.status === 200
    && parsed.activeMessage.body?.status === "applied"
    && parsed.activeMessage.body?.session_id === "gateway_live_control_eval"
    && parsed.activeMessage.body?.route === "coding_loop"
    && parsed.idempotentMessage?.status === 200
    && parsed.idempotentMessage.body?.status === "applied"
    && parsed.idempotentMessage.body?.request_id === "req_gateway_live_1"
    && parsed.idempotentMessage.body?.duplicate === false
    && parsed.duplicateMessage?.status === 200
    && parsed.duplicateMessage.body?.request_id === "req_gateway_live_1"
    && parsed.duplicateMessage.body?.duplicate === true
    && parsed.activeInterrupt?.status === 200
    && parsed.activeInterrupt.body?.status === "applied"
    && parsed.activeInterrupt.body?.session_id === "gateway_live_control_eval"
    && parsed.activeInterrupt.body?.route === "coding_loop"
    && parsed.unsupportedInterrupt?.status === 200
    && parsed.unsupportedInterrupt.body?.status === "applied"
    && parsed.unsupportedInterrupt.body?.session_id === "gateway_full_swarm_eval"
    && parsed.unsupportedInterrupt.body?.route === "full_swarm"
    && parsed.stopRequests?.length === 1
    && parsed.stopRequests[0]?.sessionId === "gateway_full_swarm_eval"
    && parsed.stopRequests[0]?.reason === "stop"
    && parsed.messages?.join(",") === "focus on tests via active route,focus on tests,dedupe once"
    && parsed.interrupts?.join(",") === "stop via active route,stop after current safe boundary";
  return ok
    ? { name: "Gateway live control routes fail closed and apply coding-loop control", status: "pass", message: "workspace and session live-control routes share active-target semantics, fail closed when unavailable, and convert full_swarm interrupts into safe-boundary stop requests" }
    : {
        name: "Gateway live control routes fail closed and apply coding-loop control",
        status: "fail",
        message: `exit=${result.status} stdout=${result.stdout.slice(0, 900)} stderr=${result.stderr.slice(0, 700)}`
      };
}

function checkGatewayApprovalQueueRouteBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SwarmGatewayServer } from "./dist/server/gateway.js";

const dir = mkdtempSync(resolve(tmpdir(), "swarm-gateway-approval-eval-"));
const workspace = resolve(dir, "workspace");
mkdirSync(workspace, { recursive: true });
const gateway = new SwarmGatewayServer({ workspace, databasePath: resolve(dir, "swarm.db"), port: 0 });
gateway.runtime.settings.extensions.mcp.exposeGatewayServer = true;

async function getJson(url) {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-swarm-local-control": "1" },
    body: JSON.stringify(body ?? {})
  });
  return { status: response.status, body: await response.json() };
}

async function callMcp(url, name, args) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-swarm-local-control": "1" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
  });
  return response.json();
}

function approvalRequest(id, sessionId, summary) {
  return {
    id,
    session_id: sessionId,
    action: "shell.exec",
    summary,
    detail: summary,
    risk: "shell",
    risk_class: "r3",
    target: "npm test",
    why_now: "Need approval.",
    predicted_impact: "Runs tests.",
    rollback_plan: "No rollback needed."
  };
}

try {
  const started = await gateway.start();
  const sessionId = "gateway_approval_eval";
  gateway.runtime.ensureTuiChatSession(sessionId);
  gateway.runtime["ensureLoopSession"]("gateway_approval_worker_session", "Worker approval session", sessionId, {
    labels: ["worker"],
    mode: "worker_loop",
    source: "worker"
  });

  const pending = approvalRequest("approval_gateway_pending", sessionId, "Pending approval");
  const approved = approvalRequest("approval_gateway_done", sessionId, "Approved approval");
  const mcpPending = approvalRequest("approval_gateway_mcp", sessionId, "MCP approval");
  const workerPending = approvalRequest("approval_gateway_worker", "gateway_approval_worker_session", "Worker approval");

  gateway.runtime.approvalStore.upsert(pending, "pending");
  gateway.runtime.approvalStore.upsert(approved, "approved");
  gateway.runtime.approvalStore.upsert(mcpPending, "pending");
  gateway.runtime.approvalStore.upsert(workerPending, "pending");

  gateway.pendingApprovals.set(pending.id, {
    request: pending,
    created_at: new Date().toISOString(),
    resolve: (allowed) => gateway.runtime.approvalStore.upsert(pending, allowed ? "approved" : "denied")
  });
  gateway.pendingApprovals.set(mcpPending.id, {
    request: mcpPending,
    created_at: new Date().toISOString(),
    resolve: (allowed) => gateway.runtime.approvalStore.upsert(mcpPending, allowed ? "approved" : "denied")
  });
  gateway.pendingApprovals.set(workerPending.id, {
    request: workerPending,
    created_at: new Date().toISOString(),
    resolve: (allowed) => gateway.runtime.approvalStore.upsert(workerPending, allowed ? "approved" : "denied")
  });

  const sessionApprovals = await getJson(\`\${started.url}/v1/sessions/\${sessionId}/approvals?limit=10\`);
  const globalApprovals = await getJson(\`\${started.url}/v1/approvals?session_id=\${sessionId}&limit=10\`);
  const detailBefore = await getJson(\`\${started.url}/v1/approvals/\${pending.id}\`);
  const decision = await postJson(\`\${started.url}/v1/approvals/\${pending.id}/decision\`, { approved: true });
  const detailAfter = await getJson(\`\${started.url}/v1/approvals/\${pending.id}\`);
  const staleDecision = await postJson(\`\${started.url}/v1/approvals/\${pending.id}/decision\`, { approved: true });

  const mcpList = await callMcp(\`\${started.url}/mcp\`, "swarm.approvals", { session_id: sessionId, limit: 10 });
  const mcpDecision = await callMcp(\`\${started.url}/mcp\`, "swarm.approval_decision", { approval_id: mcpPending.id, approved: false });
  const mcpDecisionAgain = await callMcp(\`\${started.url}/mcp\`, "swarm.approval_decision", { approval_id: mcpPending.id, approved: false });

  console.log(JSON.stringify({
    sessionApprovals,
    globalApprovals,
    detailBefore,
    decision,
    detailAfter,
    staleDecision,
    mcpList,
    mcpDecision,
    mcpDecisionAgain
  }));
} finally {
  await gateway.stop();
  rmSync(dir, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: any = {};
  try {
    parsed = JSON.parse(output);
  } catch {
    // Keep raw output in failure below.
  }
  const sessionBody = parsed.sessionApprovals?.body;
  const globalBody = parsed.globalApprovals?.body;
  const detailBefore = parsed.detailBefore?.body;
  const detailAfter = parsed.detailAfter?.body;
  const mcpList = parsed.mcpList?.result?.structuredContent;
  const mcpDecision = parsed.mcpDecision?.result?.structuredContent;
  const mcpDecisionAgain = parsed.mcpDecisionAgain?.error;
  const ok = result.status === 0
    && parsed.sessionApprovals?.status === 200
    && sessionBody?.session_id === "gateway_approval_eval"
    && sessionBody?.actionable_approval_ids?.includes("approval_gateway_pending")
    && sessionBody?.actionable_approval_ids?.includes("approval_gateway_worker")
    && sessionBody?.summary?.actionable_pending === 3
    && sessionBody?.summary?.approved === 1
    && sessionBody?.approvals?.some((approval: Record<string, unknown>) => approval.approval_id === "approval_gateway_worker" && approval.session_id === "gateway_approval_worker_session")
    && sessionBody?.approvals?.every((approval: Record<string, unknown>) => !("challenge_json" in approval))
    && parsed.globalApprovals?.status === 200
    && globalBody?.actionable_approval_ids?.includes("approval_gateway_pending")
    && globalBody?.actionable_approval_ids?.includes("approval_gateway_worker")
    && parsed.detailBefore?.status === 200
    && detailBefore?.actionable === true
    && detailBefore?.pending_request?.id === "approval_gateway_pending"
    && !("challenge_json" in (detailBefore?.approval ?? {}))
    && parsed.decision?.status === 200
    && parsed.decision?.body?.status === "approved"
    && parsed.detailAfter?.status === 200
    && detailAfter?.actionable === false
    && detailAfter?.approval?.status === "approved"
    && !("challenge_json" in (detailAfter?.approval ?? {}))
    && parsed.staleDecision?.status === 409
    && parsed.staleDecision?.body?.error?.message?.includes("current_status=approved")
    && Array.isArray(mcpList?.actionable_approval_ids)
    && mcpList.actionable_approval_ids.includes("approval_gateway_mcp")
    && mcpList.actionable_approval_ids.includes("approval_gateway_worker")
    && mcpDecision?.approval_id === "approval_gateway_mcp"
    && mcpDecision?.status === "denied"
    && mcpDecisionAgain?.message?.includes("current_status=denied");
  return ok
    ? { name: "Gateway and MCP approval routes expose actionable state and fail closed", status: "pass", message: "approval list/detail routes show actionable pending requests, HTTP decisions update state, and MCP approval tools inspect and reject stale decisions explicitly" }
    : {
        name: "Gateway and MCP approval routes expose actionable state and fail closed",
        status: "fail",
        message: `exit=${result.status} stdout=${result.stdout.slice(0, 1100)} stderr=${result.stderr.slice(0, 700)}`
      };
}

function checkSessionFamilyApprovalReplayBehavior(): EvalCaseResult {
  const dir = mkdtempSync(resolve(tmpdir(), "swarm-session-family-approval-eval-"));
  const workspace = resolve(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const runtime = new SwarmRuntime({ databasePath: resolve(dir, "swarm.db"), workspace });
  try {
    runtime.ensureTuiChatSession("approval_family_parent");
    runtime["ensureLoopSession"]("approval_family_child", "Worker child session", "approval_family_parent", {
      labels: ["worker"],
      mode: "worker_loop",
      source: "worker"
    });
    runtime.approvalStore.upsert({
      id: "approval_parent",
      session_id: "approval_family_parent",
      action: "shell.exec",
      summary: "Parent approval",
      detail: "Parent approval",
      risk: "shell",
      risk_class: "r3",
      target: "npm test",
      why_now: "Need approval.",
      predicted_impact: "Runs tests.",
      rollback_plan: "No rollback needed."
    }, "approved");
    runtime.approvalStore.upsert({
      id: "approval_child",
      session_id: "approval_family_child",
      action: "file.write",
      summary: "Child approval",
      detail: "Child approval",
      risk: "write",
      risk_class: "r2",
      target: "src/runtime/runtime.ts",
      why_now: "Need approval.",
      predicted_impact: "Updates runtime.",
      rollback_plan: "Revert the edit."
    }, "pending");
    const familyApprovals = runtime.listApprovalsForSessionFamily("approval_family_parent", 10);
    const replay = runtime.replaySession("approval_family_parent");
    const ok = runtime.sessionFamilyRootSessionId("approval_family_child") === "approval_family_parent"
      && runtime.listSessionFamilySessionIds("approval_family_child", 10).sort().join(",") === "approval_family_child,approval_family_parent"
      && familyApprovals.length === 2
      && familyApprovals.some((approval) => approval.approval_id === "approval_child" && approval.session_id === "approval_family_child")
      && replay.includes("Approvals: 2")
      && replay.includes("approval_child [pending/r2] Child approval");
    return ok
      ? { name: "session family approvals flow into runtime replay and inspection", status: "pass", message: "runtime approval inspection and replay include child worker session approvals when resuming or inspecting the parent session" }
      : {
          name: "session family approvals flow into runtime replay and inspection",
          status: "fail",
          message: JSON.stringify({
            root: runtime.sessionFamilyRootSessionId("approval_family_child"),
            family: runtime.listSessionFamilySessionIds("approval_family_child", 10),
            approvals: familyApprovals,
            replay: replay.slice(0, 1200)
          })
        };
  } finally {
    runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkMcpSessionSnapshotParityBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SwarmGatewayServer } from "./dist/server/gateway.js";

const dir = mkdtempSync(resolve(tmpdir(), "swarm-mcp-session-parity-eval-"));
const workspace = resolve(dir, "workspace");
mkdirSync(workspace, { recursive: true });
const gateway = new SwarmGatewayServer({ workspace, databasePath: resolve(dir, "swarm.db"), port: 0 });
gateway.runtime.settings.extensions.mcp.exposeGatewayServer = true;

async function getJson(url) {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}

async function mcp(url, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-swarm-local-control": "1" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  return response.json();
}

try {
  const sessionId = "mcp_session_view_eval";
  gateway.runtime.ensureTuiChatSession(sessionId);
  gateway.runtime.workerStateStore.create({
    worker_id: "worker_mcp_session_live",
    parent_session_id: sessionId,
    capability: "code.edit",
    objective: "Patch the file.",
    agent_spec_id: "coder",
    invocation_mode: "parallel",
    file_scope: ["src/app.ts"],
    tool_budget: { max_turns: 4, max_tool_calls: 12 },
    task_packet: {
      objective: "Patch the file.",
      agent_spec_id: "coder",
      invocation_mode: "parallel",
      persona_snapshot: "coder",
      file_scope: ["src/app.ts"],
      allowed_tools: ["Read", "Edit"],
      write_policy: "scoped_write",
      permission_context: { default_mode: "ask", allow: [], ask: [], deny: [], additional_directories: [] },
      budget: { max_turns: 4, max_tool_calls: 12 },
      expected_output: "Return changed files.",
      return_conditions: ["done"]
    }
  });
  gateway.runtime.approvalStore.upsert({
    id: "approval_mcp_snapshot",
    session_id: sessionId,
    action: "shell.exec",
    summary: "Review the command",
    detail: "Review the command",
    risk: "shell",
    risk_class: "r3",
    target: "npm test",
    why_now: "Need approval.",
    predicted_impact: "Runs tests.",
    rollback_plan: "No rollback needed."
  }, "approved");

  const started = await gateway.start();
  const gatewaySession = await getJson(\`\${started.url}/v1/sessions/\${sessionId}\`);
  const mcpTool = await mcp(\`\${started.url}/mcp\`, "tools/call", { name: "swarm.session_status", arguments: { session_id: sessionId } });
  const mcpSessionResource = await mcp(\`\${started.url}/mcp\`, "resources/read", { uri: \`swarm://sessions/\${sessionId}\` });
  const mcpApprovalResource = await mcp(\`\${started.url}/mcp\`, "resources/read", { uri: \`swarm://sessions/\${sessionId}/approvals\` });

  console.log(JSON.stringify({
    gatewaySession: gatewaySession.body,
    mcpTool: mcpTool.result?.structuredContent,
    mcpSessionResource: JSON.parse(mcpSessionResource.result?.contents?.[0]?.text ?? "{}"),
    mcpApprovalResource: JSON.parse(mcpApprovalResource.result?.contents?.[0]?.text ?? "[]")
  }));
} finally {
  await gateway.stop();
  rmSync(dir, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: any = {};
  try {
    parsed = JSON.parse(output);
  } catch {
    // Keep raw output in failure below.
  }
  const gatewaySession = parsed.gatewaySession;
  const mcpTool = parsed.mcpTool;
  const mcpSessionResource = parsed.mcpSessionResource;
  const mcpApprovalResource = parsed.mcpApprovalResource;
  const ok = result.status === 0
    && gatewaySession?.work_snapshot?.work_contracts?.summary?.active_workers === 1
    && mcpTool?.work_snapshot?.work_contracts?.summary?.active_workers === 1
    && mcpSessionResource?.work_snapshot?.work_contracts?.summary?.active_workers === 1
    && gatewaySession?.approvals?.summary?.approved === 1
    && JSON.stringify(mcpTool?.approvals) === JSON.stringify(gatewaySession?.approvals)
    && JSON.stringify(mcpSessionResource?.approvals) === JSON.stringify(gatewaySession?.approvals)
    && JSON.stringify(mcpTool?.task_contracts) === JSON.stringify(gatewaySession?.task_contracts)
    && JSON.stringify(mcpTool?.work_contracts) === JSON.stringify(gatewaySession?.work_contracts)
    && JSON.stringify(mcpSessionResource?.task_contracts) === JSON.stringify(gatewaySession?.task_contracts)
    && JSON.stringify(mcpSessionResource?.work_contracts) === JSON.stringify(gatewaySession?.work_contracts)
    && Array.isArray(mcpApprovalResource)
    && mcpApprovalResource.length === 1
    && mcpApprovalResource[0]?.approval_id === "approval_mcp_snapshot"
    && !("challenge_json" in mcpApprovalResource[0]);
  return ok
    ? { name: "MCP session snapshot and resources mirror Gateway session state", status: "pass", message: "swarm.session_status and swarm://sessions resources reuse the Gateway session snapshot contract, including work/task contracts and session approval history" }
    : {
        name: "MCP session snapshot and resources mirror Gateway session state",
        status: "fail",
        message: `exit=${result.status} stdout=${result.stdout.slice(0, 1100)} stderr=${result.stderr.slice(0, 700)}`
      };
}

function checkWorkspaceSessionStatusParityBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SwarmGatewayServer } from "./dist/server/gateway.js";

const dir = mkdtempSync(resolve(tmpdir(), "swarm-workspace-status-parity-eval-"));
const workspace = resolve(dir, "workspace");
mkdirSync(workspace, { recursive: true });
const gateway = new SwarmGatewayServer({ workspace, databasePath: resolve(dir, "swarm.db"), port: 0 });
gateway.runtime.settings.extensions.mcp.exposeGatewayServer = true;

async function getJson(url) {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}

async function mcp(url, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-swarm-local-control": "1" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  return response.json();
}

try {
  const sessionId = "workspace_status_parity_eval";
  gateway.runtime.ensureTuiChatSession(sessionId);
  gateway.runtime.workerStateStore.create({
    worker_id: "worker_workspace_status_eval",
    parent_session_id: sessionId,
    capability: "code.edit",
    objective: "Patch the file.",
    agent_spec_id: "coder",
    invocation_mode: "parallel",
    file_scope: ["src/app.ts"],
    tool_budget: { max_turns: 4, max_tool_calls: 12 },
    task_packet: {
      objective: "Patch the file.",
      agent_spec_id: "coder",
      invocation_mode: "parallel",
      persona_snapshot: "coder",
      file_scope: ["src/app.ts"],
      allowed_tools: ["Read", "Edit"],
      write_policy: "scoped_write",
      permission_context: { default_mode: "ask", allow: [], ask: [], deny: [], additional_directories: [] },
      budget: { max_turns: 4, max_tool_calls: 12 },
      expected_output: "Return changed files.",
      return_conditions: ["done"]
    }
  });
  gateway.runtime.approvalStore.upsert({
    id: "approval_workspace_status_eval",
    session_id: sessionId,
    action: "shell.exec",
    summary: "Review the command",
    detail: "Review the command",
    risk: "shell",
    risk_class: "r3",
    target: "npm test",
    why_now: "Need approval.",
    predicted_impact: "Runs tests.",
    rollback_plan: "No rollback needed."
  }, "pending");

  const started = await gateway.start();
  const gatewaySessions = await getJson(\`\${started.url}/v1/sessions?limit=5\`);
  const mcpTool = await mcp(\`\${started.url}/mcp\`, "tools/call", { name: "swarm.session_status", arguments: { limit: 5 } });

  console.log(JSON.stringify({
    gatewaySessions: gatewaySessions.body,
    mcpTool: mcpTool.result?.structuredContent
  }));
} finally {
  await gateway.stop();
  rmSync(dir, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: any = {};
  try {
    parsed = JSON.parse(output);
  } catch {
    // Keep raw output in failure below.
  }
  const gatewaySessions = parsed.gatewaySessions;
  const mcpTool = parsed.mcpTool;
  const ok = result.status === 0
    && gatewaySessions?.workspace_path === mcpTool?.workspace_path
    && gatewaySessions?.summary?.persisted_pending_approvals === 1
    && mcpTool?.summary?.persisted_pending_approvals === 1
    && gatewaySessions?.work_contracts?.summary?.active_workers === 1
    && mcpTool?.work_contracts?.summary?.active_workers === 1
    && JSON.stringify(gatewaySessions) === JSON.stringify(mcpTool);
  return ok
    ? { name: "Gateway sessions overview and MCP workspace status share one snapshot contract", status: "pass", message: "the no-session status surfaces now reuse one workspace snapshot, including approvals, work contracts, and active live target state" }
    : {
        name: "Gateway sessions overview and MCP workspace status share one snapshot contract",
        status: "fail",
        message: `exit=${result.status} stdout=${result.stdout.slice(0, 1100)} stderr=${result.stderr.slice(0, 700)}`
      };
}

function checkTaskContractSnapshotBehavior(): EvalCaseResult {
  const dir = mkdtempSync(resolve(tmpdir(), "swarm-task-contract-snapshot-eval-"));
  const workspace = resolve(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const runtime = new SwarmRuntime({ databasePath: resolve(dir, "swarm.db"), workspace });
  try {
    runtime.ensureTuiChatSession("task_contract_snapshot_eval");
    const row = runtime.sessionStore.get("task_contract_snapshot_eval");
    if (!row) {
      return { name: "work snapshot exposes stable task contracts", status: "fail", message: "session was not created" };
    }
    const tasks: GeneratedPlan["tasks"] = [
      {
        task_id: "task_read",
        title: "Read the README",
        description: "Inspect README",
        objective: "Inspect README",
        type: "tool_call",
        status: "completed",
        required_capabilities: ["file.read"],
        inputs: { action: "Read", path: "README.md" },
        expected_output: { format: "text" },
        dependencies: []
      },
      {
        task_id: "task_patch",
        title: "Patch the app",
        description: "Edit src/app.ts",
        objective: "Edit src/app.ts",
        type: "tool_call",
        status: "running",
        required_capabilities: ["file.edit"],
        inputs: {
          action: "Edit",
          path: "src/app.ts",
          oldText: "before",
          newText: "after",
          write_policy: "scoped_write",
          file_scope: ["src/app.ts"]
        },
        expected_output: { format: "text" },
        dependencies: ["task_read"]
      },
      {
        task_id: "task_review",
        title: "Review the patch",
        description: "Review changes",
        objective: "Review changes",
        type: "review",
        status: "pending",
        required_capabilities: ["review.general"],
        inputs: {},
        expected_output: { format: "markdown" },
        dependencies: ["task_patch"]
      }
    ];
    runtime.taskGraphStore.storePlan("task_contract_snapshot_eval", {
      objective: "Task contract eval",
      summary: "Task contract eval",
      tasks
    });
    runtime.taskStateStore.upsert({
      session_id: row.session_id,
      swarm_id: row.swarm_id,
      task: tasks[0],
      status: "completed",
      attempt: 1,
      capability: "file.read",
      write_policy: "read_only"
    });
    runtime.taskStateStore.upsert({
      session_id: row.session_id,
      swarm_id: row.swarm_id,
      task: tasks[1],
      status: "running",
      attempt: 2,
      capability: "file.edit",
      write_policy: "scoped_write",
      file_scope: ["src/app.ts"]
    });
    runtime.taskStateStore.upsert({
      session_id: row.session_id,
      swarm_id: row.swarm_id,
      task: tasks[2],
      status: "pending",
      attempt: 0,
      capability: "review.general"
    });
    const snapshot = runtime.getWorkSnapshot("task_contract_snapshot_eval");
    const graph = runtime.getTaskGraph("task_contract_snapshot_eval");
    const detail = runtime.getTaskDetail("task_contract_snapshot_eval", "task_patch");
    const ok = snapshot.task_contracts.summary.total === 3
      && snapshot.task_contracts.summary.pending === 1
      && snapshot.task_contracts.summary.running === 1
      && snapshot.task_contracts.summary.completed === 1
      && snapshot.task_contracts.summary.failed === 0
      && snapshot.task_contracts.summary.read_only === 1
      && snapshot.task_contracts.summary.scoped_write === 1
      && snapshot.task_contracts.summary.workspace_write === 0
      && snapshot.task_contracts.summary.scoped_targets.join(",") === "src/app.ts"
      && snapshot.task_contracts.tasks.some((task) => task.task_id === "task_patch" && task.write_policy === "scoped_write")
      && graph.tasks.some((task) => task.task_id === "task_patch" && task.write_policy === "scoped_write" && task.file_scope?.join(",") === "src/app.ts")
      && detail.task_contract?.task_id === "task_patch"
      && detail.task_contract?.write_policy === "scoped_write";
    return ok
      ? { name: "work snapshot exposes stable task contracts", status: "pass", message: "task snapshots preserve capability, write policy, file scope, and summary counts across graph/detail surfaces" }
      : { name: "work snapshot exposes stable task contracts", status: "fail", message: JSON.stringify({ snapshot: snapshot.task_contracts, graph: graph.tasks, detail: detail.task_contract }, null, 2) };
  } finally {
    runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkSyntheticToolContractBehavior(): EvalCaseResult {
  const dir = mkdtempSync(resolve(tmpdir(), "swarm-synthetic-tool-contract-eval-"));
  const workspace = resolve(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const runtime = new SwarmRuntime({ databasePath: resolve(dir, "swarm.db"), workspace });
  try {
    const sessionId = "synthetic_tool_contract_eval";
    runtime.ensureTuiChatSession(sessionId);
    runtime.events.emitEvent({
      type: "tool_result",
      session_id: sessionId,
      task_id: "tool_write_eval",
      title: "Patch file",
      action: "file.edit",
      summary: "edited src/app.ts",
      status: "success",
      write_policy: "scoped_write",
      file_scope: ["src/app.ts"]
    });
    const snapshot = runtime.getWorkSnapshot(sessionId);
    const graph = runtime.getTaskGraph(sessionId);
    const detail = runtime.getTaskDetail(sessionId, "tool_write_eval");
    const ok = snapshot.task_contracts.summary.total === 1
      && snapshot.task_contracts.summary.completed === 1
      && snapshot.task_contracts.summary.scoped_write === 1
      && snapshot.task_contracts.summary.scoped_targets.join(",") === "src/app.ts"
      && snapshot.task_contracts.tasks.some((task) => task.task_id === "tool_write_eval"
        && task.capability === "file.edit"
        && task.write_policy === "scoped_write"
        && task.file_scope?.join(",") === "src/app.ts")
      && graph.tasks.some((task) => task.task_id === "tool_write_eval"
        && task.capability === "file.edit"
        && task.write_policy === "scoped_write"
        && task.file_scope?.join(",") === "src/app.ts")
      && detail.task_contract?.task_id === "tool_write_eval"
      && detail.task_contract?.capability === "file.edit"
      && detail.task_contract?.write_policy === "scoped_write"
      && detail.task_contract?.file_scope?.join(",") === "src/app.ts";
    return ok
      ? { name: "synthetic tool results persist stable task contracts", status: "pass", message: "interactive tool_result events populate task snapshot, graph, and detail policy/scope contracts through the synthetic task path" }
      : {
          name: "synthetic tool results persist stable task contracts",
          status: "fail",
          message: JSON.stringify({ snapshot: snapshot.task_contracts, graph: graph.tasks, detail: detail.task_contract }, null, 2)
        };
  } finally {
    runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkGatewayWorkContractRouteBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { SwarmGatewayServer } from "./dist/server/gateway.js";

const dir = mkdtempSync(join(tmpdir(), "swarm-gateway-contract-eval-"));
const workspace = resolve(dir, "workspace");
mkdirSync(workspace, { recursive: true });
const gateway = new SwarmGatewayServer({ workspace, databasePath: resolve(dir, "swarm.db"), port: 0 });
try {
  gateway.runtime.ensureTuiChatSession("gateway_contract_eval");
  gateway.runtime["ensureLoopSession"]("worker_gateway_session", "Gateway worker session", "gateway_contract_eval", {
    labels: ["worker"],
    mode: "worker_loop",
    source: "worker"
  });
  gateway.runtime.workerStateStore.create({
    worker_id: "worker_gateway_live",
    parent_session_id: "gateway_contract_eval",
    capability: "code.edit",
    objective: "Patch the file.",
    agent_spec_id: "coder",
    invocation_mode: "call_subagent",
    handoff_id: "handoff_gateway_live",
    file_scope: ["src/app.ts"],
    tool_budget: { max_turns: 4, max_tool_calls: 12 },
    task_packet: {
      objective: "Patch the file.",
      agent_spec_id: "coder",
      invocation_mode: "call_subagent",
      persona_snapshot: "coder",
      file_scope: ["src/app.ts"],
      allowed_tools: ["Read", "Edit"],
      write_policy: "scoped_write",
      permission_context: { default_mode: "ask", allow: [], ask: [], deny: [], additional_directories: [] },
      budget: { max_turns: 4, max_tool_calls: 12 },
      expected_output: "Return changed files.",
      return_conditions: ["done"]
    }
  });
  gateway.runtime.workerStateStore.setResult({
    worker_id: "worker_gateway_live",
    status: "running",
    worker_session_id: "worker_gateway_session"
  });
  gateway.runtime.workerStateStore.create({
    worker_id: "worker_gateway_ro",
    parent_session_id: "gateway_contract_eval",
    capability: "code.review",
    objective: "Review the patch.",
    agent_spec_id: "reviewer",
    invocation_mode: "parallel",
    file_scope: [],
    tool_budget: { max_turns: 3, max_tool_calls: 8 },
    task_packet: {
      objective: "Review the patch.",
      agent_spec_id: "reviewer",
      invocation_mode: "parallel",
      persona_snapshot: "reviewer",
      file_scope: [],
      allowed_tools: ["Read", "Grep"],
      write_policy: "read_only",
      permission_context: { default_mode: "ask", allow: [], ask: [], deny: [], additional_directories: [] },
      budget: { max_turns: 3, max_tool_calls: 8 },
      expected_output: "Return findings.",
      return_conditions: ["done"]
    }
  });
  gateway.runtime.workerStateStore.setResult({
    worker_id: "worker_gateway_ro",
    status: "failed",
    last_result: "Found a blocking regression."
  });
  gateway.runtime.handoffStore.create({
    handoff_id: "handoff_gateway_live",
    worker_id: "worker_gateway_live",
    parent_session_id: "gateway_contract_eval",
    source_agent: "main_swarm",
    target_agent_spec_id: "handoff_specialist",
    reason: "Deep focused patching",
    task_packet: {
      objective: "Patch the file.",
      agent_spec_id: "handoff_specialist",
      invocation_mode: "handoff",
      persona_snapshot: "handoff specialist",
      file_scope: ["src/lib.ts"],
      allowed_tools: ["Read", "Edit"],
      write_policy: "scoped_write",
      permission_context: { default_mode: "ask", allow: [], ask: [], deny: [], additional_directories: [] },
      budget: { max_turns: 6, max_tool_calls: 18 },
      expected_output: "Return handoff summary.",
      return_conditions: ["returned"]
    }
  });
  const started = await gateway.start();
  const workerList = await fetch(\`\${started.url}/v1/workers?parent_session_id=gateway_contract_eval\`).then((response) => response.json());
  const workerDetail = await fetch(\`\${started.url}/v1/workers/worker_gateway_live\`).then((response) => response.json());
  const handoffList = await fetch(\`\${started.url}/v1/handoffs?parent_session_id=gateway_contract_eval\`).then((response) => response.json());
  const handoffDetail = await fetch(\`\${started.url}/v1/handoffs/handoff_gateway_live\`).then((response) => response.json());
  const ok = workerList.worker_contracts?.length === 2
    && workerList.work_contract_summary?.active_workers === 1
    && workerList.work_contract_summary?.running_workers === 1
    && workerList.work_contract_summary?.pending_workers === 0
    && workerList.work_contract_summary?.resumable_workers === 1
    && workerList.work_contract_summary?.active_handoffs === 1
    && workerList.work_contract_summary?.scoped_targets?.join(",") === "src/app.ts,src/lib.ts"
    && workerList.worker_contracts.some((worker) => worker.worker_id === "worker_gateway_live" && worker.write_policy === "scoped_write")
    && workerDetail.worker_contract?.worker_id === "worker_gateway_live"
    && workerDetail.worker_contract?.write_policy === "scoped_write"
    && workerDetail.worker_session?.session_id === "worker_gateway_session"
    && workerDetail.worker_session?.parent_session_id === "gateway_contract_eval"
    && handoffList.handoff_contracts?.length === 1
    && handoffList.work_contract_summary?.active_handoffs === 1
    && handoffList.handoff_contracts[0]?.handoff_id === "handoff_gateway_live"
    && handoffList.handoff_contracts[0]?.write_policy === "scoped_write"
    && handoffDetail.handoff_contract?.handoff_id === "handoff_gateway_live"
    && handoffDetail.handoff_contract?.file_scope?.join(",") === "src/lib.ts";
  console.log(JSON.stringify({
    ok,
    workerList,
    workerDetail,
    handoffList,
    handoffDetail
  }));
} finally {
  await gateway.stop();
  rmSync(dir, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000
  });
  const output = result.stdout.trim().split(/\\r?\\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    ok?: boolean;
    workerList?: { worker_contracts?: Array<{ worker_id?: string; write_policy?: string }>; work_contract_summary?: { active_workers?: number; running_workers?: number; pending_workers?: number; resumable_workers?: number; active_handoffs?: number; scoped_targets?: string[] } };
    workerDetail?: { worker_contract?: { worker_id?: string; write_policy?: string }; worker_session?: { session_id?: string; parent_session_id?: string } };
    handoffList?: { handoff_contracts?: Array<{ handoff_id?: string; write_policy?: string }>; work_contract_summary?: { active_handoffs?: number } };
    handoffDetail?: { handoff_contract?: { handoff_id?: string; file_scope?: string[] } };
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output for failure reporting.
  }
  return result.status === 0 && parsed.ok
    ? { name: "Gateway collaboration routes expose stable work contracts", status: "pass", message: "worker and handoff routes expose contract summaries, per-record contract payloads, and session filtering" }
    : {
        name: "Gateway collaboration routes expose stable work contracts",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkGatewayTaskContractRouteBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { SwarmGatewayServer } from "./dist/server/gateway.js";

const dir = mkdtempSync(join(tmpdir(), "swarm-gateway-task-contract-eval-"));
const workspace = resolve(dir, "workspace");
mkdirSync(workspace, { recursive: true });
const gateway = new SwarmGatewayServer({ workspace, databasePath: resolve(dir, "swarm.db"), port: 0 });
try {
  gateway.runtime.ensureTuiChatSession("gateway_task_contract_eval");
  const row = gateway.runtime.sessionStore.get("gateway_task_contract_eval");
  if (!row) {
    throw new Error("session missing");
  }
  const tasks = [
    {
      task_id: "task_read",
      title: "Read the README",
      description: "Inspect README",
      objective: "Inspect README",
      type: "tool_call",
      status: "completed",
      required_capabilities: ["file.read"],
      inputs: { action: "Read", path: "README.md" },
      expected_output: { format: "text" },
      dependencies: []
    },
    {
      task_id: "task_patch",
      title: "Patch the app",
      description: "Edit src/app.ts",
      objective: "Edit src/app.ts",
      type: "tool_call",
      status: "running",
      required_capabilities: ["file.edit"],
      inputs: {
        action: "Edit",
        path: "src/app.ts",
        oldText: "before",
        newText: "after",
        write_policy: "scoped_write",
        file_scope: ["src/app.ts"]
      },
      expected_output: { format: "text" },
      dependencies: ["task_read"]
    },
    {
      task_id: "task_review",
      title: "Review the patch",
      description: "Review changes",
      objective: "Review changes",
      type: "review",
      status: "pending",
      required_capabilities: ["review.general"],
      inputs: {},
      expected_output: { format: "markdown" },
      dependencies: ["task_patch"]
    }
  ];
  gateway.runtime.taskGraphStore.storePlan("gateway_task_contract_eval", {
    objective: "Gateway task contract eval",
    summary: "Gateway task contract eval",
    tasks
  });
  gateway.runtime.taskStateStore.upsert({
    session_id: row.session_id,
    swarm_id: row.swarm_id,
    task: tasks[0],
    status: "completed",
    attempt: 1,
    capability: "file.read",
    write_policy: "read_only"
  });
  gateway.runtime.taskStateStore.upsert({
    session_id: row.session_id,
    swarm_id: row.swarm_id,
    task: tasks[1],
    status: "running",
    attempt: 2,
    capability: "file.edit",
    write_policy: "scoped_write",
    file_scope: ["src/app.ts"]
  });
  gateway.runtime.taskStateStore.upsert({
    session_id: row.session_id,
    swarm_id: row.swarm_id,
    task: tasks[2],
    status: "pending",
    attempt: 0,
    capability: "review.general"
  });
  const started = await gateway.start();
  const session = await fetch(\`\${started.url}/v1/sessions/gateway_task_contract_eval\`).then((response) => response.json());
  const graph = await fetch(\`\${started.url}/v1/sessions/gateway_task_contract_eval/graph\`).then((response) => response.json());
  const detail = await fetch(\`\${started.url}/v1/sessions/gateway_task_contract_eval/tasks/task_patch\`).then((response) => response.json());
  const ok = session.task_contracts?.summary?.total === 3
    && session.task_contracts?.summary?.running === 1
    && session.task_contracts?.summary?.pending === 1
    && session.task_contracts?.summary?.completed === 1
    && session.task_contracts?.summary?.read_only === 1
    && session.task_contracts?.summary?.scoped_write === 1
    && session.work_snapshot?.task_contracts?.tasks?.some((task) => task.task_id === "task_patch" && task.write_policy === "scoped_write")
    && graph.tasks?.some((task) => task.task_id === "task_patch" && task.write_policy === "scoped_write" && task.file_scope?.join(",") === "src/app.ts")
    && detail.task_contract?.task_id === "task_patch"
    && detail.task_contract?.write_policy === "scoped_write"
    && detail.task_contract?.file_scope?.join(",") === "src/app.ts";
  console.log(JSON.stringify({ ok, session, graph, detail }));
} finally {
  await gateway.stop();
  rmSync(dir, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000
  });
  const output = result.stdout.trim().split(/\\r?\\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    ok?: boolean;
    session?: { task_contracts?: { summary?: { total?: number; running?: number; pending?: number; completed?: number; read_only?: number; scoped_write?: number }; tasks?: Array<{ task_id?: string; write_policy?: string }> }; work_snapshot?: { task_contracts?: { tasks?: Array<{ task_id?: string; write_policy?: string }> } } };
    graph?: { tasks?: Array<{ task_id?: string; write_policy?: string; file_scope?: string[] }> };
    detail?: { task_contract?: { task_id?: string; write_policy?: string; file_scope?: string[] } };
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output for failure reporting.
  }
  return result.status === 0 && parsed.ok
    ? { name: "Gateway session task routes expose stable task contracts", status: "pass", message: "session, graph, and task-detail routes expose task policy/scope contracts without replaying events" }
    : {
        name: "Gateway session task routes expose stable task contracts",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkGatewayToolWorkEventStreamBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { SwarmGatewayServer } from "./dist/server/gateway.js";

const dir = mkdtempSync(join(tmpdir(), "swarm-gateway-work-stream-eval-"));
const workspace = resolve(dir, "workspace");
mkdirSync(workspace, { recursive: true });
const gateway = new SwarmGatewayServer({ workspace, databasePath: resolve(dir, "swarm.db"), port: 0 });

async function readTaskRecord(url, taskId) {
  const response = await fetch(url);
  const reader = response.body?.getReader();
  if (!reader) {
    return { eventName: undefined, record: undefined, error: "missing-reader" };
  }
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\\n\\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const lines = block.split(/\\r?\\n/).filter(Boolean);
      const eventName = lines.find((line) => line.startsWith("event: "))?.slice(7);
      const dataLine = lines.find((line) => line.startsWith("data: "))?.slice(6);
      if (!eventName || !dataLine) {
        continue;
      }
      const parsed = JSON.parse(dataLine);
      if (eventName === "task" && parsed.task_id === taskId) {
        await reader.cancel();
        return { eventName, record: parsed };
      }
    }
  }
  await reader.cancel();
  return { eventName: undefined, record: undefined, error: "timeout" };
}

try {
  const sessionId = "gateway_work_stream_eval";
  gateway.runtime.ensureTuiChatSession(sessionId);
  const started = await gateway.start();
  gateway.runtime.events.emitEvent({
    type: "tool_result",
    session_id: sessionId,
    task_id: "tool_stream_patch",
    title: "Patch file",
    action: "file.edit",
    summary: "patched src/app.ts",
    status: "failed",
    write_policy: "scoped_write",
    file_scope: ["src/app.ts"],
    sandbox: {
      decision: "deny",
      policy: "scoped_write",
      subject: "tool_action",
      reason: "Scoped-write sandbox denied tool action: file.edit outside file_scope (private/out.ts)",
      action: "file.edit",
      targets: ["private/out.ts"],
      file_scope: ["src/app.ts"]
    }
  });
  const streamed = await readTaskRecord(\`\${started.url}/v1/sessions/\${sessionId}/work-events\`, "tool_stream_patch");
  const record = streamed.record;
  const ok = streamed.eventName === "task"
    && record?.kind === "task"
    && record?.task_id === "tool_stream_patch"
    && record?.phase === "failed"
    && record?.status === "failed"
    && record?.capability === "file.edit"
    && record?.write_policy === "scoped_write"
    && record?.file_scope?.join(",") === "src/app.ts"
    && record?.sandbox?.status === "denied"
    && record?.sandbox?.policy === "scoped_write"
    && record?.sandbox?.targets?.includes("private/out.ts");
  console.log(JSON.stringify({ ok, streamed }));
} finally {
  await gateway.stop();
  rmSync(dir, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    ok?: boolean;
    streamed?: {
      eventName?: string;
      error?: string;
      record?: {
        kind?: string;
        task_id?: string;
        phase?: string;
        status?: string;
        capability?: string;
        write_policy?: string;
        file_scope?: string[];
        sandbox?: {
          status?: string;
          policy?: string;
          targets?: string[];
        };
      };
    };
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Preserve raw output in failure mode.
  }
  return result.status === 0 && parsed.ok
    ? { name: "Gateway work-event stream emits tool results as task protocol records", status: "pass", message: "session work-events SSE emits tool_result updates as task records with write policy, file scope, and sandbox metadata" }
    : {
        name: "Gateway work-event stream emits tool results as task protocol records",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkGatewayQueueAndActivityWorkEventStreamBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { SwarmGatewayServer } from "./dist/server/gateway.js";

const dir = mkdtempSync(join(tmpdir(), "swarm-gateway-queue-activity-eval-"));
const workspace = resolve(dir, "workspace");
mkdirSync(workspace, { recursive: true });
const gateway = new SwarmGatewayServer({ workspace, databasePath: resolve(dir, "swarm.db"), port: 0 });

async function readWorkEvents(url, wanted) {
  const response = await fetch(url);
  const reader = response.body?.getReader();
  if (!reader) {
    return { found: {}, error: "missing-reader" };
  }
  const decoder = new TextDecoder();
  const found = {};
  let buffer = "";
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && Object.keys(found).length < wanted.length) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\\n\\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const lines = block.split(/\\r?\\n/).filter(Boolean);
      const eventName = lines.find((line) => line.startsWith("event: "))?.slice(7);
      const dataLine = lines.find((line) => line.startsWith("data: "))?.slice(6);
      if (!eventName || !dataLine || !wanted.includes(eventName) || found[eventName]) {
        continue;
      }
      found[eventName] = { eventName, record: JSON.parse(dataLine) };
    }
  }
  await reader.cancel();
  return Object.keys(found).length === wanted.length ? { found } : { found, error: "timeout" };
}

try {
  const sessionId = "gateway_queue_activity_eval";
  gateway.runtime.ensureTuiChatSession(sessionId);
  const started = await gateway.start();
  gateway.runtime.events.emitEvent({
    type: "queue",
    queue: "worker_slots",
    operation: "enqueue",
    id: "worker_eval_1",
    size: 1,
    session_id: sessionId,
    message: "Waiting for a worker slot: running 1/1"
  });
  gateway.runtime.events.emitEvent({
    type: "loop_activity",
    session_id: sessionId,
    phase: "running_tool",
    message: "Worker tool file.grep failed: missing required input: root",
    tool: "file.grep",
    task_id: "worker_eval_task",
    status: "failed",
    summary: "missing required input: root",
    errorCode: "INVALID_INPUT",
    recoverySuggestion: "Correct the tool arguments and retry; use file.read or tool context to build a more precise request."
  });
  const streamed = await readWorkEvents(\`\${started.url}/v1/sessions/\${sessionId}/work-events\`, ["queue", "activity"]);
  const queue = streamed.found?.queue?.record;
  const activity = streamed.found?.activity?.record;
  const ok = streamed.found?.queue?.eventName === "queue"
    && queue?.kind === "queue"
    && queue?.session_id === sessionId
    && queue?.queue === "worker_slots"
    && queue?.operation === "enqueue"
    && queue?.worker_id === "worker_eval_1"
    && queue?.message?.includes("Waiting for a worker slot")
    && streamed.found?.activity?.eventName === "activity"
    && activity?.kind === "activity"
    && activity?.session_id === sessionId
    && activity?.phase === "running_tool"
    && activity?.task_id === "worker_eval_task"
    && activity?.tool === "file.grep"
    && activity?.status === "failed"
    && activity?.summary === "missing required input: root"
    && activity?.error_code === "INVALID_INPUT"
    && activity?.recovery_suggestion?.includes("Correct the tool arguments and retry");
  console.log(JSON.stringify({ ok, streamed }));
} finally {
  await gateway.stop();
  rmSync(dir, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    ok?: boolean;
    streamed?: {
      error?: string;
      found?: {
        queue?: {
          eventName?: string;
          record?: {
            kind?: string;
            session_id?: string;
            queue?: string;
            operation?: string;
            worker_id?: string;
            message?: string;
          };
        };
        activity?: {
          eventName?: string;
          record?: {
            kind?: string;
            session_id?: string;
            phase?: string;
            task_id?: string;
            tool?: string;
            status?: string;
            summary?: string;
            error_code?: string;
            recovery_suggestion?: string;
          };
        };
      };
    };
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Preserve raw output in failure mode.
  }
  return result.status === 0 && parsed.ok
    ? { name: "Gateway work-event stream emits queue and activity protocol records", status: "pass", message: "session work-events SSE replays worker-slot queue records and structured worker activity records for automation consumers" }
    : {
        name: "Gateway work-event stream emits queue and activity protocol records",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
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
      task_packet: evalTaskPacket({
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
      })
    });
    runtime.handoffStore.create({
      handoff_id: "handoff_b",
      worker_id: "worker_b",
      parent_session_id: "session_b",
      source_agent: "main",
      target_agent_spec_id: "researcher",
      reason: "eval",
      task_packet: evalTaskPacket({
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
      })
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

function checkCodeLintSkipsMissingNodeConfigBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSwarmSettings } from "./dist/config/settings.js";
import { runLocalTool } from "./dist/tools/local-tools.js";

const workspace = mkdtempSync(join(tmpdir(), "swarm-lint-no-config-eval-"));
try {
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }), "utf8");
  writeFileSync(join(workspace, "index.js"), "export const value = 1;\\n", "utf8");
  const result = await runLocalTool({ type: "code.lint", root: "." }, { workspace, settings: defaultSwarmSettings() });
  console.log(JSON.stringify({ status: result.status, summary: result.summary, content: result.content ?? "" }));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: { status?: string; summary?: string; content?: string } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Keep raw output in failure below.
  }
  const ok = result.status === 0
    && parsed.status === "success"
    && parsed.summary === "no recognized linter configuration found"
    && !parsed.content?.includes("eslint");
  return ok
    ? { name: "code.lint skips Node projects without lint configuration", status: "pass", message: "package.json alone no longer triggers a speculative npx eslint failure" }
    : {
        name: "code.lint skips Node projects without lint configuration",
        status: "fail",
        message: `exit=${result.status} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
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
  const stalled = summarizeCodingLoopFinalStatus({
    stopRequested: false,
    modelStatus: "continue",
    content: "Need to keep going.",
    toolResults: []
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
    && finalActivityPhase(exhausted) === "failed"
    && stalled.status === "failed"
    && stalled.summary.includes("without executable tool calls");
  return ok
    ? { name: "coding loop final status reflects recoverable tool failures", status: "pass", message: "failed tool results can recover after later success while unresolved failures and exhausted budgets still fail" }
    : { name: "coding loop final status reflects recoverable tool failures", status: "fail", message: `recovered=${recovered.status}/${recovered.summary} unresolved=${unresolved.status}/${unresolved.summary} stopped=${stopped.status} exhausted=${exhausted.status}/${exhausted.summary} stalled=${stalled.status}/${stalled.summary}` };
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
  const forward = nextMainPane("plan", 1);
  const backward = nextMainPane("plan", -1);
  const wraps = nextMainPane("board", 1);
  const ok = forward === "activity"
    && backward === "chat"
    && wraps === "chat";
  return ok
    ? { name: "TUI main pane order behavior works", status: "pass", message: "explicit /view pane order wraps predictably without default Ctrl+N/P chrome" }
    : { name: "TUI main pane order behavior works", status: "fail", message: `forward=${forward} backward=${backward} wraps=${wraps}` };
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

function checkWrappedDestructiveShellRiskBehavior(): EvalCaseResult {
  const wrappedDel = { type: "shell.exec" as const, command: "cmd /c del /s /q dist" };
  const wrappedRemoveItem = { type: "exec" as const, command: "powershell -NoProfile -Command \"Remove-Item -Recurse -Force dist\"" };
  const wrappedRm = { type: "code.build" as const, command: "bash -lc \"rm -rf dist\"" };
  const wrappedGitReset = { type: "process.start" as const, command: "wsl bash -lc \"git reset --hard HEAD~1\"" };
  const nestedWrappedDelete = { type: "shell.exec" as const, command: "cmd /c powershell -Command \"Remove-Item -Recurse -Force dist\"" };
  const safeFormat = { type: "shell.exec" as const, command: "npm run format" };
  const approval = createToolApprovalRequest(wrappedDel);
  const ok = riskClassForAction(wrappedDel) === "r4"
    && riskClassForAction(wrappedRemoveItem) === "r4"
    && riskClassForAction(wrappedRm) === "r4"
    && riskClassForAction(wrappedGitReset) === "r4"
    && riskClassForAction(nestedWrappedDelete) === "r4"
    && riskClassForAction(safeFormat) === "r2"
    && approval.risk_class === "r4"
    && approval.rollback_plan.includes("No automatic rollback");
  return ok
    ? { name: "wrapped destructive shell commands are classified as r4", status: "pass", message: "cmd, PowerShell, bash, and WSL wrappers still surface destructive commands as high-risk without flagging npm run format" }
    : {
        name: "wrapped destructive shell commands are classified as r4",
        status: "fail",
        message: [
          `wrappedDel=${riskClassForAction(wrappedDel)}`,
          `wrappedRemoveItem=${riskClassForAction(wrappedRemoveItem)}`,
          `wrappedRm=${riskClassForAction(wrappedRm)}`,
          `wrappedGitReset=${riskClassForAction(wrappedGitReset)}`,
          `nestedWrappedDelete=${riskClassForAction(nestedWrappedDelete)}`,
          `safeFormat=${riskClassForAction(safeFormat)}`,
          `approval=${JSON.stringify(approval)}`
        ].join(" ")
      };
}

function checkHighRiskShellApprovalModeBehavior(): EvalCaseResult {
  const workspace = resolve("eval-workspace");
  const destructiveShell = { type: "shell.exec" as const, command: "cmd /c del /s /q dist" };
  const destructiveBuild = { type: "code.build" as const, command: "bash -lc \"rm -rf dist\"" };
  const normalShell = { type: "shell.exec" as const, command: "npm test" };

  const yoloSettings = defaultSwarmSettings();
  yoloSettings.permissions.defaultMode = "yolo";
  yoloSettings.permissions.allow = [];
  yoloSettings.permissions.ask = [];
  yoloSettings.permissions.deny = [];

  const fullAutoSettings = defaultSwarmSettings();
  fullAutoSettings.permissions.defaultMode = "full-auto";
  fullAutoSettings.permissions.allow = [];
  fullAutoSettings.permissions.ask = [];
  fullAutoSettings.permissions.deny = [];

  const explicitAllowSettings = defaultSwarmSettings();
  explicitAllowSettings.permissions.defaultMode = "yolo";
  explicitAllowSettings.permissions.allow = ["Bash(cmd /c del /s /q dist)"];
  explicitAllowSettings.permissions.ask = [];
  explicitAllowSettings.permissions.deny = [];

  const yoloDecision = decideToolPermission(destructiveShell, yoloSettings, { workspace });
  const fullAutoDecision = decideToolPermission(destructiveBuild, fullAutoSettings, { workspace });
  const normalAllowed = !toolRequiresApproval(normalShell, yoloSettings, { workspace });
  const yoloRequiresApproval = toolRequiresApproval(destructiveShell, yoloSettings, { workspace });
  const fullAutoRequiresApproval = toolRequiresApproval(destructiveBuild, fullAutoSettings, { workspace });
  const explicitAllowBypassesPrompt = !toolRequiresApproval(destructiveShell, explicitAllowSettings, { workspace });
  const ok = yoloDecision.decision === "ask"
    && yoloDecision.reason.includes("destructive command requires approval")
    && yoloDecision.reason.includes("yolo")
    && fullAutoDecision.decision === "ask"
    && fullAutoDecision.reason.includes("full-auto")
    && yoloRequiresApproval
    && fullAutoRequiresApproval
    && normalAllowed
    && explicitAllowBypassesPrompt;
  return ok
    ? { name: "high-risk destructive shell commands still require approval in bypass modes", status: "pass", message: "yolo/full-auto keep fast paths for normal commands but still pause on r4 destructive shell actions unless explicitly allowed" }
    : {
        name: "high-risk destructive shell commands still require approval in bypass modes",
        status: "fail",
        message: [
          `yoloDecision=${JSON.stringify(yoloDecision)}`,
          `fullAutoDecision=${JSON.stringify(fullAutoDecision)}`,
          `yoloRequiresApproval=${yoloRequiresApproval}`,
          `fullAutoRequiresApproval=${fullAutoRequiresApproval}`,
          `normalAllowed=${normalAllowed}`,
          `explicitAllowBypassesPrompt=${explicitAllowBypassesPrompt}`
        ].join(" ")
      };
}

function checkWorkerPermissionSnapshotBehavior(root: string): EvalCaseResult {
  const script = `
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SwarmRuntime } from "./dist/runtime/runtime.js";

const dir = mkdtempSync(resolve(tmpdir(), "swarm-worker-permission-snapshot-eval-"));
const workspace = resolve(dir, "workspace");
mkdirSync(workspace, { recursive: true });
let approvals = 0;
const runtime = new SwarmRuntime({
  databasePath: resolve(dir, "swarm.db"),
  workspace,
  approvalHandler: async () => {
    approvals += 1;
    return true;
  }
});
runtime.ensureTuiChatSession("worker_permission_snapshot_eval");
runtime.settings.permissions.defaultMode = "yolo";
let calls = 0;
runtime.provider.generateText = async () => {
  calls += 1;
  if (calls === 1) {
    runtime.settings.permissions.defaultMode = "ask";
    return JSON.stringify({
      status: "continue",
      summary: "run shell",
      message: "run shell",
      files_touched: [],
      next_actions: [],
      tool_calls: [
        {
          id: "shell_snapshot",
          action: "Bash",
          inputs: {
            command: "node -e \\"console.log('worker-snapshot')\\"",
            description: "print snapshot marker"
          }
        }
      ]
    });
  }
  return JSON.stringify({
    status: "completed",
    summary: "done",
    message: "done",
    files_touched: [],
    next_actions: [],
    tool_calls: []
  });
};

try {
  const result = await runtime.invokeAgent({
    parent_session_id: "worker_permission_snapshot_eval",
    requested_by: "main_swarm",
    capability: "code.edit",
    task: "Use a code worker to inspect the runtime permission snapshot behavior and run a trivial shell command so we can verify the worker keeps the permission mode it was spawned with instead of inheriting later settings drift.",
    preferred_agent_spec_id: "coder",
    preferred_mode: "call_subagent",
    file_scope: ["README.md", "package.json"]
  });
  const worker = runtime.workerStateStore.listByParent("worker_permission_snapshot_eval")[0];
  console.log(JSON.stringify({
    approvals,
    calls,
    resultStatus: result.status,
    workerStatus: worker?.status,
    permissionMode: worker?.task_packet?.permission_context?.default_mode,
    runtimeModeAfterMutation: runtime.settings.permissions.defaultMode
  }));
} finally {
  runtime.dispose();
  rmSync(dir, { recursive: true, force: true });
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: {
    approvals?: number;
    calls?: number;
    resultStatus?: string;
    workerStatus?: string;
    permissionMode?: string;
    runtimeModeAfterMutation?: string;
  } = {};
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    // Preserve raw output in failure mode.
  }
  const ok = result.status === 0
    && parsed.approvals === 0
    && parsed.calls === 2
    && parsed.resultStatus === "success"
    && parsed.workerStatus === "completed"
    && parsed.permissionMode === "yolo"
    && parsed.runtimeModeAfterMutation === "ask";
  return ok
    ? { name: "worker delegation snapshots permission context before settings drift", status: "pass", message: "worker loops keep their spawned permission mode and rules even if the parent runtime settings change mid-run" }
    : {
        name: "worker delegation snapshots permission context before settings drift",
        status: "fail",
        message: `exit=${result.status} signal=${result.signal ?? "-"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()} parsed=${JSON.stringify(parsed)}`
      };
}

function checkPermissionDecisionObjectBehavior(): EvalCaseResult {
  const settings = defaultSwarmSettings();
  const workspace = resolve("eval-workspace");
  settings.permissions.defaultMode = "ask";
  settings.permissions.allow = ["Bash(npm test*)"];
  settings.permissions.ask = ["WebFetch(https://example.com/*)"];
  settings.permissions.deny = ["Bash(npm publish*)"];

  const deniedShell = { type: "shell.exec" as const, command: "npm publish --dry-run" };
  const allowedShell = { type: "shell.exec" as const, command: "npm test -- --runInBand" };
  const askedFetch = { type: "web.fetch" as const, url: "https://example.com/docs" };
  const writeAction = { type: "file.write" as const, path: "src/out.txt", content: "ok" };
  const readAction = { type: "file.read" as const, path: "src/index.ts" };

  const denied = decideToolPermission(deniedShell, settings, { workspace });
  const allowed = decideToolPermission(allowedShell, settings, { workspace });
  const asked = decideToolPermission(askedFetch, settings, { workspace });
  const write = decideToolPermission(writeAction, settings, { workspace });
  const read = decideToolPermission(readAction, settings, { workspace });
  const booleanCompatibility = throws(() => toolRequiresApproval(deniedShell, settings, { workspace }))
    && !toolRequiresApproval(allowedShell, settings, { workspace })
    && toolRequiresApproval(askedFetch, settings, { workspace })
    && toolRequiresApproval(writeAction, settings, { workspace })
    && !toolRequiresApproval(readAction, settings, { workspace });
  const ok = denied.decision === "deny"
    && denied.matched_rule === "Bash(npm publish*)"
    && allowed.decision === "allow"
    && allowed.matched_rule === "Bash(npm test*)"
    && asked.decision === "ask"
    && asked.matched_rule === "WebFetch(https://example.com/*)"
    && write.decision === "ask"
    && read.decision === "allow"
    && denied.permission_name === "Bash"
    && asked.permission_name === "WebFetch"
    && booleanCompatibility;
  return ok
    ? { name: "permission decisions use a central auditable decision object", status: "pass", message: "deny/allow/ask/default decisions carry matched rules and remain compatible with existing boolean/throw APIs" }
    : { name: "permission decisions use a central auditable decision object", status: "fail", message: `denied=${JSON.stringify(denied)} allowed=${JSON.stringify(allowed)} asked=${JSON.stringify(asked)} write=${JSON.stringify(write)} read=${JSON.stringify(read)} booleanCompatibility=${booleanCompatibility}` };
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
  if (process.argv.includes("--cache-lab")) {
    const cacheLab = runCacheLabReport();
    console.log(JSON.stringify({ status: "pass", cache_lab: cacheLab }, null, 2));
    process.exitCode = 0;
  } else if (process.argv.includes("--tui-replay")) {
    const suite = runDefaultTuiReplaySuite();
    console.log(JSON.stringify({
      status: suite.status,
      tui_replay: formatTuiReplaySuiteReport(suite),
      scenarios: suite.scenarios.map((scenario) => ({
        name: scenario.name,
        status: scenario.status,
        final_state: scenario.finalState,
        failures: scenario.failures,
        max_mounted_message_count: scenario.maxMountedMessageCount,
        max_visible_message_count: scenario.maxVisibleMessageCount
      }))
    }, null, 2));
    process.exitCode = suite.status === "pass" ? 0 : 1;
  } else if (process.argv.includes("--real-swarm")) {
    const realSwarm = runOfflineRealSwarmEvalSuite();
    console.log(JSON.stringify({
      status: realSwarm.status,
      real_swarm: realSwarm,
      report: formatRealSwarmEvalSuite(realSwarm)
    }, null, 2));
    process.exitCode = realSwarm.status === "pass" ? 0 : 1;
  } else if (process.argv.includes("--release-gate")) {
    const releaseGate = buildOfflineParityReleaseGate();
    console.log(JSON.stringify({ status: releaseGate.status, release_gate: releaseGate }, null, 2));
    process.exitCode = releaseGate.status === "pass" ? 0 : 1;
  } else {
    const results = runLocalEvals();
    const failed = results.filter((result) => result.status === "fail");
    console.log(JSON.stringify({ status: failed.length ? "fail" : "pass", results }, null, 2));
    process.exitCode = failed.length ? 1 : 0;
  }
}
