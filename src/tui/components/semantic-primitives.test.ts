import { strict as assert } from "node:assert";
import React from "react";
import test from "node:test";
import { Box, Text } from "../ui.js";
import { renderTuiToFrame } from "../renderer/testing.js";
import {
  resolveTuiColor,
  resolveTuiThemeProfile,
  statusBadge,
  visualTokenColor,
  withTuiThemeProfile
} from "../theme.js";
import { StatusIcon, statusIconText } from "./StatusIcon.js";

const fixture = () => React.createElement(Box, { flexDirection: "column" },
  React.createElement(Text, { color: visualTokenColor("text.muted") }, "muted"),
  React.createElement(Text, null,
    React.createElement(StatusIcon, { status: "failed", withSpace: true }),
    React.createElement(Text, { color: visualTokenColor("brand.focus") }, "› turn "),
    React.createElement(Text, { color: visualTokenColor("status.success") }, "done")
  )
);

test("semantic primitives resolve theme tokens to renderer styles", () => {
  const frame = renderTuiToFrame(fixture(), { columns: 40, rows: 4 });
  const colors = new Set(frame.screen.cells.flatMap((row) => row.map((cell) => cell.style.color).filter(Boolean)));
  const plain = frame.screen.cells.map((row) => row.map((cell) => cell.char).join("")).join("\n");

  assert(colors.has(resolveTuiColor("text.muted")));
  assert(colors.has(resolveTuiColor("status.danger")));
  assert(colors.has(resolveTuiColor("brand.focus")));
  assert(colors.has(resolveTuiColor("status.success")));
  assert.match(plain, /✗ › turn done/);
  assert.equal(statusIconText("cache_hit"), "✓");
  assert.equal(statusIconText("running"), "○");
});

test("statuses read as the glyphs tool rows use, not bracketed badges", () => {
  assert.deepEqual(["completed", "running", "pending", "skipped", "partial", "failed", "unknown"].map(statusBadge),
    ["✓", "○", "?", "–", "!", "✗", "·"]);
});

test("theme profiles resolve default contrast and monochrome colors", () => {
  assert.equal(withTuiThemeProfile("swarm-dark", () => resolveTuiColor("brand.focus")), "rgb(224,151,88)");
  assert.equal(withTuiThemeProfile("swarm-dark", () => resolveTuiColor("status.danger")), "rgb(255,107,128)");
  assert.equal(withTuiThemeProfile("swarm-dark", () => resolveTuiColor("surface.selection")), "rgb(38,79,120)");
  assert.equal(withTuiThemeProfile("swarm-dark", () => resolveTuiColor("diff.added.bg")), "rgb(34,92,43)");
  assert.equal(withTuiThemeProfile("swarm-contrast", () => resolveTuiColor("brand.focus")), "brightYellow");
  assert.equal(withTuiThemeProfile("swarm-contrast", () => resolveTuiColor("status.danger")), "brightRed");
  assert.equal(withTuiThemeProfile("swarm-contrast", () => resolveTuiColor("surface.selection")), "brightBlue");
  assert.equal(withTuiThemeProfile("swarm-monochrome", () => resolveTuiColor("brand.focus")), undefined);
  assert.equal(withTuiThemeProfile("swarm-monochrome", () => resolveTuiColor("surface.user")), undefined);
  assert.equal(withTuiThemeProfile("swarm-monochrome", () => resolveTuiColor("red")), undefined);
});

test("the palette is small: text, muted, the accent, the status colours; roles and services take one of them", () => {
  for (const profile of ["swarm-dark", "swarm-contrast"] as const) {
    withTuiThemeProfile(profile, () => {
      const accents = ["brand.focus", "status.running", "status.success", "status.danger"].map((token) => resolveTuiColor(token as "brand.focus"));
      assert.equal(new Set(accents).size, accents.length, `${profile} keeps the accent and status colours apart`);
      assert.equal(resolveTuiColor("role.user"), resolveTuiColor("brand.focus"), "a user's turn takes the accent");
      for (const token of ["role.tool", "role.gateway", "role.swarm", "service.cache", "service.lsp", "service.gateway", "service.symphony"] as const) {
        assert.equal(resolveTuiColor(token), resolveTuiColor("text.muted"), `${profile} ${token} is muted text`);
      }
    });
  }
});

test("semantic primitives apply tokenized backgrounds through theme profiles", () => {
  const frame = renderTuiToFrame(React.createElement(Box, { flexDirection: "column" },
    React.createElement(Text, { color: visualTokenColor("text.primary"), backgroundColor: visualTokenColor("surface.selection") }, "selected"),
    React.createElement(Text, { color: visualTokenColor("diff.added"), backgroundColor: visualTokenColor("diff.added.bg") }, "added")
  ), { columns: 24, rows: 4 });

  const selectedRow = frame.screen.cells.find((row) => row.map((cell) => cell.char).join("").includes("selected"));
  const diffRow = frame.screen.cells.find((row) => row.map((cell) => cell.char).join("").includes("added"));

  assert(selectedRow);
  assert(diffRow);
  assert.equal(cellStyleAtText(selectedRow!, "selected")?.backgroundColor, resolveTuiColor("surface.selection"));
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
  const frame = withTuiThemeProfile("swarm-monochrome", () => renderTuiToFrame(fixture(), { columns: 40, rows: 4 }));
  const colors = new Set(frame.screen.cells.flatMap((row) => row.map((cell) => cell.style.color).filter(Boolean)));
  const plain = frame.screen.cells.map((row) => row.map((cell) => cell.char).join("")).join("\n");

  assert.equal(colors.size, 0);
  assert.match(plain, /muted/);
  assert.match(plain, /✗ › turn done/);
});

type FrameRow = ReturnType<typeof renderTuiToFrame>["screen"]["cells"][number];

function cellStyleAtText(row: FrameRow, text: string): FrameRow[number]["style"] | undefined {
  const index = row.map((cell) => cell.char).join("").indexOf(text);
  assert(index >= 0, `Expected row to contain ${text}`);
  return row[index]?.style;
}
