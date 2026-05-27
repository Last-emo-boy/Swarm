import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { lspFallbackFactForFailure } from "./capabilities.js";
import { detectLspWorkspaceRoot } from "./root-detection.js";
import { TypeScriptSemanticProvider } from "./typescript-provider.js";
import type {
  LspDiagnostic,
  LspOperationResult,
  LspReferenceGroup,
  LspSemanticConflictEvidence,
  LspSemanticOwnershipHint,
  LspSemanticPlanningProvider,
  LspSemanticPlanningState,
  LspSemanticPlanningStatus,
  LspSemanticRiskHotspot,
  LspSemanticTaskHint,
  LspSemanticTaskPlan,
  LspSymbol
} from "./types.js";

const PLANNING_SCHEMA_VERSION = "swarm.lsp_semantic_planning.v1";
const TASK_PLAN_SCHEMA_VERSION = "swarm.lsp_semantic_task_plan.v1";
const PLANNING_PARTICIPANT_ID = "capability:lsp:planning";

export type LspSemanticPlanningInput = {
  workspace: string;
  objective: string;
  query?: string;
  files?: string[];
  ownershipHints?: LspSemanticOwnershipHint[];
  maxSymbols?: number;
  maxDiagnostics?: number;
  maxReferences?: number;
};

type LspSemanticPlanningStatusInput = {
  providers: Array<{
    providerId: string;
    status: string;
    detected: boolean;
    available: boolean;
    languageIds: string[];
    reason?: string;
    lastError?: string;
    capabilities?: Array<{
      action: string;
      available: boolean;
      reason?: string;
      next_action?: string;
    }>;
  }>;
};

export function buildLspSemanticPlanningStatus(
  report: LspSemanticPlanningStatusInput | undefined,
  generatedAt = new Date().toISOString()
): LspSemanticPlanningStatus {
  if (!report) {
    return {
      schema_version: PLANNING_SCHEMA_VERSION,
      participant_id: PLANNING_PARTICIPANT_ID,
      state: "unavailable",
      generated_at: generatedAt,
      providers: [],
      task_hint_capable: false,
      conflict_evidence_capable: false,
      degraded_reason: "No LSP status report is available.",
      next_action: "Run swarm lsp status or use file.grep/file.read until semantic planning is available."
    };
  }
  const providers = report.providers.map(semanticPlanningProvider);
  const active = providers.filter((provider) => provider.state === "active");
  const degraded = providers.filter((provider) => provider.state === "degraded");
  const state: LspSemanticPlanningState = active.length
    ? degraded.length ? "degraded" : "active"
    : degraded.length ? "degraded" : "unavailable";
  const degradedReason = firstString(providers.map((provider) => provider.reason));
  const nextAction = firstString(providers.map((provider) => provider.next_action));
  return {
    schema_version: PLANNING_SCHEMA_VERSION,
    participant_id: PLANNING_PARTICIPANT_ID,
    state,
    generated_at: generatedAt,
    providers,
    task_hint_capable: active.length > 0 || degraded.some((provider) => provider.evidence_sources.length > 0),
    conflict_evidence_capable: active.some((provider) => provider.evidence_sources.includes("lsp.references")),
    degraded_reason: state === "active" ? undefined : degradedReason ?? "No active semantic planning provider is available.",
    next_action: state === "active" ? undefined : nextAction ?? "Use file.grep/file.read while semantic planning is degraded."
  };
}

