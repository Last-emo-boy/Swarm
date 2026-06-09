import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import React from "react";
import { PassThrough } from "node:stream";
import { defaultSwarmConfig, defaultSwarmSettings } from "../config/settings.js";
import { resetDebugLogger } from "../runtime/debug-logger.js";
import { loadSwarmVersion } from "../runtime/headless-artifacts.js";
import { SwarmChatApp } from "./SwarmChatApp.js";
import { displayWidth } from "./display-width.js";
import { stripAnsi } from "./renderer/ansi.js";
import { render } from "./ui.js";

export type TuiSmokeCheckStatus = "pass" | "fail";

export type TuiSmokeCheck = {
  id: string;
  status: TuiSmokeCheckStatus;
  detail: string;
};

export type TuiSmokeHarnessResult = {
  kind: "swarm-tui-global-smoke-v4";
  createdAt: string;
  status: TuiSmokeCheckStatus;
  viewport: { columns: number; rows: number };
  outputDirectory: string;
  fakeHome: string;
  files: {
    ansiOutput: string;
    plainScreen: string;
    debugLog: string;
    summaryJson: string;
    checklist: string;
  };
  stats: {
    ansiBytes: number;
    plainRows: number;
    sgrCount: number;
    truecolorForegroundCount: number;
    distinctTruecolorForegrounds: string[];
    distinctAnsiSequences: string[];
  };
  checks: TuiSmokeCheck[];
};

type TuiSmokeHarnessOptions = {
  out?: string;
  columns?: number;
  rows?: number;
  createdAt?: string;
  sessionId?: string;
};

const DEFAULT_OUTPUT_DIR = ".swarm/tui-smoke-v4";
const SMOKE_INPUT = "tui smoke input";

export async function runTuiSmokeHarness(options: TuiSmokeHarnessOptions = {}): Promise<TuiSmokeHarnessResult> {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const outputDirectory = resolve(options.out ?? DEFAULT_OUTPUT_DIR);
  const fakeHome = resolve(outputDirectory, `home-${sanitizePathSegment(options.sessionId ?? "tui-smoke-v4")}-${Date.now()}`);
  const columns = options.columns ?? 100;
  const rows = options.rows ?? 30;
  const sessionId = options.sessionId ?? "tui-smoke-v4";
  mkdirSync(outputDirectory, { recursive: true });
  mkdirSync(fakeHome, { recursive: true });
  createConfiguredSwarmHome(fakeHome);

  const previousEnv = snapshotEnv([
    "SWARM_HOME",
    "SWARM_DEBUG",
    "SWARM_DEBUG_LEVEL",
    "SWARM_DEBUG_SESSION_ID",
    "SWARM_PERMISSION_MODE",
    "TERM_PROGRAM",
    "TERM",
    "COLORTERM",
    "FORCE_COLOR",
    "NO_COLOR",
    "SWARM_TUI_NO_COLOR",
    "SWARM_TUI_TRUECOLOR"
  ]);

  const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream & {
    columns: number;
    rows: number;
    isTTY: false;
  };
  const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream;
  stdout.columns = columns;
  stdout.rows = rows;
  stdout.isTTY = false;
  let ansiOutput = "";
  stdout.on("data", (chunk: Buffer | string) => {
    ansiOutput += chunk.toString();
  });

  try {
    process.env.SWARM_HOME = fakeHome;
    process.env.SWARM_DEBUG = "true";
    process.env.SWARM_DEBUG_LEVEL = "debug";
    process.env.SWARM_DEBUG_SESSION_ID = sessionId;
    process.env.SWARM_PERMISSION_MODE = "yolo";
    process.env.TERM_PROGRAM = "vscode";
    process.env.TERM = "xterm-256color";
    process.env.COLORTERM = "truecolor";
    process.env.FORCE_COLOR = "3";
    process.env.SWARM_TUI_TRUECOLOR = "1";
    delete process.env.NO_COLOR;
    delete process.env.SWARM_TUI_NO_COLOR;
    resetDebugLogger();

    const beforeSigcontListeners = process.listenerCount("SIGCONT");
    const app = render(React.createElement(SwarmChatApp), {
      stdout,
      stderr: stdout,
      stdin,
      columns,
      rows,
      patchConsole: false
    });

    try {
      await waitFor(() => initialPromptVisible(terminalScreenText(ansiOutput)), "initial prompt render");
      stdin.emit("data", "\r");
      await delay(50);
      stdin.emit("data", SMOKE_INPUT);
      await waitFor(() => terminalScreenText(ansiOutput).includes(SMOKE_INPUT), "stdin prompt echo");
      stdin.emit("data", "\x03");
      await withTimeout(app.waitUntilExit(), 1_000, "TUI did not exit after Ctrl+C");
      await delay(20);

      const plainScreen = terminalScreenText(ansiOutput);
      const debugLog = await waitForDebugLog(fakeHome);
      const stats = outputStats(ansiOutput, plainScreen);
      const checks = smokeChecks({
        plainScreen,
        ansiOutput,
        debugLog,
        stats,
        stdinDataListeners: stdin.listenerCount("data"),
        stdoutResizeListeners: stdout.listenerCount("resize"),
        beforeSigcontListeners,
        afterSigcontListeners: process.listenerCount("SIGCONT")
      });
      const status = checks.every((check) => check.status === "pass") ? "pass" : "fail";
      const files = writeSmokeFiles({
        outputDirectory,
        ansiOutput,
        plainScreen,
        debugLog,
        result: {
          kind: "swarm-tui-global-smoke-v4",
          createdAt,
          status,
          viewport: { columns, rows },
          outputDirectory,
          fakeHome,
          files: {
            ansiOutput: resolve(outputDirectory, "stdout.ansi"),
            plainScreen: resolve(outputDirectory, "screen.txt"),
            debugLog: resolve(outputDirectory, "debug.log"),
            summaryJson: resolve(outputDirectory, "summary.json"),
            checklist: resolve(outputDirectory, "checklist.md")
          },
          stats,
          checks
        }
      });

      return {
        kind: "swarm-tui-global-smoke-v4",
        createdAt,
        status,
        viewport: { columns, rows },
        outputDirectory,
        fakeHome,
        files,
        stats,
        checks
      };
    } finally {
      app.unmount();
    }
  } finally {
    resetDebugLogger();
    restoreEnv(previousEnv);
  }
}

