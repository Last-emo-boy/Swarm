import { strict as assert } from "node:assert";
import { PassThrough } from "node:stream";
import test from "node:test";
import React from "react";
import { SwarmChatApp } from "./SwarmChatApp.js";
import { render } from "./ui.js";

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "");
}

// Regression: in onboarding (an early-return render), the run-board attention key
// handler is registered via useInput but the component never reaches the later
// `routeLabel` const. Pressing a non-modifier key used to hit that const in its
// temporal dead zone and crash the whole TUI on the first keystroke.
test("SwarmChatApp survives a keypress during onboarding without a TDZ crash", async () => {
  const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream & { columns: number; rows: number; isTTY: false };
  const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream;
  stdout.columns = 120;
  stdout.rows = 24;
  stdout.isTTY = false;
  let output = "";
  stdout.on("data", (chunk: Buffer | string) => {
    output += chunk.toString();
  });

  const app = render(React.createElement(SwarmChatApp, { forceOnboarding: true }), {
    stdout,
    stderr: stdout,
    stdin,
    patchConsole: false
  });

  try {
    const start = Date.now();
    while (!stripAnsi(output).includes("Onboarding") && Date.now() - start < 2_000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.match(stripAnsi(output), /Onboarding/, "onboarding screen should render");

    // A plain key with an empty input must not throw the run-board attention key
    // handler's `routeLabel` temporal-dead-zone reference.
    assert.doesNotThrow(() => stdin.emit("data", "a"), "keypress during onboarding crashed");

    stdin.emit("data", "\x03");
    await Promise.race([app.waitUntilExit(), new Promise((resolve) => setTimeout(resolve, 1_000))]);
  } finally {
    try {
      app.unmount();
    } catch {
      // already unmounted
    }
  }
});
