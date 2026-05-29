import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import React from "react";
import { defaultSwarmConfig, defaultSwarmSettings } from "../config/settings.js";
import { resetDebugLogger } from "../runtime/debug-logger.js";
import { SwarmChatApp } from "./SwarmChatApp.js";
import { render } from "./ui.js";

test("SwarmChatApp renders prompt chrome, accepts stdin, logs redacted telemetry, and exits cleanly", async () => {
  const previousHome = process.env.SWARM_HOME;
  const previousDebug = process.env.SWARM_DEBUG;
  const previousDebugSessionId = process.env.SWARM_DEBUG_SESSION_ID;
  const home = mkdtempSync(join(tmpdir(), "swarm-tui-interaction-"));
  process.env.SWARM_HOME = home;
  createConfiguredSwarmHome(home);
  process.env.SWARM_DEBUG = "true";
  process.env.SWARM_DEBUG_SESSION_ID = "swarm-tui-interaction-test";
  resetDebugLogger();

  const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream & { columns: number; rows: number; isTTY: false };
  const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream;
  stdout.columns = 160;
  stdout.rows = 32;
  stdout.isTTY = false;
  let output = "";
  stdout.on("data", (chunk: Buffer | string) => {
    output += chunk.toString();
  });

  const beforeSigcontListeners = process.listenerCount("SIGCONT");
  const app = render(React.createElement(SwarmChatApp), {
    stdout,
    stderr: stdout,
    stdin,
    patchConsole: false
  });

  try {
    await waitFor(() => stripAnsi(output).includes("Reply to selected case or create the next case"), "initial prompt render");
    await waitFor(() => stripAnsi(output).includes("[CASE]") || stripAnsi(output).includes("Reply to selected case"), "board case composer render");
    await waitFor(() => stripAnsi(output).includes("Local Agent Workspace"), "workspace title render");
    const initialScreen = stripAnsi(output);
    assert.match(initialScreen, /Cases are the workbench source of truth/);
    assert.match(initialScreen, /WORK BOARD|No work items yet\./);
    assert.match(initialScreen, /Board/);
    assert.match(initialScreen, /Tasks/);
    assert.match(initialScreen, /Workers/);
    assert.match(initialScreen, /Activity/);
    assert.match(initialScreen, /Output/);
    assert.match(initialScreen, /Skills/);
    assert.match(initialScreen, /Automations/);
    assert.match(initialScreen, /Trace/);
    assert.match(initialScreen, /Chat/);
    assert.match(initialScreen, /Run/);
    assert.doesNotMatch(initialScreen, /Overview|Blackboard|Attempts|run evidence|Current Mode|Active Tools|Model \/ Provider/);
    const secretPrompt = "secret phrase 123";
    stdin.emit("data", secretPrompt);
    await waitFor(() => stripAnsi(output).includes(secretPrompt), "prompt text update from stdin");

    assert.equal(stdin.listenerCount("data"), 1);
    stdin.emit("data", "\x03");
    await withTimeout(app.waitUntilExit(), 1_000, "SwarmChatApp did not exit after Ctrl+C");

    assert.equal(stdin.listenerCount("data"), 0);
    assert.equal(stdout.listenerCount("resize"), 0);
    assert.equal(process.listenerCount("SIGCONT"), beforeSigcontListeners);

    const logContent = await waitForDebugLog(home);
    assert.match(logContent, /"section":"tui-input"/);
    assert.match(logContent, /"section":"tui-exit"/);
    assert.doesNotMatch(logContent, /secret phrase 123/);
  } finally {
    app.unmount();
    resetDebugLogger();
    if (previousHome === undefined) {
      delete process.env.SWARM_HOME;
    } else {
      process.env.SWARM_HOME = previousHome;
    }
    if (previousDebug === undefined) {
      delete process.env.SWARM_DEBUG;
    } else {
      process.env.SWARM_DEBUG = previousDebug;
    }
    if (previousDebugSessionId === undefined) {
      delete process.env.SWARM_DEBUG_SESSION_ID;
    } else {
      process.env.SWARM_DEBUG_SESSION_ID = previousDebugSessionId;
    }
    await removeTree(home);
  }
});

function createConfiguredSwarmHome(home: string): void {
  mkdirSync(home, { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
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
