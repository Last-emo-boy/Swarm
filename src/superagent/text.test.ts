/** Chat text helpers (text.ts): cutting a message to fit, and taking a model's answer only when it can be used. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod/v4";
import { IM_WORDS, answerOf, cutToFit, noAnswer, orNull, wordCount } from "./text.js";

const Schema = z.object({ say: z.string().nullish(), count: z.number().default(0) });

test("takes a model's answer that fits, and asks once more when the first cannot be used", async () => {
  const answers = ["no object here", '{"say": "hi"}'];
  let calls = 0;
  const answer = await answerOf(Schema, async () => { calls += 1; return answers.shift()!; });
  assert.deepEqual(answer, { say: "hi", count: 0 }, "the schema's defaults are filled in");
  assert.equal(calls, 2);
  // An answer the schema refuses counts as unusable too; one wrapped in prose is read.
  const refused = ['{"say": 5}', 'Sure: {"say": null, "count": 2} done'];
  assert.deepEqual(await answerOf(Schema, async () => refused.shift()!), { say: null, count: 2 });
});

test("gives up after the second unusable answer rather than ask forever, and lets a failed call throw", async () => {
  let calls = 0;
  assert.equal(await answerOf(Schema, async () => { calls += 1; return "still not JSON"; }), undefined);
  assert.equal(calls, 2);
  await assert.rejects(answerOf(Schema, async () => { throw new Error("network down"); }), /network down/);
});

test("cuts a long message after its last whole sentence that fits", () => {
  const long = `${"这是一句完整的话。".repeat(60)}`;
  const cut = cutToFit(long, IM_WORDS);
  assert.ok(wordCount(cut) <= IM_WORDS, `${wordCount(cut)} words`);
  assert.match(cut, /。…$/);
});

test("reads null as the default a model leaves out, and still fills an absent key", () => {
  const Optional = z.object({ items: orNull(z.array(z.string()), []), text: orNull(z.string().max(5), "") });
  assert.deepEqual(Optional.parse({ items: null, text: null }), { items: [], text: "" });
  assert.deepEqual(Optional.parse({}), { items: [], text: "" });
  assert.deepEqual(Optional.parse({ items: ["a"], text: "hi" }), { items: ["a"], text: "hi" });
  assert.equal(Optional.safeParse({ text: "too long" }).success, false, "the schema's own checks still apply");
});

test("hears the last answer when it gives up, and nothing when an answer can be used", async () => {
  const heard: string[] = [];
  assert.equal(await answerOf(Schema, async () => "not json", 2, (answer) => heard.push(answer)), undefined);
  assert.deepEqual(heard, ["not json"]);
  assert.deepEqual(await answerOf(Schema, async () => '{"say": "hi"}', 2, (answer) => heard.push(answer)), { say: "hi", count: 0 });
  assert.deepEqual(heard, ["not json"]);
  // The trace names the purpose and the start of the last answer, and goes no further than 200 characters.
  const long = noAnswer("superagent_purpose", 2, `{"say": "${"x".repeat(300)}"}`);
  assert.match(long, /^superagent: no usable answer for superagent_purpose after 2 tries: \{"say": "xxx/);
  assert.equal([...long].length, "superagent: no usable answer for superagent_purpose after 2 tries: ".length + 200);
});
