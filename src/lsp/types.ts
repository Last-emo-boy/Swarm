export type LspProviderName = "typescript" | "python" | "rust" | "go" | string;

export type LspCommonActionFields = {
  provider?: LspProviderName;
  root?: string;
  command?: string;
  args?: readonly string[];
  languageId?: string;
  timeoutMs?: number;
  initializationOptions?: unknown;
  maxItems?: number;
  maxResults?: number;
  contextLines?: number;
};

export type LspDocumentActionFields = LspCommonActionFields & {
  path?: string;
  file?: string;
};

export type LspPositionActionFields = LspDocumentActionFields & {
  line?: number;
  lineZeroBased?: number;
  character?: number;
  column?: number;
};

export type LspRangeActionFields = LspDocumentActionFields & {
  range?: LspRange;
  line?: number;
  lineZeroBased?: number;
  character?: number;
  column?: number;
  startLine?: number;
  startCharacter?: number;
  endLine?: number;
  endCharacter?: number;
};

export type LspDiagnosticsAction = LspCommonActionFields & {
  type: "lsp.diagnostics";
  path?: string;
  file?: string;
  diagnosticsTimeoutMs?: number;
};

export type LspHoverAction = LspPositionActionFields & {
  type: "lsp.hover";
};

export type LspDefinitionAction = LspPositionActionFields & {
  type: "lsp.definition";
};

export type LspReferencesAction = LspPositionActionFields & {
  type: "lsp.references";
  includeDeclaration?: boolean;
};

export type LspDocumentSymbolsAction = LspDocumentActionFields & {
  type: "lsp.document_symbols";
};

export type LspWorkspaceSymbolsAction = LspCommonActionFields & {
  type: "lsp.workspace_symbols";
  query?: string;
};

export type LspCompletionAction = LspPositionActionFields & {
  type: "lsp.completion";
  triggerCharacter?: string;
  prefix?: string;
};

export type LspCodeActionsAction = LspRangeActionFields & {
  type: "lsp.code_actions";
  diagnostics?: unknown[];
  only?: string[];
};

export type LspRenamePreviewAction = LspPositionActionFields & {
  type: "lsp.rename_preview";
  newName: string;
};

export type LspFormatAction = LspDocumentActionFields & {
  type: "lsp.format";
  tabSize?: number;
  insertSpaces?: boolean;
};

export type LspToolAction =
  | LspDiagnosticsAction
  | LspHoverAction
  | LspDefinitionAction
  | LspReferencesAction
  | LspDocumentSymbolsAction
  | LspWorkspaceSymbolsAction
  | LspCompletionAction
  | LspCodeActionsAction
  | LspRenamePreviewAction
  | LspFormatAction;

export type LspPoint = {
  line: number;
  column: number;
};

export type LspRange = {
  start: LspPoint;
  end: LspPoint;
};

export type SemanticEvidence = {
  schema_version: "swarm.semantic_evidence.v1";
  evidence_id: string;
  source: "lsp" | "fallback" | "file";
  action: LspToolAction["type"] | string;
  status: "success" | "partial" | "failed";
  lsp_status?: string;
  language?: string;
  provider?: string;
  root?: string;
  symbol?: string;
  range?: LspRange;
  confidence: number;
  staleness: "fresh" | "stale" | "fallback" | "unknown";
  stale_reason?: string;
  fallback_used: boolean;
  fallback_reason?: string;
  fallback_tools?: string[];
  next_action?: string;
  truncated?: boolean;
  summary: string;
  result_keys: string[];
  primary_refs: string[];
  changed_files?: string[];
};

export type LspSemanticPlanningState = "active" | "degraded" | "unavailable";

export type LspSemanticPlanningProvider = {
  provider_id: string;
  state: LspSemanticPlanningState;
  language_ids: string[];
  evidence_sources: string[];
  reason?: string;
  next_action?: string;
};

export type LspSemanticPlanningStatus = {
  schema_version: "swarm.lsp_semantic_planning.v1";
  participant_id: "capability:lsp:planning";
  state: LspSemanticPlanningState;
  generated_at: string;
  providers: LspSemanticPlanningProvider[];
  task_hint_capable: boolean;
  conflict_evidence_capable: boolean;
  degraded_reason?: string;
  next_action?: string;
};

export type LspSemanticOwnershipHint = {
  owner_actor_id: string;
  task_id?: string;
  file: string;
  symbol?: string;
  range?: LspRange;
  reason?: string;
};

export type LspSemanticRiskHotspot = {
  file: string;
  severity: LspDiagnostic["severity"] | "unknown";
  message: string;
  symbol?: string;
  range?: LspRange;
};

export type LspSemanticTaskHint = {
  hint_id: string;
  kind: "semantic_task_scope" | "diagnostic_hotspot" | "ownership_conflict";
  summary: string;
  confidence: number;
  affected_symbols: LspSymbol[];
  candidate_files: string[];
  risk_hotspots: LspSemanticRiskHotspot[];
};

export type LspSemanticConflictEvidence = {
  conflict_id: string;
  owner_actor_id: string;
  task_id?: string;
  file: string;
  symbol?: string;
  reason: string;
  references: string[];
  diagnostics: LspSemanticRiskHotspot[];
};

export type LspSemanticTaskPlan = {
  schema_version: "swarm.lsp_semantic_task_plan.v1";
  participant_id: "capability:lsp:planning";
  state: LspSemanticPlanningState;
  objective: string;
  root: string;
  language?: string;
  provider?: string;
  degraded_reason?: string;
  recovery_suggestion?: string;
  task_hints: LspSemanticTaskHint[];
  conflict_report: {
    status: "clear" | "conflict" | "degraded";
    conflicts: LspSemanticConflictEvidence[];
  };
};

export type LspOperationStatus = {
  code: "ready" | "partial" | "symbol_not_found" | "unsupported_language" | "request_timeout" | "failed" | string;
  language?: string;
  provider?: string;
  root?: string;
  message?: string;
};

export type LspOperationResult<T> = {
  status: LspOperationStatus;
  summary: string;
  content?: string;
  data: T;
  truncated?: boolean;
};

export type LspDiagnostic = {
  file: string;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
  code?: string | number;
  range?: LspRange;
  snippet?: string;
};

export type LspHover = {
  file: string;
  line: number;
  column: number;
  signature: string;
  documentation?: string;
  tags?: string[];
  snippet?: string;
};

export type LspLocation = {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  symbol?: string;
  kind?: string;
  container?: string;
  signature?: string;
  snippet?: string;
};

export type LspReferenceGroup = {
  file: string;
  references: Array<LspLocation & { isDefinition?: boolean; isWriteAccess?: boolean }>;
};

export type LspSymbol = {
  name: string;
  kind: string;
  file: string;
  line: number;
  column: number;
  container?: string;
  detail?: string;
  score?: number;
};

export type LspCompletionItem = {
  name: string;
  kind: string;
  sortText?: string;
  detail?: string;
};

export type LspCodeAction = {
  title: string;
  fixName?: string;
  kind?: string;
  affectedFiles: string[];
  editCount: number;
};

export type LspRenamePreview = {
  canRename: boolean;
  reason?: string;
  displayName?: string;
  fullDisplayName?: string;
  triggerSpan?: LspRange;
  locations: Array<LspLocation & { oldText?: string; newText: string }>;
  truncated?: boolean;
};

export type LspFormatEdit = {
  file: string;
  range: LspRange;
  newText: string;
};
