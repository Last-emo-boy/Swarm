import { listAgentSpecs } from "../runtime/agent-specs.js";
import type { AgentSpec } from "../runtime/agent-specs.js";
import type { CapabilityDescriptor, CapabilityProvider } from "./types.js";

export class AgentSpecProvider implements CapabilityProvider {
  readonly id = "agent-specs";
  readonly title = "Built-in agent specs";

  listCapabilities(): CapabilityDescriptor[] {
    return listAgentSpecs().map((spec) => ({
      id: `agent_spec.${spec.id}`,
      kind: "agent_spec",
      source: "builtin",
      trust: "builtin",
      providerId: this.id,
      name: spec.id,
      title: spec.name,
      description: spec.description,
      inputSchema: {
        type: "object",
        properties: {
          task: { description: "bounded task for this agent spec" },
          context: { description: "optional relevant context" },
          file_scope: { description: "optional workspace paths for scoped write agents" }
        }
      },
      riskClass: riskClassForAgentSpec(spec),
      permissionName: `AgentSpec(${spec.id})`,
      modelVisible: false,
      userVisible: true,
      status: "available",
      metadata: {
        role: spec.role,
        capabilities: spec.capabilities,
        tools: spec.tools,
        write_policy: spec.write_policy,
        default_budget: spec.default_budget,
        when_to_use: spec.when_to_use,
        output_contract: spec.output_contract
      }
    }));
  }
}

function riskClassForAgentSpec(spec: AgentSpec): CapabilityDescriptor["riskClass"] {
  if (spec.write_policy === "workspace_write") {
    return "r2";
  }
  if (spec.write_policy === "scoped_write") {
    return "r1";
  }
  return "r0";
}

