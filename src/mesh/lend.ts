/**
 * Lending tools to paired devices. A node serves the tools it lends as an MCP server over Streamable HTTP at
 * `/mesh/v1/mcp`, to paired peers only, and a peer's Swarm sessions call them as `mcp__<node>__<tool>`. Nothing is lent
 * until `swarm mesh lend` names folders: `shell` runs commands whose cwd is inside its folders, `files` lists, reads and
 * writes files inside its folders. A path that leads out of the folders, through a symlink too, is refused.
 */
import { appendFileSync, existsSync, realpathSync, renameSync, statSync } from "node:fs";
import { lstat, mkdir, open, readdir, readlink, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod/v4";
import { HttpError, readJsonBody } from "../server/gateway-http.js";
import type { MeshServer } from "./server.js";
import { meshHome, readMesh, updateMesh, type Lend, type Peer } from "./state.js";
import { requireLease } from "./leases.js";
import type { MeshSurface } from "./surfaces.js";

export type LendKind = keyof Lend;
export const LEND_KINDS: LendKind[] = ["shell", "files"];
const KIND_TOOLS: Record<LendKind, string[]> = { shell: ["shell"], files: ["list_files", "read_file", "write_file"] };
/** The surface each lent tool needs: running a command, reading a folder or file, writing a file. */
export const TOOL_SURFACE: Readonly<Record<string, MeshSurface>> = {
  shell: "lend.shell", list_files: "lend.files.read", read_file: "lend.files.read", write_file: "lend.files.write"
};

const SHELL_DEFAULT_MS = 60_000;
/** The longest a lent command runs: under the five minutes Node's fetch waits for the answer to begin. */
const SHELL_MAX_MS = 240_000;
/** How long a borrower waits for one call: the longest command and the trip there and back. */
export const LEND_CALL_MS = SHELL_MAX_MS + 30_000;
const OUTPUT_BYTES = 64_000;
const READ_BYTES = 200_000;
const LIST_ENTRIES = 1000;

/** The tools a node serves for what it lends. */
export const lentTools = (lend: Lend | undefined): string[] => LEND_KINDS.flatMap((kind) => lend?.[kind] ? KIND_TOOLS[kind] : []);

/** Lends `kind` in more folders, kept as real paths; each must be an existing folder. */
export function lendFolders(kind: LendKind, folders: string[], home = meshHome()): Lend {
  const roots = folders.map((folder) => {
    const path = resolve(folder);
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`${folder} is not a folder`);
    return realpathSync(path);
  });
  return updateMesh((state) => {
    const current = state.node.lend[kind]?.roots ?? [];
    return { ...state, node: { ...state.node, lend: { ...state.node.lend, [kind]: { roots: [...new Set([...current, ...roots])] } } } };
  }, home).node.lend;
}

/** Stops lending `kind` in these folders, or in all of them. */
export function stopLending(kind: LendKind, folders: string[] = [], home = meshHome()): Lend {
  const dropped = new Set(folders.map((folder) => existsSync(resolve(folder)) ? realpathSync(resolve(folder)) : resolve(folder)));
  return updateMesh((state) => {
    const { [kind]: current, ...rest } = state.node.lend;
    const roots = folders.length ? (current?.roots ?? []).filter((root) => !dropped.has(root)) : [];
    return { ...state, node: { ...state.node, lend: roots.length ? { ...rest, [kind]: { roots } } : rest } };
  }, home).node.lend;
}

/**
 * The real path `path` names, if it lies inside one of `roots`; a relative path starts at the first root. A path that
 * does not exist yet is checked through its nearest existing parent, and a dangling symlink through where it points.
 */
async function insideRoots(roots: string[], path: string | undefined): Promise<string> {
  const real = await realTarget(resolve(roots[0]!, path ?? "."));
  for (const root of roots) {
    const rel = relative(await realpath(root), real);
    if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return real;
  }
  throw new Error(`${path ?? "."} is outside the lent folders (${roots.join(", ")})`);
}

async function realTarget(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const link = await lstat(path).catch(() => undefined);
    if (link?.isSymbolicLink()) return realTarget(resolve(dirname(path), await readlink(path)));
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await realTarget(parent), basename(path));
  }
}

interface LentTool {
  name: string;
  description: string;
  input: z.ZodRawShape;
  readOnly: boolean;
  run(args: Record<string, unknown>): Promise<unknown>;
}

