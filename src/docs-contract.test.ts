import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const MATRIX_PATH = ".workflow/specs/work-kernel-docs-coverage-matrix.md";
const VALID_STATUSES = new Set([
  "implemented+tested",
  "implemented+partial-test",
  "implemented-unverified",
  "partial",
  "deferred"
]);
const REQUIRED_REQUIREMENTS = [
  "REQ-WL",
  "REQ-AP",
  "REQ-CK",
  "REQ-SP",
  "REQ-CR",
  "REQ-RM",
  "REQ-DD",
  "REQ-BM",
  "REQ-CC"
];
const DEFERRED_ITEMS = [
  "Hook-race approval behavior",
  "Broader checkpoint orchestration",
  "Distributed ASP hardening",
  "Rich WorkSource writes"
];

test("docs coverage matrix has required requirements, statuses, and anchors", () => {
  const matrix = readWorkspaceFile(MATRIX_PATH);
  const rows = parseMatrixRows(matrix);

  for (const requirement of REQUIRED_REQUIREMENTS) {
    assert(
      rows.some((row) => row.name === requirement),
      `Missing coverage matrix requirement row: ${requirement}`
    );
  }

  for (const row of rows) {
    assert(VALID_STATUSES.has(row.status), `Unsupported coverage status for ${row.name}: ${row.status}`);
    if (row.status !== "deferred") {
      assert(row.source.includes("`"), `Non-deferred row lacks source anchors: ${row.name}`);
    }
    if (row.status === "implemented+tested") {
      assert(row.tests.includes(".test.ts"), `Strong tested row lacks .test.ts anchor: ${row.name}`);
    }
  }

  for (const deferred of DEFERRED_ITEMS) {
    const row = rows.find((candidate) => candidate.name === deferred);
    assert(row, `Missing deferred row: ${deferred}`);
    assert.equal(row.status, "deferred", `${deferred} must remain deferred until implemented and verified.`);
  }
});

test("documentation points to the coverage matrix and does not overclaim checkpoints", () => {
  const workKernel = readWorkspaceFile("docs/WORK_KERNEL.md");
  const prd = readWorkspaceFile("docs/PRD.md");
  const readme = readWorkspaceFile("README.md");
  const cli = readWorkspaceFile("src/index.ts");

  assert(workKernel.includes(MATRIX_PATH), "WORK_KERNEL.md must reference the coverage matrix.");
  assert(prd.includes(MATRIX_PATH), "PRD.md must reference the coverage matrix.");

  if (readme.includes("swarm checkpoints")) {
    assert(
      cli.includes('command === "checkpoints"') && cli.includes("runCheckpointsCommand"),
      "README advertises `swarm checkpoints`, but src/index.ts lacks the command route."
    );
  }

  assert.match(readme, /Gateway checkpoint/i, "README should keep Gateway checkpoint status visible.");
  assert.match(readme, /bounded|partial|broader checkpoint|deferred|not yet exposed|not yet implemented/i,
    "README must describe Gateway checkpoint support as bounded or keep an explicit broader checkpoint caveat.");
});

