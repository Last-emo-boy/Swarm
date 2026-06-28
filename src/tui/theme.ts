export type TuiTone =
  | "brand"
  | "muted"
  | "success"
  | "running"
  | "pending"
  | "warning"
  | "danger"
  | "agent"
  | "user"
  | "tool"
  | "gateway"
  | "swarm"
  | "surface"
  | "neutral";

export type TuiStatus = "info" | "running" | "pending" | "success" | "warning" | "error";
export type TuiColor =
  | "black"
  | "cyan"
  | "gray"
  | "green"
  | "yellow"
  | "red"
  | "magenta"
  | "white"
  | "blue"
  | "brightCyan"
  | "brightGreen"
  | "brightYellow"
  | "brightRed"
  | "brightMagenta"
  | "brightWhite"
  | "brightBlue";
export type TuiColorRef = TuiColor | TuiTone | TuiVisualToken | string;
export type TuiThemeProfileName = "swarm-dark" | "swarm-contrast" | "swarm-monochrome";
export type TuiResolvedColor = TuiColor | string | undefined;
export type TuiPrimitiveStatus = "success" | "error" | "warning" | "info" | "pending" | "loading";
export type TuiRole = "user" | "assistant" | "tool" | "gateway" | "swarm" | "system";
export type TranscriptEventKind = "message" | "logo" | "command" | "tool_use" | "tool_result" | "thinking" | "approval" | "progress";
export type ResultSectionKind = "summary" | "changed" | "checks" | "review" | "risks" | "recovery" | "artifacts" | "memory" | "contracts" | "checkpoint" | "cache" | "next";
export const TUI_VISUAL_TOKENS = [
  "text.primary",
  "text.muted",
  "surface.line",
  "surface.user",
  "surface.user.hover",
  "surface.shell",
  "surface.service",
  "surface.selection",
  "surface.searchMatch",
  "brand.focus",
  "role.user",
  "role.assistant",
  "role.tool",
  "role.gateway",
  "role.swarm",
  "status.success",
  "status.running",
  "status.pending",
  "status.warning",
  "status.danger",
  "diff.added",
  "diff.removed",
  "diff.added.bg",
  "diff.removed.bg",
  "service.cache",
  "service.lsp",
  "service.gateway",
  "service.symphony"
] as const;

export type TuiVisualToken = typeof TUI_VISUAL_TOKENS[number];

type TuiThemeProfile = {
  name: TuiThemeProfileName;
  tones: Record<TuiTone, TuiResolvedColor>;
  tokens: Record<TuiVisualToken, TuiResolvedColor>;
  raw: Partial<Record<TuiColor, TuiResolvedColor>>;
};

const SWARM_DARK_PROFILE: TuiThemeProfile = {
  name: "swarm-dark",
  tones: {
    brand: "rgb(224,151,88)",
    success: "rgb(104,208,134)",
    running: "rgb(92,200,215)",
    pending: "rgb(245,190,80)",
    warning: "rgb(245,190,80)",
    danger: "rgb(255,107,128)",
    agent: "rgb(212,140,255)",
    user: "rgb(122,217,122)",
    tool: "rgb(212,140,255)",
    gateway: "rgb(130,168,255)",
    swarm: "rgb(229,191,92)",
    surface: "rgb(82,82,82)",
    muted: "rgb(145,145,145)",
    neutral: "rgb(232,232,232)"
  },
  tokens: {
    "text.primary": "rgb(232,232,232)",
    "text.muted": "rgb(145,145,145)",
    "surface.line": "rgb(82,82,82)",
    "surface.user": "rgb(46,46,46)",
    "surface.user.hover": "rgb(58,58,58)",
    "surface.shell": "rgb(56,50,56)",
    "surface.service": "rgb(42,48,58)",
    "surface.selection": "rgb(38,79,120)",
    "surface.searchMatch": "rgb(92,70,24)",
    "brand.focus": "rgb(224,151,88)",
    "role.user": "rgb(122,217,122)",
    "role.assistant": "rgb(232,232,232)",
    "role.tool": "rgb(212,140,255)",
    "role.gateway": "rgb(130,168,255)",
    "role.swarm": "rgb(229,191,92)",
    "status.success": "rgb(104,208,134)",
    "status.running": "rgb(92,200,215)",
    "status.pending": "rgb(245,190,80)",
    "status.warning": "rgb(245,190,80)",
    "status.danger": "rgb(255,107,128)",
    "diff.added": "rgb(104,208,134)",
    "diff.removed": "rgb(255,107,128)",
    "diff.added.bg": "rgb(34,92,43)",
    "diff.removed.bg": "rgb(122,41,54)",
    "service.cache": "rgb(104,208,134)",
    "service.lsp": "rgb(130,168,255)",
    "service.gateway": "rgb(130,168,255)",
    "service.symphony": "rgb(229,191,92)"
  },
  raw: {}
};

