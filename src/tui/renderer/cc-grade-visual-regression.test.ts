import { strict as assert } from "node:assert";
import test from "node:test";
import { resolveTuiColor } from "../theme.js";
import { createFrameSnapshot, assertFrameHasNoOverflow, type TuiFrameSnapshot } from "./frame-snapshot.js";
import { renderTuiToFrame } from "./testing.js";
import { buildTerminalPatch, diffScreens, terminalPatchToString } from "./output.js";
import {
  ccGradeVisualFixture,
  formatCcGradeVisualArtifactSummary,
  renderCcGradeVisualArtifact
} from "./cc-grade-visual-artifact.js";
import { stripAnsi } from "./ansi.js";

const VIEWPORTS = [
  { columns: 80, rows: 24 },
  { columns: 100, rows: 30 },
  { columns: 120, rows: 36 }
] as const;

test("cc-grade visual matrix preserves semantic transcript footer and search layers across viewports", () => {
  const snapshots = VIEWPORTS.map((viewport) => ({
    viewport,
    snapshot: renderCcGradeSnapshot(viewport.columns, viewport.rows)
  }));

  for (const { viewport, snapshot } of snapshots) {
    assert.deepEqual(assertFrameHasNoOverflow(snapshot), [], `${viewport.columns}x${viewport.rows} overflow`);
    assert.match(snapshotText(snapshot), /❯ You\s+Find cache miss/);
    assert.match(snapshotText(snapshot), /\[cache:HIT 74%\]/);
    assert.match(snapshotText(snapshot), /● tool\s+shell/);
    assert.match(snapshotText(snapshot), /✓ result\s+stdout/);

    const userRow = snapshotRowWithText(snapshot, "❯ You");
    assert.equal(cellStyleAtText(userRow, "❯")?.color, resolveTuiColor("role.user"));
    assert.equal(cellStyleAtText(userRow, "Find")?.backgroundColor, resolveTuiColor("surface.selection"));
    assert.equal(cellStyleAtText(userRow, "cache")?.backgroundColor, resolveTuiColor("surface.searchMatch"));
    assert.equal(cellStyleAtText(userRow, "cache")?.underline, true);
    assert.equal(cellStyleAtText(userRow, "cache")?.color, resolveTuiColor("text.primary"));

    const assistantRow = snapshotRowWithText(snapshot, "Assistant body stays neutral");
    assert.equal(cellStyleAtText(assistantRow, "Assistant")?.color, resolveTuiColor("role.assistant"));
    assert.equal(cellStyleAtText(assistantRow, "Assistant")?.backgroundColor, undefined);

    const toolRow = snapshotRowWithText(snapshot, "● tool");
    assert.equal(cellStyleAtText(toolRow, "●")?.color, resolveTuiColor("status.running"));
    assert.equal(cellStyleAtText(toolRow, "shell")?.color, resolveTuiColor("text.primary"));

    const resultRow = snapshotRowWithText(snapshot, "✓ result");
    assert.equal(cellStyleAtText(resultRow, "✓")?.color, resolveTuiColor("status.success"));
    assert.equal(cellStyleAtText(resultRow, "cache")?.color, resolveTuiColor("text.primary"));

    const footerRow = snapshotRowWithText(snapshot, "[cache:HIT 74%]");
    assert.equal(cellStyleAtText(footerRow, "[cache:HIT 74%]")?.backgroundColor, resolveTuiColor("surface.selection"));
  }

  const wideText = snapshotText(snapshots[2]!.snapshot);
  assert.match(wideText, /Type a request\s+Ctrl\+O details/);
  assert.doesNotMatch(wideText, /\/help|\/continue|\/memory|PgUp\/PgDn scroll|\/ search/);
});

