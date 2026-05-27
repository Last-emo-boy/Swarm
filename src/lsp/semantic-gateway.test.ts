import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultSwarmSettings } from "../config/settings.js";
import { normalizeToolAction, runLocalTool } from "../tools/local-tools.js";
import type { LocalToolContext } from "../tools/types.js";
import { detectLspWorkspaceRoot, languageForFile } from "./root-detection.js";
import { buildLspSemanticTaskPlan } from "./semantic-participant.js";

test("detectLspWorkspaceRoot finds nearest TypeScript project root", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-lsp-root-"));
  try {
    await mkdir(join(workspace, "packages", "app", "src"), { recursive: true });
    await writeFile(join(workspace, "package.json"), "{\"type\":\"module\"}\n", "utf8");
    await writeFile(join(workspace, "packages", "app", "tsconfig.json"), "{}\n", "utf8");
    const file = join(workspace, "packages", "app", "src", "main.ts");
    await writeFile(file, "export const value = 1;\n", "utf8");

    const detected = await detectLspWorkspaceRoot({ workspace, file });

    assert.equal(detected.language, "typescript");
    assert.equal(detected.marker, "tsconfig.json");
    assert.equal(detected.workspaceRoot, join(workspace, "packages", "app"));
    assert.equal(languageForFile("service.py"), "python");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("LSP semantic gateway serves compact TypeScript tool results", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-lsp-gateway-"));
  try {
    await writeFixtureProject(workspace);
    const context = toolContext(workspace);

    const normalized = normalizeToolAction({
      action: "lsp_definition",
      path: "src/use.ts",
      line: 3,
      character: 21
    });
    assert.equal(normalized.type, "lsp.definition");
    assert.equal("file" in normalized ? normalized.file : undefined, "src/use.ts");
    assert.equal("column" in normalized ? normalized.column : undefined, 22);

    const documentSymbols = await runLocalTool({
      type: "lsp.document_symbols",
      file: "src/math.ts"
    }, context);
    assert.equal(documentSymbols.status, "success");
    assert.match(documentSymbols.content ?? "", /add/);

    const workspaceSymbols = await runLocalTool({
      type: "lsp.workspace_symbols",
      root: ".",
      query: "add"
    }, context);
    assert.equal(workspaceSymbols.status, "success");
    assert.match(workspaceSymbols.content ?? "", /add/);

    const definition = await runLocalTool({
      type: "lsp.definition",
      file: "src/use.ts",
      line: 3,
      column: 22
    }, context);
    assert.equal(definition.status, "success");
    assert.match(definition.content ?? "", /src\/math\.ts/);
    const definitionEvidence = recordValue(definition.metadata?.semantic_evidence);
    assert.equal(definitionEvidence.schema_version, "swarm.semantic_evidence.v1");
    assert.match(String(definitionEvidence.evidence_id), /^sem:[a-f0-9]{12}$/);
    assert.equal(definitionEvidence.source, "lsp");
    assert.equal(definitionEvidence.action, "lsp.definition");
    assert.equal(definitionEvidence.status, "success");
    assert.equal(definitionEvidence.lsp_status, "ready");
    assert.equal(definitionEvidence.staleness, "fresh");
    assert.equal(definitionEvidence.fallback_used, false);
    assert.equal(definitionEvidence.symbol, "add");
    assert.deepEqual(definitionEvidence.range, { start: { line: 2, column: 17 }, end: { line: 2, column: 20 } });
    assert.deepEqual(definitionEvidence.result_keys, ["definitions"]);
    assert.match(JSON.stringify(definitionEvidence.primary_refs), /src\/math\.ts/);

    const references = await runLocalTool({
      type: "lsp.references",
      file: "src/use.ts",
      line: 3,
      column: 22,
      maxResults: 10
    }, context);
    assert.equal(references.status, "success");
    assert.match(references.content ?? "", /src\/use\.ts/);

    const hover = await runLocalTool({
      type: "lsp.hover",
      file: "src/use.ts",
      line: 3,
      column: 22
    }, context);
    assert.equal(hover.status, "success");
    assert.match(hover.content ?? "", /add/);

    const diagnostics = await runLocalTool({
      type: "lsp.diagnostics",
      file: "src/use.ts",
      maxResults: 10
    }, context);
    assert.equal(diagnostics.status, "success");
    assert.match(diagnostics.content ?? "", /not assignable|参数|类型/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("LSP semantic gateway gives actionable fallback for unsupported languages", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-lsp-unsupported-"));
  try {
    await writeFile(join(workspace, "pyproject.toml"), "[project]\nname = \"fixture\"\n", "utf8");
    await writeFile(join(workspace, "service.py"), "def handler():\n    return 1\n", "utf8");

    const result = await runLocalTool({
      type: "lsp.hover",
      file: "service.py",
      line: 1,
      column: 5
    }, toolContext(workspace));

    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "unsupported_language");
    assert.match(result.summary, /python/);
    assert.match(result.content ?? "", /fallback=/);
    assert.equal(result.recovery?.category, "lsp");
    assert.match(result.content ?? "", /Recovery detail/);
    assert.match(result.recoverySuggestion ?? "", /file\.grep/);
    assert.match(result.recoverySuggestion ?? "", /file\.read/);
    assert.match(result.recoverySuggestion ?? "", /provider for python/);
    const evidence = recordValue(result.metadata?.semantic_evidence);
    assert.equal(evidence.schema_version, "swarm.semantic_evidence.v1");
    assert.match(String(evidence.evidence_id), /^sem:[a-f0-9]{12}$/);
    assert.equal(evidence.source, "fallback");
    assert.equal(evidence.action, "lsp.hover");
    assert.equal(evidence.status, "failed");
    assert.equal(evidence.lsp_status, "unsupported_language");
    assert.equal(evidence.staleness, "fallback");
    assert.equal(evidence.fallback_used, true);
    assert.equal(evidence.fallback_reason, "unsupported_language");
    assert.deepEqual(evidence.fallback_tools, ["file.grep", "file.read"]);
    assert.equal(evidence.next_action, result.recoverySuggestion);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("LSP semantic evidence marks partial rename previews stale with changed files", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-lsp-rename-evidence-"));
  try {
    await writeFixtureProject(workspace);

    const result = await runLocalTool({
      type: "lsp.rename_preview",
      file: "src/use.ts",
      line: 2,
      column: 22,
      newName: "sum",
      maxResults: 1
    }, toolContext(workspace));

    assert.equal(result.status, "partial");
    const evidence = recordValue(result.metadata?.semantic_evidence);
    assert.equal(evidence.schema_version, "swarm.semantic_evidence.v1");
    assert.equal(evidence.action, "lsp.rename_preview");
    assert.equal(evidence.symbol, "add");
    assert.equal(evidence.staleness, "stale");
    assert.match(String(evidence.stale_reason), /truncated|partial/);
    assert.deepEqual(evidence.changed_files, ["src/use.ts"]);
    assert.deepEqual(evidence.range, { start: { line: 2, column: 22 }, end: { line: 2, column: 25 } });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("LSP semantic planning participant produces TypeScript task hints", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-lsp-planning-"));
  try {
    await writeFixtureProject(workspace);

    const plan = await buildLspSemanticTaskPlan({
      workspace,
      objective: "Refactor add usage and fix arithmetic diagnostics",
      query: "add",
      files: ["src/use.ts"]
    });

    assert.equal(plan.schema_version, "swarm.lsp_semantic_task_plan.v1");
    assert.equal(plan.participant_id, "capability:lsp:planning");
    assert.equal(plan.state, "active");
    assert.equal(plan.language, "typescript");
    assert.equal(plan.provider, "typescript-language-service");
    assert.equal(plan.conflict_report.status, "clear");
    assert(plan.task_hints.some((hint) => hint.kind === "semantic_task_scope" && hint.affected_symbols.some((symbol) => symbol.name === "add")));
    assert(plan.task_hints.some((hint) => hint.kind === "diagnostic_hotspot" && hint.risk_hotspots.some((hotspot) => /assignable|类型|参数/i.test(hotspot.message))));
    assert(plan.task_hints.some((hint) => hint.candidate_files.includes("src/use.ts") || hint.candidate_files.includes("src/math.ts")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("LSP semantic planning degrades without failing for unsupported languages", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-lsp-planning-unsupported-"));
  try {
    await writeFile(join(workspace, "pyproject.toml"), "[project]\nname = \"fixture\"\n", "utf8");
    await writeFile(join(workspace, "service.py"), "def handler():\n    return 1\n", "utf8");

    const plan = await buildLspSemanticTaskPlan({
      workspace,
      objective: "Plan Python handler update",
      files: ["service.py"]
    });

    assert.equal(plan.state, "degraded");
    assert.equal(plan.language, "python");
    assert.match(plan.degraded_reason ?? "", /python/);
    assert.match(plan.recovery_suggestion ?? "", /file\.grep/);
    assert.match(plan.recovery_suggestion ?? "", /file\.read/);
    assert.equal(plan.conflict_report.status, "degraded");
    assert.deepEqual(plan.task_hints, []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("LSP semantic planning conflict report includes symbol and reference evidence", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-lsp-planning-conflict-"));
  try {
    await writeFixtureProject(workspace);

    const plan = await buildLspSemanticTaskPlan({
      workspace,
      objective: "Change add contract safely",
      query: "add",
      files: ["src/use.ts"],
      ownershipHints: [{
        owner_actor_id: "actor:worker-a",
        task_id: "TASK-A",
        file: "src/math.ts",
        symbol: "add",
        range: {
          start: { line: 2, column: 17 },
          end: { line: 2, column: 20 }
        },
        reason: "actor:worker-a owns the add API change"
      }]
    });

    assert.equal(plan.state, "active");
    assert.equal(plan.conflict_report.status, "conflict");
    const conflict = plan.conflict_report.conflicts[0];
    assert.equal(conflict.owner_actor_id, "actor:worker-a");
    assert.equal(conflict.task_id, "TASK-A");
    assert.equal(conflict.file, "src/math.ts");
    assert.equal(conflict.symbol, "add");
    assert.match(conflict.reason, /add API/);
    assert(conflict.references.some((reference) => reference.includes("src/math.ts")));
    assert(conflict.references.some((reference) => reference.includes("src/use.ts")));
    assert(plan.task_hints.some((hint) => hint.kind === "ownership_conflict" && hint.summary.includes("actor:worker-a")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function writeFixtureProject(workspace: string): Promise<void> {
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "package.json"), JSON.stringify({ type: "module" }, null, 2), "utf8");
  await writeFile(join(workspace, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      skipLibCheck: true
    },
    include: ["src/**/*.ts"]
  }, null, 2), "utf8");
  await writeFile(join(workspace, "src", "math.ts"), [
    "export type Addend = number;",
    "export function add(left: Addend, right: Addend): Addend {",
    "  return left + right;",
    "}",
    ""
  ].join("\n"), "utf8");
  await writeFile(join(workspace, "src", "use.ts"), [
    "import { add } from \"./math.js\";",
    "export const total = add(\"1\", 2);",
    "export const again = add(1, 2);",
    ""
  ].join("\n"), "utf8");
}

function toolContext(workspace: string): LocalToolContext {
  const settings = defaultSwarmSettings();
  settings.permissions.defaultMode = "full-auto";
  return { workspace, settings };
}

function recordValue(value: unknown): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value), "expected record value");
  return value as Record<string, unknown>;
}
