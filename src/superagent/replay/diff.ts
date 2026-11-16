/**
 * The card-diff mode: compares the card a run sent with the one recorded in production, hash for hash, and needs no
 * model grading. A chatter card carries its clock to the millisecond, so a card that only moved in time is found by
 * sweeping the case's clock a few seconds either way and reported with its offset: a time mismatch, not a logic change.
 */
import type { ReplayCase } from "./case.js";
import { stableHash } from "./hash.js";
import type { RunRecord } from "./run.js";

export interface CardDiff {
  verdict: "exact" | "approximate";
  system: boolean;
  user: boolean;
  /** The sections whose hashes differ, when both cards carry section hashes. */
  changedSections?: string[];
  /** A chatter card that matches at another time: the offset in ms from the case's clock. */
  ms?: number;
}

/** How far either side of the case's clock the sweep looks, as the probe does. */
const SWEEP_MS = 6000;

/** The section names whose hashes differ between the recorded card and the run's. */
function changedSections(recorded: Record<string, string> | undefined, run: Record<string, string> | undefined): string[] {
  const names = new Set([...Object.keys(recorded ?? {}), ...Object.keys(run ?? {})]);
  return [...names].filter((name) => recorded?.[name] !== run?.[name]);
}

/**
 * The offset at which a chatter card's `now` reproduces the recorded user hash, or undefined. The card's clock is the
 * only thing that moves millisecond to millisecond; everything else a run sees is the case's own, so a hit means the
 * recorded call started at another millisecond, not that the logic changed. The sweep needs the run to have made no
 * second call: a re-sent card would be a different card, not the same one at another time.
 */
export function sweepNow(text: string, at: number, recordedHash: string): number | undefined {
  const stamp = `"now": "${new Date(at).toISOString()}"`;
  if (!text.includes(stamp)) return undefined;
  for (let ms = at - SWEEP_MS; ms <= at + SWEEP_MS; ms++) {
    const moved = text.replace(stamp, `"now": "${new Date(ms).toISOString()}"`).trim();
    if (stableHash(moved) === recordedHash) return ms - at;
  }
  return undefined;
}

/**
 * Compares one run's captured card with the case's recorded card. `null` when the run made no model call at all: there
 * is no card to compare, which the CLI reports as `no-call`.
 */
export function cardDiff(kase: ReplayCase, rec: RunRecord): CardDiff | null {
  if (!rec.call) return null;
  const system = rec.call.systemHash === kase.recorded.card.systemHash;
  const user = rec.call.userHash === kase.recorded.card.userHash;
  if (system && user) return { verdict: "exact", system, user };
  const sections = changedSections(kase.recorded.card.sectionHashes, rec.call.sectionHashes);
  const diff: CardDiff = { verdict: "approximate", system, user, ...(sections.length ? { changedSections: sections } : {}) };
  if (kase.purpose === "chatter" && !user) {
    const ms = sweepNow(rec.call.user, Date.parse(kase.scene.at), kase.recorded.card.userHash);
    if (ms !== undefined) diff.ms = ms;
  }
  return diff;
}
