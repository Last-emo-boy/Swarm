/**
 * Ticket VMs end to end, with no VM and no paid model: a real host with `executor.isolation` set to vm, whose VM control
 * starts the guest supervisor as a process instead of booting a VM, with a home of its own for each ticket as its data
 * disk and the slot's gateway and token as a VM gets them. The guest prepares the ticket's directory, its worker runs
 * Swarm's coding loop through the gateway's model proxy against a scripted model, and its ticket tools run on the host.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import type { SuperagentHost as Host } from "../host.js";
import { KV } from "../kv.js";
import { startFakeModel, writeFakeModelHome, type ModelRequest } from "../testing/fake-model.js";
import type { VmControl } from "./vm-work.js";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const home = mkdtempSync(join(tmpdir(), "swarm-vm-e2e-"));
const saved = { SWARM_HOME: process.env.SWARM_HOME, SWARM_SUPERAGENT_HOME: process.env.SWARM_SUPERAGENT_HOME };
const entry = [process.execPath, "--import", import.meta.resolve("tsx"), join(repo, "src/index.ts")];
const port = 41_000 + Math.floor(Math.random() * 8000);
let model: Awaited<ReturnType<typeof startFakeModel>>;
let host: Host;

/** What the fake VMs did: each boot with its slot and ticket, the stops, the collections, and the guests that run. */
const boots: { slot: number; ticketId: string }[] = [];
const stops: number[] = [];
let collections = 0;
const guests = new Map<number, ChildProcess>();
const guestLogs: string[] = [];

