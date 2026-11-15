/** Word counting and string helpers for chat message limits and templates (from dsh-superagent's infra/text.ts). */
import type { z } from "zod/v4";

const words = new Intl.Segmenter("zh", { granularity: "word" });
export const IM_WORDS = 100;
export const NOTE_WORDS = 30;

/** Counts word-like segments across Chinese, English, and mixed text, ignoring punctuation. */
export function wordCount(text: string): number {
  let count = 0;
  for (const segment of words.segment(text)) if (segment.isWordLike) count++;
  return count;
}

/** Validates that an outgoing chat message does not exceed `IM_WORDS` (link labels and URLs both count). */
export function checkedImText(text: string): string {
  const count = wordCount(text);
  if (count > IM_WORDS) {
    throw new Error(`Chat message has ${count} words; maximum is ${IM_WORDS}. Rewrite it as one short update; do not split it into several messages.`);
  }
  return text;
}

/**
 * A message still too long for a chat, cut after its last whole sentence that fits in `words`, so it still reaches the
 * person; a first sentence too long alone is cut where it fits.
 */
export function cutToFit(text: string, words: number): string {
  let kept = "";
  for (const sentence of text.split(/(?<=[。！？!?；;\n]|\.\s)/)) {
    if (wordCount(kept + sentence) > words - 1) break;
    kept += sentence;
  }
  if (!kept) {
    kept = text;
    while (kept && wordCount(kept) > words - 1) kept = kept.slice(0, Math.floor(kept.length * 0.9));
  }
  return `${kept.trim()}…`;
}

export const fill = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? "");
/** Case-insensitive comparison for GitHub logins and repository names. */
export const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whether a person writes Chinese: Han characters and no kana, which would make it Japanese. */
export const inChinese = (text: string): boolean => /\p{Script=Han}/u.test(text) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
/** Picks a message's English or Chinese wording. */
export type Say = (english: string, chinese: string) => string;
export const sayIn = (chinese: boolean): Say => (english, inChineseWords) => chinese ? inChineseWords : english;
/** The wording of a message to a person, in the language of what they wrote. */
export const wording = (written: string): Say => sayIn(inChinese(written));

/** The first JSON object in a model's answer. */
export function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const match = /\{[\s\S]*\}/.exec(text);
    if (!match) throw new Error("The model returned no JSON object");
    return JSON.parse(match[0]);
  }
}

/**
 * A model's answer that fits `schema`, asked once more when the first cannot be used: one with no JSON object in it, or
 * one the schema refuses, which a second try usually mends. Undefined when neither can be used, so its caller gives up
 * rather than pay for more. A call that fails, such as on the network, still throws.
 */
export async function answerOf<T>(schema: z.ZodType<T>, ask: () => Promise<string>, tries = 2): Promise<T | undefined> {
  for (let attempt = 0; attempt < tries; attempt++) {
    const answer = await ask();
    try {
      const parsed = schema.safeParse(parseJsonObject(answer));
      if (parsed.success) return parsed.data;
    } catch { /* The answer holds no JSON object. */ }
  }
  return undefined;
}
