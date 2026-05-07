import type { SwarmSettings } from "../config/settings.js";
import { AgentSpecProvider } from "./agent-specs.js";
import { BuiltinLocalToolProvider } from "./builtin-tools.js";
import { CapabilityRegistry } from "./registry.js";
import { SkillProvider, type ActivatedSkill, type SkillRecord } from "./skills.js";
import { SlashCommandProvider } from "./slash-commands.js";
import type {
  CapabilityDescriptor,
  CapabilityFilter,
  CapabilityProviderSnapshot
} from "./types.js";

export class CapabilityPlane {
  readonly registry = new CapabilityRegistry();
  readonly skills: SkillProvider;

  constructor(readonly settings: SwarmSettings, readonly workspace: string) {
    this.skills = new SkillProvider({ settings, workspace });
    this.registry.register(new BuiltinLocalToolProvider());
    this.registry.register(new SlashCommandProvider());
    this.registry.register(new AgentSpecProvider());
    this.registry.register(this.skills);
  }

  listCapabilities(filter?: CapabilityFilter): Promise<CapabilityDescriptor[]> {
    return this.registry.list(filter);
  }

  getCapability(id: string): Promise<CapabilityDescriptor | undefined> {
    return this.registry.get(id);
  }

  refresh(providerId?: string): Promise<CapabilityProviderSnapshot[]> {
    return this.registry.refresh(providerId);
  }

  listProviders(): Promise<CapabilityProviderSnapshot[]> {
    return this.registry.listProviders();
  }

  listSkills(): SkillRecord[] {
    return this.skills.listSkills();
  }

  activateSkill(name: string): ActivatedSkill {
    return this.skills.activateSkill(name);
  }

  dispose(): Promise<void> {
    return this.registry.dispose();
  }
}

export function createCapabilityPlane(input: {
  settings: SwarmSettings;
  workspace: string;
}): CapabilityPlane {
  return new CapabilityPlane(input.settings, input.workspace);
}