const control: VmControl = {
  start: async (slot) => {
    const dir = join(home, "superagent", "vm", String(slot));
    const ticketId = readFileSync(join(dir, "ticket"), "utf8").trim();
    boots.push({ slot, ticketId });
    // The ticket's data disk: its home, which outlives each boot.
    const disk = join(home, "disks", ticketId);
    mkdirSync(disk, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: disk, SWARM_HOME: join(disk, ".swarm"), SWARM_GUEST_GATEWAY: `http://127.0.0.1:${port + slot}`,
      SWARM_GUEST_TOKEN: readFileSync(join(dir, "token"), "utf8") };
    delete env.SWARM_SUPERAGENT_HOME;
    const child = spawn(entry[0]!, [...entry.slice(1), "superagent", "guest"], { cwd: disk, env, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.on("data", (chunk: Buffer) => { guestLogs.push(chunk.toString("utf8")); });
    guests.set(slot, child);
    child.on("exit", () => { if (guests.get(slot) === child) guests.delete(slot); });
  },
  stop: async (slot) => {
    stops.push(slot);
    // A VM powers off once its guest told the gateway its worker exited; this one is told to stop after that.
    const child = guests.get(slot);
    setTimeout(() => child?.kill("SIGTERM"), 2000).unref();
  },
  collect: async () => { collections += 1; }
};

const loop = (result: Record<string, unknown>) => JSON.stringify({ files_touched: [], next_actions: [], tool_calls: [], ...result });
const reported = (request: ModelRequest) => request.user.includes("\"reported\":true") || request.user.includes("\\\"reported\\\":true");

/** The router accepts both requests. The hello.txt worker writes, checks and reports; the config worker reports progress, then answers. */
function answer(request: ModelRequest): string {
  if (request.system.includes("You route requests for Swarm's ticket host")) {
    if (request.user.includes("config file")) {
      return JSON.stringify({ kind: "accept", title: "Rename the config file", worktree_name: "rename-config", acknowledgement: "On it: renaming the config file." });
    }
    return JSON.stringify({ kind: "accept", title: "Create hello.txt", worktree_name: "create-hello", acknowledgement: "On it: creating hello.txt." });
  }
  if (request.system.includes("rename-config-")) {
    if (!request.user.includes("ready for review")) {
      if (reported(request)) return loop({ status: "completed", summary: "Waiting for review", message: "Waiting for review." });
      return loop({ status: "continue", summary: "Progress", message: "Recording progress.", tool_calls: [
        { id: "progress", action: "mcp__ticket__report", inputs: { state: "progress", summary: "Renamed the config file; the PR waits for review." } }
      ] });
    }
    if (request.user.includes("Yes, it is ready")) return loop({ status: "completed", summary: "Answered", message: "Answered." });
    const asked = [...request.user.matchAll(/trigger_id\\?":\\?"([0-9a-f]{32})/g)].at(-1)?.[1] ?? "";
    return loop({ status: "continue", summary: "Answer", message: "Answering.", tool_calls: [
      { id: "ready", action: "mcp__ticket__report", inputs: { state: "ready", summary: "Renamed the config file; ready for review.", reply_to_trigger_id: asked, message_for_person: "Yes, it is ready for review." } }
    ] });
  }
  const trigger = /trigger_id\\?":\\?"([0-9a-f]{32})/.exec(request.user)?.[1] ?? "";
  if (!/"action":\s*"Write"[\s\S]*"status":\s*"success"/.test(request.user)) {
    return loop({ status: "continue", summary: "Write the file", message: "Writing hello.txt.", tool_calls: [
      { id: "ack", action: "mcp__ticket__ack", inputs: { trigger_id: trigger, text: "On it: writing hello.txt." } },
      { id: "write", action: "Write", inputs: { file_path: "hello.txt", content: "hi\n" } }
    ] });
  }
  if (!reported(request)) {
    return loop({ status: "continue", summary: "Verify and report", message: "Checking the file and reporting.", tool_calls: [
      { id: "check", action: "Bash", inputs: { command: "cat hello.txt; echo \"gh=$(command -v gh) token=${SWARM_GUEST_TOKEN:+set} key=${LOCAL_TEST_API_KEY:-none}\"" } },
      { id: "report", action: "mcp__ticket__report", inputs: { state: "ready", summary: "Wrote hello.txt; cat shows hi.", message_for_person: "hello.txt is ready." } }
    ] });
  }
  return loop({ status: "completed", summary: "Done", message: "hello.txt is written and reported.", files_touched: ["hello.txt"] });
}

before(async () => {
  process.env.SWARM_HOME = home;
  process.env.SWARM_SUPERAGENT_HOME = join(home, "superagent");
  model = await startFakeModel(answer);
  writeFakeModelHome(home, model.url);
  const { settingsPath, writeSettings } = await import("../settings.js");
  // Each ticket's directory is prepared once, on its data disk, which counts the preparations.
  writeSettings({ executor: { isolation: "vm", vm: { slots: 2, port }, prepare: 'echo prepared >> "$HOME/prepared"' } }, settingsPath(join(home, "superagent")));
  const { SuperagentHost } = await import("../host.js");
  const { OpenAIProvider } = await import("../../providers/openai-provider.js");
  const provider = new OpenAIProvider();
  host = new SuperagentHost({
    workerCommand: entry,
    complete: ({ purpose, system, user }) => provider.generateText({ model: provider.workerModel, system: [{ text: system }], user,
      responseFormat: "json_object", maxOutputTokens: 2000, usage: { purpose } }),
    log: () => {},
    vmControl: control
  });
  await host.start();
});
after(async () => {
  await host?.stop();
  for (const child of guests.values()) child.kill("SIGKILL");
  await model?.close();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

const until = async (done: () => boolean, ms = 100_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !done()) await new Promise((resolve) => setTimeout(resolve, 300));
};

test("a ticket's worker runs in its VM: prepared there, its model calls through the gateway, its tools and report on the host", { timeout: 150_000 }, async () => {
  const { client } = host;
  client.request("create hello.txt containing hi");
  const find = () => client.store.tickets.list().find((ticket) => ticket.title === "Create hello.txt");
  await until(() => !!find()?.ended);
  const ticket = find();
  assert.equal(ticket?.ended?.outcome, "completed", `ticket: ${JSON.stringify(ticket?.ended)} report: ${JSON.stringify(ticket?.assignments.at(-1)?.report)} guest: ${guestLogs.join("").slice(-3000)}`);
  assert.equal(readFileSync(join(ticket.execution!.directory, "hello.txt"), "utf8"), "hi\n");
  assert.equal(readFileSync(join(home, "disks", ticket.id, "prepared"), "utf8"), "prepared\n", "the guest prepared the directory with its own home");
  assert.deepEqual(boots.filter((boot) => boot.ticketId === ticket.id).map((boot) => boot.slot), [0]);
  // The worker's provider is the gateway, with the slot's token as its key; the host's key settings never reach it.
  const guestSettings = JSON.parse(readFileSync(join(home, "disks", ticket.id, ".swarm", "settings.json"), "utf8")) as { providers: Record<string, { baseURL: string; apiKeyEnv: string }> };
  assert.equal(guestSettings.providers["local-test"]?.baseURL, `http://127.0.0.1:${port}/v1/model/local-test`);
  assert.equal(guestSettings.providers["local-test"]?.apiKeyEnv, "SWARM_GUEST_TOKEN");
  const check = model.requests.find((request) => request.system.includes("create-hello-") && request.user.includes("gh="));
  assert.match(check?.user ?? "", /token=set key=none/);
  const replies = client.store.db.prepare("SELECT value FROM outbox ORDER BY rowid").all().map((row) => JSON.parse(String(row.value)) as { text: string });
  assert.ok(replies.some((reply) => reply.text === "hello.txt is ready."));
  // The slot let the ticket go, and the ended ticket's disk was handed to the deployment to delete.
  await until(() => collections > 0 && client.store.get(KV.vm.slot("0"))?.tokenHash === "", 20_000);
  const slot = client.store.get(KV.vm.slot("0"));
  assert.equal(slot?.ticketId, ticket.id);
  assert.equal(slot?.tokenHash, "");
  assert.ok(stops.includes(0));
  assert.ok(existsSync(join(home, "superagent", "vm", "ended", ticket.id)));
});

test("an idle ticket's VM powers off, and a person's message boots it again in the same slot with its directory kept", { timeout: 150_000 }, async () => {
  const { client } = host;
  client.request("rename the config file");
  const find = () => client.store.tickets.list().find((ticket) => ticket.title === "Rename the config file");
  await until(() => !!find()?.assignments.at(-1)?.idleAt && guests.size === 0);
  const ticketId = find()!.id;
  const first = boots.filter((boot) => boot.ticketId === ticketId);
  assert.equal(first.length, 1, `boots: ${JSON.stringify(boots)} guest: ${guestLogs.join("").slice(-3000)}`);
  client.message(ticketId, "is it ready for review?");
  await until(() => find()?.assignments.at(-1)?.report?.state === "ready");
  const ticket = find()!;
  assert.equal(ticket.assignments.at(-1)?.report?.state, "ready", `report: ${JSON.stringify(ticket.assignments.at(-1)?.report)} boots: ${JSON.stringify(boots)} guest: ${guestLogs.join("").slice(-3000)}`);
  const again = boots.filter((boot) => boot.ticketId === ticketId);
  assert.equal(again.length, 2);
  assert.equal(again[1]!.slot, again[0]!.slot, "the slot that ran it boots it again");
  assert.equal(readFileSync(join(home, "disks", ticketId, "prepared"), "utf8"), "prepared\n", "its directory was prepared once");
  const replies = client.store.db.prepare("SELECT value FROM outbox ORDER BY rowid").all().map((row) => JSON.parse(String(row.value)) as { text: string });
  assert.ok(replies.some((reply) => reply.text === "Yes, it is ready for review."));
});
