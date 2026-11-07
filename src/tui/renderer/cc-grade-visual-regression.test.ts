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

test("cc-grade visual matrix keeps turn markers, tool states, search and the status line across viewports", () => {
  const snapshots = VIEWPORTS.map((viewport) => ({
    viewport,
    snapshot: renderCcGradeSnapshot(viewport.columns, viewport.rows)
  }));

  for (const { viewport, snapshot } of snapshots) {
    assert.deepEqual(assertFrameHasNoOverflow(snapshot), [], `${viewport.columns}x${viewport.rows} overflow`);
    const text = snapshotText(snapshot);
    assert.match(text, /^ › Find cache miss/m);
    assert.match(text, /^ {3}✓ Read {3}README\.md$/m);
    assert.match(text, /^ {3}✗ Bash {3}ls docs\/missing · command exited 1$/m);
    assert.match(text, /^ {3}○ Bash {3}npm run check · approved$/m);
    assert.match(text, /^ › Ask Swarm$/m);
    assert.match(text, /^ {3}deepseek daily budget reached · 1 approval waiting/m);
    assert.doesNotMatch(text, /❯|\buser\b|\[cache:|\[WORK\]/);

    const userRow = snapshotRowWithText(snapshot, "› Find");
    assert.equal(cellStyleAtText(userRow, "›")?.color, resolveTuiColor("brand.focus"));
    assert.equal(cellStyleAtText(userRow, "Find")?.backgroundColor, resolveTuiColor("surface.selection"));
    assert.equal(cellStyleAtText(userRow, "cache")?.backgroundColor, resolveTuiColor("surface.searchMatch"));
    assert.equal(cellStyleAtText(userRow, "cache")?.underline, true);
    assert.equal(cellStyleAtText(userRow, "cache")?.color, resolveTuiColor("text.primary"));

    const assistantRow = snapshotRowWithText(snapshot, "Assistant body stays neutral");
    assert.equal(cellStyleAtText(assistantRow, "Assistant")?.color, resolveTuiColor("role.assistant"));
    assert.equal(cellStyleAtText(assistantRow, "Assistant")?.backgroundColor, undefined);

    assert.equal(cellStyleAtText(snapshotRowWithText(snapshot, "README.md"), "✓")?.color, resolveTuiColor("status.success"));
    const failedRow = snapshotRowWithText(snapshot, "ls docs/missing");
    assert.equal(cellStyleAtText(failedRow, "✗")?.color, resolveTuiColor("status.danger"));
    assert.equal(cellStyleAtText(failedRow, "ls docs")?.color, resolveTuiColor("text.primary"));
    assert.equal(cellStyleAtText(snapshotRowWithText(snapshot, "npm run check"), "○")?.color, resolveTuiColor("status.running"));

    const statusRow = snapshotRowWithText(snapshot, "deepseek daily budget reached");
    assert.equal(cellStyleAtText(statusRow, "deepseek")?.color, resolveTuiColor("status.danger"));
    assert.equal(cellStyleAtText(statusRow, "1 approval")?.color, resolveTuiColor("status.warning"));
    assert.equal(cellStyleAtText(statusRow, "$0.13")?.color, resolveTuiColor("text.muted"));
  }

  assert.match(snapshotText(snapshots[2]!.snapshot), /\$0\.13 today +\? keys$/m);
});

test("cc-grade visual matrix keeps NO_COLOR readable and truecolor SGR expressive", () => {
  withNoColor(() => {
    const snapshot = renderCcGradeSnapshot(100, 30);
    assert.deepEqual(assertFrameHasNoOverflow(snapshot), []);
    assert.match(snapshotText(snapshot), /› Find cache miss/);
    assert.match(snapshotText(snapshot), /✗ Bash {3}ls docs\/missing/);
    assert.match(snapshotText(snapshot), /1 approval waiting/);
    assert.equal(coloredCellCount(snapshot), 0);
  });

  const frame = renderTuiToFrame(ccGradeVisualFixture({ columns: 100, rows: 30 }), { columns: 100, rows: 30 });
  const patch = terminalPatchToString(buildTerminalPatch(diffScreens(undefined, frame.screen), {
    capabilities: { trueColor: true }
  }));

  assert.match(patch, new RegExp(`\u001B\\[[^m]*38;2;${rgb("brand.focus")}[^m]*m›`));
  assert.match(patch, new RegExp(`\u001B\\[[^m]*48;2;${rgb("surface.searchMatch")}[^m]*mcache`));
  assert.match(patch, new RegExp(`\u001B\\[[^m]*38;2;${rgb("status.danger")}[^m]*m✗`));
});

test("cc-grade aesthetic budget prevents single-color regression without rainbowing the surface", () => {
  const snapshot = renderCcGradeSnapshot(120, 36);
  const foregrounds = foregroundColorSet(snapshot);
  const backgrounds = backgroundColorSet(snapshot);
  const semanticAccents = [
    requiredColor("brand.focus"),
    requiredColor("status.running"),
    requiredColor("status.success"),
    requiredColor("status.danger")
  ];

  for (const accent of semanticAccents) {
    assert(foregrounds.has(accent), `expected fixture foregrounds to include ${accent}`);
  }

  assert.equal(new Set(semanticAccents).size, semanticAccents.length);
  assert(backgrounds.has(requiredColor("surface.selection")));
  assert(backgrounds.has(requiredColor("surface.searchMatch")));
  assert(!backgrounds.has(requiredColor("surface.user")), "a user's turn is marked by › alone, without a band");
  assert(foregrounds.size >= 5, "expected at least five foreground color channels");
  assert(foregrounds.size <= 8, "foreground palette should stay within the cc-grade budget");
  assert(backgrounds.size <= 2, "background palette is selection and search only");
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
  assert.match(dark.plainText, /› Find cache miss/);
  assert.match(dark.ansiText, new RegExp(`\u001B\\[[^m]*38;2;${rgb("brand.focus")}[^m]*m›`));
  assert.match(dark.ansiText, new RegExp(`\u001B\\[[^m]*48;2;${rgb("surface.searchMatch")}[^m]*mcache`));
  assert.doesNotMatch(contrast.ansiText, /38;2|48;2/);
  assert.match(contrast.ansiText, /\u001B\[[^m]*9[0-7]m|\u001B\[[^m]*3[0-7]m/);
  assert.equal(stripAnsi(monochrome.ansiText).includes("Find cache miss"), true);
  assert.doesNotMatch(monochrome.ansiText, /38;2|38;5|48;2|48;5|\u001B\[[^m]*(?:3[0-7]|4[0-7]|9[0-7]|10[0-7])m/);
  assert.equal(dark.overflowIssues.length, 0);
  assert(dark.foregrounds.some((entry) => entry.tokens.includes("brand.focus")));
  assert(dark.backgrounds.some((entry) => entry.tokens.includes("surface.selection")));
  assert(artifact.profileDiffs.some((diff) => diff.right === "swarm-monochrome" && diff.foregroundOnlyLeft.length > 0));

  const summary = formatCcGradeVisualArtifactSummary(artifact);
  assert.match(summary, /CC-Grade TUI Visual Artifact/);
  assert.match(summary, /swarm-dark: colored=/);
  assert.match(summary, /Profile Diff/);
});

/** A token's truecolor channels as an SGR sequence writes them, such as "224;151;88". */
function rgb(token: Parameters<typeof resolveTuiColor>[0]): string {
  const match = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(requiredColor(token));
  if (!match) {
    throw new Error(`expected ${token} to be an rgb() color`);
  }
  return match.slice(1).join(";");
}

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