const SWARM_CONTRAST_PROFILE: TuiThemeProfile = {
  name: "swarm-contrast",
  tones: {
    brand: "brightYellow",
    success: "brightGreen",
    running: "brightCyan",
    pending: "brightYellow",
    warning: "brightYellow",
    danger: "brightRed",
    agent: "brightMagenta",
    user: "brightGreen",
    tool: "brightMagenta",
    gateway: "brightBlue",
    swarm: "brightYellow",
    surface: "brightWhite",
    muted: "brightWhite",
    neutral: "brightWhite"
  },
  tokens: {
    "text.primary": "brightWhite",
    "text.muted": "brightWhite",
    "surface.line": "brightWhite",
    "surface.user": "brightWhite",
    "surface.user.hover": "brightWhite",
    "surface.shell": "brightMagenta",
    "surface.service": "brightBlue",
    "surface.selection": "brightBlue",
    "surface.searchMatch": "brightYellow",
    "brand.focus": "brightYellow",
    "role.user": "brightGreen",
    "role.assistant": "brightWhite",
    "role.tool": "brightMagenta",
    "role.gateway": "brightBlue",
    "role.swarm": "brightYellow",
    "status.success": "brightGreen",
    "status.running": "brightCyan",
    "status.pending": "brightYellow",
    "status.warning": "brightYellow",
    "status.danger": "brightRed",
    "diff.added": "brightGreen",
    "diff.removed": "brightRed",
    "diff.added.bg": "green",
    "diff.removed.bg": "red",
    "service.cache": "brightGreen",
    "service.lsp": "brightBlue",
    "service.gateway": "brightBlue",
    "service.symphony": "brightYellow"
  },
  raw: {
    cyan: "brightCyan",
    gray: "brightWhite",
    green: "brightGreen",
    yellow: "brightYellow",
    red: "brightRed",
    magenta: "brightMagenta",
    white: "brightWhite",
    blue: "brightBlue"
  }
};

const SWARM_MONOCHROME_PROFILE: TuiThemeProfile = {
  name: "swarm-monochrome",
  tones: Object.fromEntries(Object.keys(SWARM_DARK_PROFILE.tones).map((key) => [key, undefined])) as Record<TuiTone, undefined>,
  tokens: Object.fromEntries(Object.keys(SWARM_DARK_PROFILE.tokens).map((key) => [key, undefined])) as Record<TuiVisualToken, undefined>,
  raw: Object.fromEntries([
    "black",
    "cyan",
    "gray",
    "green",
    "yellow",
    "red",
    "magenta",
    "white",
    "blue",
    "brightCyan",
    "brightGreen",
    "brightYellow",
    "brightRed",
    "brightMagenta",
    "brightWhite",
    "brightBlue"
  ].map((key) => [key, undefined])) as Partial<Record<TuiColor, undefined>>
};