export async function buildLspSemanticTaskPlan(input: LspSemanticPlanningInput): Promise<LspSemanticTaskPlan> {
  const workspace = resolve(input.workspace);
  const files = uniqueStrings(input.files ?? []);
  const focusFile = files[0] ? resolve(workspace, files[0]) : undefined;
  const detection = await detectLspWorkspaceRoot({
    workspace,
    root: focusFile ? dirname(focusFile) : workspace,
    file: focusFile
  });
  if (detection.language && detection.language !== "typescript") {
    return degradedTaskPlan(input, {
      root: detection.workspaceRoot,
      language: detection.language,
      reason: `No semantic planning provider is registered for ${detection.language}.`,
      fallbackCode: "unsupported_language"
    });
  }
  if (!detection.language && !files.length) {
    return degradedTaskPlan(input, {
      root: detection.workspaceRoot,
      reason: "No language or source file was available for semantic planning.",
      fallbackCode: "provider_unavailable"
    });
  }

  try {
    const provider = await TypeScriptSemanticProvider.create(detection.workspaceRoot);
    const query = semanticQuery(input);
    const symbolResult = await provider.workspaceSymbols({
      query,
      maxResults: input.maxSymbols ?? 24
    });
    const diagnosticsResult = await provider.diagnostics({
      file: focusFile,
      maxResults: input.maxDiagnostics ?? 20,
      contextLines: 1
    });
    const symbols = symbolsFromResult(symbolResult);
    const diagnostics = diagnosticsFromResult(diagnosticsResult);
    const conflictEvidence = await semanticConflictEvidence({
      provider,
      symbols,
      diagnostics,
      ownershipHints: input.ownershipHints ?? [],
      maxReferences: input.maxReferences ?? 24
    });
    const hints = semanticTaskHints({ objective: input.objective, query, symbols, diagnostics, conflicts: conflictEvidence });
    return {
      schema_version: TASK_PLAN_SCHEMA_VERSION,
      participant_id: PLANNING_PARTICIPANT_ID,
      state: "active",
      objective: input.objective,
      root: detection.workspaceRoot,
      language: "typescript",
      provider: provider.providerId,
      task_hints: hints,
      conflict_report: {
        status: conflictEvidence.length ? "conflict" : "clear",
        conflicts: conflictEvidence
      }
    };
  } catch (error) {
    return degradedTaskPlan(input, {
      root: detection.workspaceRoot,
      language: detection.language,
      reason: error instanceof Error ? error.message : String(error),
      fallbackCode: "provider_failed"
    });
  }
}

function semanticPlanningProvider(provider: LspSemanticPlanningStatusInput["providers"][number]): LspSemanticPlanningProvider {
  const facts = provider.capabilities ?? [];
  const available = new Set(facts.filter((fact) => fact.available).map((fact) => fact.action));
  const sources = [
    available.has("lsp.workspace_symbols") ? "lsp.workspace_symbols" : undefined,
    available.has("lsp.document_symbols") ? "lsp.document_symbols" : undefined,
    available.has("lsp.diagnostics") ? "lsp.diagnostics" : undefined,
    available.has("lsp.references") ? "lsp.references" : undefined
  ].filter((item): item is string => Boolean(item));
  const state: LspSemanticPlanningState = !provider.detected || !provider.available || provider.status === "unavailable"
    ? "unavailable"
    : provider.status === "failed" || provider.status === "exited"
      ? "degraded"
      : sources.includes("lsp.workspace_symbols") && sources.includes("lsp.diagnostics")
        ? sources.includes("lsp.references") ? "active" : "degraded"
        : "degraded";
  const unavailableFacts = facts.filter((fact) => !fact.available);
  const reason = state === "active"
    ? undefined
    : provider.reason ?? provider.lastError ?? firstString(unavailableFacts.map((fact) => fact.reason)) ?? "Semantic planning provider is degraded.";
  const nextAction = state === "active"
    ? undefined
    : firstString([provider.reason, ...unavailableFacts.map((fact) => fact.next_action)]);
  return {
    provider_id: provider.providerId,
    state,
    language_ids: provider.languageIds,
    evidence_sources: sources,
    reason,
    next_action: nextAction
  };
}

function semanticQuery(input: LspSemanticPlanningInput): string {
  const explicit = input.query?.trim();
  if (explicit) {
    return explicit;
  }
  const symbol = input.ownershipHints?.find((hint) => hint.symbol?.trim())?.symbol;
  if (symbol) {
    return symbol;
  }
  const words = input.objective.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return words.sort((left, right) => right.length - left.length)[0] ?? "";
}

function semanticTaskHints(input: {
  objective: string;
  query: string;
  symbols: LspSymbol[];
  diagnostics: LspSemanticRiskHotspot[];
  conflicts: LspSemanticConflictEvidence[];
}): LspSemanticTaskHint[] {
  const hints: LspSemanticTaskHint[] = [];
  if (input.symbols.length) {
    hints.push({
      hint_id: stableId("semantic_scope", input.query, input.symbols.map((symbol) => `${symbol.file}:${symbol.name}`)),
      kind: "semantic_task_scope",
      summary: `Semantic planning found ${input.symbols.length} candidate symbol(s) for "${input.query}" before task decomposition.`,
      confidence: 0.86,
      affected_symbols: input.symbols,
      candidate_files: uniqueStrings(input.symbols.map((symbol) => symbol.file)),
      risk_hotspots: []
    });
  }
  if (input.diagnostics.length) {
    hints.push({
      hint_id: stableId("diagnostic_hotspot", input.objective, input.diagnostics.map((diagnostic) => `${diagnostic.file}:${diagnostic.message}`)),
      kind: "diagnostic_hotspot",
      summary: `Semantic planning found ${input.diagnostics.length} diagnostic hotspot(s) that should shape the task plan.`,
      confidence: 0.78,
      affected_symbols: [],
      candidate_files: uniqueStrings(input.diagnostics.map((diagnostic) => diagnostic.file)),
      risk_hotspots: input.diagnostics
    });
  }
  for (const conflict of input.conflicts) {
    hints.push({
      hint_id: stableId("ownership_conflict", conflict.conflict_id),
      kind: "ownership_conflict",
      summary: `Potential semantic ownership conflict with ${conflict.owner_actor_id} on ${conflict.symbol ?? conflict.file}.`,
      confidence: 0.82,
      affected_symbols: input.symbols.filter((symbol) => !conflict.symbol || symbol.name === conflict.symbol),
      candidate_files: uniqueStrings([conflict.file, ...conflict.references.map((reference) => reference.split(":")[0] ?? reference)]),
      risk_hotspots: conflict.diagnostics
    });
  }
  return hints;
}

