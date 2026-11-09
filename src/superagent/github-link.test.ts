import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "./testing/expect.js";
import { GithubLinks, TOKEN_MARGIN_MS, linkKey, linkOf, namedRepository, type GithubApp } from "./github-link.js";
import { KV } from "./kv.js";
import { Store } from "./store.js";

const app: GithubApp = { clientId: "Iv23client", slug: "swarm-oauth" };
const ALICE = { source: "feishu", id: "ou_alice" };
const HOUR = 3_600_000;
let dir: string;
let store: Store;
let now: number;
let calls: { url: string; body?: Record<string, string>; token?: string }[];
/** GitHub's answers by path; a function answers from the request's body. */
let answers: Record<string, unknown | ((body: Record<string, string>) => unknown)>;
const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : undefined;
  const token = (init?.headers as Record<string, string> | undefined)?.authorization?.replace("Bearer ", "");
  calls.push({ url, ...(body ? { body } : {}), ...(token ? { token } : {}) });
  const path = new URL(url).pathname;
  const answer = answers[path];
  if (answer === undefined) return new Response("not found", { status: 404 });
  return Response.json(typeof answer === "function" ? (answer as (body: Record<string, string>) => unknown)(body ?? {}) : answer);
};
const links = (broken?: (actor: unknown) => void) => new GithubLinks({ store, key: () => linkKey(dir), fetch: fakeFetch, now: () => now,
  sleep: async (ms) => { now += ms; }, ...(broken ? { broken } : {}) });
