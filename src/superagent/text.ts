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
