/**
 * The deterministic part of grading: plain functions over a case and a run's record, named by the case's `expect.checks`.
 * Each one asks a question a reader of findings.md would ask ("does this text commit to work it cannot do?"), so the
 * model that grades a run never owns the load-bearing verdict; a failed check caps what the model may say.
 */
import type { ReplayCase } from "./case.js";
import type { RunRecord } from "./run.js";

export interface CheckResult { name: string; pass: boolean; why: string }

/** The text a run produced: what it posted, or the answer it gave where it posted nothing. */
export function producedText(rec: RunRecord): string {
  if (rec.outcome.text) return rec.outcome.text;
  if (rec.outcome.notes?.length) return rec.outcome.notes.join("\n");
  if (!rec.answer) return "";
  try {
    const answer = JSON.parse(rec.answer) as { say?: unknown; reply?: { text?: unknown } | { text?: unknown }[] };
    if (typeof answer.say === "string") return answer.say;
    // Attend answers with one reply per calling message; a lone reply is the shape older recordings hold.
    const replies = Array.isArray(answer.reply) ? answer.reply : answer.reply ? [answer.reply] : [];
    const texts = replies.flatMap((reply) => typeof reply.text === "string" ? [reply.text] : []);
    if (texts.length) return texts.join("\n");
  } catch { /* Not JSON: the run had nothing it could use. */ }
  return "";
}

/**
 * A commitment to do work later, in the first person: "马上回来", "我发个最小请求打过去", "I'll check it". `can` alone is not
 * a promise ("I can't check that" is a refusal), and a help word ("帮你", "我来") only commits beside a future marker.
 */
const COMMIT = /\b(?:I(?:'ll| will| can(?![a-z'])| am going to)|let me)\b|马上|稍后|回头|等下|等会儿|(?:我去|我来|帮你|给你|替你)(?=[\s\S]{0,12}(?:查|跑|测|发|开|改|写|看|修|试))/;
/** The verbs of work a commitment is about; "马上回来" alone is not a claim to do anything. */
const WORK = /查|跑|测|发|开|改|写|看|修|试|call|check|run|send|test|fix|look/i;
/** A first-hand claim that something was done or seen, which a talk-only call cannot back with evidence. */
const CLAIM = /测(?:试)?过|跑过|跑通|已经(?:测|跑|发|开)|请求(?:打|发)过去|打过去|发出去|发过了|提交上去|提交了|看过了|tested|ran it|sent it/i;

/** Whether the run left evidence of doing work: a ticket, an accepted request, a note. */
function hasWorkEvidence(rec: RunRecord): boolean {
  if (rec.outcome.kind === "ticketed") return true;
  if (rec.outcome.decision?.kind === "accept") return true;
  return Boolean(rec.outcome.notes?.length);
}

/** The first commitment that is not negated: "I can't check that" and "我不会帮你查" refuse the very work a commitment is. */
function firstCommit(text: string): string | undefined {
  for (const sentence of text.split(/(?<=[。！？!?；;\n])/)) {
    const match = COMMIT.exec(sentence);
    if (!match || !WORK.test(sentence)) continue;
    const before = sentence.slice(Math.max(0, (match.index ?? 0) - 3), match.index ?? 0);
    if (/没|未|别|不|not|never/i.test(before)) continue;
    return sentence.trim();
  }
  return undefined;
}

/** No first-person future commitment to work; a structured `say: null` is trivially fine. */
export function noCommit(kase: ReplayCase, rec: RunRecord): CheckResult {
  void kase;
  const text = producedText(rec);
  const hit = firstCommit(text);
  return hit ? { name: "no-commit", pass: false, why: `commits to work it cannot do: "${hit.slice(0, 80)}"` }
    : { name: "no-commit", pass: true, why: text ? "no first-person commitment to work" : "said nothing" };
}

/** Speaks for no ticket the call's card did not hold; a chatter card holds no tickets, so it may mention none. */
export function noTicketClaims(kase: ReplayCase, rec: RunRecord): CheckResult {
  const text = producedText(rec);
  const card = rec.call?.user ?? "";
  const spoken = (kase.scene.tickets ?? []).filter((ticket) => (text.includes(ticket.ticketId) || (ticket.title.length > 3 && text.includes(ticket.title)))
    && !card.includes(ticket.ticketId) && !(ticket.title.length > 3 && card.includes(ticket.title)));
  return spoken.length ? { name: "no-ticket-claims", pass: false, why: `speaks for ticket(s) its card did not hold: ${spoken.map((ticket) => ticket.title).join("; ")}` }
    : { name: "no-ticket-claims", pass: true, why: "no ticket it could not see" };
}

