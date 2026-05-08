import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { getSwarmPaths } from "../config/settings.js";

export type TaskOutputRef = {
  path: string;
  bytes: number;
  lines: number;
};

export async function writeTaskOutput(input: {
  sessionId: string;
  taskId: string;
  attempt: number;
  content: string;
}): Promise<TaskOutputRef> {
  const dir = resolve(getSwarmPaths().sessionsDir, sanitizePathPart(input.sessionId));
  await mkdir(dir, { recursive: true });
  let path = join(dir, `${sanitizePathPart(input.taskId)}.${input.attempt}.output`);
  try {
    await writeFile(path, input.content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (!isFileExistsError(error)) {
      throw error;
    }
    const existing = await readFile(path, "utf8").catch(() => undefined);
    if (existing !== input.content) {
      path = join(dir, `${sanitizePathPart(input.taskId)}.${input.attempt}.${shortHash(input.content)}.output`);
      await writeFile(path, input.content, { encoding: "utf8", flag: "wx" }).catch(async (writeError: unknown) => {
        if (!isFileExistsError(writeError)) {
          throw writeError;
        }
      });
    }
  }
  const info = await stat(path);
  return {
    path,
    bytes: info.size,
    lines: countLines(input.content)
  };
}

export async function readTaskOutput(path: string): Promise<string> {
  const resolved = resolve(path);
  const sessionsRoot = resolve(getSwarmPaths().sessionsDir);
  if (!isInsidePath(resolved, sessionsRoot)) {
    throw new Error(`Output path is outside ~/.swarm/sessions: ${basename(path)}`);
  }
  return readFile(resolved, "utf8");
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 180) || "output";
}

function countLines(content: string): number {
  return content.length === 0 ? 0 : content.split(/\r?\n/).length;
}

function isInsidePath(path: string, root: string): boolean {
  const relative = path.slice(root.length);
  return path === root || relative.startsWith("\\") || relative.startsWith("/");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EEXIST";
}