export async function runTuiSmokeHarnessCli(argv = process.argv.slice(2)): Promise<void> {
  const options = parseCliOptions(argv);
  const result = await runTuiSmokeHarness(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatTuiSmokeHarnessResult(result));
  }
  if (result.status !== "pass") {
    process.exitCode = 1;
  }
}

function formatTuiSmokeHarnessResult(result: TuiSmokeHarnessResult): string {
  return [
    `Swarm TUI global smoke: ${result.status}`,
    `created_at=${result.createdAt}`,
    `viewport=${result.viewport.columns}x${result.viewport.rows}`,
    `output=${result.outputDirectory}`,
    `colors=truecolor_fg=${result.stats.truecolorForegroundCount} sgr=${result.stats.sgrCount}`,
    "",
    ...result.checks.map((check) => `${check.status.toUpperCase()} ${check.id}: ${check.detail}`),
    "",
    `summary=${result.files.summaryJson}`,
    `screen=${result.files.plainScreen}`,
    `ansi=${result.files.ansiOutput}`,
    `log=${result.files.debugLog}`
  ].join("\n");
}

function createConfiguredSwarmHome(home: string): void {
  mkdirSync(home, { recursive: true });
  const settings = defaultSwarmSettings();
  settings.models.defaultProvider = "local-test";
  settings.models.planner = "local-test/model";
  settings.models.worker = "local-test/model";
  settings.models.aggregator = "local-test/model";
  settings.enabledProviders = ["local-test"];
  settings.runtime.databasePath = join(home, "state", "swarm.db");
  settings.providers["local-test"] = {
    id: "local-test",
    name: "Local Test Provider",
    protocol: "openai-chat-completions",
    baseURL: "http://127.0.0.1/v1",
    modelListProtocol: "none",
    apiKeyEnv: "LOCAL_TEST_API_KEY",
    apiKeyRequired: false,
    auth: "none",
    models: {
      model: { name: "Local Test Model" }
    }
  };
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  writeFileSync(join(home, "config.json"), `${JSON.stringify(defaultSwarmConfig(), null, 2)}\n`, "utf8");
}