test("cc-grade visual matrix keeps NO_COLOR readable and truecolor SGR expressive", () => {
  withNoColor(() => {
    const snapshot = renderCcGradeSnapshot(100, 30);
    assert.deepEqual(assertFrameHasNoOverflow(snapshot), []);
    assert.match(snapshotText(snapshot), /❯ You\s+Find cache miss/);
    assert.match(snapshotText(snapshot), /\[cache:HIT 74%\]/);
    assert.equal(coloredCellCount(snapshot), 0);
  });

  const frame = renderTuiToFrame(ccGradeVisualFixture({ columns: 100, rows: 30 }), { columns: 100, rows: 30 });
  const patch = terminalPatchToString(buildTerminalPatch(diffScreens(undefined, frame.screen), {
    capabilities: { trueColor: true }
  }));

  assert.match(patch, /\u001B\[38;2;122;217;122m❯/);
  assert.match(patch, /\u001B\[[^m]*48;2;92;70;24[^m]*mcache/);
  assert.match(patch, /\u001B\[[^m]*48;2;38;79;120[^m]*m\[cache:HIT 74%\]/);
});

test("cc-grade aesthetic budget prevents single-color regression without rainbowing the surface", () => {
  const snapshot = renderCcGradeSnapshot(120, 36);
  const foregrounds = foregroundColorSet(snapshot);
  const backgrounds = backgroundColorSet(snapshot);
  const semanticAccents = [
    requiredColor("brand.focus"),
    requiredColor("status.running"),
    requiredColor("role.tool"),
    requiredColor("role.user"),
    requiredColor("status.danger")
  ];

  for (const accent of semanticAccents) {
    assert(foregrounds.has(accent), `expected fixture foregrounds to include ${accent}`);
  }

  assert.equal(new Set(semanticAccents).size, semanticAccents.length);
  assert(backgrounds.has(requiredColor("surface.selection")));
  assert(backgrounds.has(requiredColor("surface.searchMatch")));
  assert(backgrounds.has(requiredColor("surface.user")));
  assert(foregrounds.size >= 5, "expected at least five foreground color channels");
  assert(foregrounds.size <= 9, "foreground palette should stay within the cc-grade budget");
  assert(backgrounds.size <= 4, "background palette should stay restrained");
});

test("cc-grade visual artifact exposes profile diff and inspectable ANSI snapshots", () => {
  const artifact = renderCcGradeVisualArtifact({
    columns: 100,
    rows: 30,
    createdAt: "2026-05-23T00:00:00.000Z"
  });
  const profiles = new Map(artifact.profiles.map((profile) => [profile.profile, profile]));
  const dark = profiles.get("swarm-dark");
  const contrast = profiles.get("swarm-contrast");
  const monochrome = profiles.get("swarm-monochrome");

  assert(dark);
  assert(contrast);
  assert(monochrome);
  assert.match(dark.plainText, /❯ You\s+Find cache miss/);
  assert.match(dark.ansiText, /\u001B\[[^m]*38;2;122;217;122m❯/);
  assert.match(dark.ansiText, /\u001B\[[^m]*48;2;38;79;120[^m]*m\[cache:HIT 74%\]/);
  assert.doesNotMatch(contrast.ansiText, /38;2|48;2/);
  assert.match(contrast.ansiText, /\u001B\[[^m]*9[0-7]m|\u001B\[[^m]*3[0-7]m/);
  assert.equal(stripAnsi(monochrome.ansiText).includes("Find cache miss"), true);
  assert.doesNotMatch(monochrome.ansiText, /38;2|38;5|48;2|48;5|\u001B\[[^m]*(?:3[0-7]|4[0-7]|9[0-7]|10[0-7])m/);
  assert.equal(dark.overflowIssues.length, 0);
  assert(dark.foregrounds.some((entry) => entry.tokens.includes("role.user")));
  assert(dark.backgrounds.some((entry) => entry.tokens.includes("surface.selection")));
  assert(artifact.profileDiffs.some((diff) => diff.right === "swarm-monochrome" && diff.foregroundOnlyLeft.length > 0));

  const summary = formatCcGradeVisualArtifactSummary(artifact);
  assert.match(summary, /CC-Grade TUI Visual Artifact/);
  assert.match(summary, /swarm-dark: colored=/);
  assert.match(summary, /Profile Diff/);
});

function renderCcGradeSnapshot(columns: number, rows: number): TuiFrameSnapshot {
  return createFrameSnapshot(renderTuiToFrame(ccGradeVisualFixture({ columns, rows }), { columns, rows }));
}

function snapshotText(snapshot: TuiFrameSnapshot): string {
  return snapshot.lines.join("\n");
}

type SnapshotRow = TuiFrameSnapshot["cells"][number];

function snapshotRowWithText(snapshot: TuiFrameSnapshot, text: string): SnapshotRow {
  const row = snapshot.cells.find((candidate) => rowText(candidate).includes(text));
  assert(row, `Expected snapshot row containing ${text}`);
  return row;
}

function cellStyleAtText(row: SnapshotRow, text: string): Record<string, unknown> | undefined {
  const index = rowText(row).indexOf(text);
  assert(index >= 0, `Expected row to contain ${text}`);
  return row[index]?.style;
}

function rowText(row: SnapshotRow): string {
  return row.map((cell) => cell.char).join("");
}

function coloredCellCount(snapshot: TuiFrameSnapshot): number {
  return snapshot.cells.flat().filter((cell) => cell.style.color || cell.style.backgroundColor).length;
}

function foregroundColorSet(snapshot: TuiFrameSnapshot): Set<string> {
  return new Set(snapshot.cells.flatMap((row) =>
    row.map((cell) => cell.style.color).filter((color): color is string => typeof color === "string")
  ));
}

function backgroundColorSet(snapshot: TuiFrameSnapshot): Set<string> {
  return new Set(snapshot.cells.flatMap((row) =>
    row.map((cell) => cell.style.backgroundColor).filter((color): color is string => typeof color === "string")
  ));
}

function requiredColor(token: Parameters<typeof resolveTuiColor>[0]): string {
  const color = resolveTuiColor(token);
  if (typeof color !== "string") {
    throw new Error(`expected ${token} to resolve in swarm-dark`);
  }
  return color;
}

function withNoColor(run: () => void): void {
  const previousNoColor = process.env.NO_COLOR;
  const previousSwarmNoColor = process.env.SWARM_TUI_NO_COLOR;
  process.env.NO_COLOR = "1";
  process.env.SWARM_TUI_NO_COLOR = "1";
  try {
    run();
  } finally {
    restoreEnv("NO_COLOR", previousNoColor);
    restoreEnv("SWARM_TUI_NO_COLOR", previousSwarmNoColor);
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
