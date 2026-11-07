import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import React from "react";
import { startFakeModel, writeFakeModelHome } from "../superagent/testing/fake-model.js";
import { SwarmChatApp } from "./SwarmChatApp.js";
import { terminalScreenText } from "./tui-smoke-harness.js";
import { render } from "./ui.js";

const loop = (fields: Record<string, unknown>): string => JSON.stringify({ files_touched: [], next_actions: [], tool_calls: [], ...fields });

// The keys the status line and the keys view advertise, driven through the real app: ? shows the keys, Esc moves to the
// transcript, ↑ and Enter pick and unfold a turn's tool calls, / searches, and typing goes back to the prompt.
test("the advertised keys work in the running app: keys view, transcript focus, folding, search, back to the prompt", async () => {
  const previousHome = process.env.SWARM_HOME;
  const previousCwd = process.cwd();
  const home = mkdtempSync(join(tmpdir(), "swarm-tui-keys-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "swarm-tui-keys-ws-"));
  writeFileSync(join(workspace, "README.md"), "# Demo\n\nA pairing code works for 15 minutes.\n");
  mkdirSync(join(workspace, "src"));
  writeFileSync(join(workspace, "src", "pair.ts"), "export const INVITE_MINUTES = 15;\n");
  const steps = [
    loop({ status: "continue", summary: "Read", message: "Reading.", tool_calls: [
      { id: "r1", action: "Read", inputs: { file_path: "README.md" } },
      { id: "r2", action: "Read", inputs: { file_path: "src/pair.ts" } }
    ] }),
    loop({ status: "completed", summary: "Answered", message: "A pairing code stays open for 15 minutes." })
  ];
  let step = 0;
  const model = await startFakeModel((request) => request.system.includes("default coding agent")
    ? steps[Math.min(step++, steps.length - 1)]!
    : loop({ status: "completed", summary: "ok", message: "ok" }));
  process.env.SWARM_HOME = home;
  writeFakeModelHome(home, model.url);
  process.chdir(workspace);

  const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream & { columns: number; rows: number; isTTY: false };
  const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream;
  stdout.columns = 100;
  stdout.rows = 30;
  stdout.isTTY = false;
  let output = "";
  stdout.on("data", (chunk: Buffer | string) => {
    output += chunk.toString();
  });
  const app = render(React.createElement(SwarmChatApp), { stdout, stderr: stdout, stdin, patchConsole: false });
  const screen = () => terminalScreenText(output);
  const press = async (input: string) => {
    stdin.emit("data", input);
    // A lone Esc counts once no escape sequence follows it.
    await new Promise((resolve) => setTimeout(resolve, input === "\u001b" ? 120 : 40));
  };

  try {
    await waitFor(() => screen().includes("Ask Swarm"), "the prompt", screen);

    await press("?");
    await waitFor(() => /^ Keys$/m.test(screen()) && screen().includes("Transcript"), "the keys view", screen);
    await press("\u001b");
    await waitFor(() => screen().includes("Ask Swarm") && !/^ Keys$/m.test(screen()), "back from the keys view", screen);
    assert.doesNotMatch(screen(), /› \?/, "? on an empty prompt is not typed");

    await press("README 里配对码多久失效？读一下 src/pair.ts");
    await press("\r");
    await waitFor(() => screen().includes("A pairing code stays open for 15 minutes."), "the answer", screen);
    await waitFor(() => /▸ Read 2 files/.test(screen()), "the turn's tool calls folded", screen);
    assert.doesNotMatch(screen(), /✓ Read {3}README\.md/);

    await press("\u001b");
    await waitFor(() => screen().includes("↑↓ pick · Enter fold · o open · Esc prompt"), "transcript focus", screen);
    await press("\u001b[A");
    await press("\r");
    await waitFor(() => /▾ Read 2 files/.test(screen()) && /✓ Read {3}README\.md/.test(screen()), "the tool calls unfolded", screen);
    await press("x");
    await waitFor(() => /▸ Read 2 files/.test(screen()), "folded again", screen);

    await press("/");
    await press("pairing");
    await waitFor(() => /search "pairing" 1\/\d/.test(screen()), "the search", screen);
    await press("\r");
    await waitFor(() => screen().includes("↑↓ pick"), "the match selected in the transcript", screen);

    await press("w");
    await waitFor(() => /^ › w$/m.test(screen()), "typing back in the prompt", screen);
    assert.doesNotMatch(screen(), /↑↓ pick/);

    await press("\u0003");
    await withTimeout(app.waitUntilExit(), 2_000, "the app did not exit after Ctrl+C");
  } finally {
    app.unmount();
    await model.close();
    process.chdir(previousCwd);
    if (previousHome === undefined) {
      delete process.env.SWARM_HOME;
    } else {
      process.env.SWARM_HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean, label: string, screen: () => string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}. Screen:\n${screen()}`);
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
