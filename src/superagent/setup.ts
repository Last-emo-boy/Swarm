/**
 * Deployment resolution: which repository the GitHub Source watches and which accounts the agent acts as, verified by
 * probing the configured CLIs (from dsh-superagent's deployment.ts and setup.ts). GitHub is optional in Swarm: without it,
 * tickets come from the Swarm TUI and Feishu only.
 */
import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod/v4";
import { fill } from "./text.js";

const exec = promisify(execFile);

export type SetupPlace = "deployment" | "github" | "feishu";
export const SETUP_PROBLEMS = {
  foreignFile: ["deployment", "{file} was not written by the Swarm superagent; move it, or choose another state directory."],
  gitTooOld: ["deployment", "git does not read the github.com credential configuration the superagent writes; it needs git 2.32 or later."],
  environmentFailed: ["deployment", "Preparing the agent environment failed."],
  repositoryUnset: ["github", "The GitHub Source names no repository."],
  agentCliUnset: ["github", "The agent GitHub CLI is not set."],
  agentCliMissing: ["github", "The agent GitHub CLI was not found."],
  agentCliSignedOut: ["github", "The agent GitHub CLI cannot read its account."],
  agentCliNoAccount: ["github", "The agent GitHub CLI did not report a GitHub account."],
  repositoryUnreadable: ["github", "@{account} cannot read {repository}."],
  repositoryUnreported: ["github", "The agent GitHub CLI did not return {repository}."],
  repositoryReadOnly: ["github", "@{account} cannot push to {repository}."],
  feishuCliFailed: ["feishu", "The bot lark-cli does not work."],
  feishuNoApp: ["feishu", "auth status of the bot lark-cli did not report the app."],
  feishuBotNotReady: ["feishu", "The bot identity of app {app} is {status}; configure the app secret with lark-cli."],
  feishuUserIdentity: ["feishu", "The bot lark-cli allows user identities (strict mode {mode}); give the bot its own lark-cli configuration in strict mode bot."],
  feishuNoBot: ["feishu", "The Feishu bot API did not return the bot's open_id."]
} as const satisfies Record<string, readonly [SetupPlace, string]>;
export type SetupCode = keyof typeof SETUP_PROBLEMS;
export interface SetupProblem { place: SetupPlace; code: SetupCode; values: Record<string, string>; detail: string }

/** A failed deployment or account check, with the place in the settings where the operator can fix it. */
export class SetupError extends Error {
  readonly place: SetupPlace;
  constructor(readonly code: SetupCode, readonly values: Record<string, string> = {}) {
    const [place, text] = SETUP_PROBLEMS[code];
    const sentence = fill(text, values);
    super(values.output ? `${sentence}\n${values.output}` : sentence);
    this.place = place;
  }
  get problem(): SetupProblem { return { place: this.place, code: this.code, values: this.values, detail: this.message }; }
}

export interface Machine {
  stateDir: string;
  /** Pages of thread context one assessment may read. */
  admissionContextMaxPages: number;
  /** Time limit of one context read during an assessment, in milliseconds. */
  admissionContextTimeoutMs: number;
}
export interface GithubAccount { cli: string; login: string; noreply: string }
export interface FeishuBot { cli: string; appId: string; brand: "feishu" | "lark"; botId: string; name: string }
/** The resolved deployment: `repository` and `github` only when the GitHub Source is set up, `feishu` only with a working bot. */
export interface Deployment extends Machine {
  repository: string;
  github?: GithubAccount;
  feishu?: FeishuBot;
}
export const defaultMachine = (stateDir: string): Machine => ({ stateDir, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15_000 });

/** The deployment's GitHub account; throws while the GitHub Source is not set up. */
export function githubAccount(deployment: Pick<Deployment, "github">): GithubAccount {
  if (!deployment.github) throw new Error("The GitHub Source is not set up");
  return deployment.github;
}

export const GithubAccountsSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, "owner/name").default(""),
  cli: z.string().trim().default("")
});
export const FeishuBotSchema = z.object({ cli: z.string().trim().default("") });
/** Source configuration keys setup reads; a change to one makes the host resolve the deployment again. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = { github: ["repository", "cli"], feishu: ["cli"] };

/** Resolve a command name or absolute path to an executable file, skipping `exclude` (the worker shim directory). */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes("/") && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`);
  const candidates = isAbsolute(name)
    ? [name]
    : path.split(delimiter).filter((dir) => isAbsolute(dir) && dir !== exclude).map((dir) => join(dir, name));
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // Not an executable file here; try the next PATH directory.
    }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? "" : " on PATH"}`);
}

