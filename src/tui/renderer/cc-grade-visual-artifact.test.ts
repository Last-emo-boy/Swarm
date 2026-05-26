import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  renderCcGradeVisualArtifact,
  writeCcGradeVisualArtifact
} from "./cc-grade-visual-artifact.js";

test("cc-grade visual artifact writer emits plain ANSI summary and profile diff files", () => {
  const directory = mkdtempSync(join(tmpdir(), "swarm-tui-visual-artifact-"));
  try {
    const artifact = renderCcGradeVisualArtifact({
      columns: 80,
      rows: 24,
      createdAt: "2026-05-23T00:00:00.000Z"
    });
    const files = writeCcGradeVisualArtifact(artifact, directory);
    const summary = JSON.parse(readFileSync(files.summaryJson, "utf8")) as {
      kind: string;
      profiles: Array<{ profile: string; plainTextFile?: string; ansiTextFile?: string; foregrounds: unknown[]; backgrounds: unknown[] }>;
      profileDiffs: unknown[];
    };
    const darkFiles = files.profiles.find((profile) => profile.profile === "swarm-dark");
    const monoFiles = files.profiles.find((profile) => profile.profile === "swarm-monochrome");

    assert.equal(summary.kind, "cc-grade-tui-visual-artifact");
    assert.equal(summary.profiles.length, 3);
    assert(summary.profileDiffs.length >= 2);
    assert(darkFiles);
    assert(monoFiles);
    assert.match(readFileSync(darkFiles.plainText, "utf8"), /Find cache miss/);
    assert.match(readFileSync(darkFiles.ansiText, "utf8"), /\u001B\[[^m]*38;2/);
    assert.doesNotMatch(readFileSync(monoFiles.ansiText, "utf8"), /38;2|38;5|48;2|48;5/);
    assert.match(readFileSync(files.profileDiffText, "utf8"), /Profile Diff/);
    assert(summary.profiles.some((profile) => profile.profile === "swarm-dark" && profile.foregrounds.length > 0 && profile.backgrounds.length > 0));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
