import { arch, release, type } from "node:os";
import { delimiter, sep } from "node:path";

export type HostEnvironmentContext = {
  os: string;
  platform: NodeJS.Platform;
  arch: string;
  node_version: string;
  workspace: string;
  process_cwd: string;
  path_separator: string;
  path_list_separator: string;
  shell: string;
  shell_invocation: string;
  command_guidance: string[];
};

export function hostEnvironmentContext(workspace = process.cwd()): HostEnvironmentContext {
  const shell = hostShell();
  const isWindows = process.platform === "win32";
  return {
    os: `${type()} ${release()}`,
    platform: process.platform,
    arch: arch(),
    node_version: process.version,
    workspace,
    process_cwd: process.cwd(),
    path_separator: sep,
    path_list_separator: delimiter,
    shell,
    shell_invocation: isWindows
      ? `${shell} -NoProfile -Command <command>`
      : `${shell} -lc <command>`,
    command_guidance: isWindows
      ? [
          "Shell commands run in PowerShell on Windows.",
          "Use PowerShell syntax: New-Item/Set-Content/Get-Content, ; for sequencing when appropriate, Start-Process for background processes, and $env:NAME for environment variables.",
          "Do not use POSIX-only constructs such as cat > file <<'EOF', mkdir -p, sleep as a portability assumption, or cd $(pwd) unless you explicitly invoke a POSIX shell that exists.",
          "Prefer workspace-relative paths and quote paths that may contain spaces or special characters."
        ]
      : [
          "Shell commands run in a POSIX-compatible shell.",
          "Use POSIX shell syntax and quote paths that may contain spaces or special characters.",
          "Prefer workspace-relative paths."
        ]
  };
}

export function renderHostEnvironmentPrompt(workspace = process.cwd()): string {
  const context = hostEnvironmentContext(workspace);
  return [
    "Host environment for local tools:",
    `- OS: ${context.os}`,
    `- platform: ${context.platform}`,
    `- arch: ${context.arch}`,
    `- node: ${context.node_version}`,
    `- workspace: ${context.workspace}`,
    `- process cwd: ${context.process_cwd}`,
    `- path separator: ${context.path_separator}`,
    `- path-list separator: ${context.path_list_separator}`,
    `- shell: ${context.shell}`,
    `- shell invocation: ${context.shell_invocation}`,
    ...context.command_guidance.map((item) => `- ${item}`)
  ].join("\n");
}

export function hostShell(): string {
  if (process.platform === "win32") {
    return "powershell.exe";
  }
  return process.env.SWARM_SHELL || process.env.SHELL || "/bin/sh";
}
