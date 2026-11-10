/**
 * The supervisor in a ticket VM (`swarm superagent guest`): what the host's executor does for a worker here, done in the
 * VM for the ticket its slot runs. It reads the ticket's spec from its gateway, points Swarm's providers at the gateway's
 * model proxy with the slot's token as their key, prepares the ticket's directory once (the prepare command, a clone of its
 * requester's repository, the patch of a ticket it takes over), starts the worker, renews the slot's lease while it runs,
 * and tells the gateway when it exits. The VM powers off after it. A ticket on an OpenCode profile gets OpenCode's
 * configuration the same way: Swarm's providers at the gateway, with the slot's token as their key.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getSwarmPaths, type ProviderDefinition } from "../../config/settings.js";
import { workerEnvironment, writeEnvironment } from "../environment.js";
import { applyPatch, cloneRepository, prepareDirectory, WORKER_SHELL_AUTO_BACKGROUND_MS } from "../executor.js";
import { settingsPath, writeSettings } from "../settings.js";
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

/** A model reference as a provider and a model, with Swarm's default provider for one that names none. */
function modelOf(ref: string, models: GuestSpec["models"]): { provider: string; model: string } {
  const at = ref.indexOf("/");
  return at < 0 ? { provider: models.defaultProvider, model: ref } : { provider: ref.slice(0, at), model: ref.slice(at + 1) };
}

/**
 * OpenCode's configuration in the VM and its credentials: Swarm's chat-completions providers with the gateway's model proxy
 * as their base URL and the slot's token as their key, the worker's model as OpenCode's, and the profile's model too.
 * DeepSeek keeps OpenCode's own DeepSeek package, which passes reasoning back as DeepSeek's API asks of a call with tools;
 * other providers go through OpenCode's OpenAI-compatible one. The gateway relays only chat-completions streams.
 */
export function opencodeConfig(spec: Pick<GuestSpec, "providers" | "models" | "model" | "harness">, gateway: Gateway):
  { config: Record<string, unknown>; auth: Record<string, unknown> } {
  const model = modelOf(spec.model, spec.models);
  const protocol = spec.providers[model.provider]?.protocol;
  if (protocol !== "openai-chat-completions") {
    throw new Error(`OpenCode in a ticket VM calls its model through the gateway as chat completions, and ${spec.model} uses ${protocol ?? "no provider Swarm knows"}: set executor.model to a chat-completions model`);
  }
  const wanted = [model, ...spec.harness?.profile.model ? [modelOf(spec.harness.profile.model, spec.models)] : []];
  const providers = Object.entries(spec.providers).filter(([, provider]) => provider.protocol === "openai-chat-completions");
  const provider = Object.fromEntries(providers.map(([id, definition]) => [id, {
    ...id === "deepseek" ? {} : { npm: "@ai-sdk/openai-compatible", name: `${definition.name} through Swarm` },
    options: { baseURL: `${gateway.url}/v1/model/${id}`, includeUsage: true },
    models: Object.fromEntries(wanted.filter((item) => item.provider === id).map((item) => [item.model, { name: item.model }]))
  }]));
  return {
    config: { $schema: "https://opencode.ai/config.json", autoupdate: false, share: "disabled", model: `${model.provider}/${model.model}`, provider },
    auth: Object.fromEntries(providers.map(([id]) => [id, { type: "api", key: gateway.token }]))
  };
}

/** Writes OpenCode's configuration and credentials into the guest's home, and the ticket's profile into its superagent settings. */
function writeOpencode(spec: GuestSpec & { harness: NonNullable<GuestSpec["harness"]> }, gateway: Gateway): void {
  const { config, auth } = opencodeConfig(spec, gateway);
  const configDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
  const dataDir = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir, "opencode.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(dataDir, "auth.json"), `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  writeSettings({ executor: { harnesses: { [spec.harness.id]: spec.harness.profile } } }, settingsPath());
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
    if (spec.harness) writeOpencode({ ...spec, harness: spec.harness }, gateway);
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
