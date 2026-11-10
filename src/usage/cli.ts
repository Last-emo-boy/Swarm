/**
 * `swarm usage`: what this device's model calls and harness turns used and cost since a time, grouped by model, provider,
 * harness, device, ticket or day, with the budgets' state; `--all-devices` adds every paired device that answers.
 */
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { getSwarmPaths, loadSwarmSettings } from "../config/settings.js";
import { meshHome, readMesh } from "../mesh/state.js";
import { budgetStatus, type CapStatus } from "./budget.js";
import { LEDGER_GROUPINGS, groupLedger, openUsageDatabase, priceLedger, readLedger, totalOf, type LedgerEntry, type LedgerGrouping, type LedgerTotal } from "./ledger.js";
import { mergedPrices } from "./prices.js";
import { budgetLines, usageTable } from "./report.js";

const USAGE = `Usage: swarm usage [--since 24h|7d|30d|<date>] [--by model|provider|harness|device|ticket|day|source|purpose] [--all-devices] [--json]

Each model call and harness turn counts once, with its tokens and its cost from the price table (usage.prices in
${getSwarmPaths().settingsPath} replaces or adds prices; a model without one shows its tokens and "unpriced").
--since defaults to 7d; a date such as 2026-11-01 starts at its local midnight. --by defaults to model.
--all-devices adds the paired devices that answer, and names those that do not.`;

export interface UsageOptions { since: Date; sinceLabel: string; by: LedgerGrouping; allDevices: boolean; json: boolean }

/** `24h`, `7d`, `30d` (any number of hours or days back from `now`), a date (its local midnight), or an ISO time. */
export function parseSince(value: string, now = new Date()): Date {
  const relative = /^(\d+)([hd])$/.exec(value.trim());
  if (relative) return new Date(now.getTime() - Number(relative[1]) * (relative[2] === "h" ? 3_600_000 : 86_400_000));
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  const date = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`--since takes 24h, 7d, 30d or a date such as 2026-11-01, not "${value}"`);
  return date;
}

export function parseUsageArgs(args: readonly string[], now = new Date()): UsageOptions {
  const options: UsageOptions = { since: parseSince("7d", now), sinceLabel: "7d", by: "model", allDevices: false, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const next = () => {
      const value = inline ?? args[++index];
      if (value === undefined) throw new Error(`${flag} needs a value\n\n${USAGE}`);
      return value;
    };
    if (flag === "--since") {
      const value = next();
      options.since = parseSince(value, now);
      options.sinceLabel = value;
    } else if (flag === "--by") {
      const value = next() as LedgerGrouping;
      if (!LEDGER_GROUPINGS.includes(value)) throw new Error(`--by takes ${LEDGER_GROUPINGS.join(", ")}, not "${value}"`);
      options.by = value;
    } else if (flag === "--all-devices") options.allDevices = true;
    else if (flag === "--json") options.json = true;
    else throw new Error(`Unknown option ${arg}\n\n${USAGE}`);
  }
  return options;
}

/** This device's name in the mesh, or its host name before it has mesh state. */
export const thisDevice = (home = meshHome()): string => existsSync(join(home, "state.json")) ? readMesh(home).node.name : hostname().replace(/\.local$/, "");

/** A device the report read, with its calls, or skipped with why. */
export interface DeviceRead { device: string; calls?: number; skipped?: string; truncated?: boolean }

/** The ledger of this device and, with `allDevices`, of each paired device that answers; those that do not are named. */
export async function collectUsage(options: { since: Date; allDevices: boolean; databasePath?: string; meshHome?: string; timeoutMs?: number }): Promise<{ entries: LedgerEntry[]; devices: DeviceRead[] }> {
  const home = options.meshHome ?? meshHome();
  const device = thisDevice(home);
  const database = openUsageDatabase(options.databasePath ?? loadSwarmSettings().runtime.databasePath);
  let entries: LedgerEntry[];
  try { entries = database ? readLedger(database, device, { since: options.since }) : []; } finally { database?.close(); }
  const devices: DeviceRead[] = [{ device, calls: entries.length }];
  if (!options.allDevices || !existsSync(join(home, "state.json"))) return { entries, devices };
  const [{ peerUsage }, { MeshError }] = await Promise.all([import("../mesh/usage.js"), import("../mesh/client.js")]);
  const peers = readMesh(home).peers;
  // A device whose Swarm predates the usage route answers 404; one that does not answer at all is named with why.
  const answers = await Promise.all(peers.map((peer) => peerUsage(peer, options.since, options.timeoutMs).then(
    (answer) => ({ answer }), (error: unknown) => ({ error: error instanceof MeshError && error.status === 404
      ? "its Swarm does not share usage yet; update it with swarm update"
      : `it did not answer (${error instanceof Error ? error.message : String(error)})` }))));
  peers.forEach((peer, index) => {
    const read = answers[index]!;
    if ("error" in read) {
      devices.push({ device: peer.name, skipped: read.error });
      return;
    }
    entries.push(...read.answer.entries);
    devices.push({ device: peer.name, calls: read.answer.entries.length, ...(read.answer.truncated ? { truncated: true } : {}) });
  });
  return { entries, devices };
}

export interface UsageReport { since: string; by: LedgerGrouping; devices: DeviceRead[]; rows: LedgerTotal[]; total: LedgerTotal; budgets: CapStatus[] }

/** The ledger priced with this device's prices and grouped, with this device's budgets. */
export function usageReport(entries: readonly LedgerEntry[], devices: DeviceRead[], options: Pick<UsageOptions, "since" | "by">,
  settings = loadSwarmSettings(), budgets?: CapStatus[]): UsageReport {
  const priced = priceLedger(entries, mergedPrices(settings.usage.prices));
  return { since: options.since.toISOString(), by: options.by, devices, rows: groupLedger(priced, options.by), total: totalOf(priced), budgets: budgets ?? [] };
}

export function usageText(report: UsageReport, sinceLabel: string): string {
  const since = new Date(report.since);
  const read = report.devices.filter((device) => !device.skipped).map((device) => device.device);
  const lines = [`Model calls and harness turns since ${since.toLocaleString()} (${sinceLabel}), by ${report.by}, on ${read.join(", ")}:`, ""];
  lines.push(...(report.total.calls ? usageTable(report.rows, report.total, report.by) : ["  No model calls recorded in this time."]));
  for (const device of report.devices) {
    if (device.skipped) lines.push("", `Skipped ${device.device}: ${device.skipped}.`);
    if (device.truncated) lines.push("", `${device.device} sent only its latest calls; the earlier ones are not counted.`);
  }
  lines.push("", report.budgets.length ? "Budgets on this device:" : `Budgets: none set (usage.budgets in ${getSwarmPaths().settingsPath}).`);
  lines.push(...budgetLines(report.budgets));
  return lines.join("\n");
}

export async function runUsageCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    console.log(USAGE);
    return;
  }
  const options = parseUsageArgs(args);
  const settings = loadSwarmSettings();
  const { entries, devices } = await collectUsage({ since: options.since, allDevices: options.allDevices, databasePath: settings.runtime.databasePath });
  const database = openUsageDatabase(settings.runtime.databasePath);
  let budgets: CapStatus[];
  try { budgets = budgetStatus(settings, database); } finally { database?.close(); }
  const report = usageReport(entries, devices, options, settings, budgets);
  console.log(options.json ? JSON.stringify(report, null, 2) : usageText(report, options.sinceLabel));
}
