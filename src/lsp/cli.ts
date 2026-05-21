import { resolve } from "node:path";
import { LspManager, type LspLogReport, type LspProviderStatus, type LspStatusReport } from "./manager.js";

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
  const lines = [
    "LSP",
    `workspace=${report.workspace}`,
    ...report.providers.map(formatProviderStatus)
  ];
  return lines.join("\n");
}

function formatProviderStatus(status: LspProviderStatus): string {
  return [
    `${status.providerId}:`,
    `status=${status.status}`,
    `detected=${status.detected}`,
    `available=${status.available}`,
    `language_ids=${status.languageIds.join(",")}`,
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
