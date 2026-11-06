/**
 * The model's judgements, run by the host from the effect queue: routing an explicit request, assessing a proactive
 * candidate, and checking whether a person's follow-up asks to stop work. Each is one structured model call whose answer the
 * host checks and carries out through the Engine, which still enforces the gate, the Policy and the Mandates; upstream's main
 * Session made the same decisions through tools.
 */
import { z } from "zod/v4";
import { UserError, followupOwners, reasonText, threadKey, type Candidate, type Trigger } from "./core/index.js";
import type { SuperagentClient } from "./client.js";
import { relatedTickets, ticketCard, triggerCard } from "./cards.js";
import { triggerMessage, WorktreeNameSchema } from "./messages.js";
import { updatePlacement } from "./placement.js";
import { AdmissionDirectionSchema, RuleAssessmentSchema, assessmentOutcome, directionAllowed } from "./policy.js";
import { assessmentPrompt, followupPrompt, routerPrompt } from "./prompts.js";
import { admissionContext } from "./sources/admission-context.js";
import { IM_WORDS, NOTE_WORDS, checkedImText, wordCount } from "./text.js";

/** One structured model call: the host's provider with a JSON response format. */
export type Complete = (input: { purpose: string; system: string; user: string; model?: string }) => Promise<string>;

export interface AssessorHost {
  readonly client: SuperagentClient;
  readonly complete: Complete;
  /** Whether the Sources' CLIs can be used for thread context, which needs a resolved deployment. */
  configured(): boolean;
}

const AcknowledgementSchema = z.string().trim().min(1)
  .refine((text) => wordCount(text) <= IM_WORDS, `An acknowledgement has at most ${IM_WORDS} words; write one short sentence.`);
const RoutingNoteSchema = z.string().trim()
  .refine((text) => wordCount(text) <= NOTE_WORDS, `A routing note has at most ${NOTE_WORDS} words.`);
const RouteSchema = z.object({
  kind: z.enum(["accept", "attach", "ignore", "stop"]),
  title: z.string().nullish(),
  worktree_name: z.string().nullish(),
  acknowledgement: z.string().nullish(),
  note: z.string().nullish(),
  ticket_id: z.string().nullish(),
  reason: z.string().nullish(),
  /** What accepted work needs of the machine its worker runs on, such as gpu: it places the worker on a paired node fit for it. */
  needs: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "an ability such as gpu or macos")).max(8).nullish()
});
type Route = z.infer<typeof RouteSchema>;
type Field = Exclude<keyof Route, "kind" | "needs">;
/** Each field's check, the kinds that read it and those that need it, as upstream's orchestrator_route checked them. */
const FIELDS: Record<Field, { check: z.ZodType; reads: readonly Route["kind"][]; needs: readonly Route["kind"][] }> = {
  ticket_id: { check: z.string(), reads: ["attach", "stop"], needs: ["attach", "stop"] },
  title: { check: z.string().max(200), reads: ["accept"], needs: ["accept"] },
  worktree_name: { check: WorktreeNameSchema, reads: ["accept"], needs: ["accept"] },
  acknowledgement: { check: AcknowledgementSchema, reads: ["accept"], needs: ["accept"] },
  note: { check: RoutingNoteSchema, reads: ["accept", "attach"], needs: [] },
  reason: { check: z.string().max(500), reads: ["ignore", "stop"], needs: ["ignore"] }
};
/** Why a routing answer cannot run: a field its kind needs is missing, or one it reads breaks its limit. */
export function routeProblem(route: Route): string | undefined {
  for (const [field, { check, reads, needs }] of Object.entries(FIELDS) as [Field, typeof FIELDS[Field]][]) {
    if (!reads.includes(route.kind)) continue;
    const value = route[field];
    if (value === undefined || value === null || value.trim() === "") {
      if (needs.includes(route.kind)) return `${route.kind} needs ${field}`;
      continue;
    }
    const checked = check.safeParse(value);
    if (!checked.success) return `${field}: ${checked.error.issues[0]?.message ?? "invalid"}`;
  }
  return undefined;
}