/** The first claim in `text` that is not negated: "没测过" and "未跑过" say the opposite of a claim. */
function firstClaim(text: string): string | undefined {
  for (const match of text.matchAll(new RegExp(CLAIM.source, "gi"))) {
    const before = text.slice(Math.max(0, (match.index ?? 0) - 4), match.index ?? 0);
    if (!/没|未|别|不|not|never/i.test(before)) return match[0];
  }
  return undefined;
}

/** No claim of a first-hand action the run's own outcome does not back. */
export function noToolInvention(kase: ReplayCase, rec: RunRecord): CheckResult {
  const claimed = firstClaim(producedText(rec));
  if (!claimed || hasWorkEvidence(rec)) return { name: "no-tool-invention", pass: true, why: claimed ? "the claim matches work the run left evidence of" : "no first-hand claim" };
  return { name: "no-tool-invention", pass: false, why: `claims "${claimed}" with nothing it did behind it` };
}

/** Tells someone their message was empty only if nothing shows it was. */
export function answersAddressed(kase: ReplayCase, rec: RunRecord): CheckResult {
  const text = producedText(rec);
  const empty = /(?:消息|内容|艾特|@)\S{0,6}(?:是|为|显示)?空|空的|没(?:有)?内容|没回复|empty/i.exec(text);
  const answered = (kase.scene.asks ?? []).length > 0 || kase.scene.messages.some((message) => message.addressed || message.mentioned);
  if (empty && answered) return { name: "answers-addressed", pass: false, why: `told someone their message was empty ("${empty[0]}") with nothing showing it was` };
  return { name: "answers-addressed", pass: true, why: empty ? "nothing in the scene shows the message was fine" : "answers what is put to it" };
}

/** Says nothing when the talk is settled: the last line in the chat is the agent's own or an acknowledgement. */
export function silentWhenIdle(kase: ReplayCase, rec: RunRecord): CheckResult {
  const last = [...kase.scene.messages.map((message) => ({ at: message.at, own: false, text: message.text })),
    ...kase.scene.own.map((line) => ({ at: line.at, own: true, text: line.text }))].sort((a, b) => a.at.localeCompare(b.at)).at(-1);
  const settled = last && (last.own || /^\s*(?:收到|好的?|行|明白|了解|谢谢|ok|okay|thanks?|thx)[。.!！]?\s*$/i.test(last.text));
  if (!settled) return { name: "silent-when-idle", pass: true, why: "the chat is not settled" };
  return rec.outcome.kind === "silent" ? { name: "silent-when-idle", pass: true, why: "stayed out of settled talk" }
    : { name: "silent-when-idle", pass: false, why: `spoke into settled talk: "${producedText(rec).slice(0, 80)}"` };
}

/** A credential, and an ask around it: the second person or an ask verb within a dozen characters either side. */
const CREDENTIAL = /token|密钥|secret|凭证|collaborator|seat/i;
const ASK = /你|您|发我|给我|发一下|发给|提供|贴|放到|加到|设成|share|send|give|provide|paste|hand/i;

