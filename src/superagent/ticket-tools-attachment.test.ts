/** The attachment ticket tool: a worker reads the files and images people attach on Feishu, downloaded by the host's bot CLI. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { SuperagentClient } from "./client.js";
import { Commands } from "./commands.js";
import { settingsPath, writeSettings } from "./settings.js";
import type { Deployment } from "./setup.js";
import { feishuTrigger } from "./sources/feishu.js";
import { ATTACHMENT_BYTES, TEXT_CHARS, feishuAttachments } from "./sources/feishu-attachment.js";
import { vi } from "./testing/expect.js";
import { ATTACHMENTS_DIR, proxiedTicketTools, ticketTools, withAttachments } from "./ticket-tools.js";

const CHAT = "oc_team";
let stateDir: string;
let client: SuperagentClient;
/** What the fake bot CLI holds: each attachment's bytes and the name Feishu gives it, by file key. */
let files: Map<string, { name: string; data: Buffer }>;
let downloads: { args: string[]; cwd: string | undefined }[];
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-attachment-tool-"));
  writeSettings({ sources: { feishu: { enabled: true, config: { cli: "lark-cli", chats: [{ chatId: CHAT, listen: "mentions" }], directMessages: true } } },
    policy: { sources: { feishu: { allowed: [{ id: "ou_owner" }] } } } }, settingsPath(stateDir));
  const deployment = { stateDir, repository: "", feishu: { cli: "lark-cli", appId: "cli_app", brand: "feishu", botId: "ou_bot", name: "w33d" } } as unknown as Deployment;
  client = new SuperagentClient({ stateDir, deployment: () => deployment });
  files = new Map();
  downloads = [];
  // The bot CLI saves the attachment in the directory it runs in, under Feishu's name for it, as lark-cli does.
  vi.spyOn(Commands.prototype, "lark").mockImplementation(async (args: string[], cwd?: string) => {
    downloads.push({ args, cwd });
    const file = files.get(args[args.indexOf("--file-key") + 1]!);
    if (args[1] !== "+messages-resources-download" || !file || !cwd) throw new Error(`unexpected lark ${args.join(" ")}`);
    writeFileSync(join(cwd, file.name), file.data);
    return { saved_path: file.name, size_bytes: file.data.length };
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  client.close();
  rmSync(stateDir, { recursive: true, force: true });
});

let n = 0;
function say(sender: string, content: string, extra: Record<string, unknown> = {}) {
  const trigger = feishuTrigger({ message_id: `om_${++n}`, chat_id: CHAT, chat_type: "group", sender_id: sender, sender_type: "user", content,
    create_time: String(Date.now() - 60_000 + n * 1000), mentions: [], ...extra }, "ou_bot", "cli_app")!;
  client.engine.receive(trigger);
  return trigger;
}
/** Someone posts a .docx, and the owner replies to it @-ing the bot "你看看", which starts a ticket on that message's thread. */
function docxTicket() {
  const posted = say("ou_wang", '<file key="file_v3_doc" name="周报.docx"/>');
  const asked = say("ou_owner", "@w33d 你看看", { parent_id: posted.meta.messageId, root_id: posted.meta.messageId,
    mentions: [{ id: "ou_bot", key: "@_user_1", name: "w33d" }] });
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(asked.id)!;
  const { ticketId } = client.engine.decide(asked.id, { kind: "accept", title: "Read the report", scope: "x", reason: "asked", name: "read-report", evalId: candidate.evalId });
  const tools = ticketTools(client, ticketId!);
  return { posted, asked, ticketId: ticketId!, tools, run: (args: Record<string, unknown>) => tools.find((tool) => tool.name === "attachment")!.run(args) };
}

/** A zip archive of `entries`, deflated as Word saves a .docx. */
function zip(entries: Record<string, string>): Buffer {
  const parts: Buffer[] = [], directory: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text), data = deflateRawSync(raw), path = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(path.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(path.length, 28); central.writeUInt32LE(offset, 42);
    parts.push(local, path, data);
    directory.push(central, path);
    offset += 30 + path.length + data.length;
  }
  const listed = Buffer.concat(directory), end = Buffer.alloc(22), count = Object.keys(entries).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(listed.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, listed, end]);
}
const DOCUMENT = '<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>本周进展</w:t></w:r></w:p>'
  + '<w:p><w:r><w:t xml:space="preserve">完成 A &amp; B</w:t><w:tab/><w:t>100%</w:t></w:r></w:p></w:body></w:document>';

test("finds the files and images a message holds, as lark-cli renders them and as Feishu's own content keeps them", () => {
  assert.deepEqual(feishuAttachments('看看 <file key="file_v3_a" name="a b.pdf"/> 和 ![Image](img_v3_x) 还有 [Image: img_v3_y] ![Image](img_v3_x)'), [
    { file_key: "file_v3_a", type: "file", name: "a b.pdf" }, { file_key: "img_v3_x", type: "image" }, { file_key: "img_v3_y", type: "image" }]);
  assert.deepEqual(feishuAttachments('<audio key="file_v3_voice" duration="3s"/><video key="file_v3_clip" name="clip.mp4"/>'), [
    { file_key: "file_v3_voice", type: "file" }, { file_key: "file_v3_clip", type: "file", name: "clip.mp4" }]);
  // The chat's history keeps Feishu's JSON content: a file, an image, and a post's elements (a video's image_key is its cover).
  assert.deepEqual(feishuAttachments('{"file_key":"file_v3_b","file_name":"b.csv"}'), [{ file_key: "file_v3_b", type: "file", name: "b.csv" }]);
  assert.deepEqual(feishuAttachments('{"image_key":"img_v3_c"}'), [{ file_key: "img_v3_c", type: "image" }]);
  assert.deepEqual(feishuAttachments(JSON.stringify({ title: "", content: [[{ tag: "text", text: "图" }, { tag: "img", image_key: "img_v3_d" }],
    [{ tag: "media", file_key: "file_v3_e", image_key: "img_v3_cover" }]] })), [{ file_key: "img_v3_d", type: "image" }, { file_key: "file_v3_e", type: "file" }]);
  assert.deepEqual(feishuAttachments("no attachment, just text about img_v3 keys"), []);
});

