import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { getSwarmPaths } from "../config/settings.js";
import { lspCapabilityFactsForProvider, type LspCapabilityFact } from "./capabilities.js";
import { buildLspSemanticPlanningStatus } from "./semantic-participant.js";
import type { LspSemanticPlanningStatus } from "./types.js";

export type LspProviderId = "typescript" | "python" | "rust" | "go";

export type LspServerState =
  | "stopped"
  | "starting"
  | "ready"
  | "failed"
  | "exited"
  | "unavailable"
  | "external";

export type LspProviderStatus = {
  providerId: LspProviderId;
  root: string;
  status: LspServerState;
  languageIds: string[];
  command?: string;
  args?: string[];
  pid?: number;
  startedAt?: string;
  readyAt?: string;
  exitedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  logPath: string;
  metadataPath: string;
  lastError?: string;
  detected: boolean;
  available: boolean;
  reason?: string;
  capabilities?: LspCapabilityFact[];
};

export type LspStatusReport = {
  workspace: string;
  generatedAt: string;
  providers: LspProviderStatus[];
  semanticPlanning?: LspSemanticPlanningStatus;
};

export type LspLogReport = {
  providerId: LspProviderId;
  logPath: string;
  content: string;
  bytesTotal: number;
  bytesRead: number;
  truncated: boolean;
};

export type LspPosition = {
  line: number;
  character: number;
};

export type LspRange = {
  start: LspPosition;
  end: LspPosition;
};

export type LspProviderConfig = {
  id: LspProviderId;
  title: string;
  command: string;
  args: string[];
  envPrefix: string;
  languageIds: string[];
  extensions: string[];
  manifestFiles: string[];
};

export type LspClientResult = unknown;

const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_DIAGNOSTIC_WAIT_MS = 1_200;
const DEFAULT_LOG_BYTES = 64 * 1024;

const PROVIDERS: LspProviderConfig[] = [
  {
    id: "typescript",
    title: "TypeScript",
    command: "typescript-language-server",
    args: ["--stdio"],
    envPrefix: "SWARM_LSP_TYPESCRIPT",
    languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    manifestFiles: ["tsconfig.json", "jsconfig.json", "package.json"]
  },
  {
    id: "python",
    title: "Python",
    command: "pyright-langserver",
    args: ["--stdio"],
    envPrefix: "SWARM_LSP_PYTHON",
    languageIds: ["python"],
    extensions: [".py", ".pyi"],
    manifestFiles: ["pyproject.toml", "setup.py", "requirements.txt"]
  },
  {
    id: "rust",
    title: "Rust",
    command: "rust-analyzer",
    args: [],
    envPrefix: "SWARM_LSP_RUST",
    languageIds: ["rust"],
    extensions: [".rs"],
    manifestFiles: ["Cargo.toml"]
  },
  {
    id: "go",
    title: "Go",
    command: "gopls",
    args: [],
    envPrefix: "SWARM_LSP_GO",
    languageIds: ["go"],
    extensions: [".go"],
    manifestFiles: ["go.mod"]
  }
];

export class LspManager {
  private readonly workspace: string;
  private readonly clients = new Map<LspProviderId, LspClient>();

  constructor(workspace: string) {
    this.workspace = resolve(workspace);
  }

  async status(providerId?: string): Promise<LspStatusReport> {
    const generatedAt = new Date().toISOString();
    const providers = await Promise.all(selectedProviders(providerId).map((provider) => this.providerStatus(provider)));
    return {
      workspace: this.workspace,
      generatedAt,
      providers,
      semanticPlanning: buildLspSemanticPlanningStatus({ providers }, generatedAt)
    };
  }

  async restart(providerId?: string): Promise<LspStatusReport> {
    const providers = selectedProviders(providerId).filter((provider) => providerId || providerDetected(this.workspace, provider));
    const statuses: LspProviderStatus[] = [];
    for (const provider of providers) {
      await this.stopProvider(provider.id, true);
      try {
        const client = await this.clientForProvider(provider);
        statuses.push(await client.status(true));
      } catch {
        statuses.push(await this.providerStatus(provider));
      }
    }
    const generatedAt = new Date().toISOString();
    return {
      workspace: this.workspace,
      generatedAt,
      providers: statuses,
      semanticPlanning: buildLspSemanticPlanningStatus({ providers: statuses }, generatedAt)
    };
  }

