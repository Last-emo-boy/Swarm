/** Component health entries with single-writer ownership per entry name (from dsh-superagent's infra/health.ts). */
export type Health = { state: "starting" | "ready" | "paused" | "error"; detail: string; at?: string };

export interface HealthEntry {
  get(): Health | undefined;
  set(health: Health): void;
  /** Unregisters the entry; later `set` calls do nothing. */
  release(): void;
}

/** The registry of health entries; the host writes a snapshot of it to the store so other Swarm processes can show it. */
export class HealthBoard {
  private readonly entries: Record<string, Health> = {};
  private readonly claimed = new Set<string>();
  claim(name: string, initial?: Health): HealthEntry {
    if (this.claimed.has(name)) throw new Error(`The health entry ${name} is reported by another part`);
    this.claimed.add(name);
    if (initial) this.entries[name] = initial;
    let held = true;
    return {
      get: () => this.entries[name],
      set: (health) => { if (held) this.entries[name] = health; },
      release: () => {
        if (!held) return;
        held = false;
        this.claimed.delete(name);
        delete this.entries[name];
      }
    };
  }
  get all(): Readonly<Record<string, Health>> { return this.entries; }
}
