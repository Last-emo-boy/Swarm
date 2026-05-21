import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultSwarmSettings } from "../config/settings.js";
import { normalizeToolAction, runLocalTool } from "../tools/local-tools.js";
import type { LocalToolContext } from "../tools/types.js";

test("normalizeToolAction maps LSP aliases to semantic gateway contracts", () => {
  const action = normalizeToolAction({
    action: "lsp_hover",
    path: "src/example.ts",
    line: 7,
    column: 5,
    provider: "typescript"
  });

  assert.equal(action.type, "lsp.hover");
  assert.equal(action.file, "src/example.ts");
  assert.equal(action.line, 7);
  assert.equal(action.column, 5);
  assert.equal(action.provider, "typescript");
});

test("LSP local tools return compact semantic TypeScript results", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-lsp-tools-"));
  try {
    await writeProject(workspace);
    const ctx = context(workspace);
    const base = { file: "sample.ts", provider: "typescript", timeoutMs: 2_000 } as const;

    const diagnostics = await runLocalTool({ type: "lsp.diagnostics", ...base, maxResults: 10 }, ctx);
    assert.equal(diagnostics.status, "success");
    assert.match(diagnostics.content ?? "", /not assignable|参数|类型/i);

    const hover = await runLocalTool({ type: "lsp.hover", ...base, line: 4, column: 16 }, ctx);
    assert.equal(hover.status, "success");
    assert.match(hover.content ?? "", /alpha/);

    const definition = await runLocalTool({ type: "lsp.definition", ...base, line: 4, column: 16 }, ctx);
    assert.equal(definition.status, "success");
    assert.match(definition.content ?? "", /sample\.ts/);

    const references = await runLocalTool({ type: "lsp.references", ...base, line: 4, column: 16 }, ctx);
    assert.equal(references.status, "success");
    assert.match(references.summary, /reference/);

    const documentSymbols = await runLocalTool({ type: "lsp.document_symbols", ...base }, ctx);
    assert.equal(documentSymbols.status, "success");
    assert.match(documentSymbols.content ?? "", /alpha/);

    const workspaceSymbols = await runLocalTool({ type: "lsp.workspace_symbols", provider: "typescript", root: ".", query: "alpha", timeoutMs: 2_000 }, ctx);
    assert.equal(workspaceSymbols.status, "success");
    assert.match(workspaceSymbols.content ?? "", /alpha/);

    const completion = await runLocalTool({ type: "lsp.completion", ...base, line: 5, column: 3, prefix: "al" }, ctx);
    assert.equal(completion.status, "success");
    assert.match(completion.content ?? "", /alpha/);

    const codeActions = await runLocalTool({ type: "lsp.code_actions", ...base, line: 2, column: 24 }, ctx);
    assert.equal(codeActions.status, "success");

    const rename = await runLocalTool({ type: "lsp.rename_preview", ...base, line: 4, column: 16, newName: "renamedAlpha" }, ctx);
    assert.equal(rename.status, "success");
    assert.match(rename.content ?? "", /renamedAlpha/);

    const format = await runLocalTool({ type: "lsp.format", ...base }, ctx);
    assert.equal(format.status, "success");
    assert.match(format.summary, /format preview/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function writeProject(workspace: string): Promise<void> {
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "package.json"), "{\"type\":\"module\"}\n", "utf8");
  await writeFile(join(workspace, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      skipLibCheck: true
    },
    include: ["*.ts"]
  }, null, 2), "utf8");
  await writeFile(join(workspace, "sample.ts"), [
    "export function alpha(value: number): number {",
    "  return value;",
    "}",
    "export const beta = alpha(1);",
    "export const bad = alpha(\"x\");",
    ""
  ].join("\n"), "utf8");
}

function context(workspace: string): LocalToolContext {
  const settings = defaultSwarmSettings();
  settings.permissions.defaultMode = "full-auto";
  return { workspace, settings };
}