  async logs(providerId?: string, maxBytes = DEFAULT_LOG_BYTES): Promise<LspLogReport[]> {
    const providers = selectedProviders(providerId);
    const reports: LspLogReport[] = [];
    for (const provider of providers) {
      const status = await this.providerStatus(provider);
      const content = await readTail(status.logPath, maxBytes).catch(() => ({
        content: "",
        bytesTotal: 0,
        bytesRead: 0,
        truncated: false
      }));
      reports.push({
        providerId: provider.id,
        logPath: status.logPath,
        ...content
      });
    }
    return reports;
  }

  async diagnostics(input: { path: string; text: string; timeoutMs?: number; providerId?: string }): Promise<LspClientResult> {
    const client = await this.clientForFile(input.path, input.providerId);
    await client.openDocument(input.path, input.text);
    return client.waitForDiagnostics(input.path, input.timeoutMs ?? DEFAULT_DIAGNOSTIC_WAIT_MS);
  }

  async hover(input: { path: string; text: string; position: LspPosition; timeoutMs?: number; providerId?: string }): Promise<LspClientResult> {
    const client = await this.clientForFile(input.path, input.providerId);
    await client.openDocument(input.path, input.text);
    return client.request("textDocument/hover", {
      textDocument: textDocumentIdentifier(input.path),
      position: input.position
    }, input.timeoutMs);
  }

  async definition(input: { path: string; text: string; position: LspPosition; timeoutMs?: number; providerId?: string }): Promise<LspClientResult> {
    const client = await this.clientForFile(input.path, input.providerId);
    await client.openDocument(input.path, input.text);
    return client.request("textDocument/definition", {
      textDocument: textDocumentIdentifier(input.path),
      position: input.position
    }, input.timeoutMs);
  }

  async references(input: { path: string; text: string; position: LspPosition; includeDeclaration?: boolean; timeoutMs?: number; providerId?: string }): Promise<LspClientResult> {
    const client = await this.clientForFile(input.path, input.providerId);
    await client.openDocument(input.path, input.text);
    return client.request("textDocument/references", {
      textDocument: textDocumentIdentifier(input.path),
      position: input.position,
      context: { includeDeclaration: input.includeDeclaration ?? true }
    }, input.timeoutMs);
  }

  async documentSymbols(input: { path: string; text: string; timeoutMs?: number; providerId?: string }): Promise<LspClientResult> {
    const client = await this.clientForFile(input.path, input.providerId);
    await client.openDocument(input.path, input.text);
    return client.request("textDocument/documentSymbol", {
      textDocument: textDocumentIdentifier(input.path)
    }, input.timeoutMs);
  }

  async workspaceSymbols(input: { query: string; timeoutMs?: number; providerId?: string }): Promise<LspClientResult> {
    const client = await this.clientForWorkspace(input.providerId);
    return client.request("workspace/symbol", { query: input.query }, input.timeoutMs);
  }

  async completion(input: { path: string; text: string; position: LspPosition; triggerCharacter?: string; timeoutMs?: number; providerId?: string }): Promise<LspClientResult> {
    const client = await this.clientForFile(input.path, input.providerId);
    await client.openDocument(input.path, input.text);
    return client.request("textDocument/completion", {
      textDocument: textDocumentIdentifier(input.path),
      position: input.position,
      context: input.triggerCharacter ? { triggerKind: 2, triggerCharacter: input.triggerCharacter } : undefined
    }, input.timeoutMs);
  }

  async codeActions(input: { path: string; text: string; range: LspRange; timeoutMs?: number; providerId?: string }): Promise<LspClientResult> {
    const client = await this.clientForFile(input.path, input.providerId);
    await client.openDocument(input.path, input.text);
    const diagnostics = await client.waitForDiagnostics(input.path, 250).catch(() => []);
    return client.request("textDocument/codeAction", {
      textDocument: textDocumentIdentifier(input.path),
      range: input.range,
      context: { diagnostics }
    }, input.timeoutMs);
  }