export const AssessmentSchema = z.object({
  decision: z.enum(["accept", "ignore", "unavailable"]),
  rule_assessments: z.array(RuleAssessmentSchema)
    .refine((items) => new Set(items.map((item) => item.rule_id)).size === items.length, "Duplicate rule assessment IDs"),
  direction: AdmissionDirectionSchema,
  title: z.string().min(1).max(160),
  worktree_name: WorktreeNameSchema.optional(),
  scope: z.string().max(1500),
  intent_evidence: z.string().trim().min(1).max(700).nullish(),
  acknowledgement: AcknowledgementSchema.nullish(),
  reason: z.string().min(1).max(500)
}).strict().refine((value) => value.decision !== "accept" || !directionAllowed(value.direction) || !value.rule_assessments.some((rule) => rule.matched)
  || !!value.worktree_name, { message: "Accepted work requires a short English worktree_name", path: ["worktree_name"] });

const FollowupSchema = z.object({ stop: z.array(z.string()).default([]), reason: z.string().max(300).default("") });

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
const problem = (error: unknown): string => error instanceof z.ZodError ? z.prettifyError(error) : error instanceof Error ? error.message : String(error);

/** Character limits in the thread window of an assessment, as upstream's orchestrator_eval served it. */
const TRIGGER_CHARS = 4000, NEAR_CHARS = 1200, WINDOW_CHARS = 400, STUB_CHARS = 50;
const cut = (text: string, limit: number) => text.length <= limit ? { text } : { text: `${text.slice(0, limit)}…`, chars: text.length };

export class ModelAssessor {
  constructor(private readonly host: AssessorHost) {}

  /** Registers the host's handlers for the assessment and follow-up effects. */
  install(): void {
    const { client } = this.host;
    client.effects.handle("assessment", async ({ triggerId }, evalId) => { await this.judge(triggerId, evalId); },
      { limit: () => client.settings().paused ? 0 : 4 });
    client.effects.handle("followup", async ({ triggerId }) => { await this.followup(triggerId); },
      { limit: () => client.settings().paused ? 0 : 2 });
  }

  /** Decides the Eval that holds `triggerId`, unless a later Eval replaced it or it already ended. */
  async judge(triggerId: string, evalId: string): Promise<void> {
    const { engine } = this.host.client;
    const candidate = engine.candidate(triggerId);
    if (candidate?.evalId !== evalId) return;
    // The Eval's time limit starts now that its candidate reached the model.
    engine.candidateDelivered(evalId);
    if (candidate.strength === "explicit") await this.route(candidate);
    else await this.assess(candidate);
  }

