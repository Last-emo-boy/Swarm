import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import React from "react";
import { ChatInputArea } from "../ChatInputArea.js";
import { ConversationFirstPane } from "../components/ConversationFirstPane.js";
import { ConversationFullscreenLayout } from "../components/ConversationFullscreenLayout.js";
import type { ConversationMessage } from "../conversation-layout.js";
import {
  resolveTuiColor,
  TUI_VISUAL_TOKENS,
  withTuiThemeProfile,
  type TuiThemeProfileName
} from "../theme.js";
import { createFrameSnapshot, assertFrameHasNoOverflow, type TuiFrameSnapshot } from "./frame-snapshot.js";
import { buildTerminalPatch, diffScreens, terminalPatchToString, type TuiTerminalPatchOptions } from "./output.js";
import { renderTuiToFrame } from "./testing.js";

export type CcGradeVisualProfileName = TuiThemeProfileName;

export type CcGradeVisualDistributionEntry = {
  value: string;
  cells: number;
  tokens: string[];
};

export type CcGradeVisualProfileArtifact = {
  profile: CcGradeVisualProfileName;
  viewport: { columns: number; rows: number };
  plainText: string;
  ansiText: string;
  foregrounds: CcGradeVisualDistributionEntry[];
  backgrounds: CcGradeVisualDistributionEntry[];
  styleCounts: {
    coloredCells: number;
    backgroundCells: number;
    inverseCells: number;
    underlineCells: number;
  };
  overflowIssues: string[];
};

export type CcGradeVisualProfileDiff = {
  left: CcGradeVisualProfileName;
  right: CcGradeVisualProfileName;
  foregroundOnlyLeft: string[];
  foregroundOnlyRight: string[];
  backgroundOnlyLeft: string[];
  backgroundOnlyRight: string[];
};

export type CcGradeVisualArtifact = {
  kind: "cc-grade-tui-visual-artifact";
  createdAt: string;
  viewport: { columns: number; rows: number };
  profiles: CcGradeVisualProfileArtifact[];
  profileDiffs: CcGradeVisualProfileDiff[];
};

export type CcGradeVisualArtifactSummary = Omit<CcGradeVisualArtifact, "profiles"> & {
  profiles: Array<Omit<CcGradeVisualProfileArtifact, "plainText" | "ansiText"> & {
    plainTextFile?: string;
    ansiTextFile?: string;
  }>;
};

export type CcGradeVisualArtifactFiles = {
  directory: string;
  summaryJson: string;
  profileDiffText: string;
  profiles: Array<{
    profile: CcGradeVisualProfileName;
    plainText: string;
    ansiText: string;
  }>;
};

const DEFAULT_PROFILES: CcGradeVisualProfileName[] = ["swarm-dark", "swarm-contrast", "swarm-monochrome"];

export function ccGradeVisualFixture(input: { columns: number; rows: number }): React.ReactElement {
  const bottomRows = 4;
  return React.createElement(ConversationFullscreenLayout, {
    columns: input.columns,
    rows: input.rows,
    bottomRows,
    scrollable: React.createElement(ConversationFirstPane, {
      messages: ccGradeMessages(),
      rows: input.rows - bottomRows,
      columns: input.columns,
      selectedMessageIndex: 0,
      searchMatchMessageIndex: 0,
      searchMatchQuery: "cache miss"
    }),
    bottom: React.createElement(ChatInputArea, {
      onSubmit: () => undefined,
      onCompletionRowsChange: () => undefined,
      inputActive: false,
      footerModeLabel: "WORK",
      footerModeTone: "brand.focus",
      footerPermissionLabel: "YOLO",
      footerPermissionTone: "status.danger",
      footerSandboxLabel: "RW",
      footerSandboxTone: "status.success",
      footerItems: [
        { id: "tasks", label: "tasks", value: "1/3", tone: "running" },
        { id: "cache", label: "cache", value: "HIT 74%", tone: "success" },
        { id: "lsp", label: "lsp", value: "TS", tone: "success" },
        { id: "gateway", label: "gateway", value: "local", tone: "success" },
        { id: "symphony", label: "symphony", value: "2 run", tone: "running" }
      ],
      selectedFooterItem: "cache",
      footerHint: "Type a request  Ctrl+O details",
      columns: input.columns,
      maxRows: bottomRows
    })
  });
}

export function renderCcGradeVisualArtifact(input: {
  columns?: number;
  rows?: number;
  profiles?: CcGradeVisualProfileName[];
  createdAt?: string;
} = {}): CcGradeVisualArtifact {
  const columns = input.columns ?? 100;
  const rows = input.rows ?? 30;
  const profiles = input.profiles ?? DEFAULT_PROFILES;
  const artifacts = profiles.map((profile) => renderCcGradeVisualProfileArtifact({ profile, columns, rows }));
  return {
    kind: "cc-grade-tui-visual-artifact",
    createdAt: input.createdAt ?? new Date().toISOString(),
    viewport: { columns, rows },
    profiles: artifacts,
    profileDiffs: profileDiffs(artifacts)
  };
}

