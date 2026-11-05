/**
 * Lending tools to paired devices. A node serves the tools it lends as an MCP server over Streamable HTTP at
 * `/mesh/v1/mcp`, to paired peers only, and a peer's Swarm sessions call them as `mcp__<node>__<tool>`. Nothing is lent
 * until `swarm mesh lend` names folders: `shell` runs commands whose cwd is inside its folders, `files` lists, reads and
 * writes files inside its folders. A path that leads out of the folders, through a symlink too, is refused.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { lstat, mkdir, open, readdir, readlink, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod/v4";
import { HttpError } from "../server/gateway-http.js";
import type { MeshServer } from "./server.js";
import { meshHome, readMesh, updateMesh, type Lend } from "./state.js";

export type LendKind = keyof Lend;
export const LEND_KINDS: LendKind[] = ["shell", "files"];
const KIND_TOOLS: Record<LendKind, string[]> = { shell: ["shell"], files: ["list_files", "read_file", "write_file"] };

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

/** Serves what this node lends on its mesh server, reading the lent folders afresh on every request. */
export function registerLending(server: MeshServer): void {
  server.endpoint("/mesh/v1/mcp", async (request, response) => {
    // Stateless: each POST is answered on its own, so there is no event stream to open and no session to end.
    if (request.method !== "POST") throw new HttpError(405, "The lent tools take POST requests only");
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
    const { node } = readMesh(server.home);
    const mcp = new McpServer({ name: `swarm-mesh-${node.name}`, version: "1.0.0" });
    for (const tool of toolsFor(node.lend, node.name)) {
      mcp.registerTool(tool.name, {
        description: tool.description,
        inputSchema: tool.input,
        annotations: { readOnlyHint: tool.readOnly, destructiveHint: !tool.readOnly, openWorldHint: false }
      }, async (args: Record<string, unknown>) => {
        try {
          return { content: [{ type: "text" as const, text: JSON.stringify(await tool.run(args)) }] };
        } catch (error) {
          return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] };
        }
      });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on("close", () => { void mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(request, response);
  });
}
