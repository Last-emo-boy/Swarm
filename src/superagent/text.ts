/** Word counting and string helpers for chat message limits and templates (from dsh-superagent's infra/text.ts). */
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
