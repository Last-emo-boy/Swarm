import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type EvalCaseResult = {
  name: string;
  status: "pass" | "fail";
  message: string;
};

export function runLocalEvals(root = process.cwd()): EvalCaseResult[] {
  return [
    checkFile(root, "docs/PRD.md", "PRD document exists"),
    checkFile(root, "src/runtime/swarm-controller.ts", "main Swarm controller exists"),
    checkFile(root, "src/runtime/coding-agent-loop.ts", "coding loop exists"),
    checkFile(root, "src/runtime/agent-specs.ts", "agent spec registry exists"),
    checkFile(root, "src/storage/handoff-store.ts", "handoff store exists"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "workerStore", "worker lifecycle is wired into coding loop"),
    checkContains(root, "src/runtime/coding-agent-loop.ts", "invokeAgent", "agent delegates route through main Swarm"),
    checkContains(root, "src/runtime/events.ts", "self_review", "self-review runtime event exists"),
    checkContains(root, "src/runtime/events.ts", "agent_spawn_decision", "agent spawn event exists"),
    checkContains(root, "src/storage/database.ts", "worker_states", "worker state table exists"),
    checkContains(root, "src/storage/database.ts", "handoff_sessions", "handoff session table exists"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "/self-review", "self-review TUI command is documented"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "/agents", "agent registry TUI command is documented"),
    checkContains(root, "src/tui/SwarmChatApp.tsx", "/handoffs", "handoff TUI command is documented"),
    checkNoForbiddenProductName(root)
  ];
}

function checkFile(root: string, path: string, name: string): EvalCaseResult {
  const fullPath = resolve(root, path);
  return existsSync(fullPath)
    ? { name, status: "pass", message: path }
    : { name, status: "fail", message: `${path} missing` };
}

function checkContains(root: string, path: string, needle: string, name: string): EvalCaseResult {
  const fullPath = resolve(root, path);
  if (!existsSync(fullPath)) {
    return { name, status: "fail", message: `${path} missing` };
  }
  const content = readFileSync(fullPath, "utf8");
  return content.includes(needle)
    ? { name, status: "pass", message: `${path} contains ${needle}` }
    : { name, status: "fail", message: `${path} does not contain ${needle}` };
}

function checkNoForbiddenProductName(root: string): EvalCaseResult {
  const files = ["src/config/settings.ts", "src/tui/SwarmChatApp.tsx", "src/runtime/runtime.ts"];
  const offenders = files.filter((path) => {
    const fullPath = resolve(root, path);
    return existsSync(fullPath) && /\.claude/i.test(readFileSync(fullPath, "utf8"));
  });
  return offenders.length === 0
    ? { name: "no foreign product config namespace", status: "pass", message: "No .claude references in core Swarm files." }
    : { name: "no foreign product config namespace", status: "fail", message: offenders.join(", ") };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/local-evals.js")) {
  const results = runLocalEvals();
  const failed = results.filter((result) => result.status === "fail");
  console.log(JSON.stringify({ status: failed.length ? "fail" : "pass", results }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
}