test("a worker lists a message's attachments and reads a .docx's text, which its own tools save into its directory", async () => {
  const { posted, asked, run, tools } = docxTicket();
  assert.deepEqual(await run({ trigger_id: posted.id }), { trigger_id: posted.id, attachments: [{ file_key: "file_v3_doc", type: "file", name: "周报.docx" }] });
  assert.deepEqual(await run({ trigger_id: asked.id }), { trigger_id: asked.id, attachments: [], note: "This message has no file or image" });
  assert.equal(downloads.length, 0, "listing reads the stored message only");
  const docx = zip({ "[Content_Types].xml": "<Types/>", "word/document.xml": DOCUMENT });
  files.set("file_v3_doc", { name: "周报.docx", data: docx });
  const read = await run({ trigger_id: posted.id, file_key: "file_v3_doc" }) as Record<string, unknown>;
  assert.deepEqual(downloads[0]!.args, ["im", "+messages-resources-download", "--message-id", posted.meta.messageId, "--file-key", "file_v3_doc", "--type", "file"]);
  assert.equal(existsSync(downloads[0]!.cwd!), false, "the host deletes its download");
  assert.deepEqual({ ...read, base64: undefined }, { trigger_id: posted.id, file_key: "file_v3_doc", type: "file", name: "周报.docx", format: "docx",
    bytes: docx.length, text: "本周进展\n完成 A & B\t100%", base64: undefined });
  assert.deepEqual(Buffer.from(String(read.base64), "base64"), docx);
  // The worker's ticket tools, wherever they run, save the bytes into its directory and give its model the path instead.
  const directory = join(stateDir, "work");
  const saved = await withAttachments(tools, directory).find((tool) => tool.name === "attachment")!.run({ trigger_id: posted.id, file_key: "file_v3_doc" }) as Record<string, unknown>;
  assert.equal(saved.base64, undefined);
  assert.equal(saved.saved_to, join(directory, ATTACHMENTS_DIR, "file_v3_doc", "周报.docx"));
  assert.deepEqual(readFileSync(String(saved.saved_to)), docx);
  assert.equal(readFileSync(join(directory, ATTACHMENTS_DIR, ".gitignore"), "utf8"), "*\n");
  assert.ok(proxiedTicketTools(async () => ({})).some((tool) => tool.name === "attachment"), "workers in VMs and on paired nodes get it too, run by the host");
});

test("a worker reads an image's bytes and long text cut with what was left out", async () => {
  const { posted, run } = docxTicket();
  const shot = say("ou_wang", "截图 ![Image](img_v3_shot) 和日志 <file key=\"file_v3_log\" name=\"run.log\"/>", { parent_id: posted.meta.messageId, root_id: posted.meta.messageId });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  files.set("img_v3_shot", { name: "img_v3_shot.png", data: png });
  files.set("file_v3_log", { name: "run.log", data: Buffer.from("x".repeat(TEXT_CHARS + 5)) });
  const image = await run({ trigger_id: shot.id, file_key: "img_v3_shot" }) as Record<string, unknown>;
  assert.deepEqual(downloads.at(-1)!.args.slice(-2), ["--type", "image"]);
  assert.deepEqual([image.name, image.format, image.bytes, image.text, Buffer.from(String(image.base64), "base64").equals(png)], ["img_v3_shot.png", "png", 12, undefined, true]);
  assert.match(String(image.note), /only if your model takes images/);
  const log = await run({ trigger_id: shot.id, file_key: "file_v3_log" }) as Record<string, unknown>;
  assert.equal(String(log.text).length, TEXT_CHARS);
  assert.equal(log.text_note, `The first ${TEXT_CHARS} of ${TEXT_CHARS + 5} characters: 5 were left out.`);
});

test("a worker reads only keys in a message its ticket can read, and nothing larger than the host downloads", async () => {
  const { posted, run } = docxTicket();
  await assert.rejects(run({ trigger_id: posted.id, file_key: "file_v3_other" }), /file_v3_other is not attached to this message/);
  // Another conversation's file never reached this ticket.
  const elsewhere = say("ou_wang", '<file key="file_v3_secret" name="salaries.xlsx"/>');
  files.set("file_v3_secret", { name: "salaries.xlsx", data: Buffer.from("x") });
  await assert.rejects(run({ trigger_id: elsewhere.id }), /did not reach this ticket/);
  await assert.rejects(run({ trigger_id: elsewhere.id, file_key: "file_v3_secret" }), /did not reach this ticket/);
  assert.equal(downloads.length, 0);
  files.set("file_v3_doc", { name: "周报.docx", data: Buffer.alloc(ATTACHMENT_BYTES + 1024 * 1024) });
  await assert.rejects(run({ trigger_id: posted.id, file_key: "file_v3_doc" }), /is 21\.0 MB, more than the 20\.0 MB the host downloads/);
  assert.equal(existsSync(downloads[0]!.cwd!), false, "a refused download is deleted too");
});