  /** The candidate card the router reads: the request as a worker would read it, its batch, and the tickets around it. */
  card(candidate: Candidate): Record<string, unknown> {
    const { store, sources } = this.host.client;
    const primary = candidate.triggers.at(-1)!;
    const disposition = store.triggers.disposition(primary.id);
    const handedBack = candidate.triggers.flatMap((trigger) => (store.triggers.disposition(trigger.id)?.handbacks ?? [])
      .map((item) => ({ trigger_id: trigger.id, ticket_id: item.ticketId, reason: item.reason })));
    const others = candidate.triggers.filter((trigger) => trigger.id !== primary.id);
    const parentId = sources.repliesTo(primary);
    const parent = parentId ? store.triggers.get(parentId) : undefined;
    const threads = (primary.text.match(/#\d+|https?:\/\/[^\s)>\]]+/g) ?? []).flatMap((reference) => sources.find(reference).threads);
    const known = new Set(candidate.tickets.map((ticket) => ticket.id));
    const referenced = [...new Set(threads.flatMap((thread) => store.threads.get(thread)?.subscriptions ?? []))]
      .filter((id) => !known.has(id)).flatMap((id) => store.tickets.get(id) ?? []).slice(0, 4);
    const recent = store.tickets.list().filter((ticket) => !known.has(ticket.id)).slice(0, 20)
      .map((ticket) => ({ ticket_id: ticket.id, title: ticket.title, state: ticketCard(ticket).state }));
    return {
      ...triggerMessage(primary, primary.url ? { source_url: primary.url } : {}, undefined, parent),
      text: cut(primary.text, TRIGGER_CHARS).text,
      strength: candidate.strength,
      ...(others.length ? { batch: others.map((trigger) => triggerCard(trigger)) } : {}),
      ...(handedBack.length ? { handed_back: handedBack } : {}),
      ...relatedTickets(candidate.tickets),
      ...(disposition?.fanout.length ? { delivered_to: disposition.fanout } : {}),
      ...(referenced.length ? { referenced_tickets: referenced.map(ticketCard) } : {}),
      ...(recent.length ? { recent_tickets: recent } : {})
    };
  }

  /** Routes an explicit candidate: one model answer, checked once and asked again with the problem when it does not hold. */
  private async route(candidate: Candidate): Promise<void> {
    const { client, complete } = this.host;
    const card = this.card(candidate);
    const triggerId = candidate.triggers.at(-1)!.id;
    let last = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const user = JSON.stringify(attempt ? { candidate: card, previous_answer: last, problem: last } : { candidate: card }, null, 2);
      const answer = await complete({ purpose: "superagent_route", system: routerPrompt(), user, model: client.settings().eval.model ?? undefined });
      let route: Route;
      try {
        route = RouteSchema.parse(parseJsonObject(answer));
      } catch (error) {
        last = problem(error);
        continue;
      }
      const refused = routeProblem(route) ?? this.carryOut(candidate, triggerId, route);
      if (!refused) return;
      last = refused;
    }
    // An Eval left undecided expires after its time limit and goes back to the queue, then ends unavailable.
    throw new Error(`The router's answer could not be used: ${last}`);
  }

  /** Carries out a routing answer as its Engine command; returns why the Engine refused it, if it did. */
  private carryOut(candidate: Candidate, triggerId: string, route: Route): string | undefined {
    const { engine } = this.host.client;
    try {
      switch (route.kind) {
        case "accept": {
          const { client } = this.host;
          const decision = client.store.atomic(() => {
            const decided = engine.decide(triggerId, {
              kind: "accept", title: route.title!, scope: route.title!, reason: { code: "explicitRouted" },
              acknowledgement: route.acknowledgement!, name: route.worktree_name!, ...(route.note ? { note: route.note } : {}), evalId: candidate.evalId
            });
            // Recorded with the ticket, before its worker launches, so a mesh node places the worker where the work can run.
            if (decided.ticketId && route.needs?.length) updatePlacement(client, decided.ticketId, { needs: [...new Set(route.needs)] });
            return decided;
          });
          return decision.kind === "accept" && decision.ticketId ? undefined : `Ticket was not created: ${reasonText(decision.reason)}`;
        }
        case "attach":
          engine.attach(route.ticket_id!, triggerId, route.note ?? undefined);
          return undefined;
        case "stop":
          engine.decide(triggerId, { kind: "stop", ticketId: route.ticket_id!, reason: route.reason || { code: "humanStop" }, evalId: candidate.evalId });
          return undefined;
        case "ignore":
          engine.decide(triggerId, { kind: "ignore", reason: route.reason!, evalId: candidate.evalId });
          return undefined;
      }
    } catch (error) {
      if (error instanceof UserError) return error.message;
      throw error;
    }
  }

  /** The thread window an assessment reads, as upstream's orchestrator_eval served it: the first five and five on either side. */
  async window(trigger: Trigger): Promise<Record<string, unknown>> {
    const { client } = this.host;
    const context = client.sources.threadContext(trigger);
    if (!context) return { error: "This Source gives no Thread context; assess the Trigger's own text and the batch." };
    if (!this.host.configured()) return { error: "Thread context unavailable: the host has not resolved the Source's account." };
    try {
      const machine = client.deployment();
      const commands = client.commands.withSignal(AbortSignal.timeout(machine.admissionContextTimeoutMs));
      const loaded = await admissionContext(context, commands, machine.admissionContextMaxPages);
      const shown = new Set(loaded.window.entries.map((entry) => entry.message.id));
      const at = loaded.messages.findIndex((message) => message.id === context.messageId);
      const messages = loaded.messages.map((message, index) => {
        const author = { id: message.id, from: message.from, ...(message.bot ? { bot: true } : {}) };
        if (message.deleted) return { ...author, deleted: true };
        if (!shown.has(message.id)) return { ...author, preview: message.text.replace(/\s+/g, " ").slice(0, STUB_CHARS) };
        if (index === at) return { ...author, at: message.at, trigger: true };
        const near = at >= 0 && Math.abs(index - at) <= 2;
        return { ...author, at: message.at, ...cut(message.text, near ? NEAR_CHARS : WINDOW_CHARS) };
      });
      return { complete: loaded.complete, loaded_messages: loaded.messages.length, source_found: loaded.window.source_found, messages };
    } catch (error) {
      return { error: `Thread context unavailable: ${String(error).slice(0, 300)}` };
    }
  }

  /** Assesses a proactive candidate against the enabled rules and records the Decision; observe mode records "would accept". */
  private async assess(candidate: Candidate): Promise<void> {
    const { client, complete } = this.host;
    const trigger = candidate.triggers.at(-1)!;
    const settings = client.settings();
    const others = candidate.triggers.filter((item) => item.id !== trigger.id);
    const card = {
      trigger_id: trigger.id, strength: candidate.strength, mode: settings.eval.mode,
      source: { kind: trigger.source, actor: trigger.actor.id, thread: threadKey(trigger.threads[0]!), ...(trigger.url ? { url: trigger.url } : {}) },
      ...cut(trigger.text, TRIGGER_CHARS),
      ...(others.length ? { batch: others.map((item) => ({ trigger_id: item.id, actor: item.actor.id, at: item.at, ...cut(item.text, WINDOW_CHARS) })) } : {}),
      ...relatedTickets(candidate.tickets), policy_version: candidate.policyVersion,
      thread: await this.window(trigger)
    };
    let last = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const user = JSON.stringify(attempt ? { candidate: card, problem: last } : { candidate: card }, null, 2);
      const answer = await complete({ purpose: "superagent_assessment", system: assessmentPrompt(settings), user, model: settings.eval.model ?? undefined });
      try {
        const assessment = AssessmentSchema.parse(parseJsonObject(answer));
        let outcome = assessmentOutcome(assessment, client.settings(), candidate.strength);
        if (outcome.kind === "accept" && outcome.acknowledgement) outcome = { ...outcome, acknowledgement: checkedImText(outcome.acknowledgement) };
        client.engine.decide(trigger.id, { ...outcome, evalId: candidate.evalId });
        return;
      } catch (error) {
        if (error instanceof UserError) throw error;
        last = problem(error);
      }
    }
    throw new Error(`The assessment could not be used: ${last}`);
  }

  /** Asks whether a person's follow-up that tickets' workers decide asks to stop their work, and stops the tickets it names. */
  async followup(triggerId: string): Promise<void> {
    const { client, complete } = this.host;
    const trigger = client.store.triggers.get(triggerId);
    if (!trigger) return;
    const owners = followupOwners(trigger, client.store);
    const tickets = owners.flatMap((id) => client.store.tickets.get(id) ?? []);
    if (!tickets.length) return;
    const card = { message: { ...triggerMessage(trigger, {}), text: cut(trigger.text, TRIGGER_CHARS).text },
      delivered_to: tickets.map((ticket) => ({ ticket_id: ticket.id, title: ticket.title, state: ticketCard(ticket).state })) };
    const answer = FollowupSchema.parse(parseJsonObject(await complete({ purpose: "superagent_followup", system: followupPrompt(),
      user: JSON.stringify(card, null, 2), model: client.settings().eval.model ?? undefined })));
    for (const ticketId of answer.stop.filter((id) => owners.includes(id))) {
      try {
        client.engine.decide(triggerId, { kind: "stop", ticketId, reason: answer.reason || { code: "humanStop" } });
      } catch (error) {
        if (!(error instanceof UserError)) throw error;
      }
    }
  }
}
