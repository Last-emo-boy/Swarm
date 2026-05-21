#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import {
  buildHeadlessResumeHint,
  buildHeadlessRunArtifacts,
  loadSwarmVersion,
  resolveHeadlessSessionId,
  writeJsonArtifact,
  type CapturedRuntimeEvent,
  type HeadlessMcpConfig,
  type HeadlessResumePreflight,
  type HeadlessRunBudget,
  type HeadlessOperation,
  type HeadlessPermissionMode,
  type HeadlessPromptCustomization,
  type HeadlessToolPolicy
} from "./runtime/headless-artifacts.js";
import { installHeadlessStdoutGuard, type HeadlessStreamRecordInput } from "./runtime/headless-stdio.js";
import type { RunSandboxMode } from "./runtime/execution-router.js";
import type { RuntimeMcpConfigOptions } from "./extensions/mcp.js";
import { normalizeSkillName } from "./extensions/skills.js";
import type { GeneratedPlan } from "./protocol/types.js";
import { restoreSessionFromRow } from "./sessions/session-row.js";
import type { SessionRow } from "./storage/session-store.js";
import { decideResumeExecution } from "./tui/resume-control.js";

const MCP_CONFIG_OPTION_SEPARATOR = "\u001f";

process.removeAllListeners("warning");
const [, , rawCommand, ...rawArgs] = process.argv;
let command: string | undefined = rawCommand;
let args = rawArgs;

// If a flag was passed where a command is expected, treat it as an arg
const KNOWN_FLAGS = new Set(["--debug", "--verbose", "-v", "--debug-trace", "--yolo", "--mode", "--workspace"]);
if (command && KNOWN_FLAGS.has(command)) {
  args = [command, ...args];
  command = undefined;
}

// Parse --debug / --verbose early so env is set before any imports
if (args.includes("--debug") || args.includes("--verbose") || args.includes("-v")) {
  process.env.SWARM_DEBUG = "true";
}
if (args.includes("--debug-trace")) {
  process.env.SWARM_DEBUG = "true";
  process.env.SWARM_DEBUG_LEVEL = "trace";
}
if (args.includes("--yolo") || command === "yolo") {
  process.env.SWARM_PERMISSION_MODE = "yolo";
  if (command === "yolo") {
    command = undefined;
  }
}

