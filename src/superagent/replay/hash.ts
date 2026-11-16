/**
 * The hashes a model call records for its card, rebuilt the way the provider builds them (providers/openai-provider.ts):
 * the system and user texts trimmed and sha256'd, and one hash per section. A replay case compares its run's hashes with
 * the recorded ones to tell whether the card the agent sends today is byte-identical to the one it sent then.
 */
import { createHash } from "node:crypto";

export const stableHash = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The sections a card's blocks can belong to, in the provider's order. */
export const CARD_SECTIONS = ["system", "tools", "workspace", "task", "context", "volatile_footer"] as const;
export type CardSection = typeof CARD_SECTIONS[number];

/**
 * What the provider records for a call whose whole system prompt is one cacheable block and whose user text is one block:
 * `systemHash` over the trimmed system, `userHash` over the trimmed user, and section hashes for `system` and `task`.
 */
export function cardHashes(system: string, user: string): { systemHash: string; userHash: string; sectionHashes: Record<string, string> } {
  const systemText = system.trim();
  const userText = user.trim();
  const systemHash = stableHash(systemText);
  const userHash = stableHash(userText);
  const sectionHashes: Record<string, string> = {};
  if (systemText) sectionHashes.system = systemHash;
  if (userText) sectionHashes.task = userHash;
  return { systemHash, userHash, sectionHashes };
}
