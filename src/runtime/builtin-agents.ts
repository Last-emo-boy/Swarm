import type { AgentCard } from "../protocol/types.js";

export const builtinAgents: AgentCard[] = [
  {
    agent_id: "worker_01",
    name: "General Worker Agent",
    role: "worker",
    capabilities: ["analysis.synthesize", "research.summarize", "code.inspect", "design.reason"],
    status: "idle",
    load: { running_tasks: 0, max_tasks: 2 },
    reliability: { success_rate: 0.9, avg_latency_ms: 2500 }
  },
  {
    agent_id: "reviewer_01",
    name: "Reviewer Agent",
    role: "reviewer",
    capabilities: ["review.general", "review.security", "review.code", "critique.result"],
    status: "idle",
    load: { running_tasks: 0, max_tasks: 1 },
    reliability: { success_rate: 0.92, avg_latency_ms: 2200 }
  },
  {
    agent_id: "aggregator_01",
    name: "Aggregator Agent",
    role: "aggregator",
    capabilities: ["aggregation.summarize", "artifact.compose"],
    status: "idle",
    load: { running_tasks: 0, max_tasks: 1 },
    reliability: { success_rate: 0.94, avg_latency_ms: 1800 }
  },
  {
    agent_id: "tool_01",
    name: "Tool Agent",
    role: "tool",
    capabilities: [
      "tool.file.list",
      "tool.file.read",
      "tool.file.glob",
      "tool.file.grep",
      "tool.file.stat",
      "tool.file.write",
      "tool.file.edit",
      "tool.shell.exec",
      "web.search",
      "web.fetch",
      "code.test",
      "code.lint",
      "git.status",
      "git.diff",
      "git.log",
      "git.branch",
      "package.install",
      "solidity.compile",
      "agent.delegate"
    ],
    status: "idle",
    load: { running_tasks: 0, max_tasks: 4 },
    reliability: { success_rate: 0.9, avg_latency_ms: 600 }
  }
];
