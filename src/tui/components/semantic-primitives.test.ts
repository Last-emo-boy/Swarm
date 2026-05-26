import { strict as assert } from "node:assert";
import React from "react";
import test from "node:test";
import { Box } from "../ui.js";
import { renderTuiToFrame } from "../renderer/testing.js";
import {
  resolveTuiColor,
  resolveTuiThemeProfile,
  withTuiThemeProfile
} from "../theme.js";
import { RoleMarker } from "./RoleMarker.js";
import { StatusIcon, statusIconText } from "./StatusIcon.js";
import { ThemedBox } from "./ThemedBox.js";
import { ThemedText } from "./ThemedText.js";
import { TonePill } from "./TonePill.js";

test("semantic primitives resolve theme tokens to renderer styles", () => {
  const frame = renderTuiToFrame(React.createElement(Box, { flexDirection: "column" },
    React.createElement(ThemedText, { color: "role.tool" }, "tool"),
    React.createElement(ThemedText, { color: "success" }, "success"),
    React.createElement(ThemedBox, { borderStyle: "single", borderColor: "role.gateway", width: 12 },
      React.createElement(ThemedText, null, "box")
    ),
    React.createElement(ThemedText, null,
      React.createElement(StatusIcon, { status: "failed", label: "badge", withSpace: true }),
      React.createElement(RoleMarker, { role: "user" }),
      React.createElement(TonePill, { label: "cache", value: "hit", tone: "status.success", prefixSpace: true })
    )
  ), { columns: 40, rows: 8 });

  const colors = new Set(frame.screen.cells.flatMap((row) => row.map((cell) => cell.style.color).filter(Boolean)));
  const plain = frame.screen.cells.map((row) => row.map((cell) => cell.char).join("")).join("\n");

  assert(colors.has(resolveTuiColor("role.tool")));
  assert(colors.has(resolveTuiColor("status.success")));
  assert(colors.has(resolveTuiColor("role.gateway")));
  assert(colors.has(resolveTuiColor("status.danger")));
  assert.match(plain, /tool/);
  assert.match(plain, /success/);
  assert.match(plain, /\[ERR\] ❯ \[cache:hit\]/);
  assert.equal(statusIconText("cache_hit", "badge"), "[OK]");
});

test("theme profiles resolve default contrast and monochrome colors", () => {
  assert.equal(withTuiThemeProfile("swarm-dark", () => resolveTuiColor("brand.focus")), "rgb(224,151,88)");
  assert.equal(withTuiThemeProfile("swarm-dark", () => resolveTuiColor("status.danger")), "rgb(255,107,128)");
  assert.equal(withTuiThemeProfile("swarm-dark", () => resolveTuiColor("surface.user")), "rgb(46,46,46)");
  assert.equal(withTuiThemeProfile("swarm-dark", () => resolveTuiColor("surface.selection")), "rgb(38,79,120)");
  assert.equal(withTuiThemeProfile("swarm-dark", () => resolveTuiColor("diff.added.bg")), "rgb(34,92,43)");
  assert.equal(withTuiThemeProfile("swarm-dark", () => resolveTuiColor("service.lsp")), "rgb(130,168,255)");
  assert.equal(withTuiThemeProfile("swarm-contrast", () => resolveTuiColor("brand.focus")), "brightYellow");
  assert.equal(withTuiThemeProfile("swarm-contrast", () => resolveTuiColor("status.danger")), "brightRed");
  assert.equal(withTuiThemeProfile("swarm-contrast", () => resolveTuiColor("surface.selection")), "brightBlue");
  assert.equal(withTuiThemeProfile("swarm-monochrome", () => resolveTuiColor("brand.focus")), undefined);
  assert.equal(withTuiThemeProfile("swarm-monochrome", () => resolveTuiColor("surface.user")), undefined);
  assert.equal(withTuiThemeProfile("swarm-monochrome", () => resolveTuiColor("red")), undefined);
});

