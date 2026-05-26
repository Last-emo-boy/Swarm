import { resolve } from "node:path";
import { LspManager, type LspLogReport, type LspProviderStatus, type LspStatusReport } from "./manager.js";

type LspCliStatusSummary = {
  health: string;
  semanticGraphHealth: string;
  providers: number;
  readyProviders: number;
  fallbackProviders: number;
  partialProviders: number;
  unavailableProviders: number;
  failedProviders: number;
  semanticEvidenceSources: string[];
  staleReasons: string[];
  fallbackReasons: string[];
  nextActions: string[];
};

export async function runLspCommand(values: string[]): Promise<void> {
  const { positionals, options } = parseOptions(values);
  const subcommand = positionals[0] ?? "status";
  const workspace = resolve(options.workspace ?? process.cwd());
  const provider = options.provider;
  const jsonOutput = parseBooleanOption(options.json);
  const manager = new LspManager(workspace);

  try {
    if (subcommand === "status" || subcommand === "list") {
      const report = await manager.status(provider);
      printLspStatus(report, jsonOutput);
      return;
    }
    if (subcommand === "restart") {
      const report = await manager.restart(provider);
      printLspStatus(report, jsonOutput);
      return;
    }
    if (subcommand === "logs" || subcommand === "log") {
      const maxBytes = parsePositiveInteger(options.tail ?? options.bytes ?? options["max-bytes"]) ?? 64 * 1024;
      const reports = await manager.logs(provider, maxBytes);
      printLspLogs(reports, jsonOutput, parsePositiveInteger(options.lines));
      return;
    }
    if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
      printLspHelp();
      return;
    }
    console.error(`Unknown lsp command: ${subcommand}`);
    printLspHelp();
    process.exitCode = 1;
  } finally {
    await manager.dispose();
  }
}