function toolsFor(lend: Lend, node: string): LentTool[] {
  const tools: LentTool[] = [];
  const shell = lend.shell?.roots;
  if (shell) {
    tools.push({
      name: "shell",
      description: `Run a shell command on ${node}, in a folder it lends: ${shell.join(", ")} (a relative cwd starts at the first). `
        + `It stops after timeout_ms (default ${SHELL_DEFAULT_MS}, at most ${SHELL_MAX_MS}) and returns at most ${OUTPUT_BYTES} bytes each of stdout and stderr.`,
      input: { command: z.string().min(1), cwd: z.string().optional(), timeout_ms: z.number().int().positive().max(SHELL_MAX_MS).optional() },
      readOnly: false,
      run: async (args) => {
        const cwd = await insideRoots(shell, args.cwd as string | undefined);
        if (!(await stat(cwd)).isDirectory()) throw new Error(`${args.cwd} is not a folder`);
        const { runShellCommand } = await import("../tools/local-tools.js");
        const result = await runShellCommand(args.command as string, { cwd, timeoutMs: (args.timeout_ms as number | undefined) ?? SHELL_DEFAULT_MS, maxOutputBytes: OUTPUT_BYTES });
        return { cwd, exit_code: result.exitCode, signal: result.signal, timed_out: result.timedOut, truncated: result.truncated,
          stdout: result.stdout, stderr: result.stderr, ...(result.error ? { error: result.error } : {}) };
      }
    });
  }
  const files = lend.files?.roots;
  if (files) {
    const where = `in a folder ${node} lends: ${files.join(", ")} (a relative path starts at the first)`;
    tools.push({
      name: "list_files",
      description: `List a folder on ${node}, ${where}.`,
      input: { path: z.string().optional() },
      readOnly: true,
      run: async (args) => {
        const path = await insideRoots(files, args.path as string | undefined);
        const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
        return {
          path, truncated: entries.length > LIST_ENTRIES,
          entries: entries.slice(0, LIST_ENTRIES).map((entry) => ({
            name: entry.name, type: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other"
          }))
        };
      }
    }, {
      name: "read_file",
      description: `Read a text file on ${node}, ${where}. Returns at most ${READ_BYTES} bytes from offset; read on from offset + those bytes.`,
      input: { path: z.string().min(1), offset: z.number().int().min(0).optional() },
      readOnly: true,
      run: async (args) => {
        const path = await insideRoots(files, args.path as string);
        const offset = (args.offset as number | undefined) ?? 0;
        const handle = await open(path, "r");
        try {
          const { size } = await handle.stat();
          const buffer = Buffer.alloc(Math.max(0, Math.min(READ_BYTES, size - offset)));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
          const chunk = buffer.subarray(0, bytesRead);
          const binary = chunk.includes(0);
          return { path, bytes: size, offset, truncated: offset + bytesRead < size, ...(binary ? { binary: true } : { content: chunk.toString("utf8") }) };
        } finally {
          await handle.close();
        }
      }
    }, {
      name: "write_file",
      description: `Write a text file on ${node}, ${where}, creating its folders and replacing what was there.`,
      input: { path: z.string().min(1), content: z.string() },
      readOnly: false,
      run: async (args) => {
        const path = await insideRoots(files, args.path as string);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, args.content as string);
        return { path, bytes: Buffer.byteLength(args.content as string) };
      }
    });
  }
  return tools;
}

/** The header a borrower names what it borrows for in, such as a ticket; the link's key, not this header, says who calls. */
export const BORROWER_HEADER = "x-swarm-borrower";
/** Where a lending node keeps the calls it took, and how large the file grows before the older half moves aside. */
export const LEND_AUDIT = "lend-audit.jsonl";
const AUDIT_BYTES = 2 * 1024 * 1024;

/**
 * Keeps one lent call on this node's record: who called it, under which lease and for what, which tool, what it was asked
 * in short, how long it took and how it ended. A lending node keeps this whether or not it runs a ticket host.
 */
function auditLent(home: string, call: { peer: { id: string; name: string }; lease?: string; borrower: string | string[] | undefined; tool: string;
  args: Record<string, unknown>; ms: number; error?: string }): void {
  const borrower = Array.isArray(call.borrower) ? call.borrower[0] : call.borrower;
  const asked = call.tool === "shell" ? String(call.args.command ?? "") : String(call.args.path ?? ".");
  const line = JSON.stringify({ at: new Date().toISOString(), peer: { id: call.peer.id, name: call.peer.name }, ...(call.lease ? { lease: call.lease } : {}),
    ...(borrower ? { for: borrower.slice(0, 128) } : {}), tool: call.tool, asked: asked.slice(0, 200),
    ...(call.tool === "shell" && call.args.cwd ? { cwd: String(call.args.cwd).slice(0, 200) } : {}), ms: call.ms,
    ...(call.error ? { error: call.error.slice(0, 200) } : { ok: true }) });
  try {
    const file = join(home, LEND_AUDIT);
    if (existsSync(file) && statSync(file).size > AUDIT_BYTES) renameSync(file, `${file}.1`);
    appendFileSync(file, `${line}\n`, { mode: 0o600 });
  } catch { /* The record is kept where it can be; a full or read-only disk must not stop the call it records. */ }
}

