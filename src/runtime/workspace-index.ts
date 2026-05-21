import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const INDEX_ROOT = ".swarm/index";
const MAX_FILES = 500;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".swarm", ".tmp", "coverage", ".cache"]);

export type WorkspaceIndex = {
  root: string;
  generatedAt: string;
  packageManager?: string;
  detected: string[];
  scripts: Record<string, string>;
  recentFiles: Array<{
    path: string;
    size: number;
    mtimeMs: number;
  }>;
  files: Array<{
    path: string;
    kind: "source" | "config" | "doc" | "other";
    size: number;
    mtimeMs: number;
    hash: string;
  }>;
  git?: {
    isRepo: boolean;
    branch?: string;
    head?: string;
    dirtyFiles: string[];
    statusSummary: string;
  };
  counts: {
    files: number;
    recent: number;
  };
  manifests: {
    workspace: string;
    files: string;
    packages: string;
    git: string;
    recent: string;
  };
};

export async function ensureWorkspaceIndex(workspace: string): Promise<WorkspaceIndex> {
  const root = resolve(workspace);
  const indexDir = resolve(root, INDEX_ROOT);
  const indexPath = resolve(indexDir, "workspace.json");
  const filesPath = resolve(indexDir, "files.json");
  const packagesPath = resolve(indexDir, "packages.json");
  const gitPath = resolve(indexDir, "git.json");
  const recentPath = resolve(indexDir, "recent.json");

  const scanned = await scanWorkspace(root);
  const index: WorkspaceIndex = {
    root,
    generatedAt: new Date().toISOString(),
    packageManager: scanned.packageManager,
    detected: scanned.detected,
    scripts: scanned.scripts,
    recentFiles: scanned.recentFiles,
    files: scanned.files,
    git: scanned.git,
    counts: {
      files: scanned.files.length,
      recent: scanned.recentFiles.length
    },
    manifests: {
      workspace: indexPath,
      files: filesPath,
      packages: packagesPath,
      git: gitPath,
      recent: recentPath
    }
  };

  await mkdir(indexDir, { recursive: true });
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  await writeFile(filesPath, `${JSON.stringify(index.files, null, 2)}\n`, "utf8");
  await writeFile(packagesPath, `${JSON.stringify({ packageManager: index.packageManager, scripts: index.scripts, detected: index.detected }, null, 2)}\n`, "utf8");
  await writeFile(gitPath, `${JSON.stringify(index.git ?? { isRepo: false, dirtyFiles: [], statusSummary: "not a git repo" }, null, 2)}\n`, "utf8");
  await writeFile(recentPath, `${JSON.stringify(index.recentFiles, null, 2)}\n`, "utf8");
  return index;
}

export function workspaceIndexSummary(index: WorkspaceIndex): string {
  const detected = index.detected.length ? index.detected.join(", ") : "unknown";
  const scripts = Object.keys(index.scripts).slice(0, 4);
  const recent = index.recentFiles.slice(0, 3).map((item) => relative(index.root, item.path).replace(/\\/g, "/"));
  const git = index.git?.isRepo
    ? `${index.git.branch ?? "detached"}${index.git.dirtyFiles.length ? ` dirty:${index.git.dirtyFiles.length}` : ""}`
    : "no git";
  return [
    `detected=${detected}`,
    `files=${index.counts.files}`,
    `scripts=${scripts.length ? scripts.join(", ") : "(none)"}`,
    `recent=${recent.length ? recent.join(", ") : "(none)"}`,
    `git=${git}`
  ].join(" | ");
}

async function scanWorkspace(root: string): Promise<{
  packageManager?: string;
  detected: string[];
  scripts: Record<string, string>;
  recentFiles: WorkspaceIndex["recentFiles"];
  files: WorkspaceIndex["files"];
  git?: WorkspaceIndex["git"];
}> {
  const packageJson = await readJson(join(root, "package.json")).catch(() => undefined);
  const tsconfig = await readJson(join(root, "tsconfig.json")).catch(() => undefined);
  const packageManager = detectPackageManager(root);
  const detected = unique([
    packageJson ? "node" : undefined,
    tsconfig ? "typescript" : undefined,
    await exists(join(root, "src")) ? "source" : undefined,
    await exists(join(root, "README.md")) ? "docs" : undefined
  ]);
  const scripts = isRecord(packageJson) && isRecord(packageJson.scripts)
    ? Object.fromEntries(Object.entries(packageJson.scripts).filter(([, value]) => typeof value === "string").map(([key, value]) => [key, String(value)]))
    : {};
  const files: WorkspaceIndex["files"] = [];
  const recentFiles: WorkspaceIndex["recentFiles"] = [];
  for await (const file of walkWorkspace(root)) {
    const info = await stat(file.path);
    if (!info.isFile()) {
      continue;
    }
    const kind = classifyFile(file.path);
    const hash = createHash("sha256").update(`${file.path}:${info.size}:${info.mtimeMs}`).digest("hex");
    const relativePath = relative(root, file.path).replace(/\\/g, "/");
    files.push({
      path: relativePath,
      kind,
      size: info.size,
      mtimeMs: info.mtimeMs,
      hash
    });
    recentFiles.push({
      path: file.path,
      size: info.size,
      mtimeMs: info.mtimeMs
    });
    if (files.length >= MAX_FILES && recentFiles.length >= 50) {
      break;
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  recentFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const git = readGitSummary(root);
  return {
    packageManager,
    detected,
    scripts,
    recentFiles: recentFiles.slice(0, 50),
    files: files.slice(0, MAX_FILES),
    git
  };
}

async function* walkWorkspace(root: string): AsyncGenerator<{ path: string }> {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      const next = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(next);
      } else if (entry.isFile()) {
        yield { path: next };
      }
    }
  }
}

function classifyFile(file: string): "source" | "config" | "doc" | "other" {
  const relativePath = file.replace(/\\/g, "/").toLowerCase();
  if (/\.(ts|tsx|js|jsx|mjs|cjs|json|py|rs|go|java|md|yml|yaml|toml|html|css|scss)$/.test(relativePath)) {
    if (relativePath.endsWith(".md")) {
      return "doc";
    }
    if (relativePath.endsWith(".json") || relativePath.endsWith(".yml") || relativePath.endsWith(".yaml") || relativePath.endsWith(".toml")) {
      return "config";
    }
    return "source";
  }
  return "other";
}

function detectPackageManager(root: string): string | undefined {
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "package-lock.json"))) return "npm";
  return undefined;
}

function readGitSummary(root: string): WorkspaceIndex["git"] {
  const gitRoot = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (gitRoot.status !== 0) {
    return {
      isRepo: false,
      dirtyFiles: [],
      statusSummary: "not a git repo"
    };
  }
  const branch = runGit(root, ["branch", "--show-current"]).trim() || undefined;
  const head = runGit(root, ["rev-parse", "HEAD"]).trim() || undefined;
  const status = runGit(root, ["status", "--porcelain"]);
  const dirtyFiles = status
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .slice(0, 50);
  return {
    isRepo: true,
    branch,
    head,
    dirtyFiles,
    statusSummary: dirtyFiles.length ? `${dirtyFiles.length} dirty file(s)` : "clean"
  };
}

function runGit(root: string, args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  return result.status === 0 ? result.stdout ?? "" : "";
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
