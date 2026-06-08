import type { ResultCard } from "../../runtime/result-card.js";
import type {
  AttentionItemView,
  ResultPreview,
  RunBoardResultAction,
  RunBoardState,
  RunBoardRisk
} from "./run-board-types.js";
import { selectAttentionHistory } from "./run-board-selectors.js";
import { labelForRunBoardAction } from "./run-board-action-labels.js";

export type ProductResultCardViewStatus = "success" | "partial" | "failed" | "cancelled" | "preview";

export type ProductResultCardView = {
  status: ProductResultCardViewStatus;
  runtimeStatus?: ResultCard["status"];
  title: string;
  objective?: string;
  sessionId?: string;
  route?: ResultCard["route"];
  summary: string;
  changedFiles: string[];
  checks: Array<{ command: string; status: "passed" | "failed" | "skipped" | "unknown" | "running" }>;
  review?: ResultCard["review"];
  reviewFindings?: ResultCard["reviewFindings"];
  recovery?: ResultCard["recovery"];
  checkpoint?: ResultCard["checkpoint"];
  risk: RunBoardRisk;
  riskSummary: string;
  workerSummary: Array<{ workerId: string; label: string; contribution: string; status: "done" | "failed" | "cancelled" }>;
  attentionHistory: Array<{ id: string; kind: AttentionItemView["kind"]; summary: string; resolution?: string; resolved: boolean }>;
  artifacts: string[];
  decisionTrail?: ResultCard["decisionTrail"];
  nextActions: RunBoardResultAction[];
  detailHint?: string;
  finished: boolean;
};

export function selectProductResultCardView(state: RunBoardState, input: {
  card?: ResultCard;
  detailHint?: string;
  decisionTrailEnabled?: boolean;
} = {}): ProductResultCardView {
  const card = input.decisionTrailEnabled === false
    ? withoutDecisionTrail(state.finalResult ?? input.card)
    : state.finalResult ?? input.card;
  return productResultCardViewFromParts({
    card,
    preview: state.resultPreview,
    attentionHistory: selectAttentionHistory(state),
    objective: state.objective,
    detailHint: input.detailHint
  });
}

function withoutDecisionTrail(card: ResultCard | undefined): ResultCard | undefined {
  if (!card?.decisionTrail) {
    return card;
  }
  return { ...card, decisionTrail: undefined };
}

export function productResultCardViewFromParts(input: {
  card?: ResultCard;
  preview: ResultPreview;
  attentionHistory: AttentionItemView[];
  objective?: string;
  detailHint?: string;
}): ProductResultCardView {
  const card = input.card;
  const risk = selectRisk(card, input.preview);
  if (!card) {
    return {
      status: "preview",
      title: "Result Preview",
      objective: input.objective,
      summary: input.preview.summary,
      changedFiles: input.preview.changedFiles,
      checks: input.preview.checks,
      reviewFindings: undefined,
      recovery: undefined,
      checkpoint: undefined,
      risk,
      riskSummary: risk,
      workerSummary: workerSummaryFromPreview(input.preview),
      attentionHistory: attentionHistoryView(input.attentionHistory),
      artifacts: input.preview.artifacts,
      decisionTrail: undefined,
      nextActions: input.preview.nextActions.map((command) => ({ command, label: labelForRunBoardAction(command), source: "preview" })),
      detailHint: input.detailHint,
      finished: false
    };
  }
  return {
    status: productStatus(card.status),
    runtimeStatus: card.status,
    title: "Result Report",
    objective: input.objective,
    sessionId: card.sessionId,
    route: card.route,
    summary: card.summary,
    changedFiles: card.changedFiles,
    checks: card.checks,
    review: card.review,
    reviewFindings: card.reviewFindings,
    recovery: card.recovery,
    checkpoint: card.checkpoint,
    risk,
    riskSummary: formatRiskSummary(card, risk),
    workerSummary: workerSummaryFromPreview(input.preview),
    attentionHistory: attentionHistoryView(input.attentionHistory),
    artifacts: card.artifacts,
    decisionTrail: card.decisionTrail,
    nextActions: finalNextActions(card),
    detailHint: input.detailHint,
    finished: true
  };
}

function productStatus(status: ResultCard["status"]): ProductResultCardViewStatus {
  if (status === "completed") return "success";
  if (status === "stopped") return "cancelled";
  return "failed";
}

function selectRisk(card: ResultCard | undefined, preview: ResultPreview): RunBoardRisk {
  const levels = [
    ...(card?.risks.map((risk) => risk.level) ?? []),
    ...preview.risks.map((risk) => risk.level)
  ];
  if (levels.includes("high")) return "high";
  if (levels.includes("medium")) return "medium";
  return "low";
}

function formatRiskSummary(card: ResultCard, fallback: RunBoardRisk): string {
  if (!card.risks.length) {
    return fallback;
  }
  return card.risks.slice(0, 2).map((risk) => risk.message ? `${risk.level}: ${risk.message}` : risk.level).join(" | ");
}

function workerSummaryFromPreview(preview: ResultPreview): ProductResultCardView["workerSummary"] {
  return preview.contributors.map((contributor) => ({
    workerId: contributor.workerId,
    label: contributor.label,
    contribution: contributor.contribution,
    status: "done"
  }));
}

function attentionHistoryView(items: AttentionItemView[]): ProductResultCardView["attentionHistory"] {
  return items.map((item) => ({
    id: item.id,
    kind: item.kind,
    summary: item.summary,
    resolution: item.resolution,
    resolved: Boolean(item.resolvedAt)
  }));
}

function finalNextActions(card: ResultCard): RunBoardResultAction[] {
  const commands = uniqueCommands([
    ...(card.checkpoint?.revertAvailable ? ["/revert last"] : []),
    ...card.next
  ]);
  return commands.map((command) => ({
    command,
    label: labelForRunBoardAction(command),
    source: "final"
  }));
}

function uniqueCommands(commands: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const command of commands) {
    const normalized = command.trim();
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}