const THEME_PROFILES: Record<TuiThemeProfileName, TuiThemeProfile> = {
  "swarm-dark": SWARM_DARK_PROFILE,
  "swarm-contrast": SWARM_CONTRAST_PROFILE,
  "swarm-monochrome": SWARM_MONOCHROME_PROFILE
};

export function resolveTuiThemeProfile(input: string | undefined = process.env.SWARM_TUI_THEME): TuiThemeProfileName {
  if (process.env.NO_COLOR === "1" || process.env.SWARM_TUI_NO_COLOR === "1") {
    return "swarm-monochrome";
  }
  const normalized = input?.toLowerCase();
  if (normalized === "swarm-contrast" || normalized === "contrast") {
    return "swarm-contrast";
  }
  if (normalized === "swarm-monochrome" || normalized === "monochrome" || normalized === "mono" || normalized === "no-color") {
    return "swarm-monochrome";
  }
  return "swarm-dark";
}

// Phase-1 redesign flag: when on, the active-run view renders the new
// conversation-result-first activity line instead of the dense Swarm Board.
// Off (default) keeps the current board byte-identical.
export function resolveNewActiveLayout(input: string | undefined = process.env.SWARM_TUI_NEW_ACTIVE_LAYOUT): boolean {
  const normalized = input?.toLowerCase();
  return normalized === "1" || normalized === "on" || normalized === "true";
}

export function withTuiThemeProfile<T>(profile: TuiThemeProfileName | string, run: () => T): T {
  const previous = process.env.SWARM_TUI_THEME;
  process.env.SWARM_TUI_THEME = profile;
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env.SWARM_TUI_THEME;
    } else {
      process.env.SWARM_TUI_THEME = previous;
    }
  }
}

export function toneColor(tone: TuiTone): TuiResolvedColor {
  return THEME_PROFILES[resolveTuiThemeProfile()].tones[tone];
}

export function defaultToneColor(tone: TuiTone): TuiColor {
  switch (tone) {
    case "brand": return "cyan";
    case "success": return "green";
    case "running": return "cyan";
    case "pending": return "yellow";
    case "warning": return "yellow";
    case "danger": return "red";
    case "agent": return "magenta";
    case "user": return "green";
    case "tool": return "magenta";
    case "gateway": return "blue";
    case "swarm": return "yellow";
    case "surface": return "gray";
    case "muted": return "gray";
    case "neutral": return "white";
  }
}

export function visualTokenColor(token: TuiVisualToken): TuiResolvedColor {
  return THEME_PROFILES[resolveTuiThemeProfile()].tokens[token];
}

export function defaultVisualTokenColor(token: TuiVisualToken): TuiColor {
  switch (token) {
    case "text.primary": return "white";
    case "text.muted": return "gray";
    case "surface.line": return "gray";
    case "surface.user": return "gray";
    case "surface.user.hover": return "gray";
    case "surface.shell": return "magenta";
    case "surface.service": return "blue";
    case "surface.selection": return "blue";
    case "surface.searchMatch": return "yellow";
    case "brand.focus": return "cyan";
    case "role.user": return "green";
    case "role.assistant": return "white";
    case "role.tool": return "magenta";
    case "role.gateway": return "blue";
    case "role.swarm": return "yellow";
    case "status.success": return "green";
    case "status.running": return "cyan";
    case "status.pending": return "yellow";
    case "status.warning": return "yellow";
    case "status.danger": return "red";
    case "diff.added": return "green";
    case "diff.removed": return "red";
    case "diff.added.bg": return "green";
    case "diff.removed.bg": return "red";
    case "service.cache": return "green";
    case "service.lsp": return "blue";
    case "service.gateway": return "blue";
    case "service.symphony": return "yellow";
  }
}