export function renderCcGradeVisualProfileArtifact(input: {
  profile: CcGradeVisualProfileName;
  columns: number;
  rows: number;
}): CcGradeVisualProfileArtifact {
  return withDeterministicColorEnv(() => withTuiThemeProfile(input.profile, () => {
    const frame = renderTuiToFrame(ccGradeVisualFixture({ columns: input.columns, rows: input.rows }), {
      columns: input.columns,
      rows: input.rows
    });
    const snapshot = createFrameSnapshot(frame);
    const tokenMap = resolvedTokenMap();
    const capabilities = terminalCapabilitiesForProfile(input.profile);
    const ansiText = terminalPatchToString(buildTerminalPatch(diffScreens(undefined, frame.screen), capabilities));
    return {
      profile: input.profile,
      viewport: { columns: input.columns, rows: input.rows },
      plainText: snapshot.lines.join("\n"),
      ansiText,
      foregrounds: styleDistribution(snapshot, "color", tokenMap),
      backgrounds: styleDistribution(snapshot, "backgroundColor", tokenMap),
      styleCounts: {
        coloredCells: snapshot.cells.flat().filter((cell) => typeof cell.style.color === "string").length,
        backgroundCells: snapshot.cells.flat().filter((cell) => typeof cell.style.backgroundColor === "string").length,
        inverseCells: snapshot.cells.flat().filter((cell) => cell.style.inverse === true).length,
        underlineCells: snapshot.cells.flat().filter((cell) => cell.style.underline === true).length
      },
      overflowIssues: assertFrameHasNoOverflow(snapshot)
    };
  }));
}

export function summarizeCcGradeVisualArtifact(artifact: CcGradeVisualArtifact): CcGradeVisualArtifactSummary {
  return {
    kind: artifact.kind,
    createdAt: artifact.createdAt,
    viewport: artifact.viewport,
    profiles: artifact.profiles.map(({ plainText, ansiText, ...profile }) => profile),
    profileDiffs: artifact.profileDiffs
  };
}

export function formatCcGradeVisualArtifactSummary(artifact: CcGradeVisualArtifact): string {
  return [
    "CC-Grade TUI Visual Artifact",
    `created_at=${artifact.createdAt}`,
    `viewport=${artifact.viewport.columns}x${artifact.viewport.rows}`,
    "",
    ...artifact.profiles.flatMap((profile) => [
      `${profile.profile}: colored=${profile.styleCounts.coloredCells} bg=${profile.styleCounts.backgroundCells} inverse=${profile.styleCounts.inverseCells} underline=${profile.styleCounts.underlineCells} overflow=${profile.overflowIssues.length}`,
      `  foregrounds: ${formatDistribution(profile.foregrounds) || "(none)"}`,
      `  backgrounds: ${formatDistribution(profile.backgrounds) || "(none)"}`
    ]),
    "",
    "Profile Diff",
    ...artifact.profileDiffs.flatMap((diff) => [
      `${diff.left} -> ${diff.right}`,
      `  fg only left: ${diff.foregroundOnlyLeft.join(", ") || "(none)"}`,
      `  fg only right: ${diff.foregroundOnlyRight.join(", ") || "(none)"}`,
      `  bg only left: ${diff.backgroundOnlyLeft.join(", ") || "(none)"}`,
      `  bg only right: ${diff.backgroundOnlyRight.join(", ") || "(none)"}`
    ])
  ].join("\n");
}

