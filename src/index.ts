#!/usr/bin/env node
import { resolve as resolvePath } from "node:path";
import { buildHeadlessRunArtifacts, loadSwarmVersion, writeJsonArtifact, type CapturedRuntimeEvent } from "./runtime/headless-artifacts.js";

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
    setModelSelection({
      defaultProvider: options["default-provider"],
      planner: options.planner,
      worker: options.worker,
      aggregator: options.aggregator
    });
    console.log("Updated model selection.");
  } else if (!subcommand || subcommand === "show") {
    const settings = loadSwarmSettings();
    console.log(JSON.stringify(settings.models, null, 2));
  } else {
    console.error(`Unknown models command: ${subcommand}`);
    process.exitCode = 1;
  }
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
      const status = getSymphonyStatus({
        runtime,
        workflowPath: options.workflow,
        limit: maxTicks
      });
      printSymphonyStatus(status);
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
  if (!objective) {
    console.error("Usage: swarm run [--mode auto|chat|coding_loop|full_swarm] [--workspace <path>] [--json] [--report <path>] [--telemetry <path>] [--trajectory <path>] <objective>");
    process.exitCode = 1;
    return;
  }

  const { SwarmRuntime } = await import("./runtime/runtime.js");
  const { formatHeadlessProgress } = await import("./runtime/event-formatters.js");
  const mode = parseRunMode(options.mode);
  const jsonOutput = parseBooleanOption(options.json);
  const reportPath = normalizeOptionalPath(options.report);
  const telemetryPath = normalizeOptionalPath(options.telemetry);
  const trajectoryPath = normalizeOptionalPath(options.trajectory);
  const absoluteReportPath = reportPath ? resolvePath(reportPath) : undefined;
  const absoluteTelemetryPath = telemetryPath ? resolvePath(telemetryPath) : undefined;
  const absoluteTrajectoryPath = trajectoryPath ? resolvePath(trajectoryPath) : undefined;
  const capturedEvents: CapturedRuntimeEvent[] = [];
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const runtime = new SwarmRuntime({
    workspace: options.workspace,
    approvalHandler: async (request) => {
      throw new Error([
        `Headless run requires approval for ${request.summary}.`,
        `action=${request.action} risk=${request.risk_class}/${request.risk} target=${request.target}`,
        `why=${request.why_now}`,
        "Re-run in the TUI or change permission mode."
      ].join(" "));
    }
  });
  const unsubscribe = runtime.events.onEvent((event) => {
    capturedEvents.push({ at: new Date().toISOString(), event });
    const progress = formatHeadlessProgress(event);
    if (progress) {
      console.error(progress);
    }
  });

  let result: Awaited<ReturnType<typeof runtime.run>> | undefined;
  let runError: Error | undefined;
  try {
    result = await runtime.run(objective, { mode });
  } catch (error) {
    runError = error instanceof Error ? error : new Error(String(error));
    process.exitCode = 1;
  } finally {
    const endedAtMs = Date.now();
    const endedAt = new Date(endedAtMs).toISOString();
    const artifacts = buildHeadlessRunArtifacts({
      objective,
      workspace: runtime.workspaceRoot(),
      mode,
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

    if (jsonOutput) {
      console.log(JSON.stringify(artifacts.report, null, 2));
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
    }
    unsubscribe();
    runtime.dispose();
  }
}

function parseRunArgs(values: string[]): { options: Record<string, string>; objective: string } {
  const options: Record<string, string> = {};
  const objectiveParts: string[] = [];
  const valueFlags = new Set(["mode", "workspace", "report", "telemetry", "trajectory", "timeout-ms"]);
  const booleanFlags = new Set(["json", "yolo", "debug", "verbose", "debug-trace", "help"]);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value.startsWith("--")) {
      const key = value.slice(2);
      if (valueFlags.has(key)) {
        const next = values[index + 1];
        if (!next || next.startsWith("--")) {
          throw new Error(`${value} requires a value.`);
        }
        options[key] = next;
        index += 1;
      } else if (booleanFlags.has(key)) {
        options[key] = "true";
      } else {
        const next = values[index + 1];
        if (next && !next.startsWith("--")) {
          options[key] = next;
          index += 1;
        } else {
          options[key] = "true";
        }
      }
      continue;
    }
    objectiveParts.push(value);
  }
  return { options, objective: objectiveParts.join(" ").trim() };
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

function printSymphonyStatus(status: Awaited<ReturnType<typeof import("./symphony/status.js").getSymphonyStatus>>): void {
  if (!status.workflow.ok) {
    console.error(`${status.workflow.error.code}: ${status.workflow.error.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Workflow: ${status.workflow.workflow.path}`);
  console.log(`Sessions: ${status.totals.sessions} running=${status.totals.running} completed=${status.totals.completed} failed=${status.totals.failed} cancelled=${status.totals.cancelled} retrying=${status.totals.retrying}`);
  console.log(`Capacity: ${status.scheduler.capacity.running}/${status.scheduler.capacity.max_concurrent}`);
  if (status.scheduler.retrying.length) {
    console.log("Retrying:");
    for (const retry of status.scheduler.retrying.slice(0, 10)) {
      console.log(`  ${workItemDisplayName(retry.work_item)}: attempt=${retry.attempt} due=${retry.due_at}${retry.error ? ` error=${retry.error}` : ""}`);
    }
  }
  if (status.sessions.length) {
    console.log("Sessions:");
    for (const session of status.sessions.slice(0, 20)) {
      const source = workItemDisplayName(session.work_item);
      const runner = session.runner_attempt ? ` runner=${session.runner_attempt.status}` : "";
      const retry = session.next_retry_at ? ` retry=${session.next_retry_at}` : "";
      console.log(`  ${session.session_id} [${session.status}] ${source}${runner}${retry}`);
    }
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

function printHelp(): void {
  const binary = process.platform === "win32" ? "swarm" : "swarm";
  console.log(`Agent Swarm Protocol CLI

Usage:
  ${binary} [--debug] [--debug-trace]
  ${binary} --version
  ${binary} --yolo
  ${binary} yolo
  ${binary} chat [--debug]
  ${binary} run [--mode auto|chat|coding_loop|full_swarm] [--json] [--report <path>] [--telemetry <path>] [--trajectory <path>] <objective>
  ${binary} onboard
  ${binary} init
  ${binary} serve [--host 127.0.0.1] [--port 38171]
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
  swarm run --report FILE ...       Write the run report JSON to FILE
  swarm run --telemetry FILE ...    Write structured telemetry JSON to FILE
  swarm run --trajectory FILE ...   Write an ATIF-v1.7 trajectory JSON to FILE

Environment:
  SWARM_HOME             Override the user-level ~/.swarm directory
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