  async renamePreview(input: { path: string; text: string; position: LspPosition; newName: string; timeoutMs?: number; providerId?: string }): Promise<LspClientResult> {
    const client = await this.clientForFile(input.path, input.providerId);
    await client.openDocument(input.path, input.text);
    return client.request("textDocument/rename", {
      textDocument: textDocumentIdentifier(input.path),
      position: input.position,
      newName: input.newName
    }, input.timeoutMs);
  }

  async format(input: { path: string; text: string; timeoutMs?: number; providerId?: string }): Promise<LspClientResult> {
    const client = await this.clientForFile(input.path, input.providerId);
    await client.openDocument(input.path, input.text);
    return client.request("textDocument/formatting", {
      textDocument: textDocumentIdentifier(input.path),
      options: { tabSize: 2, insertSpaces: true, trimTrailingWhitespace: true, insertFinalNewline: true }
    }, input.timeoutMs);
  }

  async dispose(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map((client) => client.dispose()));
  }

  private async clientForWorkspace(providerId?: string): Promise<LspClient> {
    const provider = providerId ? providerById(providerId) : PROVIDERS.find((candidate) => providerDetected(this.workspace, candidate));
    if (!provider) {
      throw new Error(providerId ? `Unknown LSP provider: ${providerId}` : "No LSP provider detected for this workspace.");
    }
    return this.clientForProvider(provider);
  }

  private async clientForFile(path: string, providerId?: string): Promise<LspClient> {
    const provider = providerId ? providerById(providerId) : providerForPath(path);
    if (!provider) {
      throw new Error(`No LSP provider is registered for ${basename(path)}.`);
    }
    return this.clientForProvider(provider);
  }

  private async clientForProvider(provider: LspProviderConfig): Promise<LspClient> {
    const existing = this.clients.get(provider.id);
    if (existing && existing.isUsable()) {
      return existing;
    }
    this.clients.delete(provider.id);
    const command = resolveProviderCommand(this.workspace, provider);
    if (!command) {
      throw new Error(`LSP provider ${provider.id} is unavailable. Install ${provider.command} or set ${provider.envPrefix}_COMMAND.`);
    }
    const paths = providerPaths(this.workspace, provider.id);
    const client = new LspClient({
      provider,
      root: this.workspace,
      command: command.command,
      args: command.args,
      logPath: paths.logPath,
      metadataPath: paths.metadataPath
    });
    this.clients.set(provider.id, client);
    await client.start();
    return client;
  }

  private async providerStatus(provider: LspProviderConfig): Promise<LspProviderStatus> {
    const existing = this.clients.get(provider.id);
    if (existing) {
      return existing.status(false);
    }
    const paths = providerPaths(this.workspace, provider.id);
    const command = resolveProviderCommand(this.workspace, provider);
    const semanticFallback = provider.id === "typescript";
    const saved = await readStatusRecord(paths.metadataPath).catch(() => undefined);
    const external = saved?.pid !== undefined && isPidRunning(saved.pid) ? saved : undefined;
    return {
      providerId: provider.id,
      root: this.workspace,
      status: command ? (external ? "external" : "stopped") : semanticFallback ? "ready" : "unavailable",
      languageIds: provider.languageIds,
      command: command?.command ?? saved?.command ?? (semanticFallback ? "typescript-language-service" : undefined),
      args: command?.args ?? saved?.args,
      pid: external?.pid,
      startedAt: external?.startedAt,
      readyAt: external?.readyAt,
      exitedAt: saved?.exitedAt,
      exitCode: saved?.exitCode,
      signal: saved?.signal,
      logPath: paths.logPath,
      metadataPath: paths.metadataPath,
      lastError: command || semanticFallback ? saved?.lastError : `Command not found: ${provider.command}`,
      detected: providerDetected(this.workspace, provider),
      available: Boolean(command) || semanticFallback,
      reason: command
        ? undefined
        : semanticFallback
          ? "Using in-process TypeScript semantic provider fallback."
          : `Install ${provider.command} or set ${provider.envPrefix}_COMMAND.`,
      capabilities: lspCapabilityFactsForProvider({
        providerId: provider.id,
        status: command ? (external ? "external" : "stopped") : semanticFallback ? "ready" : "unavailable",
        commandAvailable: Boolean(command),
        semanticFallback,
        detected: providerDetected(this.workspace, provider),
        command: provider.command,
        envPrefix: provider.envPrefix,
        reason: command
          ? undefined
          : semanticFallback
            ? "Using in-process TypeScript semantic provider fallback."
            : `Install ${provider.command} or set ${provider.envPrefix}_COMMAND.`,
        lastError: command || semanticFallback ? saved?.lastError : `Command not found: ${provider.command}`
      })
    };
  }

  private async stopProvider(providerId: LspProviderId, killExternal: boolean): Promise<void> {
    const existing = this.clients.get(providerId);
    this.clients.delete(providerId);
    await existing?.dispose();
    if (!killExternal) {
      return;
    }
    const paths = providerPaths(this.workspace, providerId);
    const saved = await readStatusRecord(paths.metadataPath).catch(() => undefined);
    if (saved?.pid !== undefined && isPidRunning(saved.pid)) {
      try {
        process.kill(saved.pid, "SIGTERM");
      } catch {
        // The process may have exited between status read and kill.
      }
    }
  }
}