const github = {
  "/user": { login: "alice-gh", id: 7 },
  "/user/installations": { installations: [{ id: 1 }, { id: 2 }] },
  "/user/installations/1/repositories": { repositories: [{ full_name: "alice-gh/tool", permissions: { push: true } }, { full_name: "org/read", permissions: { push: false } }] },
  "/user/installations/2/repositories": { repositories: [{ full_name: "owner/watched", permissions: { push: true } }] }
};
const tokens = (n: number) => ({ access_token: `ghu_${n}`, expires_in: 8 * 3600, refresh_token: `ghr_${n}`, refresh_token_expires_in: 180 * 86_400 });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "swarm-github-link-"));
  store = new Store(join(dir, "superagent.db"));
  now = Date.parse("2026-11-09T10:00:00Z");
  calls = [];
  answers = { ...github };
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("linking", () => {
  it("runs the device flow until the person enters the code, slowing down when GitHub asks", async () => {
    let polls = 0;
    answers["/login/device/code"] = { device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 };
    answers["/login/oauth/access_token"] = () => ++polls === 1 ? { error: "authorization_pending" } : polls === 2 ? { error: "slow_down", interval: 10 } : tokens(1);
    const device = await links().start(app);
    expect(device.user_code).toBe("ABCD-1234");
    const started = now;
    expect(await links().authorized(app, device)).toMatchObject({ access_token: "ghu_1" });
    expect(now - started).toBe((5 + 5 + 10) * 1000);
    expect(calls.at(-1)!.body).toEqual({ client_id: app.clientId, device_code: "dc", grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
  });
  it("gives up once the code expires or the person declines", async () => {
    const device = { device_code: "dc", user_code: "X", verification_uri: "u", expires_in: 12, interval: 5 };
    answers["/login/oauth/access_token"] = { error: "authorization_pending" };
    await expect(links().authorized(app, device)).rejects.toThrow("the code expired");
    answers["/login/oauth/access_token"] = { error: "access_denied" };
    await expect(links().authorized(app, device)).rejects.toThrow("declined");
  });
  it("keeps the account, the repositories it may push to through the app, and its tokens sealed", async () => {
    const link = await links().link(ALICE, tokens(1), { source: "feishu", thread: "feishu:oc_dm", address: { chatId: "oc_dm", messageId: "om_1" } });
    expect(link).toMatchObject({ login: "alice-gh", id: 7, repos: ["alice-gh/tool", "owner/watched"], channel: { address: { messageId: "om_1" } } });
    expect(link).not.toHaveProperty("access");
    expect(JSON.stringify(store.get(KV.links.github("feishu", "ou_alice")))).not.toContain("ghu_1");
    expect(JSON.stringify(store.get(KV.links.github("feishu", "ou_alice")))).not.toContain("ghr_1");
    expect(linkOf(store, ALICE)?.login).toBe("alice-gh");
    // Someone writing on GitHub as the linked login uses the same link.
    expect(linkOf(store, { source: "github", id: "Alice-GH" })?.id).toBe(7);
    expect(linkOf(store, { source: "feishu", id: "ou_bob" })).toBeUndefined();
    expect(await links().credential(app, ALICE)).toEqual({ token: "ghu_1", login: "alice-gh", id: 7 });
  });
  it("seals tokens under the key, which another key cannot open", async () => {
    await links().link(ALICE, tokens(1));
    writeFileSync(join(dir, "other-key"), `${Buffer.alloc(32, 1).toString("base64")}\n`);
    const other = new GithubLinks({ store, key: () => linkKey(dir, { SWARM_LINK_KEY_FILE: join(dir, "other-key") }), fetch: fakeFetch, now: () => now });
    await expect(other.credential(app, ALICE)).rejects.toThrow();
    expect(readFileSync(join(dir, "link-key"), "utf8").trim()).toHaveLength(44);
  });
});

describe("tokens", () => {
  it("refreshes a token that would expire within the margin, once for callers at the same time, and keeps the new pair", async () => {
    await links().link(ALICE, tokens(1));
    now += 8 * HOUR - TOKEN_MARGIN_MS + 1000;
    let refreshes = 0;
    answers["/login/oauth/access_token"] = (body: Record<string, string>) => { refreshes++; expect(body).toEqual({ client_id: app.clientId, grant_type: "refresh_token", refresh_token: "ghr_1" }); return tokens(2); };
    const shared = links();
    const [first, second] = await Promise.all([shared.credential(app, ALICE), shared.credential(app, ALICE)]);
    expect([first?.token, second?.token, refreshes]).toEqual(["ghu_2", "ghu_2", 1]);
    expect((await links().credential(app, ALICE))?.token).toBe("ghu_2");
  });
  it("marks a link broken when GitHub refuses its refresh token, tells its person once, and gives no token", async () => {
    await links().link(ALICE, tokens(1));
    now += 8 * HOUR;
    answers["/login/oauth/access_token"] = { error: "bad_refresh_token" };
    const told: unknown[] = [];
    expect(await links((actor) => told.push(actor)).credential(app, ALICE)).toBeUndefined();
    expect(told).toEqual([ALICE]);
    expect(linkOf(store, ALICE)?.broken).toBe("GitHub refused its refresh token");
    expect(await links((actor) => told.push(actor)).credential(app, ALICE)).toBeUndefined();
    expect(told).toHaveLength(1);
  });
  it("reads the repositories again, keeps a default only while it is one of them, and refuses another", async () => {
    await links().link(ALICE, tokens(1));
    expect(links().setDefault(ALICE, "ALICE-GH/tool")?.defaultRepo).toBe("alice-gh/tool");
    expect(links().setDefault(ALICE, "org/read")).toBeUndefined();
    answers["/user/installations"] = { installations: [{ id: 2 }] };
    expect(await links().refreshRepos(app, ALICE)).toMatchObject({ repos: ["owner/watched"] });
    expect(linkOf(store, ALICE)).not.toHaveProperty("defaultRepo");
  });
  it("unlinks after spending the refresh token, so nothing kept here works afterwards", async () => {
    await links().link(ALICE, tokens(1));
    answers["/login/oauth/access_token"] = tokens(2);
    expect(await links().unlink(app, ALICE)).toBe(true);
    expect(calls.at(-1)!.body).toMatchObject({ grant_type: "refresh_token", refresh_token: "ghr_1" });
    expect(linkOf(store, ALICE)).toBeUndefined();
    expect(await links().unlink(app, ALICE)).toBe(false);
  });
});

it("finds the repository a request names among a person's own, as owner/name or a GitHub link", () => {
  const repos = ["alice-gh/tool", "owner/watched"];
  expect(namedRepository("fix the README in https://github.com/Alice-GH/tool/blob/main/README.md", repos)).toBe("alice-gh/tool");
  expect(namedRepository("in owner/watched, rename the flag.", repos)).toBe("owner/watched");
  expect(namedRepository("clone https://github.com/owner/watched.git.", repos)).toBe("owner/watched");
  expect(namedRepository("see src/index.ts and other/repo", repos)).toBeUndefined();
});
