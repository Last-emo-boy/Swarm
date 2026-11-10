/** Ticket tools that read the host's records of people and chats (people.ts), which work wherever the worker runs. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { SuperagentClient } from "./client.js";
import { KV } from "./kv.js";
import { noticed, readMembers } from "./people.js";
import { feishuTrigger } from "./sources/feishu.js";
import { proxiedTicketTools, ticketTools } from "./ticket-tools.js";

let stateDir: string;
let client: SuperagentClient;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-ticket-tools-"));
  client = new SuperagentClient({ stateDir });
});
afterEach(() => {
  client.close();
  rmSync(stateDir, { recursive: true, force: true });
});

test("a worker reads who is who and a group's latest messages from the host's records, but nobody else's direct messages", async () => {
  const { triggerId } = client.request("summarize what the team said about the release");
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(triggerId)!;
  const { ticketId } = client.engine.decide(triggerId, { kind: "accept", title: "Summarize", scope: "x", reason: "asked", name: "summarize", evalId: candidate.evalId });
  client.store.set(KV.sources.labels("feishu"), { oc_team: "Team" });
  client.store.set(KV.feishu.chats, { oc_team: false, oc_dm: true });
  await readMembers(async () => ({ users: [{ member_id: "ou_alice", name: "Alice" }, { member_id: "ou_bob", name: "Bob" }],
    bots: [{ member_id: "ou_tickey", app_id: "cli_tickey", name: "Tickey" }] }), client.store, "oc_team");
  await readMembers(async () => ({ users: [{ member_id: "ou_carol", name: "Carol" }] }), client.store, "oc_dm");
  client.engine.receive(noticed(client.store, feishuTrigger({ message_id: "om_1", chat_id: "oc_team", chat_type: "group", sender_id: "ou_alice",
    sender_type: "user", content: "ship it on Friday", create_time: String(Date.now() - 60_000), mentions: [] }, "ou_bot", "cli_bot")!));
  const tools = ticketTools(client, ticketId!);
  const run = (name: string, args: Record<string, unknown>) => tools.find((tool) => tool.name === name)!.run(args);
  const page = await run("read", { resource: "chat/oc_team", offset: 0 }) as { text: string };
  const read = JSON.parse(page.text) as { name: string; messages: { from: string; text: string }[] };
  assert.equal(read.name, "Team");
  assert.deepEqual(read.messages.map((line) => [line.from, line.text]), [["Alice", "ship it on Friday"]]);
  await assert.rejects(run("read", { resource: "chat/oc_dm", offset: 0 }), /another person's direct messages/);
  assert.deepEqual(await run("people", {}), { chats: [{ chat_id: "oc_team", name: "Team", people: 3 }, { chat_id: "oc_dm", name: "Carol", direct: true, people: 1 }] });
  assert.deepEqual(await run("people", { chat: "oc_team" }), { chat: "oc_team", name: "Team",
    people: [{ id: "ou_alice", name: "Alice" }, { id: "ou_bob", name: "Bob" }, { id: "ou_tickey", name: "Tickey", bot: true }] });
  assert.deepEqual(await run("people", { name: "bob" }), { people: [{ id: "ou_bob", name: "Bob", chats: ["Team"] }] });
  // Workers in VMs and on paired nodes get the same tool, run by the host.
  assert.ok(proxiedTicketTools(async () => ({})).some((tool) => tool.name === "people" && tool.readOnly));
});