test("product docs keep claim boundaries explicit", () => {
  const workKernel = readWorkspaceFile("docs/WORK_KERNEL.md");
  const prd = readWorkspaceFile("docs/PRD.md");
  const readme = readWorkspaceFile("README.md");
  const docs = [
    ["README.md", readme],
    ["docs/PRD.md", prd],
    ["docs/WORK_KERNEL.md", workKernel]
  ] as const;
  const prdVision = getSection(prd, "Vision");
  const runtimeBoundary = getSection(workKernel, "Runtime Boundary Notes");
  const hookRaceLine = runtimeBoundary
    .split(/\r?\n/)
    .find((line) => /Permission hooks and user approval can race/i.test(line));

  assert.doesNotMatch(
    prdVision,
    /local and distributed agent swarm CLI/i,
    "PRD Vision must not open with an over-broad local-and-distributed product claim."
  );
  assert.match(prdVision, /local CLI\/TUI-first/i, "PRD Vision should keep the product boundary local and CLI/TUI-first.");
  assert.match(prdVision, /evidence-bounded/i, "PRD Vision should keep release claims evidence-bounded.");

  assert(hookRaceLine, "WORK_KERNEL Runtime Boundary Notes must mention hook/user approval race behavior.");
  assert.match(
    runtimeBoundary,
    /hook.*approval.*race[\s\S]*(deferred|partial|planned|design intent)/i,
    "WORK_KERNEL hook-race notes must mark arbitration as deferred, partial, planned, or design intent."
  );

  assertBoundary(readme, /bounded Gateway checkpoint route/i, "README.md", "bounded Gateway checkpoint route");
  assertBoundary(readme, /broader\s+checkpoint orchestration/i, "README.md", "broader checkpoint orchestration");
  assertBoundary(readme, /Broader distributed ASP transport is still planned/i, "README.md", "broader distributed ASP");
  assertBoundary(readme, /Hook-race approval arbitration and rich WorkSource writes remain deferred/i, "README.md", "hook-race arbitration and rich WorkSource writes");

  assertBoundary(prd, /bounded Gateway\s+checkpoint route/i, "docs/PRD.md", "bounded Gateway checkpoint route");
  assertBoundary(prd, /broader\s+checkpoint orchestration/i, "docs/PRD.md", "broader checkpoint orchestration");
  assertBoundary(prd, /broader\s+distributed ASP transport hardening[\s\S]*verified local child-process seam/i, "docs/PRD.md", "broader distributed ASP");
  assertBoundary(prd, /hook-race approval arbitration/i, "docs/PRD.md", "hook-race arbitration");
  assertBoundary(prd, /richer WorkSource write operations/i, "docs/PRD.md", "rich WorkSource writes");

  assertBoundary(workKernel, /bounded Gateway checkpoint route/i, "docs/WORK_KERNEL.md", "bounded Gateway checkpoint route");
  assertBoundary(workKernel, /broader\s+checkpoint orchestration/i, "docs/WORK_KERNEL.md", "broader checkpoint orchestration");
  assertBoundary(workKernel, /Broader distributed transport\s+hardening remains a planned follow-on slice/i, "docs/WORK_KERNEL.md", "broader distributed ASP");
  assertBoundary(workKernel, /First-authoritative-decision\s+behavior is a deferred design intent, not implemented arbitration/i, "docs/WORK_KERNEL.md", "hook-race arbitration");
  assertBoundary(workKernel, /Keep richer WorkSource writes out of the scheduler/i, "docs/WORK_KERNEL.md", "rich WorkSource writes");

  for (const [path, contents] of docs) {
    assert.match(
      contents,
      /deferred|partial|planned|not completed|not implemented|not yet exposed|not yet implemented|design intent/i,
      `${path} must retain at least one explicit caveat for unfinished claim boundaries.`
    );
  }
});

test("coverage matrix source and test anchors resolve to real workspace files", () => {
  const rows = parseMatrixRows(readWorkspaceFile(MATRIX_PATH));
  for (const row of rows) {
    const anchors = [...row.source.matchAll(/`([^`]+)`/g)]
      .map((match) => match[1])
      .filter((anchor) => anchor.startsWith("src/") || anchor.startsWith("docs/") || anchor.startsWith(".workflow/"));
    for (const anchor of anchors) {
      const file = anchor.split(/\s+/)[0];
      assert(existsSync(resolve(process.cwd(), file)), `Missing source anchor file for ${row.name}: ${file}`);
    }

    const testAnchors = [...row.tests.matchAll(/`([^`]+\.test\.ts)`/g)].map((match) => match[1]);
    for (const anchor of testAnchors) {
      assert(existsSync(resolve(process.cwd(), anchor)), `Missing test anchor file for ${row.name}: ${anchor}`);
    }
  }
});

type MatrixRow = {
  name: string;
  source: string;
  tests: string;
  status: string;
};

function parseMatrixRows(markdown: string): MatrixRow[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && !line.startsWith("| ---"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 3)
    .map((cells): MatrixRow | undefined => {
      const name = stripMarkdown(cells[0]);
      if (!name || name === "Status" || name === "Concept" || name === "Requirement" || name === "Capability" || name === "Item") {
        return undefined;
      }
      if (VALID_STATUSES.has(stripMarkdown(cells[0]))) {
        return undefined;
      }
      const statusIndex = cells.findIndex((cell) => VALID_STATUSES.has(stripMarkdown(cell)));
      if (statusIndex < 0) {
        return undefined;
      }
      return {
        name,
        source: cells[2] ?? "",
        tests: cells[3] ?? "",
        status: stripMarkdown(cells[statusIndex])
      };
    })
    .filter((row): row is MatrixRow => row !== undefined);
}

function stripMarkdown(value: string): string {
  return value.replace(/`/g, "").trim();
}

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function getSection(markdown: string, heading: string): string {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  assert.notEqual(start, -1, `Missing section: ${heading}`);
  const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start + 1, next === -1 ? undefined : next).join("\n");
}

function assertBoundary(contents: string, pattern: RegExp, path: string, boundary: string): void {
  assert.match(contents, pattern, `${path} must keep ${boundary} explicitly deferred, partial, planned, or unfinished.`);
}
