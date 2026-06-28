// Pure leaf helper utilities extracted from runtime.ts. No dependencies on runtime
// state; shared by runtime.ts and sibling runtime modules to avoid circular imports.

export function sanitizeKey(value: string): string {
  return value.replace(/\\/g, "/").replace(/[^A-Za-z0-9._/-]+/g, "_").replace(/\//g, ".");
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))].sort();
}

export function formatWorkspaceChangeForFreshness(value: unknown): string {
  const record = isRecord(value) ? value : {};
  const operation = typeof record.operation === "string" ? record.operation : "change";
  const path = typeof record.path === "string" ? record.path : "(unknown path)";
  const afterHash = typeof record.afterHash === "string" ? record.afterHash.slice(0, 12) : undefined;
  return afterHash ? `${operation} ${path}@${afterHash}` : `${operation} ${path}`;
}

export function parseJsonObject(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return {};
    }
    try {
      return JSON.parse(match[0]) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

export function firstLine(value: string): string {
  return value.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 240) ?? "";
}

export function positiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(200, Math.floor(value)));
}
