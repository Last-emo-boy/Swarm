/**
 * The supervisor in a ticket VM (`swarm superagent guest`): what the host's executor does for a worker here, done in the
 * VM for the ticket its slot runs. It reads the ticket's spec from its gateway, points Swarm's providers at the gateway's
 * model proxy with the slot's token as their key, prepares the ticket's directory once (the prepare command, a clone of its
 * requester's repository, the patch of a ticket it takes over), starts the worker, renews the slot's lease while it runs,
 * and tells the gateway when it exits. The VM powers off after it.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getSwarmPaths, type ProviderDefinition } from "../../config/settings.js";
import { workerEnvironment, writeEnvironment } from "../environment.js";
import { applyPatch, cloneRepository, prepareDirectory, WORKER_SHELL_AUTO_BACKGROUND_MS } from "../executor.js";
import type { GuestSpec } from "./gateway.js";
import { callGateway, GATEWAY_VARIABLE, gatewayFromEnv, TOKEN_VARIABLE, type Gateway } from "./gateway-link.js";

const HEARTBEAT_MS = 15_000;
/** How long the worker may take to stop once its lease ended, before it is killed. */
const STOP_GRACE_MS = 10_000;

/**
 * Swarm's settings in the VM: its models, and the providers they use with the gateway's model proxy as their base URL and
 * the slot's token, from the supervisor's environment, as their key. The VM has no provider's key.
 */
export function guestSettings(spec: Pick<GuestSpec, "models" | "providers">, gateway: Gateway): Record<string, unknown> {
  const providers = Object.fromEntries(Object.entries(spec.providers).map(([id, provider]) => {
    const { headers: _host, modelListURL: _list, ...rest } = provider;
    const guest: ProviderDefinition = { ...rest, baseURL: `${gateway.url}/v1/model/${id}`, apiKeyEnv: TOKEN_VARIABLE, apiKeyRequired: true,
      auth: provider.auth === "none" ? "bearer" : provider.auth, modelListProtocol: "none" };
    return [id, guest];
  }));
  return { version: 1, models: spec.models, providers, enabledProviders: Object.keys(providers) };
}

/** The worker's environment in the VM: the shims of its accounts, its ticket's variables and, with GitHub, its token. */
async function environment(spec: GuestSpec, gateway: Gateway): Promise<NodeJS.ProcessEnv> {
  const stateDir = join(homedir(), ".swarm", "guest");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  // Neither account's CLI runs in the VM: gh takes the token the gateway gives, and Feishu is the ticket tools' only.
  const deployment = { stateDir, github: undefined, feishu: undefined };
  writeEnvironment(deployment, spec.blockedCommands);
  if (spec.accounts === "none") return workerEnvironment(deployment, spec.variables, process.env, "none");
  const github = await callGateway<{ token: string; login: string; repository?: string }>(gateway, "GET", "/v1/github");
  // The worker runs gh and git with the token itself, as one that acts as its requester does on the host.
  return workerEnvironment(deployment, { ...spec.variables, GH_TOKEN: github.token, ...(github.repository ? { GH_REPO: github.repository } : {}) },
    process.env, "requester");
}

/** Prepares the ticket's new directory in the VM, as the executor prepares one on the host. */
async function prepare(spec: GuestSpec, gateway: Gateway, env: NodeJS.ProcessEnv): Promise<void> {
  const { directory } = spec;
  if (spec.clone) await cloneRepository(directory, spec.clone, `agent/${spec.name}`, env);
  else await prepareDirectory(directory, spec.prepare, env);
  if (!spec.from) return;
  const { patch } = await callGateway<{ patch: string }>(gateway, "GET", "/v1/takeover");
  const dir = mkdtempSync(join(tmpdir(), "swarm-takeover-"));
  try {
    writeFileSync(join(dir, "patch"), patch);
    await applyPatch(directory, join(dir, "patch"), env, spec.variables);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Flushes the guest's disks, so the host may power the VM off as soon as it hears the worker exited. */
const sync = (): Promise<void> => new Promise((resolve) => { spawn("sync", { stdio: "ignore" }).on("close", () => resolve()).on("error", () => resolve()); });

/** Runs the slot's ticket in this VM; `entry` starts Swarm again, for the worker. Returns the exit code of the supervisor. */
export async function runGuest(entry: readonly string[], log: (message: string) => void = (message) => process.stderr.write(`${message}\n`)): Promise<number> {
  const gateway = gatewayFromEnv();
  const spec = await callGateway<GuestSpec>(gateway, "GET", "/v1/spec");
  const exited = async (code: number | null, stderr: string): Promise<void> => {
    await sync();
    await callGateway(gateway, "POST", "/v1/work/exited", { code, stderr });
  };
  const paths = getSwarmPaths();
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  writeFileSync(paths.settingsPath, `${JSON.stringify(guestSettings(spec, gateway), null, 2)}\n`, { mode: 0o600 });
  let env: NodeJS.ProcessEnv;
  try {
    env = await environment(spec, gateway);
    if (!existsSync(spec.directory)) await prepare(spec, gateway, env);
  } catch (error) {
    // The ticket fails with why, as one does on the host whose directory cannot be prepared.
    const summary = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
    log(`swarm guest: ${summary}`);
    await callGateway(gateway, "POST", "/v1/work/report", { report: { state: "failed", summary } });
    await exited(0, "");
    return 0;
  }
  await callGateway(gateway, "POST", "/v1/work/started", { directory: spec.directory });
  const [program, ...prefix] = entry;
  const child = spawn(program!, [...prefix, "superagent", "worker", "--ticket", spec.ticketId, "--assignment", spec.assignmentId, "--gateway"], {
    cwd: spec.directory, stdio: ["ignore", "inherit", "pipe"],
    env: { ...env, [GATEWAY_VARIABLE]: gateway.url, [TOKEN_VARIABLE]: gateway.token, SWARM_TICKET_DIR: spec.directory,
      SWARM_PERMISSION_MODE: spec.permissionMode, SWARM_SHELL_AUTO_BACKGROUND_MS: String(WORKER_SHELL_AUTO_BACKGROUND_MS) }
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
    stderr = (stderr + chunk.toString("utf8")).slice(-4000);
  });
  const done = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
    child.on("error", (error) => { stderr += String(error); resolve(-1); });
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS).unref();
  };
  // The lease holds while the Assignment runs the ticket; once it does not, the worker stops. A gateway that does not
  // answer, as while the host restarts, is asked again at the next beat.
  const beat = setInterval(() => {
    void callGateway<{ live: boolean }>(gateway, "POST", "/v1/work/heartbeat").then(({ live }) => { if (!live) stop(); },
      (error: unknown) => log(`swarm guest: the heartbeat failed: ${error instanceof Error ? error.message : String(error)}`));
  }, HEARTBEAT_MS);
  const code = await done;
  clearInterval(beat);
  await exited(stopping ? 0 : code, stderr).catch((error: unknown) => log(`swarm guest: could not tell the gateway the worker exited: ${String(error)}`));
  return 0;
}
