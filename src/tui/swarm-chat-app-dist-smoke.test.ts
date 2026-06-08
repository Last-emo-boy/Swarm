import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import React from "react";
import { defaultSwarmConfig, defaultSwarmSettings } from "../config/settings.js";
import { resetDebugLogger } from "../runtime/debug-logger.js";

type DistTuiModule = {
  render: (node: React.ReactNode, options: Record<string, unknown>) => {
    unmount(): void;
    waitUntilExit(): Promise<void>;
  };
};

type DistSwarmChatAppModule = {
  SwarmChatApp: React.ComponentType;
};

test("built TUI accepts input and exits through the global dist entry path", async () => {
  const previousHome = process.env.SWARM_HOME;
  const previousDebug = process.env.SWARM_DEBUG;
  const previousDebugSessionId = process.env.SWARM_DEBUG_SESSION_ID;
  const home = mkdtempSync(join(tmpdir(), "swarm-tui-dist-smoke-"));
  createConfiguredSwarmHome(home);
  process.env.SWARM_HOME = home;
  process.env.SWARM_DEBUG = "true";
  process.env.SWARM_DEBUG_SESSION_ID = "swarm-tui-dist-smoke-test";
  resetDebugLogger();

  const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream & { columns: number; rows: number; isTTY: false };
  const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream;
  stdout.columns = 160;
  stdout.rows = 24;
  stdout.isTTY = false;
  let output = "";
  stdout.on("data", (chunk: Buffer | string) => {
    output += chunk.toString();
  });

  try {
    const distUiPath = new URL("../../dist/tui/ui.js", import.meta.url).href;
    const distAppPath = new URL("../../dist/tui/SwarmChatApp.js", import.meta.url).href;
    const [{ render }, { SwarmChatApp }] = await Promise.all([
      import(distUiPath) as Promise<DistTuiModule>,
      import(distAppPath) as Promise<DistSwarmChatAppModule>
    ]);
    const app = render(React.createElement(SwarmChatApp), {
      stdout,
      stderr: stdout,
      stdin,
      patchConsole: false
    });

    try {
      await waitFor(() => initialPromptVisible(stripAnsi(output)), "dist initial prompt render");
      await waitFor(
        () => stripAnsi(output).includes("Type a request"),
        "dist minimal footer render"
      );
      stdin.emit("data", "dist smoke input");
      await waitFor(() => stripAnsi(output).includes("dist smoke input"), "dist prompt text update");

      stdin.emit("data", "\x03");
      await withTimeout(app.waitUntilExit(), 1_000, "dist TUI did not exit after Ctrl+C");
      assert.equal(stdin.listenerCount("data"), 0);
    } finally {
      app.unmount();
    }

    const logContent = await waitForDebugLog(home);
    assert.match(logContent, /"section":"tui-input"/);
    assert.match(logContent, /"section":"tui-exit"/);
    assert.doesNotMatch(logContent, /dist smoke input/);
  } finally {
    resetDebugLogger();
    restoreEnv("SWARM_HOME", previousHome);
    restoreEnv("SWARM_DEBUG", previousDebug);
    restoreEnv("SWARM_DEBUG_SESSION_ID", previousDebugSessionId);
    await removeTree(home);
  }
});

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

function stripAnsi(value: string): string {
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "");
}

function initialPromptVisible(output: string): boolean {
  return output.includes("Ask Swarm") ||
    output.includes("Type a request") ||
    output.includes("❯");
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}.`);
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

async function waitForDebugLog(home: string): Promise<string> {
  const logsDir = join(home, "logs");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const content = readdirSync(logsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
      .map((entry) => readFileSync(join(logsDir, entry.name), "utf8"))
      .join("\n");
    if (content.includes("\"section\":\"tui-input\"") && content.includes("\"section\":\"tui-exit\"")) {
      return content;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for TUI debug telemetry log.");
}

async function removeTree(path: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      return;
    } catch (error) {
      if (attempt === 9) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