export function resolveTuiColor(value: TuiColorRef | undefined): TuiResolvedColor {
  if (!value) {
    return undefined;
  }
  if (isVisualToken(value)) {
    return visualTokenColor(value);
  }
  if (isTone(value)) {
    return toneColor(value);
  }
  if (isTuiColor(value)) {
    const profile = THEME_PROFILES[resolveTuiThemeProfile()];
    if (profile.name === "swarm-monochrome") {
      return undefined;
    }
    return profile.raw[value] ?? value;
  }
  return resolveTuiThemeProfile() === "swarm-monochrome" ? undefined : value;
}

export function statusIconStatus(status: string | undefined): TuiPrimitiveStatus {
  const tone = statusTone(status);
  if (tone === "success") return "success";
  if (tone === "danger") return "error";
  if (tone === "warning") return "warning";
  if (tone === "pending") return "pending";
  if (tone === "running") return "loading";
  return "info";
}

export function roleTone(role: TuiRole): TuiTone {
  switch (role) {
    case "user": return "user";
    case "assistant": return "neutral";
    case "tool": return "tool";
    case "gateway": return "gateway";
    case "swarm": return "swarm";
    case "system": return "muted";
  }
}

function isVisualToken(value: string): value is TuiVisualToken {
  return (TUI_VISUAL_TOKENS as readonly string[]).includes(value);
}

function isTone(value: string): value is TuiTone {
  return [
    "brand",
    "muted",
    "success",
    "running",
    "pending",
    "warning",
    "danger",
    "agent",
    "user",
    "tool",
    "gateway",
    "swarm",
    "surface",
    "neutral"
  ].includes(value);
}

function isTuiColor(value: string): value is TuiColor {
  return [
    "black",
    "cyan",
    "gray",
    "green",
    "yellow",
    "red",
    "magenta",
    "white",
    "blue",
    "brightCyan",
    "brightGreen",
    "brightYellow",
    "brightRed",
    "brightMagenta",
    "brightWhite",
    "brightBlue"
  ].includes(value);
}

export function statusTone(status: string | undefined): TuiTone {
  const normalized = (status ?? "").toLowerCase();
  if (["completed", "complete", "success", "approved", "pass", "passed", "done", "ok", "cache_hit", "hit", "warm", "stable", "ready", "healthy"].includes(normalized)) {
    return "success";
  }
  if (["running", "started", "processing", "applied", "thinking", "executing"].includes(normalized)) {
    return "running";
  }
  if (["pending", "queued", "assigned", "waiting", "received", "awaiting approval", "cache_miss", "miss", "changed", "cold"].includes(normalized)) {
    return "pending";
  }
  if (["skipped", "skip", "unknown", "info", "idle", "disabled"].includes(normalized)) {
    return "muted";
  }
  if (["partial", "stopped", "blocked", "needs_revision", "warn", "warning"].includes(normalized)) {
    return "warning";
  }
  if (["failed", "failure", "error", "denied", "reject", "cancelled"].includes(normalized)) {
    return "danger";
  }
  return "muted";
}

export function statusBadge(status: string | undefined): string {
  const normalized = (status ?? "info").toLowerCase();
  if (["completed", "complete", "success", "approved", "pass", "passed", "done", "ok"].includes(normalized)) {
    return "[OK]";
  }
  if (["running", "started", "processing", "applied", "thinking", "executing"].includes(normalized)) {
    return "[RUN]";
  }
  if (["pending", "queued", "assigned", "waiting", "received", "awaiting approval"].includes(normalized)) {
    return "[ASK]";
  }
  if (["skipped", "skip"].includes(normalized)) {
    return "[SKIP]";
  }
  if (["partial", "stopped", "blocked", "needs_revision", "warn", "warning"].includes(normalized)) {
    return "[WARN]";
  }
  if (["failed", "failure", "error", "denied", "reject", "cancelled"].includes(normalized)) {
    return "[ERR]";
  }
  return "[--]";
}

export function statusMarker(status: string | undefined): string {
  const tone = statusTone(status);
  if (tone === "danger") return "✗";
  if (tone === "warning") return "!";
  if (tone === "success") return "✓";
  return "·";
}

