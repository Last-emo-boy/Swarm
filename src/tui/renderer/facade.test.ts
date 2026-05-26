import { strict as assert } from "node:assert";
import { PassThrough } from "node:stream";
import test from "node:test";
import React from "react";
import { Box, render, resolveTuiRendererMode, Text, useApp, useInput, useStdout, withTuiRendererMode } from "../ui.js";
import { frameLines, renderTuiToFrame } from "./testing.js";

test("TUI facade defaults to dom-renderer mode", () => {
  assert.equal(resolveTuiRendererMode(undefined), "dom-renderer");
});

test("TUI facade ignores legacy renderer rollback values", () => {
  assert.equal(resolveTuiRendererMode("legacy"), "dom-renderer");
  assert.equal(resolveTuiRendererMode("auto"), "dom-renderer");
  assert.equal(resolveTuiRendererMode("dom-renderer"), "dom-renderer");
});

test("TUI facade renders simple trees through dom-renderer mode", () => {
  const frame = renderTuiToFrame(
    React.createElement(Box, { flexDirection: "column" },
      React.createElement(Text, { color: "green" }, "facade"),
      React.createElement(Text, null, "renderer")
    ),
    { columns: 24, rows: 5, mode: "dom-renderer" }
  );
  assert.deepEqual(frameLines(frame).slice(0, 2), ["facade", "renderer"]);
});

test("withTuiRendererMode preserves renderer-only facade compatibility", () => {
  assert.equal(resolveTuiRendererMode(undefined), "dom-renderer");
  const inside = withTuiRendererMode("legacy", () => resolveTuiRendererMode(undefined));
  assert.equal(inside, "dom-renderer");
  assert.equal(resolveTuiRendererMode(undefined), "dom-renderer");
});

test("TUI facade render targets the dom renderer", async () => {
  const stream = new PassThrough();
  let output = "";
  stream.on("data", (chunk: Buffer | string) => {
    output += chunk.toString();
  });
  const app = render(React.createElement(Box, null, React.createElement(Text, null, "mode render")), {
    mode: "dom-renderer",
    columns: 20,
    rows: 3,
    stdout: stream as unknown as NodeJS.WriteStream,
    stderr: stream as unknown as NodeJS.WriteStream,
    patchConsole: false
  });
  app.unmount();
  await app.waitUntilExit();
  assert.match(output, /mode render/);
});

test("TUI facade dom renderer redraws safely on stdout resize and SIGCONT", async () => {
  const stream = new PassThrough() as PassThrough & NodeJS.WriteStream & { columns: number; rows: number };
  stream.columns = 20;
  stream.rows = 4;
  let output = "";
  stream.on("data", (chunk: Buffer | string) => {
    output += chunk.toString();
  });

  function SizeProbe(): React.ReactElement {
    const { columns, rows } = useStdout() as unknown as { columns: number; rows: number };
    return React.createElement(Box, null, React.createElement(Text, null, `${columns}x${rows}`));
  }

  const beforeSigcontListeners = process.listenerCount("SIGCONT");
  const app = render(React.createElement(SizeProbe), {
    mode: "dom-renderer",
    stdout: stream,
    stderr: stream,
    patchConsole: false
  });

  assert.match(output, /20x4/);
  output = "";

  stream.columns = 12;
  stream.rows = 3;
  stream.emit("resize");
  assert.match(output, /\u001B\[2J/);
  assert.match(output, /12x3/);
  output = "";

  process.emit("SIGCONT", "SIGCONT");
  assert.match(output, /\u001B\[2J/);
  assert.match(output, /12x3/);

  app.unmount();
  await app.waitUntilExit();
  assert.equal(process.listenerCount("SIGCONT"), beforeSigcontListeners);
  assert.equal(stream.listenerCount("resize"), 0);
});

test("TUI facade wires stdin input to focused DOM handlers and repaints state commits", async () => {
  const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream & { columns: number; rows: number };
  const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream;
  stdout.columns = 24;
  stdout.rows = 4;
  let output = "";
  stdout.on("data", (chunk: Buffer | string) => {
    output += chunk.toString();
  });

  function PromptProbe(): React.ReactElement {
    const [value, setValue] = React.useState("");
    return React.createElement(Box, {
      focusable: true,
      onKeydown: (event: { input?: string; preventDefault: () => void }) => {
        if (event.input) {
          setValue((previous) => `${previous}${event.input}`);
          event.preventDefault();
        }
      }
    } as never, React.createElement(Text, null, `input:${value}`));
  }

  const app = render(React.createElement(PromptProbe), {
    stdout,
    stderr: stdout,
    stdin,
    patchConsole: false
  });

  assert.match(output, /input:/);
  output = "";
  stdin.emit("data", "a");
  await new Promise<void>((resolve) => setTimeout(resolve, 10));

  assert.match(output, /input:a/);
  app.unmount();
  await app.waitUntilExit();
  assert.equal(stdin.listenerCount("data"), 0);
});

test("TUI facade lets Ctrl+C exit through useApp and cleanup input listeners", async () => {
  const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream & { columns: number; rows: number };
  const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream;
  stdout.columns = 24;
  stdout.rows = 4;

  function ExitProbe(): React.ReactElement {
    const app = useApp();
    useInput((input, key) => {
      if (key.ctrl && input === "c") {
        app.exit();
      }
    });
    return React.createElement(Text, null, "exit probe");
  }

  const beforeSigcontListeners = process.listenerCount("SIGCONT");
  const app = render(React.createElement(ExitProbe), {
    stdout,
    stderr: stdout,
    stdin,
    patchConsole: false
  });

  assert.equal(stdin.listenerCount("data"), 1);
  stdin.emit("data", "\x03");
  await app.waitUntilExit();

  assert.equal(stdin.listenerCount("data"), 0);
  assert.equal(stdout.listenerCount("resize"), 0);
  assert.equal(process.listenerCount("SIGCONT"), beforeSigcontListeners);
});
