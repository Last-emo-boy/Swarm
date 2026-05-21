import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);

const LANGUAGE_MARKERS: Record<string, string[]> = {
  typescript: ["tsconfig.json", "jsconfig.json", "package.json"],
  python: ["pyproject.toml", "setup.py", "requirements.txt"],
  rust: ["Cargo.toml"],
  go: ["go.mod"],
  java: ["pom.xml", "build.gradle", "settings.gradle"],
  cpp: ["compile_commands.json", "compile_flags.txt"]
};

const GENERIC_MARKERS = [
  "tsconfig.json",
  "jsconfig.json",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "compile_commands.json",
  ".git"
];

export type LspWorkspaceDetection = {
  workspaceRoot: string;
  requestedRoot: string;
  language?: string;
  marker?: string;
  reason: string;
};

export function languageForFile(file: string): string | undefined {
  const extension = extname(file).toLowerCase();
  if (TYPESCRIPT_EXTENSIONS.has(extension)) {
    return "typescript";
  }
  if (extension === ".py") {
    return "python";
  }
  if (extension === ".rs") {
    return "rust";
  }
  if (extension === ".go") {
    return "go";
  }
  if (extension === ".java" || extension === ".kt" || extension === ".kts") {
    return "java";
  }
  if (extension === ".c" || extension === ".cc" || extension === ".cpp" || extension === ".cxx" || extension === ".h" || extension === ".hpp") {
    return "cpp";
  }
  return undefined;
}

export async function detectLspWorkspaceRoot(input: { workspace: string; root?: string; file?: string }): Promise<LspWorkspaceDetection> {
  const workspace = resolve(input.workspace);
  const requestedRoot = resolve(input.root ?? (input.file ? dirname(input.file) : workspace));
  const start = await directoryStart(requestedRoot);
  const language = input.file ? languageForFile(input.file) : detectLanguageFromMarkers(start);
  const markers = language ? [...(LANGUAGE_MARKERS[language] ?? []), ".git"] : GENERIC_MARKERS;
  const match = findNearestMarker(start, workspace, markers);
  if (match) {
    return {
      workspaceRoot: match.root,
      requestedRoot,
      language,
      marker: match.marker,
      reason: `nearest ${match.marker}`
    };
  }
  return {
    workspaceRoot: start,
    requestedRoot,
    language,
    reason: "no root marker found"
  };
}

async function directoryStart(path: string): Promise<string> {
  try {
    const info = await stat(path);
    return info.isDirectory() ? path : dirname(path);
  } catch {
    return isAbsolute(path) && extname(path) ? dirname(path) : path;
  }
}

function findNearestMarker(start: string, workspace: string, markers: string[]): { root: string; marker: string } | undefined {
  let current = resolve(start);
  const boundary = resolve(workspace);
  while (true) {
    for (const marker of markers) {
      if (existsSync(join(current, marker))) {
        return { root: current, marker };
      }
    }
    if (current === boundary || dirname(current) === current) {
      break;
    }
    current = dirname(current);
  }
  if (current !== boundary) {
    return undefined;
  }
  for (const marker of markers) {
    if (existsSync(join(boundary, marker))) {
      return { root: boundary, marker };
    }
  }
  return undefined;
}

function detectLanguageFromMarkers(root: string): string | undefined {
  for (const [language, markers] of Object.entries(LANGUAGE_MARKERS)) {
    if (markers.some((marker) => existsSync(join(root, marker)))) {
      return language;
    }
  }
  return undefined;
}