export function routeBadge(route: string): string {
  if (route === "chat" || route === "ask") return "ASK";
  if (route === "coding_loop" || route === "work") return "WORK";
  if (route === "full_swarm" || route === "team") return "TEAM";
  return route.toUpperCase();
}

export function policyBadge(permissionMode: string): string {
  if (permissionMode === "ask") return "GUARDED";
  if (permissionMode === "auto-edit") return "AUTO-EDIT";
  if (permissionMode === "full-auto" || permissionMode === "auto") return "FULL-AUTO";
  if (permissionMode === "yolo") return "YOLO";
  return permissionMode.toUpperCase();
}

export function policyTone(permissionMode: string): TuiTone {
  if (permissionMode === "yolo") return "danger";
  if (permissionMode === "full-auto" || permissionMode === "auto") return "warning";
  if (permissionMode === "auto-edit") return "pending";
  return "muted";
}

export function sandboxBadge(sandboxMode: string): string {
  if (sandboxMode === "read-only") return "RO";
  if (sandboxMode === "workspace-write") return "RW";
  return sandboxMode.toUpperCase();
}

export function sandboxTone(sandboxMode: string): TuiTone {
  if (sandboxMode === "read-only") return "pending";
  if (sandboxMode === "workspace-write") return "success";
  return "warning";
}

export function transcriptEventToken(kind: TranscriptEventKind | undefined, status?: string): {
  prefix: string;
  label: string;
  tone: TuiTone;
} {
  switch (kind) {
    case "command":
      return { prefix: "❯ ", label: "cmd", tone: "user" };
    case "tool_use":
      return { prefix: "⏵ tool ", label: "tool", tone: ["danger", "warning"].includes(statusTone(status)) ? statusTone(status) : "tool" };
    case "tool_result":
      return { prefix: `${statusMarker(status)} result `, label: "result", tone: statusTone(status) };
    case "thinking":
      return { prefix: "∴ think ", label: "think", tone: "muted" };
    case "approval":
      return { prefix: "? approval ", label: "approval", tone: "pending" };
    case "progress":
      return { prefix: "· progress ", label: "progress", tone: statusTone(status) === "muted" ? "running" : statusTone(status) };
    case "message":
    case "logo":
      return { prefix: "", label: "message", tone: "neutral" };
    default:
      return { prefix: "", label: "message", tone: "neutral" };
  }
}

export function resultSectionToken(section: ResultSectionKind): {
  label: string;
  tone: TuiTone;
} {
  switch (section) {
    case "summary": return { label: "SUMMARY", tone: "brand" };
    case "changed": return { label: "CHANGED", tone: "gateway" };
    case "checks": return { label: "CHECKS", tone: "success" };
    case "review": return { label: "REVIEW", tone: "pending" };
    case "risks": return { label: "RISKS", tone: "warning" };
    case "recovery": return { label: "RECOVERY", tone: "warning" };
    case "artifacts": return { label: "ARTIFACTS", tone: "neutral" };
    case "memory": return { label: "MEMORY", tone: "muted" };
    case "contracts": return { label: "CONTRACTS", tone: "neutral" };
    case "checkpoint": return { label: "CHECKPOINT", tone: "running" };
    case "cache": return { label: "CACHE", tone: "pending" };
    case "next": return { label: "NEXT", tone: "brand" };
  }
}

export function checkStatusTone(status: string | undefined): TuiTone {
  const normalized = (status ?? "").toLowerCase();
  if (normalized === "failed") return "danger";
  if (normalized === "skipped" || normalized === "unknown") return "warning";
  return statusTone(status);
}

export function cacheOutcomeTone(status: string | undefined): TuiTone {
  const normalized = (status ?? "").toLowerCase();
  if (["cache_hit", "hit", "warm", "stable", "ready", "ok"].includes(normalized)) return "success";
  if (["cache_miss", "miss", "changed", "unknown"].includes(normalized)) return "pending";
  if (["failed", "error", "unavailable", "disabled", "degraded"].includes(normalized)) return "warning";
  return normalized ? "neutral" : "muted";
}

