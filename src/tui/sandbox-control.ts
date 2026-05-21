import { displayPath } from "../tools/permissions.js";
import type { RunSandboxMode } from "../runtime/execution-router.js";

export type SandboxModeCommandResult = {
  mode: RunSandboxMode;
  changed: boolean;
  brief: string;
};

export type SandboxModeReport = {
  brief: string;
  detail: string;
};

export function isRunSandboxMode(value: string): value is RunSandboxMode {
  return value === "workspace-write" || value === "read-only";
}

export function applySandboxModeCommand(current: RunSandboxMode, rawMode?: string): SandboxModeCommandResult {
  if (!rawMode) {
    return {
      mode: current,
      changed: false,
      brief: `Sandbox mode: ${current}.`
    };
  }
  if (!isRunSandboxMode(rawMode)) {
    throw new Error("Usage: /sandbox [workspace-write|read-only]");
  }
  return {
    mode: rawMode,
    changed: rawMode !== current,
    brief: `Sandbox mode set to ${rawMode}.`
  };
}

export function buildSandboxReport(input: {
  mode: RunSandboxMode;
  permissionMode: string;
  workspace?: string;
  additionalDirectories?: string[];
}): SandboxModeReport {
  const workspace = input.workspace ?? process.cwd();
  const additionalDirectories = input.additionalDirectories ?? [];
  const brief = input.mode === "read-only"
    ? `Sandbox: read-only. Writes, shell commands, package installs, and delegation are blocked at execution time. Permission mode: ${input.permissionMode}.`
    : `Sandbox: workspace-write. Workspace writes follow the permission policy. Permission mode: ${input.permissionMode}.`;
  const detail = [
    `Sandbox mode: ${input.mode}`,
    `Permission mode: ${input.permissionMode}`,
    `Scope: current TUI session only`,
    `Workspace root: ${workspace}`,
    "",
    "Execution behavior",
    ...(input.mode === "read-only"
      ? [
          "- workspace writes, local shell execution, package install, delegation, and durable mutations are denied at execution time.",
          "- read-only file, git inspection, process inspection, and bounded web tools still run."
        ]
      : [
          "- workspace writes are allowed when the permission policy allows them.",
          "- writes outside the startup workspace stay denied."
        ]),
    "",
    "Interaction with permissions",
    ...(input.mode === "read-only"
      ? [
          "- the sandbox denies write-like actions even if the permission mode would otherwise allow them.",
          "- permission rules still apply to read, fetch, and approval surfaces."
        ]
      : [
          "- the permission mode decides whether write-like actions are allowed, denied, or require approval.",
          "- deny rules still apply in workspace-write mode."
        ]),
    "",
    "Read roots",
    `- workspace: ${workspace}`,
    ...(additionalDirectories.length
      ? additionalDirectories.map((directory) => `- additional: ${displayPath(directory, workspace)}`)
      : ["- additional: none"]),
    "",
    "Headless parity",
    "- use `swarm run --sandbox workspace-write|read-only` or `--read-only` for one-off runs."
  ].join("\n");
  return { brief, detail };
}