test("swarm dark keeps brand running service and tool accents visually distinct", () => {
  withTuiThemeProfile("swarm-dark", () => {
    const accents = [
      resolveTuiColor("brand.focus"),
      resolveTuiColor("status.running"),
      resolveTuiColor("role.gateway"),
      resolveTuiColor("role.tool")
    ];
    assert.equal(new Set(accents).size, accents.length);
    assert.equal(resolveTuiColor("service.lsp"), resolveTuiColor("role.gateway"));
    assert.notEqual(resolveTuiColor("brand.focus"), resolveTuiColor("status.running"));
    assert.notEqual(resolveTuiColor("brand.focus"), resolveTuiColor("role.gateway"));
    assert.notEqual(resolveTuiColor("status.running"), resolveTuiColor("role.gateway"));
  });
});

test("semantic primitives apply tokenized backgrounds through theme profiles", () => {
  const frame = renderTuiToFrame(React.createElement(Box, { flexDirection: "column" },
    React.createElement(ThemedText, { color: "text.primary", backgroundColor: "surface.user" }, "user band"),
    React.createElement(ThemedText, { color: "diff.added", backgroundColor: "diff.added.bg" }, "added")
  ), { columns: 24, rows: 4 });

  const userRow = frame.screen.cells.find((row) => row.map((cell) => cell.char).join("").includes("user band"));
  const diffRow = frame.screen.cells.find((row) => row.map((cell) => cell.char).join("").includes("added"));

  assert(userRow);
  assert(diffRow);
  assert.equal(cellStyleAtText(userRow!, "user band")?.backgroundColor, resolveTuiColor("surface.user"));
  assert.equal(cellStyleAtText(diffRow!, "added")?.color, resolveTuiColor("diff.added"));
  assert.equal(cellStyleAtText(diffRow!, "added")?.backgroundColor, resolveTuiColor("diff.added.bg"));
});

test("theme profile selection honors aliases and NO_COLOR", () => {
  const previousNoColor = process.env.NO_COLOR;
  try {
    delete process.env.NO_COLOR;
    assert.equal(resolveTuiThemeProfile("contrast"), "swarm-contrast");
    assert.equal(resolveTuiThemeProfile("mono"), "swarm-monochrome");
    assert.equal(resolveTuiThemeProfile("unknown"), "swarm-dark");
    process.env.NO_COLOR = "1";
    assert.equal(resolveTuiThemeProfile("swarm-contrast"), "swarm-monochrome");
  } finally {
    if (previousNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = previousNoColor;
    }
  }
});

test("semantic primitives keep labels and icons in monochrome profile", () => {
  const frame = withTuiThemeProfile("swarm-monochrome", () => renderTuiToFrame(React.createElement(Box, { flexDirection: "column" },
    React.createElement(ThemedText, { color: "role.tool" }, "tool"),
    React.createElement(ThemedBox, { borderStyle: "single", borderColor: "role.gateway", width: 18 },
      React.createElement(ThemedText, null, "box")
    ),
    React.createElement(ThemedText, null,
      React.createElement(StatusIcon, { status: "failed", label: "badge", withSpace: true }),
      React.createElement(RoleMarker, { role: "user" }),
      React.createElement(TonePill, { label: "cache", value: "hit", tone: "status.success", prefixSpace: true })
    )
  ), { columns: 40, rows: 8 }));

  const colors = new Set(frame.screen.cells.flatMap((row) => row.map((cell) => cell.style.color).filter(Boolean)));
  const plain = frame.screen.cells.map((row) => row.map((cell) => cell.char).join("")).join("\n");

  assert.equal(colors.size, 0);
  assert.match(plain, /tool/);
  assert.match(plain, /box/);
  assert.match(plain, /\[ERR\] ❯ \[cache:hit\]/);
});

type FrameRow = ReturnType<typeof renderTuiToFrame>["screen"]["cells"][number];

function cellStyleAtText(row: FrameRow, text: string): FrameRow[number]["style"] | undefined {
  const index = row.map((cell) => cell.char).join("").indexOf(text);
  assert(index >= 0, `Expected row to contain ${text}`);
  return row[index]?.style;
}
