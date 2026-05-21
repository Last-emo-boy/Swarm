import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  getSelectedModelReadiness,
  getSwarmPaths,
  loadSwarmConfig,
  loadSwarmSettings
} from "../config/settings.js";
import { summarizeMcpCatalog, summarizePluginCatalog, summarizeSkillCatalog } from "../extensions/catalog-summary.js";
import type { WorkItem } from "../protocol/types.js";
import type { SwarmRuntime } from "../runtime/runtime.js";
import { runSymphonyPreflight } from "../symphony/preflight.js";
import { createWorkSourceFromConfig } from "../symphony/work-source.js";
import { loadWorkflow, normalizeWorkflowConfig } from "../symphony/workflow.js";
import { listSwarmLogs } from "./logs.js";

export type DoctorReport = {
  detail: string;
  failed: number;
  warnings: number;
  ok: boolean;
};

export async function buildDoctorReport(input: {
  runtime?: SwarmRuntime;
  workflowPath?: string;
  workspace?: string;
} = {}): Promise<DoctorReport> {
  const workspace = input.workspace ?? input.runtime?.workspaceRoot() ?? process.cwd();
  const paths = getSwarmPaths();
  const settings = loadSwarmSettings(workspace);
  const config = loadSwarmConfig();
  const readiness = getSelectedModelReadiness(settings, config);
  const workflowTarget = resolve(workspace, input.workflowPath ?? "WORKFLOW.md");
  const workflow = loadWorkflow(workflowTarget);
  const lines: string[] = [
    "Swarm Doctor",
    `cwd=${process.cwd()}`,
    `workspace=${workspace}`,
    ""
  ];
  let failed = 0;
  let warnings = 0;

  const add = (status: "OK" | "WARN" | "FAIL", message: string): void => {
    lines.push(`${status} ${message}`);
    if (status === "FAIL") {
      failed += 1;
    } else if (status === "WARN") {
      warnings += 1;
    }
  };

  lines.push("Paths");
  add(pathStatus(paths.home), `home=${paths.home}`);
  add(pathStatus(paths.settingsPath), `settings=${paths.settingsPath}`);
  add(pathStatus(paths.configPath), `config=${paths.configPath}`);
  add(pathStatus(settings.runtime.databasePath), `database=${settings.runtime.databasePath}${formatFileSize(settings.runtime.databasePath)}`);
  add(pathStatus(paths.logsDir), `logs_dir=${paths.logsDir}`);
  add("OK", `latest_log=${latestLogSummary(paths.logsDir)}`);
  add(pathStatus(paths.sessionsDir), `sessions_dir=${paths.sessionsDir}`);
  add(pathStatus(paths.artifactsDir), `artifacts_dir=${paths.artifactsDir}`);

  lines.push("", "Models");
  for (const item of readiness) {
    add(
      item.configured ? "OK" : "FAIL",
      `${item.role ?? "model"}=${item.modelRef} provider=${item.providerId || "-"}${item.reason ? ` - ${item.reason}` : ""}`
    );
  }

  lines.push("", "Permissions");
  add(
    "OK",
    `mode=${settings.permissions.defaultMode} allow=${settings.permissions.allow.length} ask=${settings.permissions.ask.length} deny=${settings.permissions.deny.length} additional_read_dirs=${settings.permissions.additionalDirectories.length}`
  );
  add(
    settings.permissions.defaultMode === "yolo" ? "WARN" : "OK",
    settings.permissions.defaultMode === "yolo"
      ? "yolo mode disables approval prompts for normal actions."
      : "approval policy configured."
  );

  lines.push("", "Kernel Stores");
  if (!input.runtime) {
    add("FAIL", "runtime is not ready.");
  } else {
    const sessions = input.runtime.listRecentSessionsForWorkspace(20);
    const attempts = input.runtime.listRecentAttemptsForWorkspace(20);
    const leases = input.runtime.listRecentLeasesForWorkspace(20);
    const approvals = input.runtime.listRecentApprovalsForWorkspace(20);
    const pendingApprovals = approvals.filter((approval) => approval.status === "pending");
    const workers = input.runtime.listRecentWorkersForWorkspace(20);
    const handoffs = input.runtime.listHandoffsForWorkspace(20);
    const blackboard = input.runtime.listRecentBlackboardForWorkspace(20);
    const latestSession = sessions[0];
    add("OK", `sessions=${sessions.length} attempts=${attempts.length} leases=${leases.length} workers=${workers.length} handoffs=${handoffs.length}`);
    add(pendingApprovals.length ? "WARN" : "OK", `pending_approvals=${pendingApprovals.length} approvals=${approvals.length}`);
    add("OK", `blackboard_entries=${blackboard.length}`);
    add("OK", `latest_session=${latestSession ? `${latestSession.session_id} [${latestSession.status}]` : "none"}`);
  }

  lines.push("", "Extensions");
  if (!input.runtime) {
    add("FAIL", "runtime is not ready.");
  } else {
    const commands = input.runtime.listCustomCommands();
    const skills = input.runtime.listSkills();
    const plugins = input.runtime.listPlugins();
    const servers = input.runtime.listMcpServers();
    const activeCommands = commands.filter((command) => !command.shadowedBy);
    const commandDiagnostics = commands.flatMap((command) => command.diagnostics ?? []);
    const skillSummary = summarizeSkillCatalog(skills);
    const pluginSummary = summarizePluginCatalog(plugins);
    const mcpSummary = summarizeMcpCatalog(servers);
    add("OK", `commands total=${commands.length} active=${activeCommands.length} trusted=${commands.filter((command) => command.trust === "trusted").length}`);
    add("OK", `skills total=${skillSummary.totals.skills} active=${skillSummary.totals.active} trusted=${skillSummary.totals.trusted}`);
    add("OK", `plugins total=${pluginSummary.totals.plugins} trusted=${pluginSummary.totals.trusted} slash_commands=${pluginSummary.totals.slashCommands}`);
    add("OK", `mcp servers=${mcpSummary.totals.servers} connected=${mcpSummary.totals.connected} pending=${mcpSummary.totals.pending} failed=${mcpSummary.totals.failed} disabled=${mcpSummary.totals.disabled}`);
    if (commandDiagnostics.length) {
      add("WARN", `command_diagnostics=${commandDiagnostics.length}`);
    }
    if (skillSummary.diagnostics.length) {
      add("WARN", `skill_diagnostics=${skillSummary.diagnostics.length}`);
    }
    if (pluginSummary.diagnostics.length) {
      add("WARN", `plugin_diagnostics=${pluginSummary.diagnostics.length}`);
    }
    if (mcpSummary.diagnostics.length || mcpSummary.errors.length) {
      add("WARN", `mcp_diagnostics=${mcpSummary.diagnostics.length} errors=${mcpSummary.errors.length}`);
    }
  }

  lines.push("", "Symphony");
  if (!workflow.ok) {
    add("WARN", `${workflow.error.code}: ${workflow.error.message}`);
    return { detail: lines.join("\n"), failed, warnings, ok: failed === 0 };
  }

  const workflowConfig = normalizeWorkflowConfig(workflow.workflow);
  const source = createWorkSourceFromConfig(workflowConfig);
  let active: WorkItem[] = [];
  let terminal: WorkItem[] = [];
  let sourceError: string | undefined;
  try {
    [active, terminal] = await Promise.all([
      source.fetchCandidateItems(),
      source.listTerminalItems()
    ]);
  } catch (error) {
    sourceError = error instanceof Error ? error.message : String(error);
  }
  add("OK", `workflow=${workflow.workflow.path}`);
  add(
    sourceError ? "FAIL" : "OK",
    `work_source=${source.kind} path=${workflowConfig.work_source.path ?? "WORK_ITEMS.md"} active=${active.length} terminal=${terminal.length}${sourceError ? ` - ${sourceError}` : ""}`
  );
  add("OK", `workspace_root=${workflowConfig.workspace.root}`);
  add("OK", `max_concurrent_agents=${workflowConfig.agent.max_concurrent_agents}`);

  if (!input.runtime) {
    add("WARN", "runtime unavailable; Symphony preflight skipped.");
    return { detail: lines.join("\n"), failed, warnings, ok: failed === 0 };
  }

  const preflight = runSymphonyPreflight({
    runtime: input.runtime,
    workflow: workflow.workflow,
    config: workflowConfig,
    candidates: active
  });
  add(preflight.ok ? "OK" : "FAIL", `preflight issues=${preflight.issues.length}`);
  for (const issue of preflight.issues) {
    add(
      issue.severity === "error" ? "FAIL" : "WARN",
      `${issue.code}${issue.field ? ` ${issue.field}` : ""}: ${issue.message}`
    );
  }

  return {
    detail: lines.join("\n"),
    failed,
    warnings,
    ok: failed === 0
  };
}

function pathStatus(path: string): "OK" | "FAIL" {
  return existsSync(path) ? "OK" : "FAIL";
}

function formatFileSize(path: string): string {
  if (!existsSync(path)) {
    return "";
  }
  try {
    const size = statSync(path).size;
    return ` bytes=${size}`;
  } catch {
    return "";
  }
}

function latestLogSummary(logDir: string): string {
  if (!existsSync(logDir)) {
    return "none";
  }
  const latest = listSwarmLogs(1)[0];
  return latest ? latest.path : "none";
}