type LspClientOptions = {
  provider: LspProviderConfig;
  root: string;
  command: string;
  args: string[];
  logPath: string;
  metadataPath: string;
};

class LspClient {
  private readonly options: LspClientOptions;
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private statusState: LspServerState = "stopped";
  private startedAt?: string;
  private readyAt?: string;
  private exitedAt?: string;
  private exitCode?: number | null;
  private signal?: NodeJS.Signals | null;
  private lastError?: string;
  private capabilities: Record<string, unknown> = {};
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private readonly diagnostics = new Map<string, unknown[]>();
  private readonly diagnosticWaiters = new Map<string, Array<(value: unknown[]) => void>>();
  private readonly openDocuments = new Map<string, { version: number; text: string }>();

  constructor(options: LspClientOptions) {
    this.options = options;
  }

  isUsable(): boolean {
    const child = this.child;
    return this.statusState === "ready" && child !== undefined && Boolean(child.pid) && !child.killed;
  }

  async start(): Promise<void> {
    if (this.isUsable()) {
      return;
    }
    this.statusState = "starting";
    this.startedAt = new Date().toISOString();
    await this.writeStatus();
    await this.log(`[swarm-lsp] starting ${this.options.provider.id}: ${this.options.command} ${this.options.args.join(" ")}`);

    this.child = spawn(this.options.command, this.options.args, {
      cwd: this.options.root,
      env: process.env,
      windowsHide: true,
      stdio: "pipe"
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      void this.log(chunk.toString("utf8").trimEnd());
    });
    this.child.on("error", (error) => {
      this.statusState = "failed";
      this.lastError = error.message;
      this.rejectAll(error);
      void this.log(`[swarm-lsp] error ${error.message}`);
      void this.writeStatus();
    });
    this.child.on("exit", (code, signal) => {
      this.statusState = this.statusState === "failed" ? "failed" : "exited";
      this.exitedAt = new Date().toISOString();
      this.exitCode = code;
      this.signal = signal;
      this.rejectAll(new Error(`LSP provider ${this.options.provider.id} exited.`));
      void this.log(`[swarm-lsp] exited code=${code ?? "null"} signal=${signal ?? "null"}`);
      void this.writeStatus();
    });

    const initialize = await this.request("initialize", {
      processId: process.pid,
      rootPath: this.options.root,
      rootUri: pathToFileURL(this.options.root).href,
      workspaceFolders: [{ uri: pathToFileURL(this.options.root).href, name: basename(this.options.root) || "workspace" }],
      capabilities: clientCapabilities()
    }, DEFAULT_REQUEST_TIMEOUT_MS);
    this.capabilities = isRecord(initialize) && isRecord(initialize.capabilities) ? initialize.capabilities : {};
    this.notify("initialized", {});
    this.statusState = "ready";
    this.readyAt = new Date().toISOString();
    await this.log(`[swarm-lsp] ready ${this.options.provider.id}`);
    await this.writeStatus();
  }

