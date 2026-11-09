/**
 * People's own GitHub accounts, linked through the GitHub Source's GitHub App with the device flow: the user tokens it gives,
 * kept encrypted in the store under a key only the host reads, the repositories each person may work on through the app,
 * and their refresh. A ticket that writes to GitHub does so with its requester's token (see `Capability.credential`).
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod/v4";
import type { ActorRef, ChannelRef } from "./core/index.js";
import { KV } from "./kv.js";
import type { Settings } from "./settings.js";
import type { Store } from "./store.js";
import { sameName } from "./text.js";

/** The GitHub App people link their accounts with: its client id, for the device flow, and its slug. */
export const GithubAppSchema = z.object({ clientId: z.string().trim().min(1), slug: z.string().regex(/^[a-z0-9-]+$/) }).strict();
export type GithubApp = z.infer<typeof GithubAppSchema>;
/** The GitHub App the GitHub Source's settings name, if any. */
export const githubApp = (settings: Pick<Settings, "sources">): GithubApp | undefined =>
  GithubAppSchema.safeParse(settings.sources.github?.config.app).data;
export const installUrl = (app: GithubApp): string => `https://github.com/apps/${app.slug}/installations/new`;
/** Where people review and revoke the GitHub Apps they authorized. */
export const AUTHORIZATIONS_URL = "https://github.com/settings/apps/authorizations";

interface Sealed { iv: string; data: string; tag: string }
/** A person's linked GitHub account as the store keeps it. */
export interface GithubLink {
  login: string;
  id: number;
  /** The repositories (owner/name) where the app is installed and the person may push, when last read. */
  repos: string[];
  reposAt: string;
  /** The repository the person's tickets work on when their request names none. */
  defaultRepo?: string;
  /** Where the person linked, which hears when the link stops working. */
  channel?: ChannelRef;
  /** Why the link no longer works, such as a refresh token GitHub refused. */
  broken?: string;
  access: Sealed;
  accessExpiresAt?: string;
  refresh?: Sealed;
  refreshExpiresAt?: string;
  linkedAt: string;
}
/** A linked account as everyone may read it: without its tokens. */
export type LinkView = Omit<GithubLink, "access" | "refresh">;
type LinkStore = Pick<Store, "get" | "set" | "delete" | "keys">;

/**
 * The linked account a sender writes to GitHub with: the one they linked from their own Source, or, for someone writing on
 * GitHub, the account someone linked under that login.
 */
export function linkOf(store: LinkStore, actor: ActorRef): LinkView | undefined {
  const found = actor.source === "github"
    ? store.keys(KV.links.github).map((name) => store.get(name)).find((link) => !!link && sameName(link.login, actor.id))
    : store.get(KV.links.github(actor.source, actor.id));
  if (!found) return undefined;
  const { access: _access, refresh: _refresh, ...view } = found;
  return view;
}
/** The key a sender's link is stored under: their own, or, for a GitHub login, the account linked under it. */
function linkName(store: LinkStore, actor: ActorRef): ReturnType<typeof KV.links.github> | undefined {
  if (actor.source !== "github") return KV.links.github(actor.source, actor.id);
  return store.keys(KV.links.github).find((name) => sameName(store.get(name)?.login ?? "", actor.id));
}
const REPOSITORY = /(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)/g;
/** The first repository of `repos` that a request names, as owner/name or a github.com link. */
export function namedRepository(text: string, repos: readonly string[]): string | undefined {
  for (const match of text.matchAll(REPOSITORY)) {
    // A sentence's full stop and a clone URL's .git are not part of the name.
    const name = match[1]!.replace(/\.+$/, "").replace(/\.git$/, "");
    const found = repos.find((repo) => sameName(repo, name));
    if (found) return found;
  }
  return undefined;
}

/** The key that seals link tokens: `SWARM_LINK_KEY_FILE`, the host service's `link-key` credential, or one kept in the state directory. */
export function linkKey(stateDir: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  const file = env.SWARM_LINK_KEY_FILE || (env.CREDENTIALS_DIRECTORY ? join(env.CREDENTIALS_DIRECTORY, "link-key") : join(stateDir, "link-key"));
  if (!existsSync(file) && file === join(stateDir, "link-key")) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600, flag: "wx" });
  }
  const key = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
  if (key.length !== 32) throw new Error(`${file} must hold 32 bytes in base64`);
  return key;
}
/** AES-256-GCM, bound to the link and the token's kind so a sealed token cannot stand in for another. */
function seal(key: Buffer, text: string, aad: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), data: data.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}
function unseal(key: Buffer, sealed: Sealed, aad: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8");
}

