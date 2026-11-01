/** Deployment and async fixtures shared by the superagent tests (from dsh-superagent's tests/fixtures). */
import type { Deployment, Machine } from "../setup.js";
import { vi } from "./expect.js";

export const testMachine = (overrides: Partial<Machine> = {}): Machine => ({
  stateDir: "/tmp/swarm-superagent-test",
  admissionContextMaxPages: 10,
  admissionContextTimeoutMs: 15000,
  ...overrides
});
export const testDeployment = (overrides: Partial<Deployment> = {}): Deployment => ({
  ...testMachine(),
  repository: "acme/widgets",
  github: { cli: "/bin/false", login: "agent-bot", noreply: "7+agent-bot@users.noreply.github.com" },
  feishu: { cli: "/bin/false", botId: "ou_bot", appId: "cli_bot", brand: "feishu", name: "Widgets Bot" },
  ...overrides
});

/** Create an externally resolvable promise. */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
/** Observe whether a promise has settled without awaiting it. */
export function track<T>(promise: Promise<T>) {
  const state = { settled: false, error: undefined as unknown, promise };
  promise.then(() => { state.settled = true; }, (error: unknown) => { state.settled = true; state.error = error; });
  return state;
}
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const waitUntil = (check: () => boolean, timeout = 3000) =>
  vi.waitFor(() => { if (!check()) throw new Error("not yet"); }, { timeout, interval: 2 });
