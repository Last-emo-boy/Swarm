import { mkdir, readdir, readFile, rm, writeFile, copyFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const CHECKPOINT_DIR = ".swarm/checkpoints";
const CHECKPOINT_INDEX = "index.json";
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".swarm", ".tmp", "coverage", ".cache"]);

export type CheckpointRecord = {
  id: string;
  name: string;
  created_at: string;
  workspace: string;
  mode: "git" | "snapshot";
  base_commit?: string;
  tracked_files: number;
  untracked_files: number;
  status: "available" | "reverted" | "missing";
  reason?: string;
};

export type CheckpointSummary = Pick<CheckpointRecord, "id" | "name" | "mode" | "status"> & {
  revertAvailable: boolean;
};

export async function createCheckpoint(workspace: string, name: string, reason?: string): Promise<CheckpointSummary> {
  const root = resolve(workspace);
  const record = await snapshotWorkspace(root, name, reason);
  const index = await readCheckpointIndex(root);
  index.unshift(record);
  await writeCheckpointIndex(root, index);
  return toSummary(record);
}

export async function listCheckpoints(workspace: string, limit = 20): Promise<CheckpointSummary[]> {
  const root = resolve(workspace);
  const index = await readCheckpointIndex(root);
  return index.slice(0, limit).map(toSummary);
}

export async function revertCheckpoint(workspace: string, checkpointId?: string): Promise<CheckpointSummary | undefined> {
  const root = resolve(workspace);
  const index = await readCheckpointIndex(root);
  const record = checkpointId ? index.find((item) => item.id === checkpointId) : index[0];
  if (!record) {
    return undefined;
  }
  const checkpointDir = resolve(root, CHECKPOINT_DIR, record.id);
  const manifestPath = resolve(checkpointDir, "manifest.json");
  const manifest = await readJson<CheckpointManifest>(manifestPath).catch(() => undefined);
  if (!manifest) {
    record.status = "missing";
    await writeCheckpointIndex(root, index);
    return toSummary(record);
  }

  await restoreSnapshot(root, checkpointDir, manifest);
  record.status = "reverted";
  await writeCheckpointIndex(root, index);
  return toSummary(record);
}

export async function latestCheckpoint(workspace: string): Promise<CheckpointSummary | undefined> {
  const root = resolve(workspace);
  const index = await readCheckpointIndex(root);
  return index[0] ? toSummary(index[0]) : undefined;
}

type CheckpointManifest = {
  mode: "git" | "snapshot";
  base_commit?: string;
  tracked_files: string[];
  untracked_files: string[];
};

async function snapshotWorkspace(root: string, name: string, reason?: string): Promise<CheckpointRecord> {
  const checkpointId = `cp_${Date.now()}_${randomSuffix()}`;
  const checkpointDir = resolve(root, CHECKPOINT_DIR, checkpointId);
  await mkdir(checkpointDir, { recursive: true });
  const gitRepo = isGitRepo(root);
  const baseCommit = gitRepo ? runGit(root, ["rev-parse", "HEAD"]).trim() || undefined : undefined;
  const trackedFiles = gitRepo ? runGit(root, ["ls-files"]).split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : await listWorkspaceFiles(root);
  const status = gitRepo ? runGit(root, ["status", "--porcelain"]) : "";
  const untrackedFiles = gitRepo
    ? status.split(/\r?\n/).filter(lineLooksUntracked).map((line) => line.slice(3).trim()).filter(Boolean)
    : [];
  const manifest: CheckpointManifest = {
    mode: gitRepo ? "git" : "snapshot",
    base_commit: baseCommit,
    tracked_files: trackedFiles,
    untracked_files: unique(untrackedFiles)
  };
  await writeJson(resolve(checkpointDir, "manifest.json"), manifest);
  for (const relativePath of trackedFiles) {
    await snapshotFile(root, checkpointDir, relativePath);
  }
  for (const relativePath of manifest.untracked_files) {
    await snapshotFile(root, checkpointDir, relativePath);
  }
  const record: CheckpointRecord = {
    id: checkpointId,
    name,
    created_at: new Date().toISOString(),
    workspace: root,
    mode: manifest.mode,
    base_commit: manifest.base_commit,
    tracked_files: trackedFiles.length,
    untracked_files: manifest.untracked_files.length,
    status: "available",
    reason
  };
  await writeJson(resolve(checkpointDir, "record.json"), record);
  return record;
}

async function restoreSnapshot(root: string, checkpointDir: string, manifest: CheckpointManifest): Promise<void> {
  const snapshotRoot = resolve(checkpointDir, "snapshot");
  const restored = new Set<string>();
  for (const relativePath of [...manifest.tracked_files, ...manifest.untracked_files]) {
    restored.add(relativePath);
    const source = resolve(snapshotRoot, relativePath);
    const target = resolve(root, relativePath);
    const marker = `${source}.deleted`;
    if (await exists(marker)) {
      await rm(target, { force: true, recursive: true });
      continue;
    }
    if (await exists(source)) {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
  }

  const currentUntracked = isGitRepo(root)
    ? runGit(root, ["status", "--porcelain"]).split(/\r?\n/).filter(lineLooksUntracked).map((line) => line.slice(3).trim()).filter(Boolean)
    : await listWorkspaceFiles(root);
  for (const relativePath of currentUntracked) {
    if (restored.has(relativePath)) {
      continue;
    }
    await rm(resolve(root, relativePath), { force: true, recursive: true });
  }
}

async function snapshotFile(root: string, checkpointDir: string, relativePath: string): Promise<void> {
  const source = resolve(root, relativePath);
  const target = resolve(checkpointDir, "snapshot", relativePath);
  try {
    const info = await stat(source);
    if (!info.isFile()) {
      return;
    }
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  } catch {
    await mkdir(dirname(`${target}.deleted`), { recursive: true });
    await writeFile(`${target}.deleted`, "", "utf8");
  }
}

async function listWorkspaceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for await (const file of walk(root)) {
    files.push(relative(root, file).replace(/\\/g, "/"));
    if (files.length > 2_000) {
      break;
    }
  }
  return files;
}

async function* walk(root: string, current = root): AsyncGenerator<string> {
  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const next = join(current, entry.name);
    if (entry.isDirectory()) {
      yield* walk(root, next);
    } else if (entry.isFile()) {
      yield next;
    }
  }
}

async function readCheckpointIndex(root: string): Promise<CheckpointRecord[]> {
  return readJson<CheckpointRecord[]>(resolve(root, CHECKPOINT_DIR, CHECKPOINT_INDEX)).catch(() => []);
}

async function writeCheckpointIndex(root: string, index: CheckpointRecord[]): Promise<void> {
  const dir = resolve(root, CHECKPOINT_DIR);
  await mkdir(dir, { recursive: true });
  await writeJson(resolve(dir, CHECKPOINT_INDEX), index);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function toSummary(record: CheckpointRecord): CheckpointSummary {
  return {
    id: record.id,
    name: record.name,
    mode: record.mode,
    status: record.status,
    revertAvailable: record.status !== "missing"
  };
}

function isGitRepo(root: string): boolean {
  return runGit(root, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
}

function runGit(root: string, args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  return result.status === 0 ? result.stdout ?? "" : "";
}

function randomSuffix(): string {
  return createHash("sha256").update(`${Date.now()}${Math.random()}`).digest("hex").slice(0, 8);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function lineLooksUntracked(line: string): boolean {
  return line.startsWith("??");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
