import type { CapabilityDescriptor, CapabilityProvider } from "./types.js";

type BuiltinToolDescriptor = {
  name: string;
  title: string;
  description: string;
  riskClass: CapabilityDescriptor["riskClass"];
  permissionName: string;
  inputSchema: unknown;
};

const BUILTIN_TOOLS: BuiltinToolDescriptor[] = [
  {
    name: "file.read",
    title: "Read File",
    description: "Read one or more workspace files subject to read roots and deny rules.",
    riskClass: "r0",
    permissionName: "Read",
    inputSchema: objectSchema({ path: "string", paths: "string[]", startLine: "number", endLine: "number", maxBytes: "number" })
  },
  {
    name: "file.list",
    title: "List Files",
    description: "List files under a workspace directory.",
    riskClass: "r0",
    permissionName: "LS",
    inputSchema: objectSchema({ root: "string", maxFiles: "number", maxDepth: "number" })
  },
  {
    name: "file.glob",
    title: "Glob Files",
    description: "Find files under a directory using a glob pattern.",
    riskClass: "r0",
    permissionName: "Glob",
    inputSchema: objectSchema({ root: "string", pattern: "string", maxResults: "number", maxDepth: "number" })
  },
  {
    name: "file.grep",
    title: "Search Files",
    description: "Search text in workspace files with regex support.",
    riskClass: "r0",
    permissionName: "Grep",
    inputSchema: objectSchema({ root: "string", pattern: "string", include: "string", maxMatches: "number", contextLines: "number" })
  },
  {
    name: "file.stat",
    title: "Stat Path",
    description: "Inspect file or directory metadata.",
    riskClass: "r0",
    permissionName: "Stat",
    inputSchema: objectSchema({ path: "string" })
  },
  {
    name: "file.write",
    title: "Write File",
    description: "Create or replace a workspace file when direct writes and permissions allow it.",
    riskClass: "r1",
    permissionName: "Write",
    inputSchema: objectSchema({ path: "string", content: "string" })
  },
  {
    name: "file.edit",
    title: "Edit File",
    description: "Apply a targeted string replacement or insertion to a workspace file.",
    riskClass: "r1",
    permissionName: "Edit",
    inputSchema: objectSchema({ path: "string", operation: "str_replace | insert", oldText: "string", newText: "string", line: "number", content: "string" })
  },
  {
    name: "todo.write",
    title: "Write Todo State",
    description: "Update the current agent todo list.",
    riskClass: "r0",
    permissionName: "TodoWrite",
    inputSchema: objectSchema({ todos: "array of {content,status}" })
  },
  {
    name: "shell.exec",
    title: "Run Shell",
    description: "Run a local shell command in the workspace with approval when required.",
    riskClass: "r2",
    permissionName: "Bash",
    inputSchema: objectSchema({ command: "string", cwd: "string", timeoutMs: "number", maxOutputBytes: "number" })
  },
  {
    name: "web.search",
    title: "Search Web",
    description: "Search the web through the configured provider or search path.",
    riskClass: "r0",
    permissionName: "WebSearch",
    inputSchema: objectSchema({ query: "string", allowed_domains: "string[]", blocked_domains: "string[]", maxUses: "number" })
  },
  {
    name: "web.fetch",
    title: "Fetch Web Page",
    description: "Fetch HTTP(S) content subject to web tool settings and permissions.",
    riskClass: "r2",
    permissionName: "WebFetch",
    inputSchema: objectSchema({ url: "string", timeoutMs: "number", maxBytes: "number" })
  },
  {
    name: "code.test",
    title: "Run Test Command",
    description: "Run a project test command and capture output.",
    riskClass: "r1",
    permissionName: "CodeTest",
    inputSchema: objectSchema({ command: "string", cwd: "string", timeoutMs: "number" })
  },
  {
    name: "code.lint",
    title: "Run Lint",
    description: "Run a lint-oriented local command for a root or include pattern.",
    riskClass: "r1",
    permissionName: "CodeLint",
    inputSchema: objectSchema({ root: "string", include: "string" })
  },
  {
    name: "git.status",
    title: "Git Status",
    description: "Inspect the current git status.",
    riskClass: "r0",
    permissionName: "GitStatus",
    inputSchema: objectSchema({ cwd: "string" })
  },
  {
    name: "git.diff",
    title: "Git Diff",
    description: "Inspect unstaged or staged git diffs.",
    riskClass: "r0",
    permissionName: "GitDiff",
    inputSchema: objectSchema({ cwd: "string", staged: "boolean" })
  },
  {
    name: "git.log",
    title: "Git Log",
    description: "Inspect recent git commits.",
    riskClass: "r0",
    permissionName: "GitLog",
    inputSchema: objectSchema({ cwd: "string", maxCommits: "number" })
  },
  {
    name: "git.branch",
    title: "Git Branch",
    description: "List, create, or switch git branches.",
    riskClass: "r2",
    permissionName: "GitBranch",
    inputSchema: objectSchema({ cwd: "string", action: "list | create | switch", name: "string" })
  },
  {
    name: "package.install",
    title: "Install Packages",
    description: "Run a package manager install command.",
    riskClass: "r2",
    permissionName: "PackageInstall",
    inputSchema: objectSchema({ command: "string", cwd: "string", timeoutMs: "number" })
  },
  {
    name: "solidity.compile",
    title: "Compile Solidity",
    description: "Compile a Solidity project with solc, Hardhat, or Foundry.",
    riskClass: "r1",
    permissionName: "SolidityCompile",
    inputSchema: objectSchema({ cwd: "string", framework: "solc | hardhat | foundry" })
  },
  {
    name: "agent.delegate",
    title: "Delegate Agent Task",
    description: "Delegate a bounded task to an internal specialist agent.",
    riskClass: "r1",
    permissionName: "Delegate",
    inputSchema: objectSchema({ capability: "string", task: "string", context: "string", preferred_agent_spec_id: "string", preferred_mode: "call_subagent | handoff | parallel", file_scope: "string[]" })
  }
];

export class BuiltinLocalToolProvider implements CapabilityProvider {
  readonly id = "local-tools";
  readonly title = "Built-in local tools";

  listCapabilities(): CapabilityDescriptor[] {
    return BUILTIN_TOOLS.map((tool) => ({
      id: `local_tool.${tool.name}`,
      kind: "local_tool",
      source: "builtin",
      trust: "builtin",
      providerId: this.id,
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      riskClass: tool.riskClass,
      permissionName: tool.permissionName,
      modelVisible: true,
      userVisible: true,
      status: "available",
      metadata: {
        action: tool.name
      }
    }));
  }
}

function objectSchema(properties: Record<string, string>): unknown {
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(properties).map(([name, description]) => [
        name,
        { description }
      ])
    )
  };
}

