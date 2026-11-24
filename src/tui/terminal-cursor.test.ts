/**
 * Where the terminal's own cursor rests after each frame. The renderer hides it and draws the prompt's cursor itself, but an
 * input method draws the text it is still composing (Chinese pinyin before a candidate is chosen, say) at the terminal
 * cursor. Left where the last written row ended, that is the far right of the screen, so the composing text pushed the
 * terminal's view sideways as it grew.
 */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import React from "react";
import { ChatInputArea } from "./ChatInputArea.js";
import { displayWidth } from "./display-width.js";
import { Box } from "./renderer/components/Box.js";
import { Text } from "./renderer/components/Text.js";
import { createTuiRoot } from "./renderer/root.js";
import { terminalPatchToString } from "./renderer/output.js";
import { screenToLines } from "./renderer/screen.js";
import { render } from "./ui.js";

const h = React.createElement;

/** Follows the terminal cursor through written output: CUP moves it, text advances it by display width. */
function cursorAfter(output: string): { row: number; column: number } {
  let row = 0;
  let column = 0;
  const advance = (text: string): void => {
    for (const char of text) {
      if (char === "\r") column = 0;
      else if (char === "\n") row += 1;
      else column += displayWidth(char);
    }
  };
  const control = /\u001B\[(\d+)(?:;(\d+))?H|\u001B\[[0-9;?]*[A-Za-z]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/gu;
  let last = 0;
  for (let match = control.exec(output); match; match = control.exec(output)) {
    advance(output.slice(last, match.index));
    last = control.lastIndex;
    if (match[1]) {
      row = Number(match[1]) - 1;
      column = Number(match[2] ?? "1") - 1;
    }
  }
  advance(output.slice(last));
  return { row, column };
}

test("a frame leaves the terminal cursor on the text marked as the cursor, counted in columns", () => {
  const root = createTuiRoot({ columns: 30, rows: 4 });
  root.render(h(Box, { flexDirection: "column" },
    h(Text, null, "status line"),
    h(Text, null, "› 你好world中文", h(Text, { inverse: true, cursor: true }, " "))
  ));
  try {
    const frame = root.getFrame()!;
    // "› " is 2 columns, 你好 4, world 5, 中文 4: the cursor cell is column 15 of row 2.
    assert.deepEqual([frame.cursor.x, frame.cursor.y], [15, 1]);
    assert.deepEqual(root.getLastPatch().at(-1), { type: "moveCursor", row: 1, column: 15 });
    assert.deepEqual(cursorAfter(terminalPatchToString(root.getLastPatch())), { row: 1, column: 15 });
  } finally {
    root.unmount();
  }
});

test("a text marked as the cursor past the right edge rests on the next row, and a frame without one keeps the old resting place", () => {
  const root = createTuiRoot({ columns: 6, rows: 3 });
  try {
    root.render(h(Text, null, "你好世", h(Text, { inverse: true, cursor: true }, " ")));
    assert.deepEqual([root.getFrame()!.cursor.x, root.getFrame()!.cursor.y], [0, 1]);
    root.render(h(Text, null, "no cursor here"));
    assert.notEqual(root.getLastPatch().at(-1)?.type, "moveCursor", "no text owns the cursor, so no frame moves it");
  } finally {
    root.unmount();
  }
});

test("typing Chinese into the prompt leaves the terminal cursor where the next character goes", async () => {
  const columns = 40;
  const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream & { columns: number; rows: number };
  const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream;
  stdout.columns = columns;
  stdout.rows = 10;
  let output = "";
  stdout.on("data", (chunk: Buffer | string) => { output += chunk.toString(); });
  const app = render(
    h(Box, { flexDirection: "column", height: 10 },
      h(Box, { flexGrow: 1 }, h(Text, null, "transcript")),
      h(ChatInputArea, { onSubmit: () => {}, onCompletionRowsChange: () => {}, columns })
    ),
    { stdout, stderr: stdout, stdin, columns, rows: 10, patchConsole: false }
  );
  try {
    await waitFor(() => output.includes("Ask Swarm"));
    // A cursor at rest on the placeholder: where the first character will go, after "› " and the padding.
    const resting = cursorAfter(output);
    const promptRow = resting.row;
    assert.equal(resting.column, 3);
    // Each character typed moves it by that character's columns, never to the end of the row it was written on.
    let typed = "";
    for (const char of "你好世界，用中文输入") {
      typed += char;
      stdin.emit("data", char);
      await waitFor(() => cursorAfter(output).column === 3 + displayWidth(typed));
      assert.equal(cursorAfter(output).row, promptRow);
    }
    // Mixed with ASCII the same holds.
    stdin.emit("data", "ok");
    await waitFor(() => cursorAfter(output).column === 3 + displayWidth(`${typed}ok`));
  } finally {
    app.unmount();
  }
});

for (const columns of [40, 80]) {
  test(`at ${columns} columns a long Chinese prompt wraps inside the terminal and the cursor follows it onto the last row`, async () => {
    const root = createTuiRoot({ columns, rows: 8, patchConsole: false });
    try {
      root.render(h(Box, { flexDirection: "column", height: 8 },
        h(Box, { flexGrow: 1 }, h(Text, null, "transcript")),
        h(ChatInputArea, { onSubmit: () => {}, onCompletionRowsChange: () => {}, columns })
      ));
      const typed = "我们在终端里输入中文的时候光标应该跟着文字走而不是跑到行尾abc中文混合English测试一下换行";
      for (const char of typed) root.dispatchRawInput(char, { flush: true });
      await waitFor(() => screenToLines(root.getFrame()!.screen).join("").includes("换行"));
      const screen = root.getFrame()!.screen;
      const rows = screen.cells.map((row) => row.reduce((width, cell) => width + (cell.char === "" ? 0 : Math.max(1, displayWidth(cell.char))), 0));
      assert.ok(rows.every((width) => width <= columns), `a row is wider than the terminal: ${rows.join(",")}`);
      // The prompt's text starts at column 3 on every row it wraps to, and the last row ends where the next character goes.
      const lines = screenToLines(screen);
      const last = lines.findIndex((line) => line.includes("换行"));
      const lastText = lines[last]!.slice(3);
      assert.deepEqual(screen.cursor, { x: 3 + displayWidth(lastText), y: last });
    } finally {
      root.unmount();
    }
  });
}

async function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