function smokeChecks(input: {
  plainScreen: string;
  ansiOutput: string;
  debugLog: string;
  stats: TuiSmokeHarnessResult["stats"];
  stdinDataListeners: number;
  stdoutResizeListeners: number;
  beforeSigcontListeners: number;
  afterSigcontListeners: number;
}): TuiSmokeCheck[] {
  return [
    check(
      "prompt-visible",
      initialPromptVisible(input.plainScreen) || input.plainScreen.includes(SMOKE_INPUT),
      "Prompt/input row is visible in reconstructed screen."
    ),
    check(
      "semantic-truecolor",
      input.stats.truecolorForegroundCount >= 4 && input.ansiOutput.includes("\u001B[38;2;224;151;88m"),
      `captured ${input.stats.truecolorForegroundCount} distinct truecolor foregrounds.`
    ),
    check(
      "empty-enter-guard",
      !input.plainScreen.includes("COMMAND OUTPUT"),
      "empty Enter does not open the COMMAND OUTPUT detail pane."
    ),
    check(
      "debug-log-clean",
      input.debugLog.includes("\"section\":\"tui-input\"") &&
        input.debugLog.includes("\"section\":\"tui-exit\"") &&
        !/must be rendered inside <Text>|can't be nested inside <Text>|createTextInstance|Unhandled|uncaughtException|TypeError|ReferenceError/u.test(input.debugLog),
      "debug log contains tui-input/tui-exit and no renderer crash signature."
    ),
    check("input-redacted", !input.debugLog.includes(SMOKE_INPUT), "debug log does not record raw prompt text."),
    check(
      "ctrl-c-cleanup",
      input.stdinDataListeners === 0 && input.stdoutResizeListeners === 0 && input.afterSigcontListeners === input.beforeSigcontListeners,
      "Ctrl+C exits and input/resize/SIGCONT handlers are cleaned up."
    )
  ];
}

function initialPromptVisible(screen: string): boolean {
  return screen.includes("Ask Swarm") ||
    screen.includes("Type a request") ||
    screen.includes("❯");
}

function check(id: string, passed: boolean, detail: string): TuiSmokeCheck {
  return { id, status: passed ? "pass" : "fail", detail };
}

