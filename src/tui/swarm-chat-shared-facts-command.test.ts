import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import React from "react";
import { defaultSwarmConfig, defaultSwarmSettings } from "../config/settings.js";
import { SwarmChatApp } from "./SwarmChatApp.js";
import { render } from "./ui.js";

test("SwarmChatApp shows shared facts copy for blackboard command results", async () => {
  const previousHome = process.env.SWARM_HOME;
  const home = mkdtempSync(join(tmpdir(), "swarm-tui-shared-facts-command-"));
  process.env.SWARM_HOME = home;
  createConfiguredSwarmHome(home);

  const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream & { columns: number; rows: number; isTTY: false };
  const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream;
  stdout.columns = 140;
  stdout.rows = 30;
  stdout.isTTY = false;
  let output = "";
  stdout.on("data", (chunk: Buffer | string) => {
    output += chunk.toString();
  });

  const app = render(React.createElement(SwarmChatApp), {
    stdout,
    stderr: stdout,
    stdin,
    patchConsole: false
  });

  try {
    await waitFor(() => stripAnsi(output).includes("Ask Swarm"), "initial prompt render");
    stdin.emit("data", "/blackboard");
    stdin.emit("data", "\r");
    await waitFor(() => stripAnsi(output).includes("0 shared facts"), "shared facts command result");

    const screen = stripAnsi(output);
    assert.match(screen, /0 shared facts/);
    assert.doesNotMatch(screen, /blackboard entries/i);
    stdin.emit("data", "\x03");
    await withTimeout(app.waitUntilExit(), 1_000, "SwarmChatApp shared facts command test did not exit after Ctrl+C");
  } finally {
    app.unmount();
    if (previousHome === undefined) {
      delete process.env.SWARM_HOME;
    } else {
      process.env.SWARM_HOME = previousHome;
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