export function writeCcGradeVisualArtifact(
  artifact: CcGradeVisualArtifact,
  outputDirectory = ".swarm/tui-visual-artifacts/cc-grade-v4"
): CcGradeVisualArtifactFiles {
  const directory = resolve(outputDirectory);
  mkdirSync(directory, { recursive: true });
  const profileFiles = artifact.profiles.map((profile) => {
    const prefix = profile.profile;
    const plainText = resolve(directory, `${prefix}.txt`);
    const ansiText = resolve(directory, `${prefix}.ansi`);
    writeFileSync(plainText, `${profile.plainText}\n`, "utf8");
    writeFileSync(ansiText, `${profile.ansiText}\n`, "utf8");
    return { profile: profile.profile, plainText, ansiText };
  });
  const summaryJson = resolve(directory, "summary.json");
  const profileDiffText = resolve(directory, "profile-diff.txt");
  const summary = summarizeCcGradeVisualArtifact(artifact);
  summary.profiles = summary.profiles.map((profile) => {
    const files = profileFiles.find((candidate) => candidate.profile === profile.profile);
    return { ...profile, plainTextFile: files?.plainText, ansiTextFile: files?.ansiText };
  });
  writeFileSync(summaryJson, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeFileSync(profileDiffText, `${formatCcGradeVisualArtifactSummary(artifact)}\n`, "utf8");
  return { directory, summaryJson, profileDiffText, profiles: profileFiles };
}

export function runCcGradeVisualArtifactCli(argv = process.argv.slice(2)): void {
  const options = parseCliOptions(argv);
  const artifact = renderCcGradeVisualArtifact({
    columns: options.columns,
    rows: options.rows
  });
  const files = writeCcGradeVisualArtifact(artifact, options.out);
  if (options.json) {
    console.log(JSON.stringify(files, null, 2));
    return;
  }
  console.log(formatCcGradeVisualArtifactSummary(artifact));
  console.log("");
  console.log(`Wrote ${files.directory}`);
}

function ccGradeMessages(): ConversationMessage[] {
  return [
    { role: "user", brief: "Find cache miss without losing marker color" },
    { role: "assistant", brief: "Assistant body stays neutral while search and selection use backgrounds." },
    { role: "user", brief: "Keep the ordinary prompt band visible too." },
    {
      role: "system",
      kind: "tool_use",
      status: "running",
      brief: "shell npm run check"
    },
    {
      role: "system",
      kind: "tool_result",
      status: "success",
      brief: "stdout cache hit and tests passed"
    }
  ];
}

function terminalCapabilitiesForProfile(profile: CcGradeVisualProfileName): TuiTerminalPatchOptions {
  if (profile === "swarm-monochrome") {
    return { capabilities: { color: false, trueColor: false, colorLevel: 0 } };
  }
  if (profile === "swarm-contrast") {
    return { capabilities: { color: true, trueColor: false, colorLevel: 1 } };
  }
  return { capabilities: { color: true, trueColor: true, colorLevel: 3 } };
}

function styleDistribution(
  snapshot: TuiFrameSnapshot,
  field: "color" | "backgroundColor",
  tokenMap: Map<string, string[]>
): CcGradeVisualDistributionEntry[] {
  const counts = new Map<string, number>();
  for (const cell of snapshot.cells.flat()) {
    const value = cell.style[field];
    if (typeof value !== "string") {
      continue;
    }
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, cells]) => ({
      value,
      cells,
      tokens: tokenMap.get(value) ?? []
    }))
    .sort((left, right) => right.cells - left.cells || left.value.localeCompare(right.value));
}

function resolvedTokenMap(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const token of TUI_VISUAL_TOKENS) {
    const color = resolveTuiColor(token);
    if (typeof color !== "string") {
      continue;
    }
    map.set(color, [...(map.get(color) ?? []), token]);
  }
  return map;
}

function profileDiffs(profiles: CcGradeVisualProfileArtifact[]): CcGradeVisualProfileDiff[] {
  const base = profiles[0];
  if (!base) {
    return [];
  }
  return profiles.slice(1).map((profile) => ({
    left: base.profile,
    right: profile.profile,
    foregroundOnlyLeft: setDifference(distributionValues(base.foregrounds), distributionValues(profile.foregrounds)),
    foregroundOnlyRight: setDifference(distributionValues(profile.foregrounds), distributionValues(base.foregrounds)),
    backgroundOnlyLeft: setDifference(distributionValues(base.backgrounds), distributionValues(profile.backgrounds)),
    backgroundOnlyRight: setDifference(distributionValues(profile.backgrounds), distributionValues(base.backgrounds))
  }));
}

function distributionValues(entries: CcGradeVisualDistributionEntry[]): Set<string> {
  return new Set(entries.map((entry) => entry.value));
}

function setDifference(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((value) => !right.has(value)).sort();
}

function formatDistribution(entries: CcGradeVisualDistributionEntry[]): string {
  return entries
    .map((entry) => `${entry.value}=${entry.cells}${entry.tokens.length ? ` [${entry.tokens.join("|")}]` : ""}`)
    .join("; ");
}

function withDeterministicColorEnv<T>(run: () => T): T {
  const previousNoColor = process.env.NO_COLOR;
  const previousSwarmNoColor = process.env.SWARM_TUI_NO_COLOR;
  delete process.env.NO_COLOR;
  delete process.env.SWARM_TUI_NO_COLOR;
  try {
    return run();
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

function parseCliOptions(argv: string[]): { out?: string; columns?: number; rows?: number; json?: boolean } {
  const options: { out?: string; columns?: number; rows?: number; json?: boolean } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") {
      options.json = true;
      continue;
    }
    if (value === "--out") {
      options.out = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--columns") {
      options.columns = parsePositiveInteger(argv[index + 1], "--columns");
      index += 1;
      continue;
    }
    if (value === "--rows") {
      options.rows = parsePositiveInteger(argv[index + 1], "--rows");
      index += 1;
    }
  }
  return options;
}

function parsePositiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function isDirectCli(): boolean {
  const invoked = process.argv[1];
  return Boolean(invoked && pathToFileURL(resolve(invoked)).href === import.meta.url);
}

if (isDirectCli()) {
  try {
    runCcGradeVisualArtifactCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
