import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultSwarmSettings } from "../config/settings.js";
import { normalizeToolAction, runLocalTool } from "../tools/local-tools.js";
import type { LocalToolContext } from "../tools/types.js";
import { lspCapabilityFactsForProvider } from "./capabilities.js";
import { disposeGlobalLspManager, LspManager } from "./manager.js";

test("lsp status reports TypeScript semantic fallback without external command", async () => {
  const fixture = await createFixture("swarm-lsp-status-");
  const previousPath = process.env.PATH;
  const previousPathExt = process.env.PATHEXT;
  const previousHome = process.env.SWARM_HOME;
  const previousTsCommand = process.env.SWARM_LSP_TYPESCRIPT_COMMAND;
  const previousTsArgs = process.env.SWARM_LSP_TYPESCRIPT_ARGS;
  try {
    process.env.PATH = "";
    process.env.PATHEXT = "";
    process.env.SWARM_HOME = fixture.home;
    delete process.env.SWARM_LSP_TYPESCRIPT_COMMAND;
    delete process.env.SWARM_LSP_TYPESCRIPT_ARGS;
    await writeFile(join(fixture.workspace, "package.json"), "{}\n", "utf8");

    const report = await new LspManager(fixture.workspace).status("typescript");
    const provider = report.providers[0];

    assert.equal(provider.providerId, "typescript");
    assert.equal(provider.detected, true);
    assert.equal(provider.available, true);
    assert.equal(provider.status, "ready");
    assert.equal(provider.command, "typescript-language-service");
    assert.match(provider.reason ?? "", /semantic provider fallback/);
  } finally {
    restoreEnv(previousPath, previousPathExt, previousHome);
    restoreEnvValue("SWARM_LSP_TYPESCRIPT_COMMAND", previousTsCommand);
    restoreEnvValue("SWARM_LSP_TYPESCRIPT_ARGS", previousTsArgs);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("lsp capability facts omit undetected missing providers", () => {
  const capabilities = lspCapabilityFactsForProvider({
    providerId: "python",
    status: "unavailable",
    commandAvailable: false,
    semanticFallback: false,
    detected: false,
    command: "pyright-langserver",
    envPrefix: "SWARM_LSP_PYTHON"
  });

  assert.deepEqual(capabilities, []);
});

test("lsp tool uses TypeScript semantic fallback when server command is missing", async () => {
  const fixture = await createFixture("swarm-lsp-tool-");
  const previousPath = process.env.PATH;
  const previousPathExt = process.env.PATHEXT;
  const previousHome = process.env.SWARM_HOME;
  const previousTsCommand = process.env.SWARM_LSP_TYPESCRIPT_COMMAND;
  const previousTsArgs = process.env.SWARM_LSP_TYPESCRIPT_ARGS;
  try {
    process.env.PATH = "";
    process.env.PATHEXT = "";
    process.env.SWARM_HOME = fixture.home;
    delete process.env.SWARM_LSP_TYPESCRIPT_COMMAND;
    delete process.env.SWARM_LSP_TYPESCRIPT_ARGS;
    await writeFile(join(fixture.workspace, "package.json"), "{}\n", "utf8");
    await writeFile(join(fixture.workspace, "sample.ts"), "const value = 1;\n", "utf8");

    const action = normalizeToolAction({ action: "lsp_hover", file: "sample.ts", line: 1, column: 7 });
    const result = await runLocalTool(action, context(fixture.workspace));

    assert.equal(result.status, "success");
    assert.match(result.summary, /hover/i);
    assert.match(result.content ?? "", /value/);
  } finally {
    await disposeGlobalLspManager(fixture.workspace);
    restoreEnv(previousPath, previousPathExt, previousHome);
    restoreEnvValue("SWARM_LSP_TYPESCRIPT_COMMAND", previousTsCommand);
    restoreEnvValue("SWARM_LSP_TYPESCRIPT_ARGS", previousTsArgs);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("lsp cli status emits json provider report", async () => {
  const fixture = await createFixture("swarm-lsp-cli-");
  try {
    await writeFile(join(fixture.workspace, "package.json"), "{}\n", "utf8");
    const result = await runCli([
      "--import",
      "tsx",
      "src/index.ts",
      "lsp",
      "status",
      "--workspace",
      fixture.workspace,
      "--provider",
      "typescript",
      "--json"
    ], {
      SWARM_HOME: fixture.home,
      PATH: "",
      PATHEXT: "",
      SWARM_LSP_TYPESCRIPT_COMMAND: "",
      SWARM_LSP_TYPESCRIPT_ARGS: ""
    });

    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as {
      workspace: string;
      providers: Array<{ providerId: string; detected: boolean; available: boolean; status: string }>;
      semanticPlanning?: {
        participant_id: string;
        state: string;
        task_hint_capable: boolean;
        conflict_evidence_capable: boolean;
      };
    };
    assert.equal(parsed.workspace, fixture.workspace);
    assert.equal(parsed.providers.length, 1);
    assert.equal(parsed.providers[0].providerId, "typescript");
    assert.equal(parsed.providers[0].detected, true);
    assert.equal(parsed.providers[0].available, true);
    assert.equal(parsed.providers[0].status, "ready");
    assert.equal(parsed.semanticPlanning?.participant_id, "capability:lsp:planning");
    assert.equal(parsed.semanticPlanning?.state, "active");
    assert.equal(parsed.semanticPlanning?.task_hint_capable, true);
    assert.equal(parsed.semanticPlanning?.conflict_evidence_capable, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("lsp cli restart, logs, and unknown command keep stable product shapes", async () => {
  const fixture = await createFixture("swarm-lsp-cli-lifecycle-");
  try {
    await writeFile(join(fixture.workspace, "package.json"), "{}\n", "utf8");
    const restart = await runCli([
      "--import",
      "tsx",
      "src/index.ts",
      "lsp",
      "restart",
      "--workspace",
      fixture.workspace,
      "--provider",
      "typescript",
      "--json"
    ], {
      SWARM_HOME: fixture.home,
      PATH: "",
      PATHEXT: "",
      SWARM_LSP_TYPESCRIPT_COMMAND: "",
      SWARM_LSP_TYPESCRIPT_ARGS: ""
    });
    assert.equal(restart.code, 0, restart.stderr);
    const parsedRestart = JSON.parse(restart.stdout) as { providers: Array<{ providerId: string; status: string; available: boolean }> };
    assert.equal(parsedRestart.providers[0].providerId, "typescript");
    assert.equal(parsedRestart.providers[0].status, "ready");
    assert.equal(parsedRestart.providers[0].available, true);

    const logs = await runCli([
      "--import",
      "tsx",
      "src/index.ts",
      "lsp",
      "logs",
      "--workspace",
      fixture.workspace,
      "--provider",
      "typescript",
      "--lines",
      "2"
    ], {
      SWARM_HOME: fixture.home,
      PATH: "",
      PATHEXT: "",
      SWARM_LSP_TYPESCRIPT_COMMAND: "",
      SWARM_LSP_TYPESCRIPT_ARGS: ""
    });
    assert.equal(logs.code, 0, logs.stderr);
    assert.match(logs.stdout, /typescript:/);

    const unknown = await runCli([
      "--import",
      "tsx",
      "src/index.ts",
      "lsp",
      "inspect",
      "--workspace",
      fixture.workspace
    ], {
      SWARM_HOME: fixture.home,
      PATH: "",
      PATHEXT: ""
    });
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /Unknown lsp command: inspect/);
    assert.match(unknown.stdout, /Usage: swarm lsp status/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("LspManager stdio client handles lifecycle, diagnostics, timeout, restart, and logs", async () => {
  const fixture = await createFixture("swarm-lsp-stdio-");
  const previousHome = process.env.SWARM_HOME;
  const previousTsCommand = process.env.SWARM_LSP_TYPESCRIPT_COMMAND;
  const previousTsArgs = process.env.SWARM_LSP_TYPESCRIPT_ARGS;
  try {
    process.env.SWARM_HOME = fixture.home;
    process.env.SWARM_LSP_TYPESCRIPT_COMMAND = JSON.stringify(process.execPath);
    const stubServer = join(fixture.root, "stub-lsp-server.mjs");
    await writeFile(stubServer, STUB_LSP_SERVER, "utf8");
    process.env.SWARM_LSP_TYPESCRIPT_ARGS = JSON.stringify(stubServer);
    await writeFile(join(fixture.workspace, "package.json"), "{}\n", "utf8");
    const file = join(fixture.workspace, "sample.ts");
    await writeFile(file, "const value = 1;\n", "utf8");

    const manager = new LspManager(fixture.workspace);
    const diagnostics = await manager.diagnostics({
      path: file,
      text: "const value = 1;\n",
      providerId: "typescript",
      timeoutMs: 2_000
    }) as Array<{ message: string }>;
    assert.equal(diagnostics[0]?.message, "stub diagnostic");

    const hover = await manager.hover({
      path: file,
      text: "const value = 1;\n",
      position: { line: 0, character: 6 },
      providerId: "typescript",
      timeoutMs: 2_000
    }) as { contents?: { value?: string } };
    assert.match(hover.contents?.value ?? "", /stub hover/);

    await assert.rejects(
      manager.definition({
        path: file,
        text: "const value = 1;\n",
        position: { line: 0, character: 6 },
        providerId: "typescript",
        timeoutMs: 30
      }),
      /timed out/
    );

    const beforeRestart = await manager.status("typescript");
    assert.equal(beforeRestart.providers[0].status, "ready");
    const restarted = await manager.restart("typescript");
    assert.equal(restarted.providers[0].status, "ready");
    assert.notEqual(restarted.providers[0].pid, beforeRestart.providers[0].pid);

    const logs = await manager.logs("typescript", 2048);
    assert.match(logs[0].content, /starting typescript|ready typescript/);

    await manager.dispose();
    const stopped = await manager.status("typescript");
    assert.equal(stopped.providers[0].status, "stopped");
  } finally {
    restoreEnvValue("SWARM_HOME", previousHome);
    restoreEnvValue("SWARM_LSP_TYPESCRIPT_COMMAND", previousTsCommand);
    restoreEnvValue("SWARM_LSP_TYPESCRIPT_ARGS", previousTsArgs);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("LspManager records exited status when stdio server exits during initialize", async () => {
  const fixture = await createFixture("swarm-lsp-exit-");
  const previousHome = process.env.SWARM_HOME;
  const previousTsCommand = process.env.SWARM_LSP_TYPESCRIPT_COMMAND;
  const previousTsArgs = process.env.SWARM_LSP_TYPESCRIPT_ARGS;
  try {
    process.env.SWARM_HOME = fixture.home;
    process.env.SWARM_LSP_TYPESCRIPT_COMMAND = JSON.stringify(process.execPath);
    const exitServer = join(fixture.root, "exit-lsp-server.mjs");
    await writeFile(exitServer, "process.exit(7);\n", "utf8");
    process.env.SWARM_LSP_TYPESCRIPT_ARGS = JSON.stringify(exitServer);
    await writeFile(join(fixture.workspace, "package.json"), "{}\n", "utf8");
    const file = join(fixture.workspace, "sample.ts");
    await writeFile(file, "const value = 1;\n", "utf8");

    const manager = new LspManager(fixture.workspace);
    await assert.rejects(
      manager.hover({
        path: file,
        text: "const value = 1;\n",
        position: { line: 0, character: 6 },
        providerId: "typescript",
        timeoutMs: 200
      }),
      /exited|timed out|not running/
    );
    const report = await manager.status("typescript");
    assert.equal(report.providers[0].status, "exited");
    assert.equal(report.providers[0].exitCode, 7);
    await manager.dispose();
  } finally {
    restoreEnvValue("SWARM_HOME", previousHome);
    restoreEnvValue("SWARM_LSP_TYPESCRIPT_COMMAND", previousTsCommand);
    restoreEnvValue("SWARM_LSP_TYPESCRIPT_ARGS", previousTsArgs);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture(prefix: string): Promise<{ root: string; workspace: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  await mkdir(workspace, { recursive: true });
  await mkdir(home, { recursive: true });
  return { root, workspace, home };
}

function context(workspace: string): LocalToolContext {
  const settings = defaultSwarmSettings();
  settings.permissions.defaultMode = "full-auto";
  return { workspace, settings };
}

function restoreEnv(path: string | undefined, pathExt: string | undefined, home: string | undefined): void {
  restoreEnvValue("PATH", path);
  restoreEnvValue("PATHEXT", pathExt);
  restoreEnvValue("SWARM_HOME", home);
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function runCli(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

const STUB_LSP_SERVER = `
let buffer = Buffer.alloc(0);
function send(message) {
  const json = JSON.stringify(message);
  process.stdout.write("Content-Length: " + Buffer.byteLength(json, "utf8") + "\\r\\n\\r\\n" + json);
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = header.match(/content-length:\\s*(\\d+)/i);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const start = headerEnd + 4;
    const end = start + length;
    if (buffer.length < end) return;
    const message = JSON.parse(buffer.subarray(start, end).toString("utf8"));
    buffer = buffer.subarray(end);
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { hoverProvider: true, definitionProvider: true, textDocumentSync: 1 } } });
    } else if (message.method === "textDocument/didOpen") {
      send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: message.params.textDocument.uri, diagnostics: [{ severity: 2, message: "stub diagnostic" }] } });
    } else if (message.method === "textDocument/hover") {
      send({ jsonrpc: "2.0", id: message.id, result: { contents: { kind: "markdown", value: "stub hover" } } });
    } else if (message.method === "shutdown") {
      send({ jsonrpc: "2.0", id: message.id, result: null });
    } else if (message.method === "exit") {
      process.exit(0);
    } else if (message.id !== undefined && message.method !== "textDocument/definition") {
      send({ jsonrpc: "2.0", id: message.id, result: [] });
    }
  }
});
`;