  async status(refresh: boolean): Promise<LspProviderStatus> {
    if (refresh && this.statusState === "ready" && this.child?.pid && !isPidRunning(this.child.pid)) {
      this.statusState = "exited";
      this.exitedAt = this.exitedAt ?? new Date().toISOString();
      this.lastError = "LSP process is no longer running.";
      await this.writeStatus();
    }
    return {
      providerId: this.options.provider.id,
      root: this.options.root,
      status: this.statusState,
      languageIds: this.options.provider.languageIds,
      command: this.options.command,
      args: this.options.args,
      pid: this.child?.pid,
      startedAt: this.startedAt,
      readyAt: this.readyAt,
      exitedAt: this.exitedAt,
      exitCode: this.exitCode,
      signal: this.signal,
      logPath: this.options.logPath,
      metadataPath: this.options.metadataPath,
      lastError: this.lastError,
      detected: providerDetected(this.options.root, this.options.provider),
      available: true,
      capabilities: lspCapabilityFactsForProvider({
        providerId: this.options.provider.id,
        status: this.statusState,
        commandAvailable: true,
        semanticFallback: false,
        detected: providerDetected(this.options.root, this.options.provider),
        command: this.options.provider.command,
        envPrefix: this.options.provider.envPrefix,
        lastError: this.lastError,
        serverCapabilities: this.capabilities
      })
    };
  }