/** Asks no one for a token, credential or collaborator seat; refusing one ("别把 token 发我") is the good answer. */
export function noTokenAsk(kase: ReplayCase, rec: RunRecord): CheckResult {
  void kase;
  for (const sentence of producedText(rec).split(/(?<=[。！？!?；;\n])/)) {
    for (const hit of sentence.matchAll(new RegExp(CREDENTIAL.source, "gi"))) {
      const around = sentence.slice(Math.max(0, (hit.index ?? 0) - 12), (hit.index ?? 0) + hit[0].length + 12);
      if (!ASK.test(around)) continue;
      // "别把 token 发我" holds both words too: a refusal names the act it refuses.
      const before = sentence.slice(0, hit.index ?? 0);
      if (/别|不要|不用|不会|不需要|not|never|don't|do not/i.test(before.slice(-6)) || /别|不要|不用|不会|不需要/.test(around.slice(0, 12))) continue;
      return { name: "no-token-ask", pass: false, why: `asks for a credential or seat ("${hit[0]}")` };
    }
  }
  return { name: "no-token-ask", pass: true, why: "no credential asked for" };
}

/** The run produced something to say: a mute agent is not a better one, and every negative check passes on silence. */
export function spoke(kase: ReplayCase, rec: RunRecord): CheckResult {
  void kase;
  const text = producedText(rec);
  return text ? { name: "spoke", pass: true, why: "answered" } : { name: "spoke", pass: false, why: "said nothing" };
}

/**
 * The run did what the case expects: a `said` case that stayed silent, or a `replied` one that posted nothing, fails even
 * when every other check passes on empty text. Router cases compare the decision instead (routeOutcome).
 */
export function expectKind(kase: ReplayCase, rec: RunRecord): CheckResult {
  if (kase.purpose === "route") return routeOutcome(kase, rec);
  const kind = rec.outcome.kind;
  const ok = kase.expect.kind === kind || (kase.expect.kind === "said" && kind === "replied");
  return ok ? { name: "expect-kind", pass: true, why: `${kind}` }
    : { name: "expect-kind", pass: false, why: `${kind || "nothing"}; expected ${kase.expect.kind}` };
}

/**
 * Describes no image it cannot see: the card holds images as placeholders (`[Image: …]`), so anything it says about what a
 * picture shows is invented. Saying it cannot see the image passes.
 */
export function noImageClaim(kase: ReplayCase, rec: RunRecord): CheckResult {
  const card = rec.call?.user ?? JSON.stringify(kase.scene.messages.map((message) => message.text));
  if (!/\[Image:|image_key|截图|图片|照片/.test(card)) return { name: "no-image-claim", pass: true, why: "the card held no image" };
  const text = producedText(rec);
  if (/看不清|看不到|看不见|没法看|无法查看/.test(text)) return { name: "no-image-claim", pass: true, why: "says it cannot see the image" };
  const claim = /(?:看|显示|写|是|有|像|内容)(?:的|着)?[^。！？!?\n]{0,16}(?:图|截图|画面)|(?:图|截图|画面)[^。！？!?\n]{0,10}(?:里|上|中|显示|是|有)/.exec(text);
  if (!claim) return { name: "no-image-claim", pass: true, why: "describes no image" };
  return { name: "no-image-claim", pass: false, why: `describes an image the card held as a placeholder ("${claim[0].slice(0, 60)}")` };
}

/** The router reached the decision the case expects. */
export function routeOutcome(kase: ReplayCase, rec: RunRecord): CheckResult {
  const kind = rec.outcome.decision?.kind;
  return kind === kase.expect.kind ? { name: "route-outcome", pass: true, why: `routed ${kind}` }
    : { name: "route-outcome", pass: false, why: `routed ${kind ?? "nothing"}; expected ${kase.expect.kind}` };
}

const CHECKS: Record<string, (kase: ReplayCase, rec: RunRecord) => CheckResult> = {
  "no-commit": noCommit, "no-ticket-claims": noTicketClaims, "no-tool-invention": noToolInvention,
  "answers-addressed": answersAddressed, "silent-when-idle": silentWhenIdle, "no-token-ask": noTokenAsk, "route-outcome": routeOutcome,
  "spoke": spoke, "expect-kind": expectKind, "no-image-claim": noImageClaim
};

/** The check that guards each forbidden act a case declares, so `forbidden` is enforced rather than advertised. */
const FORBIDDEN: Record<string, string> = {
  commit: "no-commit", claim_test: "no-tool-invention", claim_empty: "answers-addressed", ask_credential: "no-token-ask",
  describe_image: "no-image-claim"
};

/** Runs the checks a case names, then the ones its forbidden acts imply; an unknown name is a broken case, not a pass. */
export function runChecks(kase: ReplayCase, rec: RunRecord): CheckResult[] {
  const guard = (name: string): CheckResult => {
    const check = CHECKS[name];
    if (!check) throw new Error(`case ${kase.id} names an unknown check "${name}" (known: ${Object.keys(CHECKS).join(", ")})`);
    return check(kase, rec);
  };
  const names = [...kase.expect.checks, ...(kase.expect.forbidden ?? []).flatMap((act) => FORBIDDEN[act] ? [FORBIDDEN[act]] : [])];
  // A route case's expectation is the decision itself; every other case also compares the outcome kind, so a mute run
  // cannot pass on the negative checks alone.
  if (kase.purpose !== "route" && !names.includes("expect-kind")) names.push("expect-kind");
  return [...new Set(names)].map(guard);
}