/** Whether `path` lies in `root`, both real paths: decided as `insideRoots` does, so a root such as `/` holds its folders. */
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * The lease a shell call names, checked against the lent folder its command would run in. A cwd outside every lent folder
 * has no folder to lease: the tool itself refuses it, with its own words, so this lets it through to that refusal.
 */
async function shellLease(server: MeshServer, peer: Peer, headers: Record<string, string | string[] | undefined>, cwd: unknown) {
  const roots = readMesh(server.home).node.lend.shell?.roots ?? [];
  const path = await insideRoots(roots, typeof cwd === "string" ? cwd : undefined).catch(() => undefined);
  if (path === undefined) return undefined;
  return requireLease(peer, "lend.shell", headers, (resource) => roots.includes(resource) && within(resource, path), server.home);
}

/** The shell calls in a JSON-RPC body, one message or a batch: their cwd, which their lease must cover. */
function shellCalls(body: unknown): { cwd: unknown }[] {
  const messages = Array.isArray(body) ? body : [body];
  return messages.flatMap((message) => {
    const call = message as { method?: unknown; params?: { name?: unknown; arguments?: { cwd?: unknown } } } | null;
    return call?.method === "tools/call" && call.params?.name === "shell" ? [{ cwd: call.params.arguments?.cwd }] : [];
  });
}

/** Serves what this node lends on its mesh server, reading the lent folders afresh on every request. */
export function registerLending(server: MeshServer): void {
  // The endpoint writes every answer itself, so it authorizes each tool call's own surface; a tool lent later without a
  // surface here fails rather than running open.
  server.endpoint("/mesh/v1/mcp", async (request, response, peer) => {
    // Stateless: each POST is answered on its own, so there is no event stream to open and no session to end.
    if (request.method !== "POST") throw new HttpError(405, "The lent tools take POST requests only");
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
    const { node } = readMesh(server.home);
    const mcp = new McpServer({ name: `swarm-mesh-${node.name}`, version: "1.0.0" });
    for (const tool of toolsFor(node.lend, node.name)) {
      const surface = TOOL_SURFACE[tool.name];
      if (!surface) throw new HttpError(500, `The lent tool ${tool.name} has no surface`);
      mcp.registerTool(tool.name, {
        description: tool.description,
        inputSchema: tool.input,
        annotations: { readOnlyHint: tool.readOnly, destructiveHint: !tool.readOnly, openWorldHint: false }
      }, async (args: Record<string, unknown>) => {
        const started = Date.now();
        let lease: string | undefined;
        try {
          server.authorize(peer, surface);
          // A command run here cannot be had back, so the shell takes a lease on the lent folder the command runs in.
          if (tool.name === "shell") lease = (await shellLease(server, peer, request.headers, args.cwd))?.id;
          const answer = await tool.run(args);
          auditLent(server.home, { peer, ...(lease ? { lease } : {}), borrower: request.headers[BORROWER_HEADER], tool: tool.name, args, ms: Date.now() - started });
          return { content: [{ type: "text" as const, text: JSON.stringify(answer) }] };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          auditLent(server.home, { peer, ...(lease ? { lease } : {}), borrower: request.headers[BORROWER_HEADER], tool: tool.name, args, ms: Date.now() - started, error: message });
          return { isError: true, content: [{ type: "text" as const, text: message }] };
        }
      });
    }
    // A shell call's lease is checked before the MCP layer, so a refusal is an HTTP 403 the borrower can answer by asking for
    // a fresh lease, not a tool result it would take as the command's own failure.
    const body = await readJsonBody(request).catch(() => undefined);
    for (const call of shellCalls(body)) {
      try {
        server.authorize(peer, "lend.shell");
        await shellLease(server, peer, request.headers, call.cwd);
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 400;
        const message = error instanceof Error ? error.message : String(error);
        auditLent(server.home, { peer, borrower: request.headers[BORROWER_HEADER], tool: "shell", args: { cwd: call.cwd, command: "" }, ms: 0, error: message });
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { status, message } }));
        return;
      }
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on("close", () => { void mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(request, response, body);
  });
}