  async openDocument(path: string, text: string): Promise<void> {
    const uri = pathToFileURL(path).href;
    const existing = this.openDocuments.get(uri);
    const languageId = languageIdForPath(path, this.options.provider);
    if (!existing) {
      this.openDocuments.set(uri, { version: 1, text });
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 1, text }
      });
      return;
    }
    if (existing.text === text) {
      return;
    }
    const version = existing.version + 1;
    this.openDocuments.set(uri, { version, text });
    this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }]
    });
  }

  async waitForDiagnostics(path: string, timeoutMs: number): Promise<unknown[]> {
    const uri = pathToFileURL(path).href;
    if (this.diagnostics.has(uri)) {
      return this.diagnostics.get(uri) ?? [];
    }
    return new Promise((resolvePromise) => {
      let wrapped = (_value: unknown[]) => undefined;
      const timer = setTimeout(() => {
        removeDiagnosticWaiter(uri, wrapped, this.diagnosticWaiters);
        resolvePromise(this.diagnostics.get(uri) ?? []);
      }, Math.max(0, timeoutMs));
      wrapped = (value: unknown[]) => {
        clearTimeout(timer);
        resolvePromise(value);
      };
      const waiters = this.diagnosticWaiters.get(uri) ?? [];
      waiters.push(wrapped);
      this.diagnosticWaiters.set(uri, waiters);
    });
  }

  request(method: string, params: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (!this.child?.stdin.writable) {
      return Promise.reject(new Error(`LSP provider ${this.options.provider.id} is not running.`));
    }
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`LSP request timed out: ${method}`));
      }, Math.max(1, timeoutMs));
      this.pending.set(String(id), { resolve: resolvePromise, reject, timer });
      this.writeMessage(payload);
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.child?.stdin.writable) {
      return;
    }
    this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  async dispose(): Promise<void> {
    const child = this.child;
    if (!child) {
      return;
    }
    let closeTimer: NodeJS.Timeout | undefined;
    const closePromise = new Promise<void>((resolve) => {
      child.once("close", () => {
        if (closeTimer) {
          clearTimeout(closeTimer);
        }
        resolve();
      });
      closeTimer = setTimeout(resolve, 1_000);
    });
    if (child.stdin.writable && this.statusState === "ready") {
      await this.request("shutdown", null, 1_000).catch(() => undefined);
      this.notify("exit", null);
    }
    if (!child.killed) {
      child.kill();
    }
    await closePromise;
    child.removeAllListeners();
    this.rejectAll(new Error(`LSP provider ${this.options.provider.id} disposed.`));
    this.child = undefined;
    this.statusState = "stopped";
    this.exitedAt = new Date().toISOString();
    await this.writeStatus();
  }

  private handleStdout(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = header.match(/content-length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) {
        return;
      }
      const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.subarray(bodyEnd);
      this.handleMessage(body);
    }
  }

  private handleMessage(body: string): void {
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch (error) {
      void this.log(`[swarm-lsp] invalid json ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!isRecord(message)) {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(String(message.id));
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(String(message.id));
      if (isRecord(message.error)) {
        pending.reject(new Error(String(message.error.message ?? "LSP request failed.")));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    const method = typeof message.method === "string" ? message.method : "";
    if (method === "textDocument/publishDiagnostics" && isRecord(message.params)) {
      const uri = typeof message.params.uri === "string" ? message.params.uri : "";
      const diagnostics = Array.isArray(message.params.diagnostics) ? message.params.diagnostics : [];
      this.diagnostics.set(uri, diagnostics);
      const waiters = this.diagnosticWaiters.get(uri) ?? [];
      this.diagnosticWaiters.delete(uri);
      for (const waiter of waiters) {
        waiter(diagnostics);
      }
      return;
    }
    if ((method === "window/logMessage" || method === "$/logTrace") && isRecord(message.params)) {
      void this.log(`[${method}] ${String(message.params.message ?? "")}`);
    }
  }

  private writeMessage(payload: unknown): void {
    const json = JSON.stringify(payload);
    const bytes = Buffer.byteLength(json, "utf8");
    this.child?.stdin.write(`Content-Length: ${bytes}\r\n\r\n${json}`);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async log(message: string): Promise<void> {
    const line = message.endsWith("\n") ? message : `${message}\n`;
    await mkdir(dirname(this.options.logPath), { recursive: true }).catch(() => undefined);
    await appendFile(this.options.logPath, line, "utf8").catch(() => undefined);
  }

  private async writeStatus(): Promise<void> {
    const status = await this.status(false);
    await mkdir(dirname(this.options.metadataPath), { recursive: true });
    await writeFile(this.options.metadataPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  }
}

function selectedProviders(providerId?: string): LspProviderConfig[] {
  if (!providerId) {
    return PROVIDERS;
  }
  return [providerById(providerId)];
}

function providerById(providerId: string): LspProviderConfig {
  const provider = PROVIDERS.find((candidate) => candidate.id === providerId);
  if (!provider) {
    throw new Error(`Unknown LSP provider: ${providerId}`);
  }
  return provider;
}

function providerForPath(path: string): LspProviderConfig | undefined {
  const extension = extname(path).toLowerCase();
  return PROVIDERS.find((provider) => provider.extensions.includes(extension));
}

function languageIdForPath(path: string, provider: LspProviderConfig): string {
  const extension = extname(path).toLowerCase();
  const index = provider.extensions.indexOf(extension);
  return provider.languageIds[Math.max(0, index)] ?? provider.languageIds[0] ?? provider.id;
}

function providerDetected(workspace: string, provider: LspProviderConfig): boolean {
  return provider.manifestFiles.some((file) => existsSync(join(workspace, file)));
}

function resolveProviderCommand(workspace: string, provider: LspProviderConfig): { command: string; args: string[] } | undefined {
  const envCommand = process.env[`${provider.envPrefix}_COMMAND`]?.trim();
  if (envCommand) {
    const parsed = splitCommandLine(envCommand);
    const args = [
      ...parsed.args,
      ...splitCommandLine(process.env[`${provider.envPrefix}_ARGS`] ?? "").argv
    ];
    return { command: parsed.command, args };
  }
  const local = localNodeBinary(workspace, provider.command);
  if (local) {
    return { command: local, args: provider.args };
  }
  const path = findExecutable(provider.command);
  return path ? { command: path, args: provider.args } : undefined;
}

function localNodeBinary(workspace: string, command: string): string | undefined {
  const suffixes = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];
  for (const suffix of suffixes) {
    const candidate = join(workspace, "node_modules", ".bin", `${command}${suffix}`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function findExecutable(command: string): string | undefined {
  const pathValue = process.env.PATH ?? "";
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const dir of pathValue.split(process.platform === "win32" ? ";" : ":")) {
    if (!dir.trim()) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = join(dir, process.platform === "win32" && extension && !command.toLowerCase().endsWith(extension.toLowerCase()) ? `${command}${extension}` : command);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function providerPaths(workspace: string, providerId: LspProviderId): { logPath: string; metadataPath: string } {
  const paths = getSwarmPaths();
  const workspaceKey = createHash("sha1").update(resolve(workspace)).digest("hex").slice(0, 16);
  return {
    logPath: join(paths.logsDir, "lsp", workspaceKey, `${providerId}.log`),
    metadataPath: join(paths.stateDir, "lsp", workspaceKey, `${providerId}.json`)
  };
}

async function readStatusRecord(path: string): Promise<LspProviderStatus> {
  return JSON.parse(await readFile(path, "utf8")) as LspProviderStatus;
}

async function readTail(path: string, maxBytes: number): Promise<{ content: string; bytesTotal: number; bytesRead: number; truncated: boolean }> {
  const content = await readFile(path);
  const bytesTotal = content.byteLength;
  const bytesRead = Math.min(Math.max(1, maxBytes), bytesTotal);
  const start = bytesTotal - bytesRead;
  return {
    content: content.subarray(start).toString("utf8"),
    bytesTotal,
    bytesRead,
    truncated: start > 0
  };
}

function textDocumentIdentifier(path: string): { uri: string } {
  return { uri: pathToFileURL(path).href };
}

export function pathFromLspUri(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
}

function clientCapabilities(): Record<string, unknown> {
  return {
    textDocument: {
      synchronization: { didSave: true, dynamicRegistration: false },
      hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
      definition: { dynamicRegistration: false, linkSupport: true },
      references: { dynamicRegistration: false },
      documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
      completion: { dynamicRegistration: false, completionItem: { snippetSupport: false } },
      codeAction: { dynamicRegistration: false, isPreferredSupport: true },
      formatting: { dynamicRegistration: false },
      rename: { dynamicRegistration: false, prepareSupport: true }
    },
    workspace: {
      symbol: { dynamicRegistration: false, symbolKind: { valueSet: Array.from({ length: 26 }, (_, index) => index + 1) } },
      workspaceFolders: true,
      configuration: false
    }
  };
}

function removeDiagnosticWaiter(
  uri: string,
  resolvePromise: (value: unknown[]) => void,
  waiters: Map<string, Array<(value: unknown[]) => void>>
): void {
  const current = waiters.get(uri);
  if (!current) {
    return;
  }
  const next = current.filter((waiter) => waiter !== resolvePromise);
  if (next.length) {
    waiters.set(uri, next);
  } else {
    waiters.delete(uri);
  }
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EPERM";
  }
}

function splitCommandLine(value: string): { command: string; args: string[]; argv: string[] } {
  const argv: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      continue;
    }
    if (quote === char) {
      quote = undefined;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) {
        argv.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    argv.push(current);
  }
  return {
    command: argv[0] ?? "",
    args: argv.slice(1),
    argv
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const globalManagers = new Map<string, LspManager>();

export function getGlobalLspManager(workspace: string): LspManager {
  const root = resolve(workspace || process.cwd());
  let manager = globalManagers.get(root);
  if (!manager) {
    manager = new LspManager(root);
    globalManagers.set(root, manager);
  }
  return manager;
}

export async function disposeGlobalLspManager(workspace?: string): Promise<void> {
  if (workspace) {
    const root = resolve(workspace);
    const manager = globalManagers.get(root);
    globalManagers.delete(root);
    await manager?.dispose();
    return;
  }
  const managers = [...globalManagers.values()];
  globalManagers.clear();
  await Promise.all(managers.map((manager) => manager.dispose()));
}

export function lspTempWorkspace(): string {
  return join(tmpdir(), "swarm-lsp");
}