function outputStats(ansiOutput: string, plainScreen: string): TuiSmokeHarnessResult["stats"] {
  const distinctAnsiSequences = [...new Set(ansiOutput.match(/\u001B\[[0-?]*[ -/]*m/gu) ?? [])];
  const distinctTruecolorForegrounds = [
    ...new Set([...ansiOutput.matchAll(/\u001B\[[^m]*38;2;(\d+;\d+;\d+)[^m]*m/gu)].map((match) => match[1] ?? ""))
  ].filter(Boolean).sort();
  return {
    ansiBytes: Buffer.byteLength(ansiOutput, "utf8"),
    plainRows: terminalRows(plainScreen).length,
    sgrCount: ansiOutput.match(/\u001B\[[0-?]*[ -/]*m/gu)?.length ?? 0,
    truecolorForegroundCount: distinctTruecolorForegrounds.length,
    distinctTruecolorForegrounds,
    distinctAnsiSequences: distinctAnsiSequences.slice(0, 40)
  };
}

function writeSmokeFiles(input: {
  outputDirectory: string;
  ansiOutput: string;
  plainScreen: string;
  debugLog: string;
  result: TuiSmokeHarnessResult;
}): TuiSmokeHarnessResult["files"] {
  const files = input.result.files;
  writeFileSync(files.ansiOutput, input.ansiOutput, "utf8");
  writeFileSync(files.plainScreen, `${input.plainScreen}\n`, "utf8");
  writeFileSync(files.debugLog, input.debugLog, "utf8");
  writeFileSync(files.summaryJson, `${JSON.stringify(input.result, null, 2)}\n`, "utf8");
  writeFileSync(files.checklist, `${formatChecklist(input.result)}\n`, "utf8");
  return files;
}

function formatChecklist(result: TuiSmokeHarnessResult): string {
  return [
    "# Swarm TUI Global Smoke V4",
    "",
    `- Created: ${result.createdAt}`,
    `- Version: ${loadSwarmVersion()}`,
    `- Viewport: ${result.viewport.columns}x${result.viewport.rows}`,
    `- Status: ${result.status}`,
    "",
    "## Evidence",
    "",
    `- ANSI output: \`${result.files.ansiOutput}\``,
    `- Plain screen: \`${result.files.plainScreen}\``,
    `- Debug log: \`${result.files.debugLog}\``,
    `- Summary: \`${result.files.summaryJson}\``,
    "",
    "## Checks",
    "",
    ...result.checks.map((check) => `- [${check.status === "pass" ? "x" : " "}] ${check.id}: ${check.detail}`),
    "",
    "## Manual Follow-Up",
    "",
    "- Run `npm run build && npm install -g .` when validating the installed binary.",
    "- Run `swarm --yolo --debug` in a real terminal and confirm the same visual properties: multiple semantic colors, no automatic COMMAND OUTPUT focus jump on empty Enter, clean Ctrl+C exit, and no Ink/Text crash in `swarm logs latest`."
  ].join("\n");
}

function terminalScreenText(value: string): string {
  const rows: string[][] = [];
  let cursorRow = 0;
  let cursorColumn = 0;

  function ensureRow(row: number): string[] {
    while (rows.length <= row) {
      rows.push([]);
    }
    return rows[row]!;
  }

  function write(text: string): void {
    for (const char of stripAnsi(text)) {
      if (char === "\n") {
        cursorRow += 1;
        cursorColumn = 0;
        continue;
      }
      if (char === "\r") {
        cursorColumn = 0;
        continue;
      }
      const row = ensureRow(cursorRow);
      row[cursorColumn] = char;
      cursorColumn += Math.max(1, displayWidth(char));
    }
  }

  const tokenPattern = /\u001B\[(\d+)(?:;(\d+))?([HJK])|\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu;
  let offset = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(value))) {
    write(value.slice(offset, match.index));
    offset = tokenPattern.lastIndex;
    const command = match[3];
    if (command === "J" && match[1] === "2") {
      rows.splice(0);
      cursorRow = 0;
      cursorColumn = 0;
    } else if (command === "H") {
      cursorRow = Math.max(0, Number.parseInt(match[1] ?? "1", 10) - 1);
      cursorColumn = Math.max(0, Number.parseInt(match[2] ?? "1", 10) - 1);
    } else if (command === "K" && match[1] === "2") {
      rows[cursorRow] = [];
      cursorColumn = 0;
    }
  }
  write(value.slice(offset));

  return terminalRows(rows.map((row) => row.join("").trimEnd()).join("\n")).join("\n");
}

function terminalRows(value: string): string[] {
  const rows = value.split(/\r?\n/u);
  while (rows.at(-1) === "") {
    rows.pop();
  }
  return rows;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) {
      return;
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function waitForDebugLog(home: string): Promise<string> {
  const logsDir = join(home, "logs");
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const content = readLogFiles(logsDir);
    if (content.includes("\"section\":\"tui-input\"") && content.includes("\"section\":\"tui-exit\"")) {
      return content;
    }
    await delay(10);
  }
  throw new Error("Timed out waiting for TUI debug telemetry log.");
}

function readLogFiles(logsDir: string): string {
  try {
    return readdirSync(logsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => readFileSync(join(logsDir, entry.name), "utf8"))
      .join("\n");
  } catch {
    return "";
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(label)), ms);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCliOptions(argv: string[]): TuiSmokeHarnessOptions & { json?: boolean } {
  const options: TuiSmokeHarnessOptions & { json?: boolean } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") {
      options.json = true;
      continue;
    }
    if (value === "--out") {
      options.out = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--columns") {
      options.columns = parsePositiveInteger(argv[index + 1], "--columns");
      index += 1;
      continue;
    }
    if (value === "--rows") {
      options.rows = parsePositiveInteger(argv[index + 1], "--rows");
      index += 1;
      continue;
    }
    throw new Error(`Unknown tui-smoke option: ${value}`);
  }
  return options;
}

function parsePositiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function snapshotEnv(keys: string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function sanitizePathSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "session";
}

function restoreEnv(snapshot: Map<string, string | undefined>): void {
  for (const [key, value] of snapshot.entries()) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function isDirectCli(): boolean {
  const invoked = process.argv[1];
  return Boolean(invoked && pathToFileURL(resolve(invoked)).href === import.meta.url);
}

if (isDirectCli()) {
  runTuiSmokeHarnessCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