export function serviceHealthTone(status: string | undefined): TuiTone {
  const normalized = (status ?? "").toLowerCase();
  if (["failed", "failure", "error", "denied", "cancelled", "blocked"].includes(normalized)) return "danger";
  if (["warning", "warn", "degraded", "partial", "reconnecting", "retrying", "unavailable"].includes(normalized)) return "warning";
  if (["pending", "queued", "waiting", "awaiting approval", "starting"].includes(normalized)) return "pending";
  if (["running", "processing"].includes(normalized)) return "running";
  if (["ok", "ready", "healthy", "success", "completed", "cache_hit", "hit", "warm", "stable", "local", "external"].includes(normalized)) return "success";
  return normalized ? "neutral" : "muted";
}

export function approvalRiskToken(input: { risk?: string; riskClass?: string }): {
  label: string;
  tone: TuiTone;
  badge: string;
} {
  const risk = input.risk?.toLowerCase() ?? "unknown";
  const riskClass = input.riskClass?.toLowerCase() ?? "r?";
  if (riskClass === "r4" || risk === "shell") {
    return { label: `${riskClass.toUpperCase()}/${risk.toUpperCase()}`, tone: "danger", badge: "[HIGH]" };
  }
  if (riskClass === "r3" || risk === "install" || risk === "delegate") {
    return { label: `${riskClass.toUpperCase()}/${risk.toUpperCase()}`, tone: "warning", badge: "[RISK]" };
  }
  if (riskClass === "r2" || risk === "write" || risk === "web") {
    return { label: `${riskClass.toUpperCase()}/${risk.toUpperCase()}`, tone: "pending", badge: "[ASK]" };
  }
  return { label: `${riskClass.toUpperCase()}/${risk.toUpperCase()}`, tone: "muted", badge: "[LOW]" };
}

export function progressBar(completed: number, total: number, width = 12): string {
  if (!Number.isFinite(total) || total <= 0) {
    return `[${"-".repeat(width)}]`;
  }
  const safeCompleted = Math.max(0, Math.min(completed, total));
  const filled = Math.round((safeCompleted / total) * width);
  return `[${"#".repeat(filled)}${"-".repeat(Math.max(0, width - filled))}]`;
}

export function compactValue(value: string | undefined, maxLength: number): string {
  const input = value?.trim() ?? "";
  if (input.length <= maxLength) {
    return input;
  }
  if (maxLength <= 3) {
    return input.slice(0, maxLength);
  }
  return `${input.slice(0, maxLength - 3)}...`;
}

export function sectionLabel(label: string): string {
  return label.toUpperCase();
}

export function compactId(value: string | undefined, maxLength = 10): string {
  return compactValue(value ?? "-", maxLength);
}

export function attentionRankForStatus(status: string | undefined): number {
  const tone = statusTone(status);
  if (tone === "danger") return 0;
  if (tone === "warning") return 1;
  if (tone === "pending") return 2;
  if (tone === "running") return 3;
  if (tone === "success") return 5;
  return 4;
}

export function compactKernelRow(input: {
  status?: string;
  kind?: string;
  id?: string;
  title: string;
  metadata?: Array<string | undefined>;
  maxTitleLength?: number;
  idLength?: number;
}): string {
  const label = [
    input.status ? statusBadge(input.status) : undefined,
    input.kind ? sectionLabel(input.kind) : undefined,
    input.id ? compactId(input.id, input.idLength ?? 10) : undefined
  ].filter((part): part is string => Boolean(part)).join(" ");
  const title = compactValue(input.title, input.maxTitleLength ?? 72);
  const metadata = (input.metadata ?? [])
    .filter((part): part is string => Boolean(part?.trim()))
    .join(" | ");
  return [label, title, metadata ? `(${metadata})` : undefined]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}