if (!command) {
  await launchChat();
} else if (command === "help" || command === "--help" || command === "-h") {
  printHelp();
} else if (command === "version" || command === "--version" || command === "-V") {
  console.log(loadSwarmVersion());
} else if (command === "chat") {
  await launchChat();
} else if (command === "run") {
  await runHeadless(args);
} else if (command === "work") {
  await runHeadless(["--mode", "coding_loop", ...args]);
} else if (command === "watch") {
  await runWatchCommand(args);
} else if (command === "live") {
  await runLiveStatusCommand(args);
} else if (command === "reply" || command === "interrupt") {
  await runLiveControlCommand(command, args);
} else if (command === "attach") {
  await runSessionsCommand(["attach", ...defaultSessionSelectorArgs(args)]);
} else if (command === "resume" || command === "continue") {
  await runSessionsCommand([command, ...args]);
} else if (command === "runs") {
  await runRunsCommand(args);
} else if (command === "checkpoints") {
  await runCheckpointsCommand(args);
} else if (command === "sessions" || command === "ps") {
  await runSessionsCommand(args);
} else if (command === "workers") {
  await runWorkersCommand(args);
} else if (command === "handoffs") {
  await runHandoffsCommand(args);
} else if (command === "doctor") {
  await runDoctorCommand(args);
} else if (command === "logs") {
  await runLogsCommand(args);
} else if (command === "capabilities") {
  await runCapabilitiesCommand(args);
} else if (command === "approvals") {
  await runApprovalsCommand(args);
} else if (command === "plugins") {
  await runPluginsCommand(args);
} else if (command === "skills") {
  await runSkillsCommand(args);
} else if (command === "mcp") {
  await runMcpCommand(args);
} else if (command === "lsp") {
  const { runLspCommand } = await import("./lsp/cli.js");
  await runLspCommand(args);
} else if (command === "onboard") {
  await launchChat({ forceOnboarding: true });
} else if (command === "init") {
  const { ensureSwarmHome } = await import("./config/settings.js");
  const { paths, created } = ensureSwarmHome();
  console.log(`Swarm home: ${paths.home}`);
  if (created.length === 0) {
    console.log("Already initialized.");
  } else {
    console.log("Created:");
    for (const path of created) {
    console.log(`  ${path}`);
    }
  }
} else if (command === "serve") {
  const options = parseOptions(args);
  const { SwarmGatewayServer } = await import("./server/gateway.js");
  const port = options.port ? Number(options.port) : undefined;
  const server = new SwarmGatewayServer({
    host: options.host,
    port: Number.isFinite(port) ? port : undefined,
    workspace: options.workspace
  });
  const started = await server.start();
  console.log(`Swarm Gateway listening on ${started.url}`);
  console.log("Press Ctrl+C to stop.");
  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await new Promise<void>(() => undefined);
} else if (command === "symphony") {
  await runSymphonyCommand(args);
} else if (command === "config") {
  const subcommand = args[0];
  const { ensureSwarmHome } = await import("./config/settings.js");
  const { paths } = ensureSwarmHome();
  if (!subcommand || subcommand === "path") {
    const target = args[1] ?? "settings";
    console.log(target === "config" ? paths.configPath : paths.settingsPath);
  } else if (subcommand === "home") {
    console.log(paths.home);
  } else {
    console.error(`Unknown config command: ${subcommand}`);
    process.exitCode = 1;
  }
} else if (command === "auth") {
  const subcommand = args[0];
  const { ensureSwarmHome, loadSwarmConfig, loadSwarmSettings, setPrimaryApiKey, setProviderApiKey } = await import(
    "./config/settings.js"
  );
  const { paths } = ensureSwarmHome();
  if (subcommand === "set-key") {
    const maybeProvider = args[1];
    const maybeKey = args[2];
    const settings = loadSwarmSettings();
    const config = loadSwarmConfig();
    const provider = maybeKey ? maybeProvider : config.primaryProvider;
    const key = maybeKey ?? maybeProvider;
    if (!key) {
      console.error("Usage: swarm auth set-key [provider] <api-key>");
      process.exitCode = 1;
    } else if (!provider) {
      console.error("Provider is required because no primary provider is selected.");
      console.error("Usage: swarm auth set-key <provider> <api-key>");
      process.exitCode = 1;
    } else if (!settings.providers[provider]) {
      console.error(`Unknown provider: ${provider}`);
      process.exitCode = 1;
    } else {
      if (maybeKey) {
        setProviderApiKey(provider, key);
      } else {
        setPrimaryApiKey(key);
      }
      console.log(`Saved plaintext API key for ${provider} to ${paths.configPath}`);
    }
  } else if (!subcommand || subcommand === "status" || subcommand === "list") {
    const config = loadSwarmConfig();
    const settings = loadSwarmSettings();
    console.log(`Config: ${paths.configPath}`);
    console.log(`Primary provider: ${config.primaryProvider || "none selected"}`);
    for (const provider of Object.values(settings.providers)) {
      const key = config.providerApiKeys[provider.id] || process.env[provider.apiKeyEnv] || "";
      const source = config.providerApiKeys[provider.id] ? "plaintext" : process.env[provider.apiKeyEnv] ? "env" : "none";
      console.log(`${provider.id.padEnd(12)} ${key ? `configured (${source}, ${key.length} chars)` : "not configured"}`);
    }
  } else {
    console.error(`Unknown auth command: ${subcommand}`);
    process.exitCode = 1;
  }
} else if (command === "providers") {
  const { addCustomProvider, ensureSwarmHome, getProviderModels, loadSwarmSettings } = await import("./config/settings.js");
  ensureSwarmHome();
  const settings = loadSwarmSettings();
  const subcommand = args[0] ?? "list";
  if (subcommand === "list") {
    for (const provider of Object.values(settings.providers)) {
      const disabled = settings.disabledProviders.includes(provider.id) ? " disabled" : "";
      const models = Object.keys(provider.models).slice(0, 3).join(", ");
      console.log(`${provider.id.padEnd(12)} ${provider.protocol.padEnd(23)} ${provider.name}${disabled}`);
      if (models) {
        console.log(`             models: ${models}${Object.keys(provider.models).length > 3 ? ", ..." : ""}`);
      }
    }
  } else if (subcommand === "add" || subcommand === "add-openai" || subcommand === "add-claude") {
    const id = args[1];
    const options = parseOptions(args.slice(2));
    const isClaudeCompatible = subcommand === "add-claude";
    if (!id || !options.name || !options["base-url"]) {
      console.error(
        `Usage: swarm providers ${subcommand} <id> --name <name> --base-url <url> [--model <model>] [--api-key <key>]`
      );
      process.exitCode = 1;
    } else {
      addCustomProvider({
        id,
        name: options.name,
        baseURL: options["base-url"],
        model: options.model,
        apiKey: options["api-key"],
        protocol: isClaudeCompatible ? "anthropic-messages" : "openai-chat-completions",
        auth: isClaudeCompatible ? "x-api-key" : options["api-key"] ? "bearer" : "none",
        apiKeyRequired: isClaudeCompatible ? true : undefined
      });
      console.log(`Added custom ${isClaudeCompatible ? "Claude-compatible" : "OpenAI-compatible"} provider: ${id}`);
    }
  } else if (subcommand === "refresh") {
    const { refreshProviderModels } = await import("./providers/model-discovery.js");
    const providerIds = args[1] ? [args[1]] : Object.keys(settings.providers);
    for (const providerId of providerIds) {
      const result = await refreshProviderModels(providerId);
      if (result.error) {
        console.log(`${providerId}: ${result.error}`);
      } else {
        console.log(`${providerId}: discovered ${result.models.length} models`);
      }
    }
  } else if (subcommand === "models") {
    const providerId = args[1] ?? settings.models.defaultProvider;
    if (!providerId) {
      console.error("Provider is required because no default provider is selected.");
      process.exitCode = 1;
    } else {
      const provider = settings.providers[providerId];
      if (!provider) {
        console.error(`Unknown provider: ${providerId}`);
        process.exitCode = 1;
      } else {
        const models = getProviderModels(provider);
        if (provider.lastModelDiscoveryError) {
          console.log(`Last discovery error: ${provider.lastModelDiscoveryError}`);
        }
        for (const model of models) {
          console.log(model);
        }
      }
    }
  } else {
    const provider = settings.providers[subcommand];
    if (!provider) {
      console.error(`Unknown provider: ${subcommand}`);
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify(provider, null, 2));
    }
  }
} else if (command === "models") {
  const subcommand = args[0];
  const { ensureSwarmHome, loadSwarmSettings, setModelSelection } = await import("./config/settings.js");
  ensureSwarmHome();
  if (subcommand === "set") {
    const options = parseOptions(args.slice(1));
    try {
      setModelSelection({
        defaultProvider: options["default-provider"],
        planner: options.planner,
        worker: options.worker,
        aggregator: options.aggregator
      });
      console.log("Updated model selection.");
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  } else if (!subcommand || subcommand === "show") {
    const settings = loadSwarmSettings();
    console.log(JSON.stringify(settings.models, null, 2));
  } else {
    console.error(`Unknown models command: ${subcommand}`);
    process.exitCode = 1;
  }
} else if (command === "bench") {
  await runBenchCommand(args);
} else {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

async function runSymphonyCommand(values: string[]): Promise<void> {
  const subcommand = values[0] ?? "preview";
  if (subcommand !== "preview" && subcommand !== "tick" && subcommand !== "run-once" && subcommand !== "daemon" && subcommand !== "status" && subcommand !== "cleanup") {
    console.error(`Unknown symphony command: ${subcommand}`);
    process.exitCode = 1;
    return;
  }
  const options = parseOptions(values.slice(1));
  let maxRunnerTurns: number | undefined;
  let maxRunnerToolCalls: number | undefined;
  let maxTicks: number | undefined;
  try {
    maxRunnerTurns = parsePositiveIntegerOption(options, "max-turns");
    maxRunnerToolCalls = parsePositiveIntegerOption(options, "max-tool-calls");
    maxTicks = parsePositiveIntegerOption(options, "max-ticks");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  const { SwarmRuntime } = await import("./runtime/runtime.js");
  const runtime = new SwarmRuntime({ workspace: options.workspace });
  try {
    if (subcommand === "status") {
      const { getSymphonyStatus } = await import("./symphony/status.js");
      const { formatSymphonyCliStatus } = await import("./symphony/status-format.js");
      const status = getSymphonyStatus({
        runtime,
        workflowPath: options.workflow,
        limit: maxTicks
      });
      printSymphonyStatus(formatSymphonyCliStatus(status));
      return;
    }

    if (subcommand === "cleanup") {
      const { cleanupSymphonyWorkspaces } = await import("./symphony/cleanup.js");
      const result = await cleanupSymphonyWorkspaces({
        runtime,
        workflowPath: options.workflow,
        execute: options.execute === "true" || options.run === "true",
        limit: maxTicks
      });
      if (!result.workflow.ok) {
        console.error(`${result.workflow.error.code}: ${result.workflow.error.message}`);
        process.exitCode = 1;
        return;
      }
      console.log(`Workflow: ${result.workflow.workflow.path}`);
      console.log(`Cleanup: ${result.execute ? "execute" : "dry-run"} inspected=${result.inspected} removed=${result.removed} skipped=${result.skipped} failed=${result.failed}`);
      console.log(`Retention: min_age_ms=${result.retention.min_age_ms} keep_latest=${result.retention.keep_latest} preserve_artifacts=${result.retention.preserve_artifacts}`);
      for (const record of result.records.slice(0, 30)) {
        console.log(`  ${record.session_id} [${record.status}] ${workItemDisplayName(record.work_item)} ${record.workspace?.workspace_path ?? ""}${record.reason ? ` - ${record.reason}` : ""}${record.age_ms !== undefined ? ` age_ms=${record.age_ms}` : ""}${record.artifact_path ? ` artifact=${record.artifact_path}` : ""}${record.error ? ` error=${record.error}` : ""}`);
      }
      return;
    }

    if (subcommand === "daemon") {
      await runSymphonyDaemon(runtime, options, { maxRunnerTurns, maxRunnerToolCalls, maxTicks });
      return;
    }

    if (subcommand === "tick" || subcommand === "run-once") {
      const { runSymphonyTick } = await import("./symphony/scheduler.js");
      const result = await runSymphonyTick({
        runtime,
        workflowPath: options.workflow,
        createWorkspace: options["no-create"] !== "true",
        execute: subcommand === "run-once",
        maxRunnerTurns,
        maxRunnerToolCalls
      });
      if (!result.workflow.ok) {
        console.error(`${result.workflow.error.code}: ${result.workflow.error.message}`);
        process.exitCode = 1;
        return;
      }
      console.log(`Workflow: ${result.workflow.workflow.path}`);
      console.log(`Candidates: ${result.candidates.length}`);
      console.log(`Dispatched: ${result.dispatched.length}`);
      for (const dispatch of result.dispatched) {
        console.log("");
        console.log(`${dispatch.session?.session_id ?? "(no-session)"} ${dispatch.session?.objective ?? dispatch.work_item.title}`);
        console.log(`  workspace: ${dispatch.workspace_path ?? "(none)"}`);
        console.log(`  attempt: ${dispatch.attempt?.attempt ?? 0} ${dispatch.attempt?.status ?? ""}`);
        console.log(`  prompt: ${firstLine(dispatch.prompt ?? "")}`);
      }
      if (result.skipped.length) {
        console.log(`Skipped: ${result.skipped.length}`);
        for (const skipped of result.skipped) {
          console.log(`  ${workItemDisplayName(skipped.work_item)}: ${skipped.reason ?? "skipped"}`);
        }
      }
      if (result.failed.length) {
        console.log(`Failed: ${result.failed.length}`);
        for (const failed of result.failed) {
          console.log(`  ${workItemDisplayName(failed.work_item)}: ${failed.error ?? failed.reason ?? "failed"}`);
        }
      }
      if (result.preflight && result.preflight.issues.length) {
        console.log(`Preflight: ${result.preflight.ok ? "passed_with_warnings" : "failed"}`);
        for (const issue of result.preflight.issues) {
          console.log(`  ${issue.severity} ${issue.code}${issue.field ? ` ${issue.field}` : ""}: ${issue.message}`);
        }
      }
      if (result.runs?.length) {
        console.log(`Runs: ${result.runs.length}`);
        for (const run of result.runs) {
          console.log(`  ${run.session_id ?? "(no-session)"}: ${run.status}${run.error ? ` - ${run.error}` : ""}`);
        }
      }
      console.log(`Capacity: ${result.snapshot.capacity.running}/${result.snapshot.capacity.max_concurrent}`);
      return;
    }

    const { createSymphonyPreview } = await import("./symphony/preview.js");
    const result = await createSymphonyPreview({
      runtime,
      workflowPath: options.workflow,
      createWorkspace: options["no-create"] !== "true"
    });
    if (!result.workflow.ok) {
      console.error(`${result.workflow.error.code}: ${result.workflow.error.message}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Workflow: ${result.workflow.workflow.path}`);
    console.log(`Items: ${result.items.length}`);
    for (const session of result.sessions) {
      console.log("");
      console.log(`${session.session.session_id} ${session.session.objective}`);
      console.log(`  workspace: ${session.workspace_path}`);
      console.log(`  source: ${workItemDisplayName(session.session.source)}`);
      console.log(`  prompt: ${firstLine(session.prompt)}`);
    }
  } finally {
    runtime.dispose();
  }
}

async function runDoctorCommand(values: string[]): Promise<void> {
  const options = parseOptions(values);
  if (options.help === "true") {
    console.log("Usage: swarm doctor [workflow_path] [--workflow WORKFLOW.md] [--workspace <path>]");
    return;
  }
  const workflowPath = options.workflow ?? firstPositionalArg(values, new Set(["workspace", "workflow"]));
  const { buildDoctorReport } = await import("./doctor/report.js");
  const { SwarmRuntime } = await import("./runtime/runtime.js");
  const runtime = new SwarmRuntime({ workspace: options.workspace });
  try {
    const report = await buildDoctorReport({
      runtime,
      workflowPath,
      workspace: options.workspace
    });
    console.log(report.detail);
    if (!report.ok) {
      process.exitCode = 1;
    }
  } finally {
    runtime.dispose();
  }
}

async function runLogsCommand(values: string[]): Promise<void> {
  const options = parseOptions(values);
  if (options.help === "true") {
    console.log("Usage: swarm logs [latest|log_name] [--tail N] [--limit N]");
    return;
  }
  const { formatSwarmLogList, listSwarmLogs, readSwarmLogTail, resolveSwarmLog } = await import("./doctor/logs.js");
  const target = firstPositionalArg(values, new Set(["tail", "limit"]));
  const tailLines = parsePositiveIntegerOption(options, "tail");
  if (!target && tailLines === undefined) {
    console.log(formatSwarmLogList(listSwarmLogs(parsePositiveIntegerOption(options, "limit") ?? 20)));
    return;
  }
  const log = resolveSwarmLog(target);
  if (!log) {
    console.error(`No Swarm debug log matched: ${target ?? "latest"}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Log: ${log.path}`);
  console.log(`Updated: ${log.updatedAt}`);
  console.log(`Bytes: ${log.size}`);
  console.log("");
  console.log(readSwarmLogTail(log.path, tailLines ?? 120));
}

async function runLiveControlCommand(commandName: "reply" | "interrupt", values: string[]): Promise<void> {
  const options = parseOptions(values);
  const jsonOutput = parseBooleanOption(options.json);
  if (options.help === "true") {
    console.log(commandName === "reply"
      ? "Usage: swarm reply <message> [--gateway-url <url>] [--request-id <id>] [--json]"
      : "Usage: swarm interrupt [message] [--gateway-url <url>] [--request-id <id>] [--json]");
    return;
  }

  const positionals = collectPositionalsWithValueFlags(values, new Set(["gateway-url", "request-id"]));
  const message = positionals.join(" ").trim();
  if (commandName === "reply" && !message) {
    console.error("Usage: swarm reply <message> [--gateway-url <url>] [--request-id <id>] [--json]");
    process.exitCode = 1;
    return;
  }

  const {
    sendActiveInterruptViaGateway,
    sendActiveReplyViaGateway,
    isSessionGatewayControlError
  } = await import("./sessions/gateway-control.js");
  try {
    const report = commandName === "reply"
      ? await sendActiveReplyViaGateway({
          gatewayUrl: normalizeOptionalValue(options["gateway-url"]),
          requestId: normalizeOptionalValue(options["request-id"]),
          message
        })
      : await sendActiveInterruptViaGateway({
          gatewayUrl: normalizeOptionalValue(options["gateway-url"]),
          requestId: normalizeOptionalValue(options["request-id"]),
          message: message || undefined
        });
    console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
  } catch (error) {
    if (jsonOutput && isSessionGatewayControlError(error)) {
      console.log(JSON.stringify({
        action: commandName,
        gateway_url: error.gatewayUrl,
        session_id: error.sessionId,
        error: {
          status: error.status,
          message: error.message,
          body: error.body
        }
      }, null, 2));
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  }
}

async function runLiveStatusCommand(values: string[]): Promise<void> {
  const options = parseOptions(values);
  const jsonOutput = parseBooleanOption(options.json);
  if (options.help === "true") {
    console.log("Usage: swarm live [--gateway-url <url>] [--json]");
    return;
  }

  const positionals = collectPositionalsWithValueFlags(values, new Set(["gateway-url"]));
  if (positionals.length > 0) {
    console.error("Usage: swarm live [--gateway-url <url>] [--json]");
    process.exitCode = 1;
    return;
  }

  const {
    readActiveLiveStatusViaGateway,
    isSessionGatewayControlError
  } = await import("./sessions/gateway-control.js");
  try {
    const report = await readActiveLiveStatusViaGateway({
      gatewayUrl: normalizeOptionalValue(options["gateway-url"])
    });
    console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
  } catch (error) {
    if (jsonOutput && isSessionGatewayControlError(error)) {
      console.log(JSON.stringify({
        action: "live",
        gateway_url: error.gatewayUrl,
        session_id: error.sessionId,
        error: {
          status: error.status,
          message: error.message,
          body: error.body
        }
      }, null, 2));
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  }
}

async function runSessionsCommand(values: string[]): Promise<void> {
  const options = parseOptions(values);
  const jsonOutput = parseBooleanOption(options.json);
  const jsonlOutput = parseBooleanOption(options.jsonl);
  if (options.help === "true") {
    console.log("Usage: swarm sessions [list] [--limit N] [--workspace <path>] [--json]");
    console.log("       swarm sessions show [session_id|latest] [--workspace <path>] [--json]");
    console.log("       swarm sessions watch|attach <session_id|latest> [--gateway-url <url>] [--protocol runtime|work] [--workspace <path>] [--jsonl]");
    console.log("       swarm sessions resume <session_id|latest> [message] [--workspace <path>] [resume flags]");
    console.log("       swarm sessions continue [message] [--workspace <path>] [resume flags]");
    console.log("       swarm sessions execute <session_id|latest> [--gateway-url <url>] [--workspace <path>] [--json]");
    console.log("       swarm sessions fork <session_id|latest> [message] [--gateway-url <url>] [--workspace <path>] [--json]");
    console.log("       swarm sessions reply <session_id|latest> <message> [--gateway-url <url>] [--request-id <id>] [--workspace <path>] [--json]");
    console.log("       swarm sessions interrupt|stop|kill <session_id|latest> [message] [--gateway-url <url>] [--request-id <id>] [--workspace <path>] [--json]");
    console.log("       swarm ps [--limit N] [--workspace <path>] [--json]");
    return;
  }

  const positionals = collectPositionalsWithValueFlags(values, new Set([
    "workspace",
    "gateway-url",
    "request-id",
    "limit",
    "protocol"
  ]));
  let subcommand = positionals[0] ?? "list";
  if (subcommand === "attach") {
    subcommand = "watch";
  } else if (subcommand === "stop" || subcommand === "kill") {
    subcommand = "interrupt";
  }
  const implicitSelector = subcommand !== "list"
    && subcommand !== "show"
    && subcommand !== "watch"
    && subcommand !== "resume"
    && subcommand !== "continue"
    && subcommand !== "execute"
    && subcommand !== "fork"
    && subcommand !== "reply"
    && subcommand !== "interrupt";
  if (implicitSelector) {
    subcommand = "show";
  }

  if (subcommand === "resume") {
    const selector = positionals[1];
    if (!selector) {
      console.error("Usage: swarm sessions resume <session_id|latest> [message] [--workspace <path>] [resume flags]");
      process.exitCode = 1;
      return;
    }
    const { SwarmRuntime } = await import("./runtime/runtime.js");
    const { resolveSessionSelector } = await import("./sessions/report.js");
    const runtime = new SwarmRuntime({ workspace: options.workspace });
    let sessionId: string | undefined;
    try {
      const resolved = resolveSessionSelector(runtime, selector);
      if (!resolved.sessionId) {
        console.error(resolved.error ?? `Unknown session: ${selector}`);
        process.exitCode = 1;
        return;
      }
      sessionId = resolved.sessionId;
    } finally {
      runtime.dispose();
    }
    await runHeadless(["--resume", sessionId!, ...values.slice(2)]);
    return;
  }

  if (subcommand === "continue") {
    await runHeadless(["--continue", ...values.slice(1)]);
    return;
  }

  if (subcommand === "watch") {
    const selector = positionals[1];
    if (!selector) {
      console.error("Usage: swarm sessions watch|attach <session_id|latest> [--gateway-url <url>] [--protocol runtime|work] [--workspace <path>] [--jsonl]");
      process.exitCode = 1;
      return;
    }
    if (jsonOutput) {
      console.error("Use --jsonl with `swarm sessions watch`; --json is only supported by list/show and control commands.");
      process.exitCode = 1;
      return;
    }
    const { SwarmRuntime } = await import("./runtime/runtime.js");
    const { resolveSessionSelector } = await import("./sessions/report.js");
    const { isSessionWatchError, watchSessionViaGateway } = await import("./sessions/gateway-watch.js");
    const runtime = new SwarmRuntime({ workspace: options.workspace });
    try {
      const resolved = resolveSessionSelector(runtime, selector);
      if (!resolved.sessionId) {
        console.error(resolved.error ?? `Unknown session: ${selector}`);
        process.exitCode = 1;
        return;
      }
      await watchSessionViaGateway({
        gatewayUrl: normalizeOptionalValue(options["gateway-url"]),
        sessionId: resolved.sessionId,
        protocol: normalizeOptionalValue(options.protocol),
        jsonl: jsonlOutput,
        writeLine: (line) => process.stdout.write(`${line}\n`)
      });
      return;
    } catch (error) {
      if (jsonlOutput && isSessionWatchError(error)) {
        console.log(JSON.stringify({
          schema_version: "swarm.sessions.watch.v1",
          type: "watch_error",
          gateway_url: error.gatewayUrl,
          session_id: error.sessionId,
          error: {
            status: error.status,
            message: error.message,
            body: error.body
          }
        }));
      } else {
        console.error(error instanceof Error ? error.message : String(error));
      }
      process.exitCode = 1;
      return;
    } finally {
      runtime.dispose();
    }
  }

  if (subcommand === "execute" || subcommand === "fork" || subcommand === "reply" || subcommand === "interrupt") {
    const selector = positionals[1];
    const message = positionals.slice(2).join(" ").trim();
    if (!selector) {
      const messageUsage = subcommand === "reply"
        ? " <message>"
        : subcommand === "fork" || subcommand === "interrupt"
          ? " [message]"
          : "";
      const commandUsage = subcommand === "interrupt" ? "interrupt|stop|kill" : subcommand;
      console.error(`Usage: swarm sessions ${commandUsage} <session_id|latest>${messageUsage} [--gateway-url <url>] [--request-id <id>] [--workspace <path>] [--json]`);
      process.exitCode = 1;
      return;
    }
    if (subcommand === "reply" && !message) {
      console.error("Usage: swarm sessions reply <session_id|latest> <message> [--gateway-url <url>] [--request-id <id>] [--workspace <path>] [--json]");
      process.exitCode = 1;
      return;
    }
    const { SwarmRuntime } = await import("./runtime/runtime.js");
    const { resolveSessionSelector } = await import("./sessions/report.js");
    const {
      sendSessionExecuteViaGateway,
      sendSessionForkViaGateway,
      isSessionGatewayControlError,
      sendSessionInterruptViaGateway,
      sendSessionReplyViaGateway
    } = await import("./sessions/gateway-control.js");
    const runtime = new SwarmRuntime({ workspace: options.workspace });
    try {
      const resolved = resolveSessionSelector(runtime, selector);
      if (!resolved.sessionId) {
        console.error(resolved.error ?? `Unknown session: ${selector}`);
        process.exitCode = 1;
        return;
      }
      const report = subcommand === "reply"
          ? await sendSessionReplyViaGateway({
            gatewayUrl: normalizeOptionalValue(options["gateway-url"]),
            requestId: normalizeOptionalValue(options["request-id"]),
            sessionId: resolved.sessionId,
            message
          })
        : subcommand === "interrupt"
          ? await sendSessionInterruptViaGateway({
              gatewayUrl: normalizeOptionalValue(options["gateway-url"]),
              requestId: normalizeOptionalValue(options["request-id"]),
              sessionId: resolved.sessionId,
              message: message || undefined
            })
          : subcommand === "execute"
            ? await sendSessionExecuteViaGateway({
                gatewayUrl: normalizeOptionalValue(options["gateway-url"]),
                sessionId: resolved.sessionId
              })
            : await sendSessionForkViaGateway({
                gatewayUrl: normalizeOptionalValue(options["gateway-url"]),
                sessionId: resolved.sessionId,
                message: message || undefined
              });
      console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
      return;
    } catch (error) {
      if (jsonOutput && isSessionGatewayControlError(error)) {
        console.log(JSON.stringify({
          action: subcommand,
          gateway_url: error.gatewayUrl,
          session_id: error.sessionId,
          error: {
            status: error.status,
            message: error.message,
            body: error.body
          }
        }, null, 2));
      } else {
        console.error(error instanceof Error ? error.message : String(error));
      }
      process.exitCode = 1;
      return;
    } finally {
      runtime.dispose();
    }
  }

  const { SwarmRuntime } = await import("./runtime/runtime.js");
  const { buildSessionDetailReport, buildSessionListReport } = await import("./sessions/report.js");
  const runtime = new SwarmRuntime({ workspace: options.workspace });
  try {
    if (subcommand === "list") {
      const report = buildSessionListReport(runtime, {
        limit: parsePositiveIntegerOption(options, "limit")
      });
      console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
      return;
    }

    const selector = implicitSelector ? positionals[0] : positionals[1];
    const report = buildSessionDetailReport(runtime, selector);
    console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    runtime.dispose();
  }
}

async function runPluginsCommand(values: string[]): Promise<void> {
  const options = parseOptions(values);
  if (options.help === "true") {
    console.log("Usage: swarm plugins [list] [--workspace <path>] [--json]");
    console.log("       swarm plugins show <plugin_id> [--workspace <path>] [--json]");
    console.log("       swarm plugins install <root_path> [--workspace <path>] [--json]");
    console.log("       swarm plugins remove-root <root_path> [--workspace <path>] [--json]");
    console.log("       swarm plugins refresh [--workspace <path>] [--json]");
    console.log("       swarm plugins update [--workspace <path>] [--json]");
    console.log("       swarm plugins enable <plugin_id> [--workspace <path>] [--json]");
    console.log("       swarm plugins disable <plugin_id> [--workspace <path>] [--json]");
    console.log("       swarm plugins validate [plugin_id] [--workspace <path>] [--json]");
    return;
  }

  const positionals = collectPositionals(values);
  let subcommand = positionals[0] ?? "list";
  const implicitSelector = subcommand !== "list"
    && subcommand !== "show"
    && subcommand !== "install"
    && subcommand !== "remove-root"
    && subcommand !== "refresh"
    && subcommand !== "update"
    && subcommand !== "enable"
    && subcommand !== "disable"
    && subcommand !== "validate";
  if (implicitSelector) {
    subcommand = "show";
  }

  const jsonOutput = parseBooleanOption(options.json);
  const { installPluginRoot, removePluginRoot, setPluginEnabled } = await import("./config/settings.js");
  const { SwarmRuntime } = await import("./runtime/runtime.js");
  const {
    buildPluginDetailReport,
    buildPluginListReport,
    buildPluginValidationReport,
    resolvePluginSelector
  } = await import("./extensions/plugin-report.js");
  const runtime = new SwarmRuntime({ workspace: options.workspace });
  try {
    if (subcommand === "list") {
      const report = buildPluginListReport(runtime);
      console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
      return;
    }

    if (subcommand === "show") {
      const selector = implicitSelector ? positionals[0] : positionals[1];
      if (!selector) {
        console.error("Usage: swarm plugins show <plugin_id> [--workspace <path>] [--json]");
        process.exitCode = 1;
        return;
      }
      const report = await buildPluginDetailReport(runtime, selector);
      console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
      return;
    }

    if (subcommand === "validate") {
      const selector = positionals[1];
      const report = buildPluginValidationReport(runtime, selector);
      console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
      if (report.ok === false) {
        process.exitCode = 1;
      }
      return;
    }

    if (subcommand === "install" || subcommand === "remove-root") {
      const root = positionals[1];
      if (!root) {
        console.error(`Usage: swarm plugins ${subcommand} <root_path> [--workspace <path>] [--json]`);
        process.exitCode = 1;
        return;
      }
      if (subcommand === "install") {
        installPluginRoot(root);
      } else {
        removePluginRoot(root);
      }
      runtime.reloadSettings();
      await runtime.refreshCapabilities();
      const report = buildPluginListReport(runtime);
      const data = {
        action: subcommand,
        root_path: resolvePath(root),
        ...report.data
      };
      if (jsonOutput) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(`Plugin root ${subcommand === "install" ? "installed" : "removed"}: ${resolvePath(root)}`);
        console.log("");
        console.log(report.detail);
      }
      return;
    }

    if (subcommand === "refresh" || subcommand === "update") {
      runtime.reloadSettings();
      await runtime.refreshCapabilities();
      const report = buildPluginListReport(runtime);
      const data = {
        action: subcommand,
        ...report.data
      };
      if (jsonOutput) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log("Plugin catalog refreshed.");
        console.log("");
        console.log(report.detail);
      }
      return;
    }

    if (subcommand === "enable" || subcommand === "disable") {
      const selector = positionals[1];
      if (!selector) {
        console.error(`Usage: swarm plugins ${subcommand} <plugin_id> [--workspace <path>] [--json]`);
        process.exitCode = 1;
        return;
      }
      const resolution = resolvePluginSelector(runtime, selector);
      if (!resolution.pluginId) {
        console.error(resolution.error ?? `Unknown plugin: ${selector}`);
        process.exitCode = 1;
        return;
      }
      setPluginEnabled(resolution.pluginId, subcommand === "enable");
      runtime.reloadSettings();
      await runtime.refreshCapabilities();
      const report = await buildPluginDetailReport(runtime, resolution.pluginId);
      const data = {
        action: subcommand,
        ...report.data
      };
      if (jsonOutput) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(`Plugin ${resolution.pluginId} ${subcommand === "enable" ? "enabled" : "disabled"}.`);
        console.log("");
        console.log(report.detail);
      }
      return;
    }

    console.error(`Unknown plugins command: ${subcommand}`);
    process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    runtime.dispose();
  }
}

async function runCapabilitiesCommand(values: string[]): Promise<void> {
  const options = parseOptions(values);
  const positionals = collectPositionalsWithValueFlags(values, new Set([
    "workspace",
    "kind",
    "provider",
    "provider-id",
    "query",
    "session",
    "write-policy",
    "file-scope"
  ]));
  if (options.help === "true") {
    console.log("Usage: swarm capabilities [list] [kind:<kind>|provider:<provider>|query...] [--all] [--include-disabled] [--workspace <path>] [--json]");
    console.log("       swarm capabilities show <capability_id> [--workspace <path>] [--json]");
    console.log("       swarm capabilities refresh [provider_id] [kind:<kind>|provider:<provider>|query...] [--all] [--include-disabled] [--workspace <path>] [--json]");
    console.log("       swarm capabilities enable <capability_id> [--workspace <path>] [--json]");
    console.log("       swarm capabilities disable <capability_id> [--workspace <path>] [--json]");
    console.log("       swarm capabilities hide <capability_id> [--workspace <path>] [--json]");
    console.log("       swarm capabilities unhide <capability_id> [--workspace <path>] [--json]");
    console.log("       swarm capabilities invoke <capability_id> [key=value...] [--session <session_id>] [--write-policy workspace_write|scoped_write|read_only] [--file-scope path1,path2] [--workspace <path>] [--json]");
    return;
  }

  let subcommand = positionals[0] ?? "list";
  let listAll = parseBooleanOption(options.all);
  let implicitSelector = false;
  if (subcommand === "all") {
    subcommand = "list";
    listAll = true;
  } else if (looksLikeCapabilityFilterToken(subcommand)) {
    subcommand = "list";
  } else if (
    subcommand !== "list"
    && subcommand !== "show"
    && subcommand !== "refresh"
    && subcommand !== "enable"
    && subcommand !== "disable"
    && subcommand !== "hide"
    && subcommand !== "unhide"
    && subcommand !== "invoke"
  ) {
    subcommand = "show";
    implicitSelector = true;
  }

  const jsonOutput = parseBooleanOption(options.json);
  const { setCapabilityEnabled, setCapabilityModelVisible } = await import("./config/settings.js");
  const { SwarmRuntime } = await import("./runtime/runtime.js");
  const {
    buildCapabilityDetailReport,
    buildCapabilityInvocationReport,
    buildCapabilityListReport,
    hasCapabilityCliFilter,
    resolveCapabilitySelector
  } = await import("./extensions/capability-report.js");
  const runtime = new SwarmRuntime({ workspace: options.workspace });
  try {
    if (subcommand === "list") {
      const listTokens = looksLikeCapabilityFilterToken(positionals[0] ?? "") ? positionals : positionals.slice(1);
      const filter = parseCapabilityCliFilter(listTokens, options);
      const report = await buildCapabilityListReport(runtime, {
        filter,
        includeDisabled: parseBooleanOption(options["include-disabled"]),
        advanced: listAll || hasCapabilityCliFilter(filter)
      });
      console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
      return;
    }

    if (subcommand === "refresh") {
      const refreshTokens = positionals.slice(1);
      const providerId = refreshTokens[0] && !looksLikeCapabilityFilterToken(refreshTokens[0]) ? refreshTokens[0] : undefined;
      const filter = parseCapabilityCliFilter(providerId ? refreshTokens.slice(1) : refreshTokens, options);
      runtime.reloadSettings();
      const providers = await runtime.refreshCapabilities(providerId);
      const report = await buildCapabilityListReport(runtime, {
        filter,
        includeDisabled: parseBooleanOption(options["include-disabled"]),
        advanced: listAll || hasCapabilityCliFilter(filter)
      });
      const data = {
        action: "refresh",
        provider_id: providerId,
        refreshed_providers: providers,
        ...report.data
      };
      if (jsonOutput) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(providerId ? `Capability provider refreshed: ${providerId}` : "Capability providers refreshed.");
        console.log("");
        console.log(report.detail);
      }
      return;
    }

    const selector = implicitSelector ? positionals[0] : positionals[1];
    if (!selector) {
      console.error(`Usage: swarm capabilities ${subcommand} <capability_id> [--workspace <path>] [--json]`);
      process.exitCode = 1;
      return;
    }

    if (subcommand === "show") {
      const report = await buildCapabilityDetailReport(runtime, selector);
      console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
      return;
    }

    if (subcommand === "enable" || subcommand === "disable" || subcommand === "hide" || subcommand === "unhide") {
      const resolution = await resolveCapabilitySelector(runtime, selector);
      if (!resolution.capabilityId) {
        console.error(resolution.error ?? `Unknown capability: ${selector}`);
        process.exitCode = 1;
        return;
      }
      if (subcommand === "enable" || subcommand === "disable") {
        setCapabilityEnabled(resolution.capabilityId, subcommand === "enable");
      } else {
        setCapabilityModelVisible(resolution.capabilityId, subcommand === "unhide");
      }
      runtime.reloadSettings();
      await runtime.refreshCapabilities();
      const report = await buildCapabilityDetailReport(runtime, resolution.capabilityId);
      const data = {
        action: subcommand,
        ...report.data
      };
      if (jsonOutput) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(`Capability ${resolution.capabilityId} ${subcommand === "enable"
          ? "enabled"
          : subcommand === "disable"
            ? "disabled"
            : subcommand === "hide"
              ? "hidden from model"
              : "restored to model visibility"}.`);
        console.log("");
        console.log(report.detail);
      }
      return;
    }

    if (subcommand === "invoke") {
      const args = parseStructuredKeyValueArgs(positionals.slice(2));
      const report = await buildCapabilityInvocationReport(runtime, selector, args, {
        sessionId: normalizeOptionalValue(options.session),
        writePolicy: parseCapabilityWritePolicy(options["write-policy"], parseBooleanOption(options["read-only"])),
        fileScope: parseCommaSeparatedOption(options["file-scope"])
      });
      console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
      const result = report.data.result as { status?: string } | undefined;
      if (result?.status === "failed") {
        process.exitCode = 1;
      }
      return;
    }

    console.error(`Unknown capabilities command: ${subcommand}`);
    process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    runtime.dispose();
  }
}

async function runApprovalsCommand(values: string[]): Promise<void> {
  const options = parseOptions(values);
  if (options.help === "true") {
    console.log("Usage: swarm approvals [list] [--session <session_id|latest>] [--status pending|approved|denied] [--limit N] [--gateway-url <url>] [--workspace <path>] [--json]");
    console.log("       swarm approvals show <approval_id|latest> [--session <session_id|latest>] [--gateway-url <url>] [--workspace <path>] [--json]");
    console.log("       swarm approvals pending [--session <session_id|latest>] [--limit N] [--gateway-url <url>] [--workspace <path>] [--json]");
    console.log("       swarm approvals approve <approval_id|latest> [--session <session_id|latest>] [--gateway-url <url>] [--workspace <path>] [--json]");
    console.log("       swarm approvals deny <approval_id|latest> [--session <session_id|latest>] [--gateway-url <url>] [--workspace <path>] [--json]");
    return;
  }

  const positionals = collectPositionalsWithValueFlags(values, new Set([
    "workspace",
    "session",
    "status",
    "limit",
    "gateway-url"
  ]));
  let subcommand = positionals[0] ?? "list";
  const implicitSelector = subcommand !== "list"
    && subcommand !== "show"
    && subcommand !== "pending"
    && subcommand !== "approve"
    && subcommand !== "deny";
  if (implicitSelector) {
    subcommand = "show";
  }

  const jsonOutput = parseBooleanOption(options.json);
  const { SwarmRuntime } = await import("./runtime/runtime.js");
  const {
    buildApprovalDetailReport,
    buildApprovalListReport,
    decideApprovalLocally,
    parseApprovalStatus,
    resolveApprovalSelector
  } = await import("./approvals/report.js");
  const { resolveSessionSelector } = await import("./sessions/report.js");
  const {
    decideApprovalViaGateway,
    isApprovalGatewayError,
    listApprovalsViaGateway,
    showApprovalViaGateway
  } = await import("./approvals/gateway-control.js");
  const runtime = new SwarmRuntime({ workspace: options.workspace });
  const resolveApprovalId = (selector: string, sessionSelector?: string, pendingOnly = false): string => {
    const resolution = resolveApprovalSelector(runtime, selector, { sessionSelector, pendingOnly });
    if (!resolution.approvalId) {
      throw new Error(resolution.error ?? `Unknown approval: ${selector}`);
    }
    return resolution.approvalId;
  };
  const resolveScopedSessionId = (selector?: string): string | undefined => {
    const normalized = normalizeOptionalValue(selector);
    if (!normalized) {
      return undefined;
    }
    const resolution = resolveSessionSelector(runtime, normalized);
    if (!resolution.sessionId) {
      throw new Error(resolution.error ?? `Unknown session: ${normalized}`);
    }
    return resolution.sessionId;
  };
  try {
    if (subcommand === "list") {
      const sessionSelector = normalizeOptionalValue(options.session);
      const report = normalizeOptionalValue(options["gateway-url"]) || process.env.SWARM_GATEWAY_URL?.trim()
        ? await listApprovalsViaGateway({
            gatewayUrl: normalizeOptionalValue(options["gateway-url"]),
            sessionId: resolveScopedSessionId(sessionSelector),
            limit: parsePositiveIntegerOption(options, "limit"),
            status: parseApprovalStatus(options.status)
          })
        : buildApprovalListReport(runtime, {
            limit: parsePositiveIntegerOption(options, "limit"),
            sessionSelector,
            status: parseApprovalStatus(options.status)
          });
      console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
      return;
    }

    if (subcommand === "pending") {
      const sessionSelector = normalizeOptionalValue(options.session);
      const report = normalizeOptionalValue(options["gateway-url"]) || process.env.SWARM_GATEWAY_URL?.trim()
        ? await listApprovalsViaGateway({
            gatewayUrl: normalizeOptionalValue(options["gateway-url"]),
            sessionId: resolveScopedSessionId(sessionSelector),
            limit: parsePositiveIntegerOption(options, "limit"),
            status: "pending"
          })
        : buildApprovalListReport(runtime, {
            limit: parsePositiveIntegerOption(options, "limit"),
            sessionSelector,
            status: "pending"
          });
      console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
      return;
    }

    const selector = implicitSelector ? positionals[0] : positionals[1];
    if (!selector) {
      console.error(`Usage: swarm approvals ${subcommand} <approval_id|latest> [--session <session_id|latest>] [--workspace <path>] [--json]`);
      process.exitCode = 1;
      return;
    }

    if (subcommand === "show") {
      const sessionSelector = normalizeOptionalValue(options.session);
      const report = normalizeOptionalValue(options["gateway-url"]) || process.env.SWARM_GATEWAY_URL?.trim()
        ? await showApprovalViaGateway({
            gatewayUrl: normalizeOptionalValue(options["gateway-url"]),
            approvalId: resolveApprovalId(selector, sessionSelector)
          })
        : buildApprovalDetailReport(runtime, selector, {
            sessionSelector
          });
      console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
      return;
    }

    if (subcommand === "approve" || subcommand === "deny") {
      const approvalId = resolveApprovalId(selector, normalizeOptionalValue(options.session), true);
      const approved = subcommand === "approve";
      const gatewayUrl = normalizeOptionalValue(options["gateway-url"]) || process.env.SWARM_GATEWAY_URL?.trim();
      const report = gatewayUrl
        ? await decideApprovalViaGateway({
            gatewayUrl,
            approvalId,
            approved
          })
        : decideApprovalLocally(runtime, approvalId, {
            approved,
            sessionSelector: normalizeOptionalValue(options.session)
          });
      console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
      return;
    }

    console.error(`Unknown approvals command: ${subcommand}`);
    process.exitCode = 1;
  } catch (error) {
    if (jsonOutput && isApprovalGatewayError(error)) {
      console.log(JSON.stringify({
        gateway_url: error.gatewayUrl,
        approval_id: error.approvalId,
        error: {
          status: error.status,
          message: error.message,
          body: error.body
        }
      }, null, 2));
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  } finally {
    runtime.dispose();
  }
}

async function runRunsCommand(values: string[]): Promise<void> {
  const options = parseOptions(values);
  if (options.help === "true") {
    console.log("Usage: swarm runs [list] [--gateway-url <url>] [--json]");
    console.log("       swarm runs show <run_id|latest> [--gateway-url <url>] [--json]");
    console.log("       swarm runs watch [run_id|latest] [--gateway-url <url>] [--protocol runtime|work] [--jsonl]");
    return;
  }

  const positionals = collectPositionalsWithValueFlags(values, new Set([
    "gateway-url",
    "protocol"
  ]));
  let subcommand = positionals[0] ?? "list";
  const implicitSelector = subcommand !== "list" && subcommand !== "show" && subcommand !== "watch";
  if (implicitSelector) {
    subcommand = "show";
  }

  const jsonOutput = parseBooleanOption(options.json);
  const jsonlOutput = parseBooleanOption(options.jsonl);
  const {
    isRunGatewayError,
    listRunsViaGateway,
    showRunViaGateway
  } = await import("./runs/gateway-report.js");
  const {
    isRunWatchError,
    watchRunViaGateway
  } = await import("./runs/gateway-watch.js");
  try {
    if (subcommand === "list") {
      const report = await listRunsViaGateway({
        gatewayUrl: normalizeOptionalValue(options["gateway-url"])
      });
      console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
      return;
    }

    if (subcommand === "watch") {
      if (jsonOutput) {
        console.error("Use --jsonl with `swarm runs watch`; --json is only supported by list/show.");
        process.exitCode = 1;
        return;
      }
      await watchRunViaGateway({
        gatewayUrl: normalizeOptionalValue(options["gateway-url"]),
        selector: positionals[1] ?? "latest",
        protocol: normalizeOptionalValue(options.protocol),
        jsonl: jsonlOutput,
        writeLine: (line) => process.stdout.write(`${line}\n`)
      });
      return;
    }

    const selector = implicitSelector ? positionals[0] : positionals[1];
    if (!selector) {
      console.error("Usage: swarm runs show <run_id|latest> [--gateway-url <url>] [--json]");
      process.exitCode = 1;
      return;
    }
    const report = await showRunViaGateway({
      gatewayUrl: normalizeOptionalValue(options["gateway-url"]),
      selector
    });
    console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
  } catch (error) {
    if (jsonOutput && isRunGatewayError(error)) {
      console.log(JSON.stringify({
        gateway_url: error.gatewayUrl,
        run_id: error.runId,
        error: {
          status: error.status,
          message: error.message,
          body: error.body
        }
      }, null, 2));
    } else if (jsonlOutput && isRunWatchError(error)) {
      console.log(JSON.stringify({
        schema_version: "swarm.runs.watch.v1",
        type: "watch_error",
        gateway_url: error.gatewayUrl,
        run_id: error.runId,
        error: {
          status: error.status,
          message: error.message,
          body: error.body
        }
      }));
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  }
}

async function runCheckpointsCommand(values: string[]): Promise<void> {
  const options = parseOptions(values);
  if (options.help === "true") {
    console.log("Usage: swarm checkpoints [list] [--workspace <path>] [--json]");
    console.log("       swarm checkpoints create <name> [--reason <text>] [--workspace <path>] [--json]");
    console.log("       swarm checkpoints revert [checkpoint_id|last] [--workspace <path>] [--json]");
    return;
  }

  const positionals = collectPositionalsWithValueFlags(values, new Set(["workspace", "reason"]));
  const subcommand = positionals[0] ?? "list";
  const jsonOutput = parseBooleanOption(options.json);
  const workspace = options.workspace ?? process.cwd();
  const { SwarmRuntime } = await import("./runtime/runtime.js");
  const runtime = new SwarmRuntime({ workspace });
  try {
    if (subcommand === "list") {
      const checkpoints = await runtime.listCheckpoints(parsePositiveIntegerOption(options, "limit") ?? 20);
      const data = { workspace, checkpoints };
      if (jsonOutput) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(formatCheckpointList(workspace, checkpoints));
      }
      return;
    }

    if (subcommand === "create") {
      const name = positionals.slice(1).join(" ").trim();
      if (!name) {
        console.error("Usage: swarm checkpoints create <name> [--reason <text>] [--workspace <path>] [--json]");
        process.exitCode = 1;
        return;
      }
      const checkpoint = await runtime.createCheckpoint(name, normalizeOptionalValue(options.reason));
      const data = { workspace, checkpoint };
      if (jsonOutput) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(`Checkpoint created: ${checkpoint.name} (${checkpoint.id})`);
      }
      return;
    }

    if (subcommand === "revert") {
      const selector = positionals[1];
      const checkpoint = await runtime.revertCheckpoint(!selector || selector === "last" ? undefined : selector);
      if (!checkpoint) {
        console.error("No checkpoint found to revert.");
        process.exitCode = 1;
        return;
      }
      const data = { workspace, checkpoint };
      if (jsonOutput) {
        console.log(JSON.stringify(data, null, 2));
      } else if (checkpoint.status === "missing") {
        console.log(`Checkpoint missing: ${checkpoint.name} (${checkpoint.id})`);
      } else {
        console.log(`Reverted checkpoint: ${checkpoint.name} (${checkpoint.id})`);
      }
      return;
    }

    console.error(`Unknown checkpoints command: ${subcommand}`);
    process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    runtime.dispose();
  }
}

function formatCheckpointList(workspace: string, checkpoints: Array<{
  id: string;
  name: string;
  mode: string;
  status: string;
  revertAvailable: boolean;
}>): string {
  return [
    "Swarm Checkpoints",
    `workspace=${workspace}`,
    `summary total=${checkpoints.length}`,
    "",
    ...(checkpoints.length === 0
      ? ["No checkpoints recorded."]
      : checkpoints.map((checkpoint) =>
          `${checkpoint.id} [${checkpoint.status}/${checkpoint.mode}] ${checkpoint.name} revert=${checkpoint.revertAvailable ? "yes" : "no"}`
        ))
  ].join("\n");
}

async function runWatchCommand(values: string[]): Promise<void> {
  const options = parseOptions(values);
  if (options.help === "true") {
    console.log("Usage: swarm watch [--gateway-url <url>] [--protocol runtime|work] [--jsonl]");
    return;
  }

  const positionals = collectPositionalsWithValueFlags(values, new Set([
    "gateway-url",
    "protocol"
  ]));
  if (positionals.length > 0) {
    console.error("Usage: swarm watch [--gateway-url <url>] [--protocol runtime|work] [--jsonl]");
    process.exitCode = 1;
    return;
  }

  const jsonOutput = parseBooleanOption(options.json);
  const jsonlOutput = parseBooleanOption(options.jsonl);
  const {
    isWorkspaceWatchError,
    watchWorkspaceViaGateway
  } = await import("./watch/gateway-watch.js");
  try {
    if (jsonOutput) {
      console.error("Use --jsonl with `swarm watch`; --json is not supported for live event streams.");
      process.exitCode = 1;
      return;
    }
    await watchWorkspaceViaGateway({
      gatewayUrl: normalizeOptionalValue(options["gateway-url"]),
      protocol: normalizeOptionalValue(options.protocol),
      jsonl: jsonlOutput,
      writeLine: (line) => process.stdout.write(`${line}\n`)
    });
  } catch (error) {
    if (jsonlOutput && isWorkspaceWatchError(error)) {
      console.log(JSON.stringify({
        schema_version: "swarm.watch.v1",
        type: "watch_error",
        gateway_url: error.gatewayUrl,
        scope: "workspace",
        error: {
          status: error.status,
          message: error.message,
          body: error.body
        }
      }));
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  }
}

async function runWorkersCommand(values: string[]): Promise<void> {
  const options = parseOptions(values);
  if (options.help === "true") {
    console.log("Usage: swarm workers [list] [--session <session_id|latest>] [--limit N] [--workspace <path>] [--json]");
    console.log("       swarm workers show <worker_id|latest> [--session <session_id|latest>] [--workspace <path>] [--json]");
    console.log("       swarm workers watch <worker_id|latest> [--session <session_id|latest>] [--gateway-url <url>] [--protocol runtime|work] [--workspace <path>] [--jsonl]");
    console.log("       swarm workers stop <worker_id|latest> [--session <session_id|latest>] [--gateway-url <url>] [--workspace <path>] [--json]");
    console.log("       swarm workers continue <worker_id|latest> <message> [--session <session_id|latest>] [--gateway-url <url>] [--workspace <path>] [--json]");
    return;
  }

  const positionals = collectPositionalsWithValueFlags(values, new Set([
    "workspace",
    "session",
    "limit",
    "gateway-url",
    "protocol"
  ]));
  let subcommand = positionals[0] ?? "list";
  const implicitSelector = subcommand !== "list"
    && subcommand !== "show"
    && subcommand !== "watch"
    && subcommand !== "stop"
    && subcommand !== "continue";
  if (implicitSelector) {
    subcommand = "show";
  }

  const jsonOutput = parseBooleanOption(options.json);
  const jsonlOutput = parseBooleanOption(options.jsonl);
  const { SwarmRuntime } = await import("./runtime/runtime.js");
  const {
    buildWorkerDetailReport,
    buildWorkerListReport,
    resolveWorkerSelector
  } = await import("./workers/report.js");
  const {
    continueWorkerViaGateway,
    isWorkerGatewayControlError,
    stopWorkerViaGateway
  } = await import("./workers/gateway-control.js");
  const {
    isWorkerWatchError,
    watchWorkerViaGateway
  } = await import("./workers/gateway-watch.js");
  const runtime = new SwarmRuntime({ workspace: options.workspace });
  const resolveWorkerId = (selector: string, sessionSelector?: string): string => {
    const resolution = resolveWorkerSelector(runtime, selector, { sessionSelector });
    if (!resolution.workerId) {
      throw new Error(resolution.error ?? `Unknown worker: ${selector}`);
    }
    return resolution.workerId;
  };
  const resolveWorkerRecord = (selector: string, sessionSelector?: string) => {
    const workerId = resolveWorkerId(selector, sessionSelector);
    const worker = runtime.workerStateStore.get(workerId);
    if (!worker) {
      throw new Error(`Unknown worker: ${workerId}`);
    }
    return worker;
  };
  try {
    if (subcommand === "list") {
      const report = buildWorkerListReport(runtime, {
        limit: parsePositiveIntegerOption(options, "limit"),
        sessionSelector: normalizeOptionalValue(options.session)
      });
      console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
      return;
    }

    const selector = implicitSelector ? positionals[0] : positionals[1];
    if (!selector) {
      console.error(subcommand === "watch"
        ? "Usage: swarm workers watch <worker_id|latest> [--session <session_id|latest>] [--gateway-url <url>] [--protocol runtime|work] [--workspace <path>] [--jsonl]"
        : `Usage: swarm workers ${subcommand} <worker_id|latest>${subcommand === "continue" ? " <message>" : ""} [--session <session_id|latest>] [--workspace <path>] [--json]`);
      process.exitCode = 1;
      return;
    }

    if (subcommand === "show") {
      const report = buildWorkerDetailReport(runtime, selector, {
        sessionSelector: normalizeOptionalValue(options.session)
      });
      console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
      return;
    }

    if (subcommand === "watch") {
      if (jsonOutput) {
        console.error("Use --jsonl with `swarm workers watch`; --json is only supported by list/show and control commands.");
        process.exitCode = 1;
        return;
      }
      await watchWorkerViaGateway({
        gatewayUrl: normalizeOptionalValue(options["gateway-url"]),
        worker: resolveWorkerRecord(selector, normalizeOptionalValue(options.session)),
        protocol: normalizeOptionalValue(options.protocol),
        jsonl: jsonlOutput,
        writeLine: (line) => process.stdout.write(`${line}\n`)
      });
      return;
    }

    if (subcommand === "stop") {
      const report = await stopWorkerViaGateway({
        gatewayUrl: normalizeOptionalValue(options["gateway-url"]),
        workerId: resolveWorkerId(selector, normalizeOptionalValue(options.session))
      });
      console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
      return;
    }

    if (subcommand === "continue") {
      const message = positionals.slice(2).join(" ").trim();
      if (!message) {
        console.error("Usage: swarm workers continue <worker_id|latest> <message> [--session <session_id|latest>] [--gateway-url <url>] [--workspace <path>] [--json]");
        process.exitCode = 1;
        return;
      }
      const report = await continueWorkerViaGateway({
        gatewayUrl: normalizeOptionalValue(options["gateway-url"]),
        workerId: resolveWorkerId(selector, normalizeOptionalValue(options.session)),
        message
      });
      console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
      return;
    }

    console.error(`Unknown workers command: ${subcommand}`);
    process.exitCode = 1;
  } catch (error) {
    if (jsonOutput && isWorkerGatewayControlError(error)) {
      console.log(JSON.stringify({
        gateway_url: error.gatewayUrl,
        worker_id: error.workerId,
        error: {
          status: error.status,
          message: error.message,
          body: error.body
        }
      }, null, 2));
    } else if (jsonlOutput && isWorkerWatchError(error)) {
      console.log(JSON.stringify({
        schema_version: "swarm.workers.watch.v1",
        type: "watch_error",
        gateway_url: error.gatewayUrl,
        worker_id: error.workerId,
        error: {
          status: error.status,
          message: error.message,
          body: error.body
        }
      }));
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  } finally {
    runtime.dispose();
  }
}

async function runHandoffsCommand(values: string[]): Promise<void> {
  const options = parseOptions(values);
  if (options.help === "true") {
    console.log("Usage: swarm handoffs [list] [--session <session_id|latest>] [--limit N] [--workspace <path>] [--json]");
    console.log("       swarm handoffs show <handoff_id|latest> [--session <session_id|latest>] [--workspace <path>] [--json]");
    console.log("       swarm handoffs watch <handoff_id|latest> [--session <session_id|latest>] [--gateway-url <url>] [--protocol runtime|work] [--workspace <path>] [--jsonl]");
    console.log("       swarm handoffs take-back <handoff_id|latest> [--session <session_id|latest>] [--gateway-url <url>] [--workspace <path>] [--json]");
    return;
  }

  const positionals = collectPositionalsWithValueFlags(values, new Set([
    "workspace",
    "session",
    "limit",
    "gateway-url",
    "protocol"
  ]));
  let subcommand = positionals[0] ?? "list";
  const implicitSelector = subcommand !== "list"
    && subcommand !== "show"
    && subcommand !== "watch"
    && subcommand !== "take-back";
  if (implicitSelector) {
    subcommand = "show";
  }

  const jsonOutput = parseBooleanOption(options.json);
  const jsonlOutput = parseBooleanOption(options.jsonl);
  const { SwarmRuntime } = await import("./runtime/runtime.js");
  const {
    buildHandoffDetailReport,
    buildHandoffListReport,
    resolveHandoffSelector
  } = await import("./handoffs/report.js");
  const {
    isHandoffGatewayControlError,
    takeBackHandoffViaGateway
  } = await import("./handoffs/gateway-control.js");
  const {
    isHandoffWatchError,
    watchHandoffViaGateway
  } = await import("./handoffs/gateway-watch.js");
  const runtime = new SwarmRuntime({ workspace: options.workspace });
  const resolveHandoffId = (selector: string, sessionSelector?: string): string => {
    const resolution = resolveHandoffSelector(runtime, selector, { sessionSelector });
    if (!resolution.handoffId) {
      throw new Error(resolution.error ?? `Unknown handoff: ${selector}`);
    }
    return resolution.handoffId;
  };
  const resolveHandoffRecord = (selector: string, sessionSelector?: string) => {
    const handoffId = resolveHandoffId(selector, sessionSelector);
    const handoff = runtime.getHandoff(handoffId);
    if (!handoff) {
      throw new Error(`Unknown handoff: ${handoffId}`);
    }
    return handoff;
  };
  try {
    if (subcommand === "list") {
      const report = buildHandoffListReport(runtime, {
        limit: parsePositiveIntegerOption(options, "limit"),
        sessionSelector: normalizeOptionalValue(options.session)
      });
      console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
      return;
    }

    const selector = implicitSelector ? positionals[0] : positionals[1];
    if (!selector) {
      console.error(subcommand === "watch"
        ? "Usage: swarm handoffs watch <handoff_id|latest> [--session <session_id|latest>] [--gateway-url <url>] [--protocol runtime|work] [--workspace <path>] [--jsonl]"
        : `Usage: swarm handoffs ${subcommand} <handoff_id|latest> [--session <session_id|latest>] [--workspace <path>] [--json]`);
      process.exitCode = 1;
      return;
    }

    if (subcommand === "show") {
      const report = buildHandoffDetailReport(runtime, selector, {
        sessionSelector: normalizeOptionalValue(options.session)
      });
      console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
      return;
    }

    if (subcommand === "watch") {
      if (jsonOutput) {
        console.error("Use --jsonl with `swarm handoffs watch`; --json is only supported by list/show and control commands.");
        process.exitCode = 1;
        return;
      }
      const handoff = resolveHandoffRecord(selector, normalizeOptionalValue(options.session));
      await watchHandoffViaGateway({
        gatewayUrl: normalizeOptionalValue(options["gateway-url"]),
        handoff,
        worker: runtime.workerStateStore.get(handoff.worker_id),
        protocol: normalizeOptionalValue(options.protocol),
        jsonl: jsonlOutput,
        writeLine: (line) => process.stdout.write(`${line}\n`)
      });
      return;
    }

    if (subcommand === "take-back") {
      const report = await takeBackHandoffViaGateway({
        gatewayUrl: normalizeOptionalValue(options["gateway-url"]),
        handoffId: resolveHandoffId(selector, normalizeOptionalValue(options.session))
      });
      console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
      return;
    }

    console.error(`Unknown handoffs command: ${subcommand}`);
    process.exitCode = 1;
  } catch (error) {
    if (jsonOutput && isHandoffGatewayControlError(error)) {
      console.log(JSON.stringify({
        gateway_url: error.gatewayUrl,
        handoff_id: error.handoffId,
        error: {
          status: error.status,
          message: error.message,
          body: error.body
        }
      }, null, 2));
    } else if (jsonlOutput && isHandoffWatchError(error)) {
      console.log(JSON.stringify({
        schema_version: "swarm.handoffs.watch.v1",
        type: "watch_error",
        gateway_url: error.gatewayUrl,
        handoff_id: error.handoffId,
        error: {
          status: error.status,
          message: error.message,
          body: error.body
        }
      }));
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  } finally {
    runtime.dispose();
  }
}

async function runSkillsCommand(values: string[]): Promise<void> {
  const options = parseOptions(values);
  if (options.help === "true") {
    console.log("Usage: swarm skills [list] [--workspace <path>] [--json]");
    console.log("       swarm skills show <skill_name> [--workspace <path>] [--json]");
    console.log("       swarm skills activate <skill_name> [--session <session_id>] [--reason <text>] [--workspace <path>] [--json]");
    return;
  }

  const positionals = collectPositionals(values);
  let subcommand = positionals[0] ?? "list";
  const implicitSelector = subcommand !== "list"
    && subcommand !== "show"
    && subcommand !== "activate";
  if (implicitSelector) {
    subcommand = "show";
  }

  const jsonOutput = parseBooleanOption(options.json);
  const { SwarmRuntime } = await import("./runtime/runtime.js");
  const {
    buildSkillActivationReport,
    buildSkillDetailReport,
    buildSkillListReport
  } = await import("./extensions/skill-report.js");
  const runtime = new SwarmRuntime({ workspace: options.workspace });
  try {
    if (subcommand === "list") {
      const report = buildSkillListReport(runtime);
      console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
      return;
    }

    const selector = implicitSelector ? positionals[0] : positionals[1];
    if (!selector) {
      console.error(`Usage: swarm skills ${subcommand} <skill_name> [--workspace <path>] [--json]`);
      process.exitCode = 1;
      return;
    }

    if (subcommand === "show") {
      const report = await buildSkillDetailReport(runtime, selector);
      console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
      return;
    }

    if (subcommand === "activate") {
      const report = buildSkillActivationReport(runtime, selector, {
        sessionId: normalizeOptionalValue(options.session),
        reason: normalizeOptionalValue(options.reason)
      });
      console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
      return;
    }

    console.error(`Unknown skills command: ${subcommand}`);
    process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    runtime.dispose();
  }
}

async function runMcpCommand(values: string[]): Promise<void> {
  const options = parseOptions(values);
  if (options.help === "true") {
    console.log("Usage: swarm mcp [list] [--workspace <path>] [--json]");
    console.log("       swarm mcp show <server_id> [--workspace <path>] [--json]");
    console.log("       swarm mcp refresh <server_id> [--workspace <path>] [--json]");
    console.log("       swarm mcp resources <server_id> [--workspace <path>] [--json]");
    console.log("       swarm mcp read <server_id> <uri> [--session <session_id>] [--workspace <path>] [--json]");
    console.log("       swarm mcp prompts <server_id> [--workspace <path>] [--json]");
    console.log("       swarm mcp prompt <server_id> <name> [key=value...] [--session <session_id>] [--workspace <path>] [--json]");
    return;
  }

  const positionals = collectPositionals(values);
  let subcommand = positionals[0] ?? "list";
  const implicitSelector = subcommand !== "list"
    && subcommand !== "show"
    && subcommand !== "refresh"
    && subcommand !== "resources"
    && subcommand !== "read"
    && subcommand !== "prompts"
    && subcommand !== "prompt";
  if (implicitSelector) {
    subcommand = "show";
  }

  const jsonOutput = parseBooleanOption(options.json);
  const { SwarmRuntime } = await import("./runtime/runtime.js");
  const {
    buildMcpDetailReport,
    buildMcpListReport,
    buildMcpPromptResultReport,
    buildMcpPromptsReport,
    buildMcpResourceReadReport,
    buildMcpResourcesReport,
    resolveMcpServerSelector
  } = await import("./extensions/mcp-report.js");
  const runtime = new SwarmRuntime({ workspace: options.workspace });
  try {
    if (subcommand === "list") {
      const report = buildMcpListReport(runtime);
      console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
      return;
    }

    const selector = implicitSelector ? positionals[0] : positionals[1];
    if (!selector) {
      console.error(`Usage: swarm mcp ${subcommand} <server_id> [--workspace <path>] [--json]`);
      process.exitCode = 1;
      return;
    }
    const resolution = resolveMcpServerSelector(runtime, selector);
    if (!resolution.serverId) {
      console.error(resolution.error ?? `Unknown MCP server: ${selector}`);
      process.exitCode = 1;
      return;
    }
    const resolvedServerId = resolution.serverId;

    if (subcommand === "show") {
      await runtime.refreshMcpServer(resolvedServerId);
      const report = await buildMcpDetailReport(runtime, resolvedServerId);
      console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
      return;
    }

    if (subcommand === "refresh") {
      await runtime.refreshMcpServer(resolvedServerId);
      const report = await buildMcpDetailReport(runtime, resolvedServerId);
      const data = {
        action: "refresh",
        ...report.data
      };
      if (jsonOutput) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(`MCP server refreshed: ${resolvedServerId}`);
        console.log("");
        console.log(report.detail);
      }
      return;
    }

    if (subcommand === "resources") {
      await runtime.refreshMcpServer(resolvedServerId);
      const report = buildMcpResourcesReport(runtime, resolvedServerId);
      console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
      return;
    }

    if (subcommand === "read") {
      const uri = positionals[2];
      if (!uri) {
        console.error("Usage: swarm mcp read <server_id> <uri> [--session <session_id>] [--workspace <path>] [--json]");
        process.exitCode = 1;
        return;
      }
      await runtime.refreshMcpServer(resolvedServerId);
      const report = await buildMcpResourceReadReport(runtime, resolvedServerId, uri, normalizeOptionalValue(options.session));
      console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
      return;
    }

    if (subcommand === "prompts") {
      await runtime.refreshMcpServer(resolvedServerId);
      const report = buildMcpPromptsReport(runtime, resolvedServerId);
      console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
      return;
    }

    if (subcommand === "prompt") {
      const name = positionals[2];
      if (!name) {
        console.error("Usage: swarm mcp prompt <server_id> <name> [key=value...] [--session <session_id>] [--workspace <path>] [--json]");
        process.exitCode = 1;
        return;
      }
      const args = parseKeyValueArgs(positionals.slice(3));
      await runtime.refreshMcpServer(resolvedServerId);
      const report = await buildMcpPromptResultReport(runtime, resolvedServerId, name, args, normalizeOptionalValue(options.session));
      console.log(jsonOutput ? JSON.stringify(report.data, null, 2) : report.detail);
      return;
    }

    console.error(`Unknown mcp command: ${subcommand}`);
    process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    runtime.dispose();
  }
}

async function runSymphonyDaemon(
  runtime: InstanceType<typeof import("./runtime/runtime.js").SwarmRuntime>,
  options: Record<string, string>,
  parsed: {
    maxRunnerTurns?: number;
    maxRunnerToolCalls?: number;
    maxTicks?: number;
  } = {}
): Promise<void> {
  const { SymphonyDaemonManager } = await import("./symphony/daemon.js");
  const manager = new SymphonyDaemonManager(runtime);
  const start = await manager.start({
    workflowPath: options.workflow,
    createWorkspace: options["no-create"] !== "true",
    execute: options.execute === "true" || options.run === "true",
    maxRunnerTurns: parsed.maxRunnerTurns,
    maxRunnerToolCalls: parsed.maxRunnerToolCalls,
    maxTicks: parsed.maxTicks
  });
  if (!start.ok) {
    console.error(`${start.error.code}: ${start.error.message}`);
    process.exitCode = 1;
    return;
  }
  const daemonId = start.daemon.daemon_id;
  let stopping = false;
  let lastPrintedTick = 0;
  const stop = (): void => {
    stopping = true;
    manager.requestStop({ daemonId, reason: "signal_stop", cancelRunning: true });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    console.log(`Symphony daemon started: ${daemonId}${parsed.maxTicks !== undefined ? ` for ${parsed.maxTicks} tick(s)` : ""}.`);
    while (true) {
      const record = manager.getRecord(daemonId);
      if (!record) {
        console.error(`Symphony daemon record disappeared: ${daemonId}`);
        process.exitCode = 1;
        break;
      }
      if (record.tick_count > lastPrintedTick) {
        const history = record.history.filter((item) => item.tick > lastPrintedTick);
        if (history.length) {
          for (const item of history) {
            printSymphonyDaemonRecord(record, item);
          }
        } else {
          printSymphonyDaemonRecord(record, record.last_result);
        }
        lastPrintedTick = record.tick_count;
      }
      if (record.status === "failed") {
        process.exitCode = 1;
        break;
      }
      if (record.status === "stopped" || (stopping && record.status !== "running")) {
        break;
      }
      await delay(100);
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await manager.stopAll("cli_exit", true);
  }
  console.log("Symphony daemon stopped.");
}

async function runHeadless(values: string[]): Promise<void> {
  let parsed: { options: Record<string, string>; objective: string };
  try {
    parsed = parseRunArgs(values);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  const { options, objective } = parsed;
  const requestedResumeSessionId = normalizeOptionalValue(options.resume);
  const continueRequested = parseBooleanOption(options["continue"]);
  if (requestedResumeSessionId && continueRequested) {
    console.error("Use either --resume <session_id> or --continue, not both.");
    process.exitCode = 1;
    return;
  }
  const resumeRequested = Boolean(requestedResumeSessionId || continueRequested);
  if (!objective && !resumeRequested) {
    console.error("Usage: swarm run [--mode auto|chat|coding_loop|full_swarm] [--resume <session_id>|--continue] [--max-turns N] [--max-tool-calls N] [--allowed-tools A,B] [--disallowed-tools A,B] [--add-dir DIR] [--skill NAME] [--skills A,B] [--mcp-config JSON_OR_FILE] [--strict-mcp-config] [--system-prompt TEXT|--system-prompt-file FILE] [--append-system-prompt TEXT|--append-system-prompt-file FILE] [--permission-mode ask|auto-edit|full-auto|yolo] [--approval-mode fail|wait] [--approval-timeout-ms N] [--sandbox workspace-write|read-only] [--read-only] [--workspace <path>] [--json|--stream-json|--output-format text|json|stream-json] [--report <path>] [--telemetry <path>] [--trajectory <path>] <objective>");
    process.exitCode = 1;
    return;
  }

  const requestedMode = parseRunMode(options.mode);
  const mode = resumeRequested ? "coding_loop" : requestedMode;
  let outputFormat: "text" | "json" | "stream-json";
  let requestedPermissionMode: HeadlessPermissionMode | undefined;
  let approvalMode: HeadlessApprovalMode;
  let approvalTimeoutMs: number | undefined;
  let sandboxMode: RunSandboxMode;
  let budget: HeadlessRunBudget | undefined;
  let toolPolicy: HeadlessToolPolicy | undefined;
  let additionalReadDirectories: string[] | undefined;
  let promptOptions: ParsedHeadlessPromptOptions | undefined;
  let mcpOptions: ParsedHeadlessMcpConfigOptions | undefined;
  let activatedSkills: string[] | undefined;
  try {
    outputFormat = parseHeadlessOutputFormat(options["output-format"]);
    requestedPermissionMode = parseHeadlessPermissionModeOption(options["permission-mode"]);
    approvalMode = parseHeadlessApprovalMode(options["approval-mode"]);
    approvalTimeoutMs = parsePositiveIntegerOption(options, "approval-timeout-ms");
    sandboxMode = parseHeadlessSandboxModeOption(options.sandbox, parseBooleanOption(options["read-only"]));
    budget = parseHeadlessBudgetOptions(options);
    toolPolicy = parseHeadlessToolPolicyOptions(options);
    additionalReadDirectories = parseHeadlessAdditionalReadDirectories(options);
    promptOptions = parseHeadlessPromptOptions(options);
    activatedSkills = parseHeadlessSkillOptions(options);
    const { loadRuntimeMcpConfigSources } = await import("./extensions/mcp.js");
    mcpOptions = parseHeadlessMcpConfigOptions(options, loadRuntimeMcpConfigSources);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  if (parseBooleanOption(options.yolo)) {
    if (requestedPermissionMode && requestedPermissionMode !== "yolo") {
      console.error("Use either --yolo or --permission-mode, not both.");
      process.exitCode = 1;
      return;
    }
    requestedPermissionMode = "yolo";
  }
  if (requestedPermissionMode) {
    process.env.SWARM_PERMISSION_MODE = requestedPermissionMode;
  }

  const [{ formatModelReadinessProblems }, { OpenAIProvider }] = await Promise.all([
    import("./config/settings.js"),
    import("./providers/openai-provider.js")
  ]);
  const providerPreflight = new OpenAIProvider();
  if (!providerPreflight.enabled) {
    console.error("No usable model provider is configured.");
    for (const line of formatModelReadinessProblems(providerPreflight.readiness())) {
      console.error(`- ${line}`);
    }
    console.error('Run "swarm onboard" or fix ~/.swarm/settings.json and ~/.swarm/config.json.');
    process.exitCode = 1;
    return;
  }

  const { SwarmRuntime } = await import("./runtime/runtime.js");
  const { createHeadlessApprovalHandler } = await import("./approvals/headless-handler.js");
  const { formatHeadlessProgress } = await import("./runtime/event-formatters.js");
  const jsonOutput = parseBooleanOption(options.json) || outputFormat === "json";
  const streamJsonOutput = parseBooleanOption(options["stream-json"]) || outputFormat === "stream-json";
  if (jsonOutput && streamJsonOutput) {
    console.error("Use either --json or --stream-json, not both.");
    process.exitCode = 1;
    return;
  }
  const reportPath = normalizeOptionalPath(options.report);
  const telemetryPath = normalizeOptionalPath(options.telemetry);
  const trajectoryPath = normalizeOptionalPath(options.trajectory);
  const absoluteReportPath = reportPath ? resolvePath(reportPath) : undefined;
  const absoluteTelemetryPath = telemetryPath ? resolvePath(telemetryPath) : undefined;
  const absoluteTrajectoryPath = trajectoryPath ? resolvePath(trajectoryPath) : undefined;
  const capturedEvents: CapturedRuntimeEvent[] = [];
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  let stdoutBrokenPipe = false;
  let runtimeForBrokenPipe: { requestStopActiveWork(reason?: string): boolean; interrupt(reason: string): void } | undefined;
  const stdoutGuard = installHeadlessStdoutGuard({
    enabled: jsonOutput || streamJsonOutput,
    onBrokenPipe: () => {
      stdoutBrokenPipe = true;
      const message = "stdout pipe closed; stopping active Swarm work.";
      const stopRequested = runtimeForBrokenPipe?.requestStopActiveWork(message);
      if (runtimeForBrokenPipe && !stopRequested) {
        runtimeForBrokenPipe.interrupt(message);
      }
    }
  });
  let runtimeForApproval: InstanceType<typeof SwarmRuntime> | undefined;
  const runtime = new SwarmRuntime({
    workspace: options.workspace,
    mcpConfig: mcpOptions?.runtime,
    approvalHandler: (request) => {
      if (!runtimeForApproval) {
        throw new Error("Headless approval runtime is not ready.");
      }
      return createHeadlessApprovalHandler({
        runtime: runtimeForApproval,
        mode: approvalMode,
        workspace: options.workspace,
        timeoutMs: approvalTimeoutMs,
        streamJsonOutput
      })(request);
    }
  });
  runtimeForApproval = runtime;
  runtimeForBrokenPipe = runtime;
  const permissionMode = normalizeHeadlessPermissionMode(runtime.settings.permissions.defaultMode);
  let operation: HeadlessOperation = "run";
  let resumeSessionId: string | undefined;
  let resumeRow: SessionRow | undefined;
  let resumePreflight: HeadlessResumePreflight | undefined;
  let artifactObjective = objective;
  if (resumeRequested) {
    operation = continueRequested ? "continue" : "resume";
    resumeSessionId = requestedResumeSessionId ?? runtime.listRecentSessionsForWorkspace(1)[0]?.session_id;
    if (!resumeSessionId) {
      console.error(continueRequested ? "No recent session found for --continue." : "Missing --resume session id.");
      runtime.dispose();
      stdoutGuard.restore();
      process.exitCode = 1;
      return;
    }
    resumeRow = runtime.sessionStore.get(resumeSessionId);
    if (!resumeRow) {
      console.error(`Unknown session: ${resumeSessionId}`);
      runtime.dispose();
      stdoutGuard.restore();
      process.exitCode = 1;
      return;
    }
    try {
      const execution = decideResumeExecution({
        command: operation,
        sessionId: resumeSessionId,
        hasStoredPlan: Boolean(resumeRow.plan_json),
        instruction: objective
      });
      resumePreflight = {
        command: operation,
        route: execution.route,
        instruction: execution.instruction,
        detail: runtime.renderResumePreflight({
          sessionId: resumeSessionId,
          instruction: execution.instruction,
          sandboxMode,
          command: operation,
          route: execution.route
        })
      };
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      runtime.dispose();
      stdoutGuard.restore();
      process.exitCode = 1;
      return;
    }
    if (!jsonOutput && !streamJsonOutput && resumePreflight) {
      console.error(resumePreflight.detail);
      console.error("");
    }
    const operationLabel = operation === "continue" ? "Continue" : "Resume";
    artifactObjective = resumePreflight.instruction
      ? `${operationLabel} ${resumeSessionId}: ${resumePreflight.instruction}`
      : `${operationLabel} ${resumeSessionId}: ${resumeRow.objective}`;
  }
  const writeStreamRecord = (record: HeadlessStreamRecordInput) => {
    return stdoutGuard.writeRecord(record);
  };
  if (streamJsonOutput) {
    writeStreamRecord({
      type: "run_start",
      at: startedAt,
      objective: artifactObjective,
      workspace: runtime.workspaceRoot(),
      mode,
      permission_mode: permissionMode,
      sandbox_mode: sandboxMode,
      operation,
      resume_session_id: resumeSessionId,
      resume_preflight: resumePreflight,
      budget,
      tool_policy: toolPolicy,
      additional_read_directories: additionalReadDirectories,
      prompt_customization: promptOptions?.customization,
      mcp_config: mcpOptions?.metadata,
      activated_skills: activatedSkills
    });
  }
  let result: Awaited<ReturnType<typeof runtime.run>> | undefined;
  let runError: Error | undefined;
  let receivedSignal: NodeJS.Signals | undefined;
  let signalCount = 0;
  let cleanedUp = false;
  let unsubscribe: () => void = () => undefined;
  const cleanupRuntime = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    unsubscribe();
    runtime.dispose();
  };
  const handleSignal = (signal: NodeJS.Signals) => {
    signalCount += 1;
    receivedSignal = signal;
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    const sessionId = resolveHeadlessSessionId({ capturedEvents, result });
    const resumeHint = buildHeadlessResumeHint(sessionId);
    const message = `Received ${signal}; stopping active Swarm work at the next safe boundary.`;
    if (streamJsonOutput) {
      writeStreamRecord({
        type: "run_signal",
        at: new Date().toISOString(),
        signal,
        message,
        session_id: sessionId,
        resume_hint: resumeHint
      });
    } else {
      console.error(message);
      if (resumeHint) {
        console.error(resumeHint);
      }
      console.error("Press Ctrl+C again to exit immediately.");
    }
    const stopRequested = runtime.requestStopActiveWork(message);
    if (!stopRequested) {
      runtime.interrupt(message);
    }
    if (signalCount > 1) {
      cleanupRuntime();
      process.exit(process.exitCode ?? 1);
    }
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
  unsubscribe = runtime.events.onEvent((event) => {
    const captured = { at: new Date().toISOString(), event };
    capturedEvents.push(captured);
    if (streamJsonOutput) {
      writeStreamRecord({
        type: "runtime_event",
        at: captured.at,
        event
      });
      return;
    }
    const progress = formatHeadlessProgress(event);
    if (progress) {
      console.error(progress);
    }
  });

  try {
    result = resumeSessionId
      ? resumePreflight?.route === "stored_plan"
        ? await runtime.execute({
            session: restoreSessionFromRow(resumeRow!),
            plan: JSON.parse(resumeRow!.plan_json!) as GeneratedPlan
          })
        : await runtime.executeWorkSession({
            session_id: resumeSessionId,
            prompt: runtime.buildResumePrompt(resumeSessionId, resumePreflight?.instruction ?? objective),
            maxTurns: budget?.max_turns,
            maxToolCalls: budget?.max_tool_calls,
            sandboxMode,
            allowedTools: toolPolicy?.allowed_tools,
            disallowedTools: toolPolicy?.disallowed_tools,
            additionalReadDirectories,
            systemPrompt: promptOptions?.systemPrompt,
            appendSystemPrompt: promptOptions?.appendSystemPrompt,
            skills: activatedSkills
          })
      : await runtime.run(objective, {
          mode,
          maxTurns: budget?.max_turns,
          maxToolCalls: budget?.max_tool_calls,
          sandboxMode,
          allowedTools: toolPolicy?.allowed_tools,
          disallowedTools: toolPolicy?.disallowed_tools,
          additionalReadDirectories,
          systemPrompt: promptOptions?.systemPrompt,
          appendSystemPrompt: promptOptions?.appendSystemPrompt,
          skills: activatedSkills
        });
  } catch (error) {
    runError = error instanceof Error ? error : new Error(String(error));
    if (!receivedSignal && !stdoutBrokenPipe) {
      process.exitCode = 1;
    }
  } finally {
    const endedAtMs = Date.now();
    const endedAt = new Date(endedAtMs).toISOString();
    const artifacts = buildHeadlessRunArtifacts({
      objective: artifactObjective,
      workspace: runtime.workspaceRoot(),
      mode,
      permissionMode,
      sandboxMode,
      operation,
      resumeSessionId,
      resumePreflight,
      budget,
      toolPolicy,
      additionalReadDirectories,
      promptCustomization: promptOptions?.customization,
      mcpConfig: mcpOptions?.metadata,
      activatedSkills,
      startedAt,
      endedAt,
      durationMs: endedAtMs - startedAtMs,
      capturedEvents,
      result,
      error: runError,
      reportPath: absoluteReportPath,
      telemetryPath: absoluteTelemetryPath,
      trajectoryPath: absoluteTrajectoryPath
    });
    if (absoluteReportPath) {
      writeJsonArtifact(absoluteReportPath, artifacts.report);
    }
    if (absoluteTelemetryPath) {
      writeJsonArtifact(absoluteTelemetryPath, artifacts.telemetry);
    }
    if (absoluteTrajectoryPath) {
      writeJsonArtifact(absoluteTrajectoryPath, artifacts.trajectory);
    }

    const sessionId = resolveHeadlessSessionId({ capturedEvents, result });
    const resumeHint = buildHeadlessResumeHint(sessionId);
    if (stdoutGuard.brokenPipe()) {
      // Downstream has closed stdout; avoid emitting fallback text into stderr from guarded console methods.
    } else if (streamJsonOutput) {
      writeStreamRecord({
        type: "run_end",
        at: endedAt,
        status: artifacts.report.status,
        session_id: sessionId,
        duration_ms: endedAtMs - startedAtMs,
        report: artifacts.report,
        resume_hint: receivedSignal || runError ? resumeHint : undefined
      });
    } else if (jsonOutput) {
      stdoutGuard.writeLine(JSON.stringify(artifacts.report, null, 2));
    } else if (result) {
      console.log(result.content);
      if (result.outcome) {
        console.log("");
        console.log("Outcome:");
        console.log(`  changed_files: ${result.outcome.changed_files.length ? result.outcome.changed_files.join(", ") : "none"}`);
        console.log(`  checks: ${result.outcome.tests_run.length ? result.outcome.tests_run.join(", ") : "none"}`);
        if (result.outcome.intermediate_artifacts.length) {
          console.log(`  artifacts: ${result.outcome.intermediate_artifacts.join(", ")}`);
        }
      }
    } else if (runError) {
      console.error(runError.message);
      if (resumeHint) {
        console.error(resumeHint);
      }
    }
    cleanupRuntime();
    stdoutGuard.restore();
  }
}

async function runBenchCommand(values: string[]): Promise<void> {
  const {
    listBenchSuites,
    runBenchSuite,
    readBenchReport,
    compareBenchReports,
    evaluateBenchComparisonGate
  } = await import("./bench/bench-runner.js");
  const subcommand = values[0] ?? "list";
  const options = parseOptions(values.slice(1));
  const positionals = collectPositionals(values.slice(1));
  const workspace = options.workspace ?? process.cwd();

  if (subcommand === "list") {
    const suites = listBenchSuites();
    for (const suite of suites) {
      console.log(`${suite.name.padEnd(18)} ${suite.description}`);
    }
    return;
  }

  if (subcommand === "run") {
    const suiteName = positionals[0] ?? options.suite;
    if (!suiteName) {
      console.error("Usage: swarm bench run <suite> [--workspace <path>]");
      process.exitCode = 1;
      return;
    }
    let result: Awaited<ReturnType<typeof runBenchSuite>>;
    try {
      result = await runBenchSuite({ workspace, suiteName });
    } catch (error) {
      printBenchCliError(error);
      if (error instanceof Error && error.message.startsWith("Unknown benchmark suite:")) {
        console.error("Run `swarm bench list` to see available benchmark suites.");
      }
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ report: result.report, report_path: result.reportPath }, null, 2));
    return;
  }

  if (subcommand === "report") {
    const runId = positionals[0] ?? options.run;
    if (!runId) {
      console.error("Usage: swarm bench report <run_id> [--workspace <path>]");
      process.exitCode = 1;
      return;
    }
    let report: Awaited<ReturnType<typeof readBenchReport>>;
    try {
      report = await readBenchReport(workspace, runId);
    } catch (error) {
      printBenchMissingReportError(error, runId);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (subcommand === "compare") {
    const leftId = positionals[0] ?? options.left;
    const rightId = positionals[1] ?? options.right;
    if (!leftId || !rightId) {
      console.error("Usage: swarm bench compare <run_a> <run_b> [--workspace <path>] [--max-duration-delta-ms N] [--max-model-call-delta N] [--max-tool-call-delta N] [--max-failed-delta N] [--fail-on-status-change]");
      process.exitCode = 1;
      return;
    }
    let thresholds: import("./bench/bench-runner.js").BenchComparisonThresholds;
    try {
      thresholds = parseBenchComparisonThresholds(options);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      return;
    }
    const readReportForCompare = async (runId: string): Promise<Awaited<ReturnType<typeof readBenchReport>> | undefined> => {
      try {
        return await readBenchReport(workspace, runId);
      } catch (error) {
        printBenchMissingReportError(error, runId);
        process.exitCode = 1;
        return undefined;
      }
    };
    const left = await readReportForCompare(leftId);
    if (!left) {
      return;
    }
    const right = await readReportForCompare(rightId);
    if (!right) {
      return;
    }
    console.log(compareBenchReports(left, right, thresholds));
    const gate = evaluateBenchComparisonGate(left, right, thresholds);
    if (gate.exit_code !== 0) {
      process.exitCode = gate.exit_code;
    }
    return;
  }

  console.error(`Unknown bench command: ${subcommand}`);
  console.log("Available suites:");
  for (const suite of listBenchSuites()) {
    console.log(`  ${suite.name} - ${suite.description}`);
  }
  process.exitCode = 1;
}

function printBenchCliError(error: unknown): void {
  console.error(error instanceof Error ? error.message : String(error));
}

function printBenchMissingReportError(error: unknown, runId: string): void {
  if (isNodeError(error) && error.code === "ENOENT") {
    console.error(`Benchmark report not found: ${runId}`);
    console.error("Run `swarm bench run <suite>` first or choose an existing run id.");
    return;
  }
  printBenchCliError(error);
}

function isNodeError(error: unknown): error is Error & { code?: string } {
  return error instanceof Error && "code" in error;
}

function parseBenchComparisonThresholds(options: Record<string, string>): import("./bench/bench-runner.js").BenchComparisonThresholds {
  return {
    maxDurationDeltaMs: parseNonNegativeNumberOption(options, "max-duration-delta-ms"),
    maxModelCallDelta: parseNonNegativeNumberOption(options, "max-model-call-delta"),
    maxToolCallDelta: parseNonNegativeNumberOption(options, "max-tool-call-delta"),
    maxFailedDelta: parseNonNegativeNumberOption(options, "max-failed-delta"),
    failOnStatusChange: parseBooleanOption(options["fail-on-status-change"])
  };
}

function parseNonNegativeNumberOption(options: Record<string, string>, key: string): number | undefined {
  const value = options[key];
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid --${key}: ${value}. Expected a non-negative number.`);
  }
  return parsed;
}

function parseRunArgs(values: string[]): { options: Record<string, string>; objective: string } {
  const options: Record<string, string> = {};
  const objectiveParts: string[] = [];
  const valueFlags = new Set(["mode", "workspace", "report", "telemetry", "trajectory", "timeout-ms", "output-format", "permission-mode", "approval-mode", "approval-timeout-ms", "sandbox", "resume", "max-turns", "max-tool-calls", "allowed-tools", "disallowed-tools", "tools", "add-dir", "add-dirs", "skill", "skills", "mcp-config", "system-prompt", "system-prompt-file", "append-system-prompt", "append-system-prompt-file"]);
  const listValueFlags = new Set(["allowed-tools", "disallowed-tools", "tools", "add-dir", "add-dirs", "skill", "skills", "mcp-config"]);
  const booleanFlags = new Set(["json", "stream-json", "continue", "read-only", "strict-mcp-config", "yolo", "debug", "verbose", "debug-trace", "help"]);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value.startsWith("--")) {
      const key = value.slice(2);
      if (valueFlags.has(key)) {
        const next = values[index + 1];
        if (!next || next.startsWith("--")) {
          throw new Error(`${value} requires a value.`);
        }
        setParsedOptionValue(options, key, next, listValueFlags.has(key));
        index += 1;
      } else if (booleanFlags.has(key)) {
        options[key] = "true";
      } else {
        throw new Error(`Unknown swarm run option: --${key}. Use swarm run --help for supported options.`);
      }
      continue;
    }
    objectiveParts.push(value);
  }
  return { options, objective: objectiveParts.join(" ").trim() };
}

function setParsedOptionValue(options: Record<string, string>, key: string, value: string, append: boolean): void {
  if (append && options[key]) {
    const separator = key === "mcp-config" ? MCP_CONFIG_OPTION_SEPARATOR : ",";
    options[key] = `${options[key]}${separator}${value}`;
    return;
  }
  options[key] = value;
}

function parseRunMode(value: string | undefined): "auto" | "chat" | "coding_loop" | "full_swarm" {
  if (!value || value === "auto") {
    return "auto";
  }
  if (value === "chat") {
    return "chat";
  }
  if (value === "coding" || value === "fast" || value === "coding_loop") {
    return "coding_loop";
  }
  if (value === "swarm" || value === "full" || value === "full_swarm") {
    return "full_swarm";
  }
  throw new Error(`Invalid --mode: ${value}. Expected auto, chat, coding_loop, or full_swarm.`);
}

function parseHeadlessOutputFormat(value: string | undefined): "text" | "json" | "stream-json" {
  if (!value || value === "text") {
    return "text";
  }
  if (value === "json" || value === "stream-json") {
    return value;
  }
  throw new Error(`Invalid --output-format: ${value}. Expected text, json, or stream-json.`);
}

function parseHeadlessApprovalMode(value: string | undefined): HeadlessApprovalMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "fail" || normalized === "fail-closed") {
    return "fail";
  }
  if (normalized === "wait" || normalized === "local" || normalized === "queue") {
    return "wait";
  }
  throw new Error(`Invalid --approval-mode: ${value}. Expected fail or wait.`);
}

function parseHeadlessPermissionModeOption(value: string | undefined): HeadlessPermissionMode | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "ask" || value === "auto-edit" || value === "full-auto" || value === "yolo") {
    return value;
  }
  throw new Error(`Invalid --permission-mode: ${value}. Expected ask, auto-edit, full-auto, or yolo.`);
}

function parseHeadlessSandboxModeOption(value: string | undefined, readOnly: boolean): RunSandboxMode {
  const normalized = value?.trim().replace(/_/g, "-");
  let sandboxMode: RunSandboxMode;
  if (!normalized) {
    sandboxMode = readOnly ? "read-only" : "workspace-write";
  } else if (normalized === "workspace-write" || normalized === "workspace") {
    sandboxMode = "workspace-write";
  } else if (normalized === "read-only" || normalized === "readonly") {
    sandboxMode = "read-only";
  } else {
    throw new Error(`Invalid --sandbox: ${value}. Expected workspace-write or read-only.`);
  }
  if (readOnly && sandboxMode !== "read-only") {
    throw new Error("Use either --read-only or --sandbox workspace-write, not both.");
  }
  return sandboxMode;
}

function parseHeadlessBudgetOptions(options: Record<string, string>): HeadlessRunBudget | undefined {
  const maxTurns = parsePositiveIntegerOption(options, "max-turns");
  const maxToolCalls = parsePositiveIntegerOption(options, "max-tool-calls");
  return maxTurns || maxToolCalls
    ? {
        max_turns: maxTurns,
        max_tool_calls: maxToolCalls
      }
    : undefined;
}

function parseHeadlessToolPolicyOptions(options: Record<string, string>): HeadlessToolPolicy | undefined {
  const allowedTools = parseToolListOption(options["allowed-tools"] ?? options.tools);
  const disallowedTools = parseToolListOption(options["disallowed-tools"]);
  if (!allowedTools?.length && !disallowedTools?.length) {
    return undefined;
  }
  return {
    allowed_tools: allowedTools,
    disallowed_tools: disallowedTools
  };
}

function parseToolListOption(value: string | undefined): string[] | undefined {
  if (!value || value === "true") {
    return undefined;
  }
  const tools = value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
  return tools.length ? [...new Set(tools)] : undefined;
}

function parseHeadlessAdditionalReadDirectories(options: Record<string, string>): string[] | undefined {
  const directories = [
    ...parsePathListOption(options["add-dir"]),
    ...parsePathListOption(options["add-dirs"])
  ];
  if (!directories.length) {
    return undefined;
  }
  const resolved = directories.map((path) => resolveReadableDirectoryOption(path));
  return [...new Set(resolved)].sort();
}

function parseHeadlessSkillOptions(options: Record<string, string>): string[] | undefined {
  const requested = [
    ...(parseToolListOption(options.skill) ?? []),
    ...(parseToolListOption(options.skills) ?? [])
  ];
  if (!requested.length) {
    return undefined;
  }
  const normalized = requested.map((name) => {
    const value = normalizeSkillName(name);
    if (!value) {
      throw new Error(`Invalid --skill value: ${name}`);
    }
    return value;
  });
  return [...new Set(normalized)];
}

type ParsedHeadlessPromptOptions = {
  systemPrompt?: string;
  appendSystemPrompt?: string;
  customization?: HeadlessPromptCustomization;
};

type HeadlessApprovalMode = import("./approvals/headless-handler.js").HeadlessApprovalMode;

function parseHeadlessPromptOptions(options: Record<string, string>): ParsedHeadlessPromptOptions | undefined {
  const systemPrompt = normalizePromptOptionValue(options["system-prompt"]);
  const systemPromptFile = normalizePromptOptionValue(options["system-prompt-file"]);
  const appendSystemPrompt = normalizePromptOptionValue(options["append-system-prompt"]);
  const appendSystemPromptFile = normalizePromptOptionValue(options["append-system-prompt-file"]);
  if (systemPrompt !== undefined && systemPromptFile !== undefined) {
    throw new Error("Use either --system-prompt or --system-prompt-file, not both.");
  }
  if (appendSystemPrompt !== undefined && appendSystemPromptFile !== undefined) {
    throw new Error("Use either --append-system-prompt or --append-system-prompt-file, not both.");
  }

  const parsed: ParsedHeadlessPromptOptions = {};
  const customization: HeadlessPromptCustomization = {};
  if (systemPrompt !== undefined) {
    parsed.systemPrompt = systemPrompt;
    customization.system_prompt = { source: "inline", bytes: byteLength(systemPrompt) };
  } else if (systemPromptFile !== undefined) {
    parsed.systemPrompt = readHeadlessPromptFileOption("--system-prompt-file", systemPromptFile);
    customization.system_prompt = { source: "file", bytes: byteLength(parsed.systemPrompt) };
  }
  if (appendSystemPrompt !== undefined) {
    parsed.appendSystemPrompt = appendSystemPrompt;
    customization.append_system_prompt = { source: "inline", bytes: byteLength(appendSystemPrompt) };
  } else if (appendSystemPromptFile !== undefined) {
    parsed.appendSystemPrompt = readHeadlessPromptFileOption("--append-system-prompt-file", appendSystemPromptFile);
    customization.append_system_prompt = { source: "file", bytes: byteLength(parsed.appendSystemPrompt) };
  }
  if (!customization.system_prompt && !customization.append_system_prompt) {
    return undefined;
  }
  parsed.customization = customization;
  return parsed;
}

type ParsedHeadlessMcpConfigOptions = {
  runtime: RuntimeMcpConfigOptions;
  metadata: HeadlessMcpConfig;
};

function parseHeadlessMcpConfigOptions(
  options: Record<string, string>,
  loadSources: (values: string[], baseDirectory?: string) => RuntimeMcpConfigOptions["sources"]
): ParsedHeadlessMcpConfigOptions | undefined {
  const values = parseMcpConfigListOption(options["mcp-config"]);
  const strict = parseBooleanOption(options["strict-mcp-config"]);
  if (!values.length && !strict) {
    return undefined;
  }
  const sources = loadSources(values, process.cwd());
  return {
    runtime: {
      sources,
      strict
    },
    metadata: {
      strict,
      sources: sources.map((source) => ({
        source: source.source,
        path: source.path,
        bytes: source.bytes,
        server_ids: source.serverIds
      }))
    }
  };
}

function parseMcpConfigListOption(value: string | undefined): string[] {
  if (!value || value === "true") {
    return [];
  }
  return value.split(MCP_CONFIG_OPTION_SEPARATOR).map((item) => item.trim()).filter(Boolean);
}

function normalizePromptOptionValue(value: string | undefined): string | undefined {
  return value === undefined || value === "true" ? undefined : value;
}

function readHeadlessPromptFileOption(flag: string, value: string): string {
  const path = resolvePath(expandUserPath(value));
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${flag}: ${value}. ${message}`);
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function parsePathListOption(value: string | undefined): string[] {
  if (!value || value === "true") {
    return [];
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function resolveReadableDirectoryOption(value: string): string {
  const expanded = expandUserPath(value);
  const resolved = resolvePath(expanded);
  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(resolved);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid --add-dir: ${value}. ${message}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`Invalid --add-dir: ${value}. Expected an existing directory.`);
  }
  return resolved;
}

function expandUserPath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return resolvePath(homedir(), value.slice(2));
  }
  return value;
}

function normalizeHeadlessPermissionMode(value: string | undefined): HeadlessPermissionMode {
  if (value === "auto-edit" || value === "full-auto" || value === "yolo") {
    return value;
  }
  if (value === "auto") {
    return "full-auto";
  }
  return "ask";
}

function parsePositiveIntegerOption(options: Record<string, string>, key: string): number | undefined {
  const value = options[key];
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid --${key}: ${value}. Expected a positive integer.`);
  }
  return parsed;
}

function parseBooleanOption(value: string | undefined): boolean {
  return value === "true" || value === "1" || value === "yes" || value === "on";
}

function normalizeOptionalPath(value: string | undefined): string | undefined {
  return value && value !== "true" ? value : undefined;
}

function normalizeOptionalValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "true" ? trimmed : undefined;
}

function defaultSessionSelectorArgs(values: string[]): string[] {
  return values[0]?.startsWith("-") || !values[0]
    ? ["latest", ...values]
    : values;
}

function printSymphonyStatus(status: import("./symphony/status-format.js").SymphonyStatusFormatResult): void {
  const write = status.ok ? console.log : console.error;
  for (const line of status.lines) {
    write(line);
  }
  if (status.exitCode !== undefined) {
    process.exitCode = status.exitCode;
  }
}

function printSymphonyDaemonRecord(
  record: import("./symphony/daemon.js").SymphonyDaemonRecord,
  summary = record.last_result
): void {
  const isLatest = (summary?.tick ?? record.tick_count) === record.tick_count;
  console.log([
    `tick=${summary?.tick ?? record.tick_count}`,
    `status=${isLatest ? record.status : summary?.status ?? record.status}`,
    summary ? `candidates=${summary.candidates}` : undefined,
    summary ? `dispatched=${summary.dispatched}` : undefined,
    summary ? `skipped=${summary.skipped}` : undefined,
    summary ? `failed=${summary.failed}` : undefined,
    summary ? `running=${summary.running}/${summary.max_concurrent}` : undefined,
    summary?.preflight_issues ? `preflight=${summary.preflight_ok ? "warn" : "failed"}` : undefined,
    summary?.runs ? `runs=${summary.runs.join(",") || "none"}` : undefined,
    isLatest && record.stop_reason ? `reason=${record.stop_reason}` : undefined,
    isLatest && record.last_error ? `error=${record.last_error}` : undefined
  ].filter(Boolean).join(" "));
  if (summary?.preflight_issue_summaries?.length) {
    for (const issue of summary.preflight_issue_summaries) {
      console.log(`  preflight ${issue.severity} ${issue.code}: ${issue.message}`);
    }
    if ((summary.preflight_issues ?? 0) > summary.preflight_issue_summaries.length) {
      console.log(`  preflight ... ${(summary.preflight_issues ?? 0) - summary.preflight_issue_summaries.length} more`);
    }
  }
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 180) ?? "";
}

function workItemDisplayName(item: { human_id?: string; source_id?: string; external_id?: string; title?: string } | undefined): string {
  if (!item) {
    return "-";
  }
  return item.human_id ?? item.source_id ?? item.external_id ?? item.title ?? "-";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function launchChat(options: { forceOnboarding?: boolean } = {}): Promise<void> {
  const [{ render }, React, { SwarmChatApp }] = await Promise.all([
    import("ink"),
    import("react"),
    import("./tui/SwarmChatApp.js")
  ]);
  render(React.default.createElement(SwarmChatApp, options));
}

function parseOptions(values: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      continue;
    }
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = "true";
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return options;
}

function firstPositionalArg(values: string[], valueFlags: Set<string>): string | undefined {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value || value.startsWith("--")) {
      continue;
    }
    const previous = values[index - 1];
    if (previous?.startsWith("--") && valueFlags.has(previous.slice(2))) {
      continue;
    }
    return value;
  }
  return undefined;
}

function collectPositionals(values: string[]): string[] {
  const positionals: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      index += 1;
    }
  }
  return positionals;
}

function collectPositionalsWithValueFlags(values: string[], valueFlags: Set<string>): string[] {
  const positionals: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const key = value.slice(2);
    if (valueFlags.has(key)) {
      const next = values[index + 1];
      if (next && !next.startsWith("--")) {
        index += 1;
      }
    }
  }
  return positionals;
}

function parseKeyValueArgs(tokens: string[]): Record<string, string> {
  return Object.fromEntries(tokens
    .map((token) => {
      const index = token.indexOf("=");
      return index > 0 ? [token.slice(0, index), token.slice(index + 1)] as const : undefined;
    })
    .filter((entry): entry is readonly [string, string] => entry !== undefined));
}

function parseStructuredKeyValueArgs(tokens: string[]): Record<string, unknown> {
  return Object.fromEntries(tokens
    .map((token) => {
      const index = token.indexOf("=");
      return index > 0 ? [token.slice(0, index), parseStructuredArgValue(token.slice(index + 1))] as const : undefined;
    })
    .filter((entry): entry is readonly [string, unknown] => entry !== undefined));
}

function parseStructuredArgValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (trimmed === "null") {
    return null;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}

function parseCapabilityCliFilter(tokens: string[], options: Record<string, string>): { kind?: string; providerId?: string; query?: string } {
  const filter: { kind?: string; providerId?: string; query?: string } = {};
  const optionKind = normalizeOptionalValue(options.kind);
  const optionProvider = normalizeOptionalValue(options.provider ?? options["provider-id"]);
  const optionQuery = normalizeOptionalValue(options.query);
  if (optionKind) {
    filter.kind = optionKind;
  }
  if (optionProvider) {
    filter.providerId = optionProvider;
  }
  const queryTokens = optionQuery ? [optionQuery] : [];
  for (const token of tokens) {
    if (!token || token === "all") {
      continue;
    }
    if (token.startsWith("kind:")) {
      filter.kind = token.slice("kind:".length);
      continue;
    }
    if (token.startsWith("provider:")) {
      filter.providerId = token.slice("provider:".length);
      continue;
    }
    if (isCapabilityCliKind(token)) {
      filter.kind = token;
      continue;
    }
    queryTokens.push(token);
  }
  if (queryTokens.length) {
    filter.query = queryTokens.join(" ");
  }
  return filter;
}

function parseCapabilityWritePolicy(
  value: string | undefined,
  readOnly = false
): "read_only" | "scoped_write" | "workspace_write" | undefined {
  if (readOnly) {
    return "read_only";
  }
  const normalized = normalizeOptionalValue(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "workspace_write" || normalized === "workspace-write") {
    return "workspace_write";
  }
  if (normalized === "scoped_write" || normalized === "scoped-write") {
    return "scoped_write";
  }
  if (normalized === "read_only" || normalized === "read-only" || normalized === "readonly") {
    return "read_only";
  }
  throw new Error("Capability invoke write policy must be workspace_write, scoped_write, or read_only.");
}

function parseCommaSeparatedOption(value: string | undefined): string[] | undefined {
  const normalized = normalizeOptionalValue(value);
  if (!normalized) {
    return undefined;
  }
  const values = normalized
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length ? values : undefined;
}

function looksLikeCapabilityFilterToken(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "all"
    || normalized.startsWith("kind:")
    || normalized.startsWith("provider:")
    || isCapabilityCliKind(normalized);
}

function isCapabilityCliKind(value: string): boolean {
  return [
    "local_tool",
    "mcp_tool",
    "mcp_resource",
    "mcp_prompt",
    "skill",
    "slash_command",
    "agent_spec",
    "plugin"
  ].includes(value.toLowerCase());
}

function printHelp(): void {
  const binary = process.platform === "win32" ? "swarm" : "swarm";
  console.log(`Agent Swarm Protocol CLI

Usage:
  ${binary} [--debug] [--debug-trace]
  ${binary} --version
  ${binary} --yolo
  ${binary} yolo
  ${binary} chat [--debug]
  ${binary} run [--mode auto|chat|coding_loop|full_swarm] [--resume <session_id>|--continue] [--max-turns N] [--max-tool-calls N] [--allowed-tools A,B] [--disallowed-tools A,B] [--add-dir DIR] [--skill NAME] [--skills A,B] [--mcp-config JSON_OR_FILE] [--strict-mcp-config] [--system-prompt TEXT] [--append-system-prompt TEXT] [--permission-mode ask|auto-edit|full-auto|yolo] [--approval-mode fail|wait] [--approval-timeout-ms N] [--sandbox workspace-write|read-only] [--read-only] [--json|--stream-json|--output-format text|json|stream-json] [--report <path>] [--telemetry <path>] [--trajectory <path>] <objective>
  ${binary} work [run flags] <objective>
  ${binary} watch [--gateway-url <url>] [--protocol runtime|work] [--jsonl]
  ${binary} live [--gateway-url <url>] [--json]
  ${binary} reply <message> [--gateway-url <url>] [--request-id <id>] [--json]
  ${binary} interrupt [message] [--gateway-url <url>] [--request-id <id>] [--json]
  ${binary} attach [session_id|latest] [--gateway-url <url>] [--protocol runtime|work] [--workspace <path>] [--jsonl]
  ${binary} resume <session_id|latest> [message] [--workspace <path>] [resume flags]
  ${binary} continue [message] [--workspace <path>] [resume flags]
  ${binary} runs [list] [--gateway-url <url>] [--json]
  ${binary} runs show <run_id|latest> [--gateway-url <url>] [--json]
  ${binary} runs watch [run_id|latest] [--gateway-url <url>] [--protocol runtime|work] [--jsonl]
  ${binary} checkpoints [list] [--workspace <path>] [--json]
  ${binary} checkpoints create <name> [--reason <text>] [--workspace <path>] [--json]
  ${binary} checkpoints revert [checkpoint_id|last] [--workspace <path>] [--json]
  ${binary} sessions [list] [--limit N] [--workspace <path>] [--json]
  ${binary} sessions show [session_id|latest] [--workspace <path>] [--json]
  ${binary} sessions watch|attach <session_id|latest> [--gateway-url <url>] [--protocol runtime|work] [--workspace <path>] [--jsonl]
  ${binary} sessions resume <session_id|latest> [message] [--workspace <path>] [resume flags]
  ${binary} sessions continue [message] [--workspace <path>] [resume flags]
  ${binary} sessions execute <session_id|latest> [--gateway-url <url>] [--workspace <path>] [--json]
  ${binary} sessions fork <session_id|latest> [message] [--gateway-url <url>] [--workspace <path>] [--json]
  ${binary} sessions reply <session_id|latest> <message> [--gateway-url <url>] [--request-id <id>] [--workspace <path>] [--json]
  ${binary} sessions interrupt|stop|kill <session_id|latest> [message] [--gateway-url <url>] [--request-id <id>] [--workspace <path>] [--json]
  ${binary} workers [list] [--session <session_id|latest>] [--limit N] [--workspace <path>] [--json]
  ${binary} workers show <worker_id|latest> [--session <session_id|latest>] [--workspace <path>] [--json]
  ${binary} workers watch <worker_id|latest> [--session <session_id|latest>] [--gateway-url <url>] [--protocol runtime|work] [--workspace <path>] [--jsonl]
  ${binary} workers stop <worker_id|latest> [--session <session_id|latest>] [--gateway-url <url>] [--workspace <path>] [--json]
  ${binary} workers continue <worker_id|latest> <message> [--session <session_id|latest>] [--gateway-url <url>] [--workspace <path>] [--json]
  ${binary} handoffs [list] [--session <session_id|latest>] [--limit N] [--workspace <path>] [--json]
  ${binary} handoffs show <handoff_id|latest> [--session <session_id|latest>] [--workspace <path>] [--json]
  ${binary} handoffs watch <handoff_id|latest> [--session <session_id|latest>] [--gateway-url <url>] [--protocol runtime|work] [--workspace <path>] [--jsonl]
  ${binary} handoffs take-back <handoff_id|latest> [--session <session_id|latest>] [--gateway-url <url>] [--workspace <path>] [--json]
  ${binary} approvals [list] [--session <session_id|latest>] [--status pending|approved|denied] [--limit N] [--gateway-url <url>] [--workspace <path>] [--json]
  ${binary} approvals show <approval_id|latest> [--session <session_id|latest>] [--gateway-url <url>] [--workspace <path>] [--json]
  ${binary} approvals pending [--session <session_id|latest>] [--limit N] [--gateway-url <url>] [--workspace <path>] [--json]
  ${binary} approvals approve <approval_id|latest> [--session <session_id|latest>] [--gateway-url <url>] [--workspace <path>] [--json]
  ${binary} approvals deny <approval_id|latest> [--session <session_id|latest>] [--gateway-url <url>] [--workspace <path>] [--json]
  ${binary} ps [--limit N] [--workspace <path>] [--json]
  ${binary} doctor [workflow_path] [--workflow WORKFLOW.md] [--workspace <path>]
  ${binary} logs [latest|log_name] [--tail N] [--limit N]
  ${binary} capabilities [list] [kind:<kind>|provider:<provider>|query...] [--all] [--include-disabled] [--workspace <path>] [--json]
  ${binary} capabilities show <capability_id> [--workspace <path>] [--json]
  ${binary} capabilities refresh [provider_id] [kind:<kind>|provider:<provider>|query...] [--all] [--include-disabled] [--workspace <path>] [--json]
  ${binary} capabilities enable <capability_id> [--workspace <path>] [--json]
  ${binary} capabilities disable <capability_id> [--workspace <path>] [--json]
  ${binary} capabilities hide <capability_id> [--workspace <path>] [--json]
  ${binary} capabilities unhide <capability_id> [--workspace <path>] [--json]
  ${binary} capabilities invoke <capability_id> [key=value...] [--session <session_id>] [--write-policy workspace_write|scoped_write|read_only] [--file-scope path1,path2] [--workspace <path>] [--json]
  ${binary} plugins [list] [--workspace <path>] [--json]
  ${binary} plugins show <plugin_id> [--workspace <path>] [--json]
  ${binary} plugins install <root_path> [--workspace <path>] [--json]
  ${binary} plugins remove-root <root_path> [--workspace <path>] [--json]
  ${binary} plugins refresh [--workspace <path>] [--json]
  ${binary} plugins enable <plugin_id> [--workspace <path>] [--json]
  ${binary} plugins disable <plugin_id> [--workspace <path>] [--json]
  ${binary} plugins validate [plugin_id] [--workspace <path>] [--json]
  ${binary} skills [list] [--workspace <path>] [--json]
  ${binary} skills show <skill_name> [--workspace <path>] [--json]
  ${binary} skills activate <skill_name> [--session <session_id>] [--reason <text>] [--workspace <path>] [--json]
  ${binary} mcp [list] [--workspace <path>] [--json]
  ${binary} mcp show <server_id> [--workspace <path>] [--json]
  ${binary} mcp refresh <server_id> [--workspace <path>] [--json]
  ${binary} mcp resources <server_id> [--workspace <path>] [--json]
  ${binary} mcp read <server_id> <uri> [--session <session_id>] [--workspace <path>] [--json]
  ${binary} mcp prompts <server_id> [--workspace <path>] [--json]
  ${binary} mcp prompt <server_id> <name> [key=value...] [--session <session_id>] [--workspace <path>] [--json]
  ${binary} lsp status|restart|logs [--provider typescript|python|rust|go] [--workspace <path>] [--json]
  ${binary} onboard
  ${binary} init
  ${binary} serve [--host 127.0.0.1] [--port 38171]
  ${binary} bench run <suite> [--workspace <path>]
  ${binary} bench report <run_id> [--workspace <path>]
  ${binary} bench compare <run_a> <run_b> [--workspace <path>]
  ${binary} symphony preview [--workflow WORKFLOW.md] [--workspace <path>] [--no-create]
  ${binary} symphony tick [--workflow WORKFLOW.md] [--workspace <path>] [--no-create]
  ${binary} symphony run-once [--workflow WORKFLOW.md] [--workspace <path>] [--max-turns 12]
  ${binary} symphony status [--workflow WORKFLOW.md] [--max-ticks 20]
  ${binary} symphony cleanup [--workflow WORKFLOW.md] [--execute]
  ${binary} symphony daemon [--workflow WORKFLOW.md] [--workspace <path>] [--execute] [--max-ticks 3]
  ${binary} config path
  ${binary} auth set-key [provider] <api-key>
  ${binary} providers list
  ${binary} providers add-openai <id> --name <name> --base-url <url> [--model <model>] [--api-key <key>]
  ${binary} providers add-claude <id> --name <name> --base-url <url> [--model <model>] [--api-key <key>]
  ${binary} providers refresh [provider]
  ${binary} providers models <provider>
  ${binary} models set --planner <provider/model> --worker <provider/model> --aggregator <provider/model>

Commands:
  chat       Open the interactive swarm TUI (also the default)
  version    Print the Swarm CLI version
  run        Run one objective non-interactively. Defaults to the local coding loop in auto mode.
  watch      Follow the live Gateway event stream for the current workspace
  live       Show the active Gateway-controlled live target and its current session summary
  reply      Send a live reply to the active Gateway-controlled run
  interrupt  Request an interrupt for the active Gateway-controlled coding loop
  runs       Inspect and watch Gateway runs
  checkpoints
             List, create, and revert local workspace checkpoints
  sessions   List, inspect, resume, execute, and fork persisted WorkSessions
  workers    Inspect, watch, stop, and continue persisted worker contracts
  handoffs   Inspect, watch, and take back persisted handoff contracts
  approvals  Inspect approval records and answer live Gateway approval requests
  ps         Alias for swarm sessions
  doctor     Diagnose local model setup, stores, extensions, logs, and Symphony preflight
  logs       List recent debug logs or tail the latest matching log file
  capabilities
             List, inspect, refresh, toggle, and invoke capability-plane surfaces
  plugins    List, inspect, validate, and manage plugin roots and plugin enablement
  skills     List, inspect, and activate discovered Agent Skills
  mcp        List, inspect, refresh, and read configured MCP servers, resources, and prompts
  lsp        Inspect local Language Server Protocol providers and logs
  bench      Run, report, or compare optimization benchmarks
  yolo       Open chat with temporary yolo permissions for this process
  onboard    Configure provider, model, and plaintext API key
  init       Create ~/.swarm with user-level settings and state folders
  serve      Start the local Swarm Gateway HTTP/event-stream server
  symphony   Preview, dispatch, run once, or poll local WorkItems into the shared Work Kernel
  config     Print config paths
  auth       Manage plaintext API keys in ~/.swarm/config.json
  providers  List built-in model providers
  models     Show or update selected models

Debug:
  --debug, --verbose, -v    Write one JSONL log per chat session to ~/.swarm/logs/
  --debug-trace             Same but with trace-level detail (envelope payloads, etc.)
                            Logs roll to .part-N when a file exceeds 1MB

Headless run artifacts:
  swarm run --json ...              Print a machine-readable run report to stdout
  swarm run --stream-json ...       Print JSONL run_start/runtime_event/run_end records to stdout
  swarm run --output-format FORMAT  Select text, json, or stream-json output
  swarm run --resume SESSION ...    Continue a previous WorkSession from headless mode
  swarm run --continue ...          Continue the latest WorkSession for this workspace
  swarm run --max-turns N ...       Cap local coding-loop turns for this run
  swarm run --max-tool-calls N ...  Cap local coding-loop tool calls for this run
  swarm run --allowed-tools LIST    Restrict this run to comma-separated tool names
  swarm run --disallowed-tools LIST Deny comma-separated tool names for this run
  swarm run --add-dir DIR ...       Add an extra read-only directory for this run
  swarm run --skill NAME ...        Activate a trusted skill for this run
  swarm run --skills LIST           Activate comma-separated trusted skills
  swarm run --mcp-config JSON_OR_FILE
                                    Load MCP servers for this run from JSON or a file
  swarm run --strict-mcp-config     Use only MCP servers from --mcp-config for this run
  swarm run --system-prompt TEXT    Replace the run's default behavior prompt
  swarm run --system-prompt-file FILE
                                    Read the replacement behavior prompt from FILE
  swarm run --append-system-prompt TEXT
                                    Append extra instructions to the run prompt
  swarm run --append-system-prompt-file FILE
                                    Read appended instructions from FILE
  swarm run --permission-mode MODE  Override approvals for this run: ask, auto-edit, full-auto, yolo
  swarm run --approval-mode wait    Wait for local \`swarm approvals approve|deny\` decisions instead of failing on approval
  swarm run --approval-timeout-ms N Timeout for --approval-mode wait, default 600000
  swarm run --sandbox MODE ...      Select workspace-write or read-only tool sandbox
  swarm run --read-only ...         Alias for --sandbox read-only
  swarm run --report FILE ...       Write the run report JSON to FILE
  swarm run --telemetry FILE ...    Write structured telemetry JSON to FILE
  swarm run --trajectory FILE ...   Write an ATIF-v1.7 trajectory JSON to FILE

Environment:
  SWARM_HOME             Override the user-level ~/.swarm directory
  SWARM_GATEWAY_URL      Override the default local Gateway URL for live-control commands
  SWARM_PERMISSION_MODE  Override permissions for this process: ask, auto-edit, full-auto, yolo
  SWARM_DEBUG=1          Equivalent to --debug
  SWARM_DEBUG_SESSION_ID Override the debug log session filename stem
  OPENAI_API_KEY          Environment key source if no plaintext key is configured
  SWARM_MODEL             Override the configured planner model
  SWARM_WORKER_MODEL      Override the configured worker model
  SWARM_AGGREGATOR_MODEL  Override the configured aggregator model
`);
  if (args.length > 0) {
    console.log(`Ignored arguments: ${args.join(" ")}`);
  }
}