export type Probe = (argv: string[]) => Promise<string>;
/** Runs a setup check with a time limit, in `cwd`, under `env`. */
export function commandProbe(cwd: string, env: NodeJS.ProcessEnv = process.env): Probe {
  return async (argv) => {
    const [program, ...args] = argv;
    const { stdout } = await exec(program!, args, { cwd, env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  };
}

const reason = (error: unknown): string => {
  const stderr = (error as { stderr?: unknown } | undefined)?.stderr;
  return typeof stderr === "string" && stderr.trim() ? stderr.trim().slice(0, 1000) : error instanceof Error ? error.message : String(error);
};
const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() });
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() });
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
}

/**
 * Verify the agent's GitHub CLI identity and push access to the configured repository; returns undefined while the GitHub
 * Source names neither a repository nor a CLI (GitHub not used).
 */
export async function resolveGithub(github: unknown, probe: Probe, exclude?: string, path = process.env.PATH ?? ""):
  Promise<{ repository: string; github: GithubAccount } | undefined> {
  const accounts = GithubAccountsSchema.parse(github ?? {});
  if (!accounts.repository && !accounts.cli) return undefined;
  if (!accounts.repository) throw new SetupError("repositoryUnset");
  if (!accounts.cli) throw new SetupError("agentCliUnset");
  let cli: string;
  try { cli = executable(accounts.cli, path, exclude); } catch (error) { throw new SetupError("agentCliMissing", { output: reason(error) }); }
  const text = await probe([cli, "api", "user"]).catch((error: unknown) => { throw new SetupError("agentCliSignedOut", { output: reason(error) }); });
  const agent = parsed(GithubUser, text);
  if (!agent) throw new SetupError("agentCliNoAccount");
  const access = parsed(RepositoryAccess, await probe([cli, "api", `repos/${accounts.repository}`, "--jq", "{name: .full_name, push: .permissions.push}"])
    .catch((error: unknown) => {
      throw new SetupError("repositoryUnreadable", { account: agent.login, repository: accounts.repository, output: reason(error) });
    }));
  if (!access) throw new SetupError("repositoryUnreported", { repository: accounts.repository });
  // The canonical name GitHub returns, so renamed repositories match incoming notifications.
  if (access.push !== true) throw new SetupError("repositoryReadOnly", { account: agent.login, repository: access.name });
  return { repository: access.name, github: { cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` } };
}

const AuthStatus = z.object({
  appId: z.string().regex(/^cli_[A-Za-z0-9]+$/),
  brand: z.enum(["feishu", "lark"]).default("feishu"),
  identities: z.object({ bot: z.object({ status: z.string() }) })
});
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default("") }) });
/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`. Workers invoke this
 * CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(feishu: unknown, probe: Probe, exclude?: string, path = process.env.PATH ?? ""): Promise<FeishuBot | undefined> {
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {});
  if (!name) return undefined;
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError("feishuCliFailed", { output: reason(error) }); };
  let cli = "";
  try { cli = executable(name, path, exclude); } catch (error) { fail(error); }
  const run = (...args: string[]): Promise<string> =>
    probe(["env", "LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1", "LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1", cli, ...args]).catch(fail);
  const text = await run("auth", "status");
  const status = parsed(AuthStatus, text.slice(text.indexOf("{")));
  if (!status) return fail(new SetupError("feishuNoApp"));
  if (status.identities.bot.status !== "ready") fail(new SetupError("feishuBotNotReady", { app: status.appId, status: status.identities.bot.status }));
  const mode = /strict-mode:\s*(\w+)/.exec(await run("config", "strict-mode"))?.[1];
  if (mode !== "bot") fail(new SetupError("feishuUserIdentity", { mode: mode ?? "unknown" }));
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(BotInfo, (await run("api", "GET", "/open-apis/bot/v3/info", "--as", "bot", "--format", "ndjson")).split("\n")[0] ?? "");
  if (!info) return fail(new SetupError("feishuNoBot"));
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name };
}
