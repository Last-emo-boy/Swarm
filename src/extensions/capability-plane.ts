import type { SwarmSettings } from "../config/settings.js";
import { AgentSpecProvider } from "./agent-specs.js";
import { BuiltinLocalToolProvider } from "./builtin-tools.js";
import { CapabilityRegistry } from "./registry.js";
import { SlashCommandProvider } from "./slash-commands.js";
import type {
  CapabilityDescriptor,
  CapabilityFilter,
  CapabilityProviderSnapshot
} from "./types.js";

export class CapabilityPlane {
  readonly registry = new CapabilityRegistry();

  constructor(readonly settings: SwarmSettings, readonly workspace: string) {
    this.registry.register(new BuiltinLocalToolProvider());
    this.registry.register(new SlashCommandProvider());
    this.registry.register(new AgentSpecProvider());
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