async function semanticConflictEvidence(input: {
  provider: TypeScriptSemanticProvider;
  symbols: LspSymbol[];
  diagnostics: LspSemanticRiskHotspot[];
  ownershipHints: LspSemanticOwnershipHint[];
  maxReferences: number;
}): Promise<LspSemanticConflictEvidence[]> {
  const conflicts: LspSemanticConflictEvidence[] = [];
  for (const hint of input.ownershipHints) {
    const symbol = hint.symbol ? input.symbols.find((item) => item.name === hint.symbol) : undefined;
    const file = hint.file;
    const position = hint.range?.start ?? (symbol ? { line: symbol.line, column: symbol.column } : undefined);
    const references = position
      ? referenceStrings(await input.provider.references({
          file,
          line: position.line,
          column: position.column,
          maxResults: input.maxReferences,
          contextLines: 0
        }).catch(() => undefined))
      : [];
    const diagnostics = input.diagnostics.filter((diagnostic) => diagnostic.file === hint.file || (hint.symbol && diagnostic.symbol === hint.symbol));
    if (!references.length && !diagnostics.length && !hint.symbol) {
      continue;
    }
    conflicts.push({
      conflict_id: stableId("semantic_conflict", hint.owner_actor_id, hint.task_id, hint.file, hint.symbol, references),
      owner_actor_id: hint.owner_actor_id,
      task_id: hint.task_id,
      file: hint.file,
      symbol: hint.symbol,
      reason: hint.reason ?? `Existing ownership overlaps semantic symbol/reference evidence for ${hint.symbol ?? hint.file}.`,
      references,
      diagnostics
    });
  }
  return conflicts;
}

function degradedTaskPlan(
  input: LspSemanticPlanningInput,
  options: { root: string; language?: string; reason: string; fallbackCode: string }
): LspSemanticTaskPlan {
  const fallback = lspFallbackFactForFailure({
    action: "lsp.semantic_planning",
    code: options.fallbackCode,
    language: options.language,
    root: options.root,
    message: options.reason
  });
  return {
    schema_version: TASK_PLAN_SCHEMA_VERSION,
    participant_id: PLANNING_PARTICIPANT_ID,
    state: "degraded",
    objective: input.objective,
    root: options.root,
    language: options.language,
    degraded_reason: options.reason,
    recovery_suggestion: fallback.next_action,
    task_hints: [],
    conflict_report: {
      status: "degraded",
      conflicts: []
    }
  };
}

function symbolsFromResult(result: LspOperationResult<{ symbols: LspSymbol[] }>): LspSymbol[] {
  return Array.isArray(result.data.symbols) ? result.data.symbols : [];
}

function diagnosticsFromResult(result: LspOperationResult<{ diagnostics: LspDiagnostic[] }>): LspSemanticRiskHotspot[] {
  return (Array.isArray(result.data.diagnostics) ? result.data.diagnostics : []).map((diagnostic) => ({
    file: diagnostic.file,
    severity: diagnostic.severity,
    message: diagnostic.message,
    range: diagnostic.range
  }));
}

function referenceStrings(result: LspOperationResult<{ groups: LspReferenceGroup[]; total: number }> | undefined): string[] {
  const groups = result?.data.groups;
  if (!Array.isArray(groups)) {
    return [];
  }
  return uniqueStrings(groups.flatMap((group) =>
    group.references.map((reference) => `${reference.file}:${reference.line}:${reference.column}${reference.symbol ? `#${reference.symbol}` : ""}`)
  ));
}

function stableId(...values: unknown[]): string {
  const hash = createHash("sha1").update(JSON.stringify(values)).digest("hex").slice(0, 12);
  return `lsp-plan:${hash}`;
}

function firstString(values: Array<string | undefined>): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))].sort();
}
