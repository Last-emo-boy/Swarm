import type {
  CapabilityDescriptor,
  CapabilityDiagnostic,
  CapabilityFilter,
  CapabilityProvider,
  CapabilityProviderSnapshot
} from "./types.js";

type ProviderCache = {
  capabilities: CapabilityDescriptor[];
  diagnostics: CapabilityDiagnostic[];
  refreshedAt?: string;
};

export class CapabilityRegistry {
  private readonly providers = new Map<string, CapabilityProvider>();
  private readonly cache = new Map<string, ProviderCache>();

  register(provider: CapabilityProvider): void {
    this.providers.set(provider.id, provider);
    this.cache.delete(provider.id);
  }

  listProviderIds(): string[] {
    return [...this.providers.keys()].sort();
  }

  async listProviders(): Promise<CapabilityProviderSnapshot[]> {
    await this.ensureLoaded();
    return [...this.providers.values()]
      .map((provider) => {
        const cached = this.cache.get(provider.id);
        return {
          providerId: provider.id,
          title: provider.title ?? provider.id,
          capabilities: cached?.capabilities.length ?? 0,
          diagnostics: cached?.diagnostics ?? [],
          refreshedAt: cached?.refreshedAt
        };
      })
      .sort((a, b) => a.providerId.localeCompare(b.providerId));
  }

  async refresh(providerId?: string): Promise<CapabilityProviderSnapshot[]> {
    if (providerId) {
      await this.refreshProvider(providerId);
    } else {
      await Promise.all([...this.providers.keys()].map((id) => this.refreshProvider(id)));
    }
    return this.listProviders();
  }

  invalidate(providerId?: string): void {
    if (providerId) {
      this.cache.delete(providerId);
      return;
    }
    this.cache.clear();
  }

  async list(filter: CapabilityFilter = {}): Promise<CapabilityDescriptor[]> {
    await this.ensureLoaded();
    return [...this.cache.values()]
      .flatMap((entry) => entry.capabilities)
      .filter((capability) => matchesFilter(capability, filter))
      .sort(compareCapabilities);
  }

  async get(id: string): Promise<CapabilityDescriptor | undefined> {
    await this.ensureLoaded();
    for (const entry of this.cache.values()) {
      const found = entry.capabilities.find((capability) => capability.id === id);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.providers.values()].map((provider) => provider.dispose?.()));
    this.cache.clear();
    this.providers.clear();
  }

  private async ensureLoaded(): Promise<void> {
    await Promise.all(
      [...this.providers.keys()]
        .filter((id) => !this.cache.has(id))
        .map((id) => this.refreshProvider(id))
    );
  }

  private async refreshProvider(providerId: string): Promise<void> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Unknown capability provider: ${providerId}`);
    }
    const diagnostics: CapabilityDiagnostic[] = [];
    let capabilities: CapabilityDescriptor[] = [];
    try {
      await provider.refresh?.();
      capabilities = await provider.listCapabilities();
      diagnostics.push(...(provider.diagnostics?.() ?? []));
    } catch (error) {
      diagnostics.push({
        severity: "error",
        code: "PROVIDER_REFRESH_FAILED",
        message: error instanceof Error ? error.message : String(error)
      });
    }
    this.cache.set(providerId, {
      capabilities: dedupeCapabilities(capabilities),
      diagnostics,
      refreshedAt: new Date().toISOString()
    });
  }
}

function dedupeCapabilities(capabilities: CapabilityDescriptor[]): CapabilityDescriptor[] {
  const seen = new Set<string>();
  const deduped: CapabilityDescriptor[] = [];
  for (const capability of capabilities) {
    if (seen.has(capability.id)) {
      deduped.push({
        ...capability,
        status: "failed",
        diagnostics: [
          ...(capability.diagnostics ?? []),
          {
            severity: "error",
            code: "DUPLICATE_CAPABILITY_ID",
            message: `Duplicate capability id in provider output: ${capability.id}`
          }
        ]
      });
      continue;
    }
    seen.add(capability.id);
    deduped.push(capability);
  }
  return deduped;
}

function matchesFilter(capability: CapabilityDescriptor, filter: CapabilityFilter): boolean {
  if (!filter.includeDisabled && (capability.trust === "disabled" || capability.status === "disabled")) {
    return false;
  }
  if (filter.kind && capability.kind !== filter.kind) {
    return false;
  }
  if (filter.source && capability.source !== filter.source) {
    return false;
  }
  if (filter.trust && capability.trust !== filter.trust) {
    return false;
  }
  const provider = filter.providerId ?? filter.provider;
  if (provider && capability.providerId !== provider) {
    return false;
  }
  if (typeof filter.modelVisible === "boolean" && capability.modelVisible !== filter.modelVisible) {
    return false;
  }
  if (typeof filter.userVisible === "boolean" && capability.userVisible !== filter.userVisible) {
    return false;
  }
  if (filter.query) {
    const query = filter.query.toLowerCase();
    const haystack = [
      capability.id,
      capability.name,
      capability.title ?? "",
      capability.description,
      capability.providerId,
      capability.permissionName
    ].join("\n").toLowerCase();
    if (!haystack.includes(query)) {
      return false;
    }
  }
  return true;
}

function compareCapabilities(a: CapabilityDescriptor, b: CapabilityDescriptor): number {
  return a.kind.localeCompare(b.kind) ||
    a.providerId.localeCompare(b.providerId) ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id);
}