const TokensSchema = z.object({
  access_token: z.string().min(1), expires_in: z.number().optional(),
  refresh_token: z.string().optional(), refresh_token_expires_in: z.number().optional()
});
type Tokens = z.infer<typeof TokensSchema>;
const DeviceSchema = z.object({ device_code: z.string(), user_code: z.string(), verification_uri: z.string(), expires_in: z.number(), interval: z.number() });
export type Device = z.infer<typeof DeviceSchema>;
/** A refresh GitHub refused for good: the link no longer works until its person links again. */
export class LinkBroken extends Error {}
/** A user token, the account it acts as, and the repository its ticket writes to. */
export interface Credential { token: string; login: string; id: number }
/** How long an access token must still be valid when a worker gets it, since a worker keeps the one it started with. */
export const TOKEN_MARGIN_MS = 2 * 3_600_000;
const MAX_REPO_PAGES = 10;

export interface GithubLinksOptions {
  store: LinkStore;
  /** The sealing key; read when a token is sealed or opened, so processes that only read links never need it. */
  key: () => Buffer;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Told when a link stops working, so its person hears of it. */
  broken?: (actor: ActorRef, link: LinkView) => void;
}

const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

/** The host's side of linked accounts: the device flow, tokens, refreshes and the repositories people may work on. */
export class GithubLinks {
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly refreshing = new Map<string, Promise<GithubLink>>();
  constructor(private readonly options: GithubLinksOptions) {
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private async post(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await this.fetch(url, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`GitHub answered ${response.status} to ${new URL(url).pathname}`);
    return await response.json() as Record<string, unknown>;
  }
  private async api<T>(token: string, path: string, schema: z.ZodType<T>): Promise<T> {
    const response = await this.fetch(`https://api.github.com${path}`, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28", "user-agent": "Swarm" } });
    if (!response.ok) throw new Error(`GitHub answered ${response.status} to ${path.split("?")[0]}`);
    return schema.parse(await response.json());
  }

  /** Starts the device flow: the code the person enters at `verification_uri`. */
  async start(app: GithubApp): Promise<Device> {
    return DeviceSchema.parse(await this.post("https://github.com/login/device/code", { client_id: app.clientId }));
  }
  /** Polls until the person entered the code, and returns their tokens; throws once the code expired or they declined. */
  async authorized(app: GithubApp, device: Device, signal?: AbortSignal): Promise<Tokens> {
    const sleep = this.options.sleep ?? wait;
    const deadline = this.now() + device.expires_in * 1000;
    let interval = device.interval;
    while (this.now() < deadline) {
      await sleep(interval * 1000, signal);
      const answer = await this.post("https://github.com/login/oauth/access_token",
        { client_id: app.clientId, device_code: device.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
      if (answer.error === "authorization_pending") continue;
      if (answer.error === "slow_down") { interval = typeof answer.interval === "number" ? answer.interval : interval + 5; continue; }
      if (answer.error === "expired_token") break;
      if (answer.error) throw new Error(answer.error === "access_denied" ? "the request was declined on GitHub" : `GitHub refused: ${String(answer.error)}`);
      return TokensSchema.parse(answer);
    }
    throw new Error("the code expired");
  }
  /** The account a token acts as. */
  identity(token: string): Promise<{ login: string; id: number }> {
    return this.api(token, "/user", z.looseObject({ login: z.string(), id: z.number() }));
  }
  /** The repositories where the app is installed and the token's account may push. */
  async repositories(token: string): Promise<string[]> {
    const { installations } = await this.api(token, "/user/installations?per_page=100", z.looseObject({ installations: z.array(z.looseObject({ id: z.number() })) }));
    const repos: string[] = [];
    for (const { id } of installations) {
      for (let page = 1; page <= MAX_REPO_PAGES; page++) {
        const listed = await this.api(token, `/user/installations/${id}/repositories?per_page=100&page=${page}`,
          z.looseObject({ repositories: z.array(z.looseObject({ full_name: z.string(), permissions: z.looseObject({ push: z.boolean().optional() }).optional() })) }));
        repos.push(...listed.repositories.filter((repo) => repo.permissions?.push).map((repo) => repo.full_name));
        if (listed.repositories.length < 100) break;
      }
    }
    return [...new Set(repos)].sort();
  }

  /** Links a sender's account with the tokens the device flow gave, replacing a link they had. */
  async link(actor: ActorRef, tokens: Tokens, channel?: ChannelRef): Promise<LinkView> {
    const { login, id } = await this.identity(tokens.access_token);
    const repos = await this.repositories(tokens.access_token);
    const name = KV.links.github(actor.source, actor.id);
    const before = this.options.store.get(name);
    const link: GithubLink = { login, id, repos, reposAt: this.iso(), ...this.sealed(name, tokens), linkedAt: this.iso(),
      ...(before?.defaultRepo && repos.includes(before.defaultRepo) ? { defaultRepo: before.defaultRepo } : {}), ...(channel ? { channel } : {}) };
    this.options.store.set(name, link);
    return linkOf(this.options.store, actor)!;
  }
  private iso(offsetMs = 0): string { return new Date(this.now() + offsetMs).toISOString(); }
  private sealed(name: string, tokens: Tokens): Pick<GithubLink, "access" | "accessExpiresAt" | "refresh" | "refreshExpiresAt"> {
    const key = this.options.key();
    return {
      access: seal(key, tokens.access_token, `${name}:access`),
      ...(tokens.expires_in ? { accessExpiresAt: this.iso(tokens.expires_in * 1000) } : {}),
      ...(tokens.refresh_token ? { refresh: seal(key, tokens.refresh_token, `${name}:refresh`) } : {}),
      ...(tokens.refresh_token_expires_in ? { refreshExpiresAt: this.iso(tokens.refresh_token_expires_in * 1000) } : {})
    };
  }

  /**
   * A sender's access token, valid for at least `TOKEN_MARGIN_MS`, refreshed when it is not; undefined without a working link.
   * Refreshes of one link run one at a time, since GitHub replaces both tokens on each.
   */
  async credential(app: GithubApp, actor: ActorRef): Promise<Credential | undefined> {
    const name = linkName(this.options.store, actor);
    let link = name && this.options.store.get(name);
    if (!name || !link || link.broken) return undefined;
    if (link.accessExpiresAt && Date.parse(link.accessExpiresAt) - this.now() < TOKEN_MARGIN_MS) {
      try {
        link = await this.refreshed(app, name, actor);
      } catch (error) {
        if (error instanceof LinkBroken) return undefined;
        throw error;
      }
    }
    return { token: unseal(this.options.key(), link.access, `${name}:access`), login: link.login, id: link.id };
  }
  private refreshed(app: GithubApp, name: string, actor: ActorRef): Promise<GithubLink> {
    let running = this.refreshing.get(name);
    if (!running) {
      running = this.refresh(app, name, actor).finally(() => this.refreshing.delete(name));
      this.refreshing.set(name, running);
    }
    return running;
  }
  private async refresh(app: GithubApp, name: string, actor: ActorRef): Promise<GithubLink> {
    const { store } = this.options;
    const link = store.get(name as ReturnType<typeof KV.links.github>)!;
    const expired = link.refreshExpiresAt && Date.parse(link.refreshExpiresAt) <= this.now();
    if (!link.refresh || expired) return this.break(name, actor, link, "its refresh token expired");
    const answer = await this.post("https://github.com/login/oauth/access_token",
      { client_id: app.clientId, grant_type: "refresh_token", refresh_token: unseal(this.options.key(), link.refresh, `${name}:refresh`) });
    if (answer.error === "bad_refresh_token") return this.break(name, actor, link, "GitHub refused its refresh token");
    if (answer.error) throw new Error(`GitHub refused the refresh: ${String(answer.error)}`);
    const next: GithubLink = { ...link, ...this.sealed(name, TokensSchema.parse(answer)) };
    store.set(name as ReturnType<typeof KV.links.github>, next);
    return next;
  }
  private break(name: string, actor: ActorRef, link: GithubLink, why: string): never {
    const broken = { ...link, broken: why };
    this.options.store.set(name as ReturnType<typeof KV.links.github>, broken);
    const { access: _access, refresh: _refresh, ...view } = broken;
    this.options.broken?.(actor, view);
    throw new LinkBroken(`${link.login}'s GitHub link stopped working: ${why}`);
  }

  /** Reads again which repositories a sender may work on, and keeps their default only while it is one of them. */
  async refreshRepos(app: GithubApp, actor: ActorRef): Promise<LinkView | undefined> {
    const credential = await this.credential(app, actor);
    const name = linkName(this.options.store, actor);
    const link = name && this.options.store.get(name);
    if (!credential || !name || !link) return undefined;
    const repos = await this.repositories(credential.token);
    const { defaultRepo, ...rest } = link;
    this.options.store.set(name, { ...rest, repos, reposAt: this.iso(), ...(defaultRepo && repos.includes(defaultRepo) ? { defaultRepo } : {}) });
    return linkOf(this.options.store, actor);
  }
  /** Sets the repository a sender's tickets work on when their request names none: one of their repositories, else undefined. */
  setDefault(actor: ActorRef, repository: string): LinkView | undefined {
    const name = linkName(this.options.store, actor);
    const link = name && this.options.store.get(name);
    const repo = link?.repos.find((item) => sameName(item, repository));
    if (!name || !link || !repo) return undefined;
    this.options.store.set(name, { ...link, defaultRepo: repo });
    return linkOf(this.options.store, actor);
  }
  /**
   * Removes a sender's link. A refresh first replaces the refresh token, whose successor is thrown away, so nothing kept
   * here works afterwards; the person revokes the app's access at `AUTHORIZATIONS_URL`.
   * @returns whether there was a link.
   */
  async unlink(app: GithubApp | undefined, actor: ActorRef): Promise<boolean> {
    const name = linkName(this.options.store, actor);
    const link = name && this.options.store.get(name);
    if (!name || !link) return false;
    if (app && link.refresh && !link.broken) await this.post("https://github.com/login/oauth/access_token",
      { client_id: app.clientId, grant_type: "refresh_token", refresh_token: unseal(this.options.key(), link.refresh, `${name}:refresh`) }).catch(() => undefined);
    this.options.store.delete(name);
    return true;
  }
}
