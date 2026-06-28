import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

// NOTE: the previous ".workflow/specs/work-kernel-docs-coverage-matrix.md"
// coverage-matrix contract was retired (the matrix file was dropped when
// .workflow/ was gitignored). These tests now enforce documentation claim
// boundaries directly against the shipped docs, without a separate matrix file.

test("documentation does not overclaim checkpoints", () => {
  const readme = readWorkspaceFile("README.md");
  const cli = readWorkspaceFile("src/index.ts");

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

test("true swarm claims stay evidence-backed and bounded", () => {
  const readme = readWorkspaceFile("README.md");
  const prd = readWorkspaceFile("docs/PRD.md");
  const workKernel = readWorkspaceFile("docs/WORK_KERNEL.md");
  const rfc = readWorkspaceFile("docs/SWARM_V2_PROTOCOL_RFC.md");
  const docs = [
    ["README.md", readme],
    ["docs/PRD.md", prd],
    ["docs/WORK_KERNEL.md", workKernel],
    ["docs/SWARM_V2_PROTOCOL_RFC.md", rfc]
  ] as const;

  for (const [path, contents] of docs) {
    assert.match(
      contents,
      /Evidence-backed local Swarm v2 collaboration/i,
      `${path} must describe the upgraded Swarm v2 claim as evidence-backed local collaboration.`
    );
    assert.match(
      contents,
      /cross-host distributed network/i,
      `${path} must keep cross-host distributed network work deferred.`
    );
    assert.match(
      contents,
      /complex consensus/i,
      `${path} must keep complex consensus claims bounded.`
    );
    assert.match(
      contents,
      /external provider dogfood/i,
      `${path} must keep external provider dogfood optional or deferred.`
    );
    assert.doesNotMatch(
      contents,
      /fully autonomous true swarm|true swarm is fully autonomous|fully implemented true swarm|complete true swarm/i,
      `${path} must not claim fully autonomous or complete true swarm.`
    );
  }
});

test("TUI product spec preserves CC-style product requirements and evidence gates", () => {
  const spec = readWorkspaceFile("docs/TUI_PRODUCT_SPEC.md");
  const renderer = readWorkspaceFile("docs/TUI_RENDERER.md");

  for (const phrase of [
    "Conversation-first layout",
    "No default auto-open of command output detail panes",
    "MCP, Skills, LSP, Gateway, Cache, Symphony, Tasks, and Approvals",
    "Empty Enter must not open a `COMMAND OUTPUT` screen",
    "NO_COLOR",
    "npm run smoke",
    "swarm tui-smoke --json"
  ]) {
    assert(spec.includes(phrase), `TUI product spec is missing: ${phrase}`);
  }
  assert(renderer.includes("dom-renderer"), "renderer doc must keep the default DOM renderer contract visible.");
});

test("Swarm v2 protocol RFC keeps planned boundary and compatibility gates explicit", () => {
  const rfc = readWorkspaceFile("docs/SWARM_V2_PROTOCOL_RFC.md");

  for (const phrase of [
    "Status: evidence-backed local Swarm v2 protocol surface; distributed and remote-worker scope remains deferred.",
    "Every new agent-to-agent interaction MUST be representable as an Envelope.",
    "Envelope Bus",
    "Agent Actor",
    "Ownership Contract",
    "Handoff",
    "Blackboard Collaboration",
    "Symphony MUST enter as `symphony.scheduler` participant",
    "Gateway MUST normalize external control actions",
    "Compatibility Matrix",
    "Direct Paths To Migrate",
    "Allowed Compatibility Adapters",
    "Migration Gates",
    "Evidence-backed local Swarm v2 collaboration",
    "No claim that Swarm v2 is complete beyond the local evidence-backed protocol surface."
  ]) {
    assert(rfc.includes(phrase), `Swarm v2 RFC is missing: ${phrase}`);
  }

  for (const legacyPath of [
    "`SwarmRuntime.invokeAgent()`",
    "`HandoffStore.create()`",
    "`SymphonyScheduler.dispatchItem()`",
    "`TraceStore`",
    "`WorkerStateStore`"
  ]) {
    assert(rfc.includes(legacyPath), `Swarm v2 RFC must name compatibility or migration path: ${legacyPath}`);
  }

  assert.doesNotMatch(
    rfc,
    /Swarm v2 (is|has been) fully implemented|fully autonomous true swarm/i,
    "Swarm v2 RFC must not overclaim implementation completion."
  );
});

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