export function formatLspStatusReport(report: LspStatusReport): string {
  const summary = lspStatusSummary(report);
  const lines = [
    "LSP",
    `workspace=${report.workspace}`,
    `health=${summary.health} semantic_graph=${summary.semanticGraphHealth} providers=${summary.providers} ready=${summary.readyProviders} fallback=${summary.fallbackProviders} partial=${summary.partialProviders} unavailable=${summary.unavailableProviders} failed=${summary.failedProviders}`,
    summary.semanticEvidenceSources.length ? `semantic_sources=${summary.semanticEvidenceSources.join(",")}` : undefined,
    summary.staleReasons.length ? `stale_reasons=${summary.staleReasons.join(",")}` : undefined,
    summary.fallbackReasons.length ? `fallback_reasons=${summary.fallbackReasons.join(",")}` : undefined,
    summary.nextActions.length ? `next=${summary.nextActions.join(" | ")}` : undefined,
    ...report.providers.map(formatProviderStatus)
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

function lspStatusSummary(report: LspStatusReport): LspCliStatusSummary {
  const relevant = report.providers.filter((provider) => provider.detected);
  const failedProviders = relevant.filter((provider) => provider.status === "failed" || provider.status === "exited");
  const unavailableProviders = relevant.filter((provider) => provider.status === "unavailable" || !provider.available);
  const fallbackProviders = relevant.filter((provider) =>
    provider.capabilities?.some((capability) => capability.available && capability.mode === "typescript_semantic_fallback")
  );
  const partialProviders = relevant.filter((provider) =>
    provider.capabilities?.some((capability) => !capability.available || capability.fallback_reason === "partial_capability")
  );
  const readyProviders = relevant.filter((provider) => provider.status === "ready" || (provider.status === "stopped" && provider.available));
  const fallbackReasons = uniqueStrings(relevant.flatMap((provider) =>
    provider.capabilities?.flatMap((capability) => capability.fallback_reason ? [capability.fallback_reason] : []) ?? []
  ));
  const semanticEvidenceSources = uniqueStrings(relevant.flatMap((provider) =>
    provider.capabilities?.map((capability) => capability.mode) ?? []
  ));
  const staleReasons = uniqueStrings(relevant.flatMap((provider) =>
    provider.capabilities?.flatMap((capability) =>
      !capability.available && capability.fallback_reason ? [capability.fallback_reason] : []
    ) ?? []
  ));
  return {
    health: lspHealth({
      failed: failedProviders.length,
      unavailable: unavailableProviders.length,
      starting: relevant.filter((provider) => provider.status === "starting").length,
      partial: partialProviders.length,
      fallback: fallbackProviders.length,
      external: relevant.filter((provider) => provider.status === "external").length,
      ready: readyProviders.length
    }),
    semanticGraphHealth: semanticGraphHealth({
      failed: failedProviders.length,
      unavailable: unavailableProviders.length,
      partial: partialProviders.length,
      fallback: fallbackProviders.length,
      ready: readyProviders.length
    }),
    providers: relevant.length,
    readyProviders: readyProviders.length,
    fallbackProviders: fallbackProviders.length,
    partialProviders: partialProviders.length,
    unavailableProviders: unavailableProviders.length,
    failedProviders: failedProviders.length,
    semanticEvidenceSources,
    staleReasons,
    fallbackReasons,
    nextActions: uniqueStrings(relevant.flatMap((provider) =>
      provider.capabilities?.flatMap((capability) => capability.next_action ? [capability.next_action] : []) ?? []
    )).slice(0, 4)
  };
}

function lspHealth(counts: {
  failed: number;
  unavailable: number;
  starting: number;
  partial: number;
  fallback: number;
  external: number;
  ready: number;
}): string {
  if (counts.failed > 0) return "failed";
  if (counts.unavailable > 0) return "unavailable";
  if (counts.starting > 0) return "starting";
  if (counts.partial > 0) return "partial";
  if (counts.fallback > 0) return "fallback";
  if (counts.external > 0) return "external";
  if (counts.ready > 0) return "ready";
  return "unknown";
}

function semanticGraphHealth(counts: {
  failed: number;
  unavailable: number;
  partial: number;
  fallback: number;
  ready: number;
}): string {
  if (counts.failed > 0 || counts.unavailable > 0) return "unavailable";
  if (counts.partial > 0) return "partial";
  if (counts.fallback > 0) return "fallback";
  if (counts.ready > 0) return "ready";
  return "unknown";
}

function formatProviderStatus(status: LspProviderStatus): string {
  const capabilities = status.capabilities ?? [];
  const fallbackReasons = uniqueStrings(capabilities.flatMap((capability) => capability.fallback_reason ? [capability.fallback_reason] : []));
  const nextActions = uniqueStrings(capabilities.flatMap((capability) => capability.next_action ? [capability.next_action] : [])).slice(0, 2);
  return [
    `${status.providerId}:`,
    `status=${status.status}`,
    `detected=${status.detected}`,
    `available=${status.available}`,
    `language_ids=${status.languageIds.join(",")}`,
    capabilities.length
      ? `capabilities=${capabilities.filter((capability) => capability.available).length}/${capabilities.length} modes=${uniqueStrings(capabilities.map((capability) => capability.mode)).join(",")}`
      : undefined,
    fallbackReasons.length ? `fallback_reasons=${fallbackReasons.join(",")}` : undefined,
    nextActions.length ? `next=${nextActions.join(" | ")}` : undefined,
    status.pid !== undefined ? `pid=${status.pid}` : undefined,
    status.command ? `command=${status.command}${status.args?.length ? ` ${status.args.join(" ")}` : ""}` : undefined,
    status.reason ? `reason=${status.reason}` : undefined,
    status.lastError && status.status !== "unavailable" ? `error=${status.lastError}` : undefined,
    `log=${status.logPath}`
  ].filter(Boolean).join(" ");
}

function printLspStatus(report: LspStatusReport, jsonOutput: boolean): void {
  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(formatLspStatusReport(report));
}

function printLspLogs(reports: LspLogReport[], jsonOutput: boolean, lines?: number): void {
  if (jsonOutput) {
    console.log(JSON.stringify({ logs: reports }, null, 2));
    return;
  }
  for (const [index, report] of reports.entries()) {
    if (index > 0) {
      console.log("");
    }
    console.log(`${report.providerId}: ${report.logPath}`);
    const content = lines ? report.content.split(/\r?\n/).slice(-lines).join("\n") : report.content;
    console.log(content.trimEnd() || "(empty)");
  }
}

function printLspHelp(): void {
  console.log("Usage: swarm lsp status [--provider typescript|python|rust|go] [--workspace <path>] [--json]");
  console.log("       swarm lsp restart [--provider typescript|python|rust|go] [--workspace <path>] [--json]");
  console.log("       swarm lsp logs [--provider typescript|python|rust|go] [--workspace <path>] [--tail N] [--lines N] [--json]");
  console.log("       When unavailable, fall back to file.grep/file.read or add an LSP provider for the language.");
}

function parseOptions(values: string[]): { positionals: string[]; options: Record<string, string> } {
  const positionals: string[] = [];
  const options: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = "true";
    }
  }
  return { positionals, options };
}

function parseBooleanOption(value: string | undefined): boolean {
  return value === "true" || value === "1" || value === "yes";
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
