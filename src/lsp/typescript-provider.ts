import { readdir, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import type {
  LspCodeAction,
  LspCompletionItem,
  LspDiagnostic,
  LspFormatEdit,
  LspHover,
  LspLocation,
  LspOperationResult,
  LspPoint,
  LspRange,
  LspReferenceGroup,
  LspRenamePreview,
  LspSymbol
} from "./types.js";

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".swarm", ".workflow", "coverage", ".cache"]);
const SOURCE_EXTENSIONS = /\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i;
const MAX_PROJECT_FILES = 2500;
const PROJECT_REFRESH_TTL_MS = 15_000;

export class TypeScriptSemanticProvider {
  readonly language = "typescript";
  readonly providerId = "typescript-language-service";

  private readonly root: string;
  private readonly configPath?: string;
  private readonly options: ts.CompilerOptions;
  private readonly files = new Set<string>();
  private readonly versions = new Map<string, string>();
  private readonly service: ts.LanguageService;
  private refreshedAt = 0;

  private constructor(root: string, configPath: string | undefined, options: ts.CompilerOptions, files: string[]) {
    this.root = root;
    this.configPath = configPath;
    this.options = options;
    for (const file of files) {
      this.files.add(resolve(file));
    }
    this.service = ts.createLanguageService(this.host(), ts.createDocumentRegistry());
  }

  static async create(root: string): Promise<TypeScriptSemanticProvider> {
    const parsed = await loadProject(root);
    const provider = new TypeScriptSemanticProvider(root, parsed.configPath, parsed.options, parsed.files);
    await provider.refreshProjectFiles();
    return provider;
  }

  status(): { provider: string; root: string; configPath?: string; files: number } {
    return {
      provider: this.providerId,
      root: this.root,
      configPath: this.configPath,
      files: this.files.size
    };
  }

  async diagnostics(input: { file?: string; maxResults?: number; contextLines?: number }): Promise<LspOperationResult<{ diagnostics: LspDiagnostic[] }>> {
    await this.refreshProjectFiles(input.file ? [input.file] : undefined);
    const maxResults = clamp(input.maxResults ?? 50, 1, 250);
    const candidates = input.file ? [resolve(input.file)] : [...this.files].slice(0, 100);
    const diagnostics: LspDiagnostic[] = [];
    for (const file of candidates) {
      if (!this.isKnownSource(file)) {
        continue;
      }
      for (const diagnostic of [
        ...this.service.getSyntacticDiagnostics(file),
        ...this.service.getSemanticDiagnostics(file),
        ...this.service.getSuggestionDiagnostics(file)
      ]) {
        const mapped = this.mapDiagnostic(diagnostic, input.contextLines ?? 2);
        if (mapped) {
          diagnostics.push(mapped);
        }
      }
      if (diagnostics.length >= maxResults) {
        break;
      }
    }
    diagnostics.sort(compareDiagnostics);
    const selected = diagnostics.slice(0, maxResults);
    const truncated = diagnostics.length > selected.length;
    return {
      status: { code: truncated ? "partial" : "ready", language: this.language, provider: this.providerId, root: this.root },
      summary: selected.length ? `found ${selected.length}${truncated ? "+" : ""} TypeScript diagnostic(s)` : "no TypeScript diagnostics",
      data: { diagnostics: selected },
      content: renderDiagnostics(selected, truncated),
      truncated
    };
  }

  async hover(input: { file: string; line: number; column: number; contextLines?: number }): Promise<LspOperationResult<{ hover?: LspHover }>> {
    await this.refreshProjectFiles([input.file]);
    const file = resolve(input.file);
    const offset = this.positionToOffset(file, input.line, input.column);
    const info = this.service.getQuickInfoAtPosition(file, offset);
    if (!info) {
      return symbolNotFound("no hover information at position", this.root, this.language, this.providerId, { hover: undefined });
    }
    const point = this.offsetToPoint(file, info.textSpan.start);
    const hover: LspHover = {
      file: this.display(file),
      line: point.line,
      column: point.column,
      signature: ts.displayPartsToString(info.displayParts ?? []),
      documentation: ts.displayPartsToString(info.documentation ?? []) || undefined,
      tags: info.tags?.map((tag) => tag.text?.map((part) => part.text).join("") || tag.name).filter(Boolean),
      snippet: this.snippet(file, point.line, input.contextLines ?? 3)
    };
    return {
      status: { code: "ready", language: this.language, provider: this.providerId, root: this.root },
      summary: `hover: ${hover.signature}`,
      data: { hover },
      content: renderHover(hover)
    };
  }

  async definition(input: { file: string; line: number; column: number; maxResults?: number; contextLines?: number }): Promise<LspOperationResult<{ definitions: LspLocation[] }>> {
    await this.refreshProjectFiles([input.file]);
    const file = resolve(input.file);
    const offset = this.positionToOffset(file, input.line, input.column);
    const definitions = dedupeLocations(
      (this.service.getDefinitionAtPosition(file, offset) ?? [])
        .map((definition) => this.locationFromSpan(definition.fileName, definition.textSpan, {
          symbol: definition.name,
          kind: definition.kind,
          container: definition.containerName,
          contextLines: input.contextLines ?? 20
        }))
        .filter((location): location is LspLocation => Boolean(location))
    ).slice(0, clamp(input.maxResults ?? 8, 1, 50));
    if (!definitions.length) {
      return symbolNotFound("definition not found", this.root, this.language, this.providerId, { definitions });
    }
    return {
      status: { code: "ready", language: this.language, provider: this.providerId, root: this.root },
      summary: `found ${definitions.length} definition(s)`,
      data: { definitions },
      content: renderLocations("Definitions", definitions)
    };
  }

  async references(input: { file: string; line: number; column: number; maxResults?: number; contextLines?: number }): Promise<LspOperationResult<{ groups: LspReferenceGroup[]; total: number }>> {
    await this.refreshProjectFiles([input.file]);
    const file = resolve(input.file);
    const offset = this.positionToOffset(file, input.line, input.column);
    const maxResults = clamp(input.maxResults ?? 80, 1, 500);
    const refs = this.service.findReferences(file, offset) ?? [];
    const flat: Array<LspLocation & { isDefinition?: boolean; isWriteAccess?: boolean }> = [];
    for (const symbol of refs) {
      for (const reference of symbol.references) {
        const location = this.locationFromSpan(reference.fileName, reference.textSpan, {
          symbol: symbol.definition?.name,
          kind: symbol.definition?.kind,
          container: symbol.definition?.containerName,
          contextLines: input.contextLines ?? 2
        });
        if (location) {
          flat.push({ ...location, isDefinition: reference.isDefinition, isWriteAccess: reference.isWriteAccess });
        }
      }
    }
    const selected = flat.slice(0, maxResults);
    const groups = groupReferences(selected);
    if (!flat.length) {
      return symbolNotFound("references not found", this.root, this.language, this.providerId, { groups, total: 0 });
    }
    const truncated = flat.length > selected.length;
    return {
      status: { code: truncated ? "partial" : "ready", language: this.language, provider: this.providerId, root: this.root },
      summary: `found ${selected.length}${truncated ? `/${flat.length}` : ""} reference(s) in ${groups.length} file(s)`,
      data: { groups, total: flat.length },
      content: renderReferenceGroups(groups, truncated),
      truncated
    };
  }

  async documentSymbols(input: { file: string; maxResults?: number }): Promise<LspOperationResult<{ symbols: LspSymbol[] }>> {
    await this.refreshProjectFiles([input.file]);
    const file = resolve(input.file);
    const tree = this.service.getNavigationTree(file);
    const symbols = flattenNavigationTree(tree, (span, item, container) => {
      const location = this.locationFromSpan(file, span, {
        symbol: item.text,
        kind: item.kind,
        container,
        contextLines: 0
      });
      if (!location) {
        return undefined;
      }
      return {
        name: item.text,
        kind: item.kind,
        file: location.file,
        line: location.line,
        column: location.column,
        container,
        detail: item.kindModifiers || undefined
      };
    }).slice(0, clamp(input.maxResults ?? 80, 1, 500));
    return {
      status: { code: "ready", language: this.language, provider: this.providerId, root: this.root },
      summary: `found ${symbols.length} document symbol(s)`,
      data: { symbols },
      content: renderSymbols("Document Symbols", symbols)
    };
  }

  async workspaceSymbols(input: { query: string; maxResults?: number }): Promise<LspOperationResult<{ symbols: LspSymbol[] }>> {
    await this.refreshProjectFiles();
    const maxResults = clamp(input.maxResults ?? 80, 1, 500);
    const raw = this.service.getNavigateToItems(input.query, maxResults * 4, undefined, true, true);
    const seen = new Set<string>();
    const symbols = raw
      .map((item) => this.symbolFromNavigateToItem(item, input.query))
      .filter((item): item is LspSymbol => Boolean(item))
      .filter((item) => {
        const key = `${item.file}:${item.line}:${item.column}:${item.name}:${item.kind}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      })
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || left.file.localeCompare(right.file) || left.line - right.line)
      .slice(0, maxResults);
    return {
      status: { code: "ready", language: this.language, provider: this.providerId, root: this.root },
      summary: `found ${symbols.length} workspace symbol(s) for "${input.query}"`,
      data: { symbols },
      content: renderSymbols("Workspace Symbols", symbols)
    };
  }

  async completion(input: { file: string; line: number; column: number; prefix?: string; maxResults?: number }): Promise<LspOperationResult<{ completions: LspCompletionItem[] }>> {
    await this.refreshProjectFiles([input.file]);
    const file = resolve(input.file);
    const offset = this.positionToOffset(file, input.line, input.column);
    const maxResults = clamp(input.maxResults ?? 40, 1, 200);
    const prefix = input.prefix?.toLowerCase();
    const completions = (this.service.getCompletionsAtPosition(file, offset, {
      includeCompletionsForModuleExports: true,
      includeCompletionsWithInsertText: true
    })?.entries ?? [])
      .filter((entry) => !prefix || entry.name.toLowerCase().startsWith(prefix))
      .slice(0, maxResults)
      .map((entry): LspCompletionItem => ({
        name: entry.name,
        kind: entry.kind,
        sortText: entry.sortText,
        detail: entry.source
      }));
    return {
      status: { code: "ready", language: this.language, provider: this.providerId, root: this.root },
      summary: `found ${completions.length} completion(s)`,
      data: { completions },
      content: completions.map((item) => `${item.name} (${item.kind})${item.detail ? ` - ${item.detail}` : ""}`).join("\n")
    };
  }

  async codeActions(input: { file: string; range?: LspRange; line?: number; column?: number; maxResults?: number }): Promise<LspOperationResult<{ actions: LspCodeAction[] }>> {
    await this.refreshProjectFiles([input.file]);
    const file = resolve(input.file);
    const range = input.range ?? this.pointRange(file, input.line ?? 1, input.column ?? 1);
    const start = this.pointToOffset(file, range.start);
    const end = this.pointToOffset(file, range.end);
    const diagnostics = [
      ...this.service.getSyntacticDiagnostics(file),
      ...this.service.getSemanticDiagnostics(file)
    ].filter((diagnostic) => diagnostic.start !== undefined && rangesOverlap(diagnostic.start, diagnostic.start + (diagnostic.length ?? 0), start, end));
    const errorCodes = [...new Set(diagnostics.map((diagnostic) => diagnostic.code))];
    const fixes = errorCodes.length
      ? this.service.getCodeFixesAtPosition(file, start, end, errorCodes, defaultFormatOptions(), {})
      : [];
    const actions = fixes.slice(0, clamp(input.maxResults ?? 20, 1, 100)).map((fix): LspCodeAction => ({
      title: fix.description,
      fixName: fix.fixName,
      kind: typeof fix.fixId === "string" ? fix.fixId : undefined,
      affectedFiles: [...new Set(fix.changes.map((change) => this.display(change.fileName)))],
      editCount: fix.changes.reduce((sum, change) => sum + change.textChanges.length, 0)
    }));
    return {
      status: { code: "ready", language: this.language, provider: this.providerId, root: this.root },
      summary: `found ${actions.length} code action(s)`,
      data: { actions },
      content: actions.map((action) => `${action.title} (${action.editCount} edit${action.editCount === 1 ? "" : "s"})`).join("\n")
    };
  }

  async renamePreview(input: { file: string; line: number; column: number; newName: string; maxResults?: number; contextLines?: number }): Promise<LspOperationResult<LspRenamePreview>> {
    await this.refreshProjectFiles([input.file]);
    const file = resolve(input.file);
    const offset = this.positionToOffset(file, input.line, input.column);
    const renameInfo = this.service.getRenameInfo(file, offset, {});
    if (!renameInfo.canRename) {
      const data: LspRenamePreview = {
        canRename: false,
        reason: renameInfo.localizedErrorMessage,
        locations: []
      };
      return {
        status: { code: "symbol_not_found", message: renameInfo.localizedErrorMessage, language: this.language, provider: this.providerId, root: this.root },
        summary: renameInfo.localizedErrorMessage || "symbol cannot be renamed",
        data,
        content: renameInfo.localizedErrorMessage
      };
    }
    const locations = this.service.findRenameLocations(file, offset, false, false, true) ?? [];
    const maxResults = clamp(input.maxResults ?? 80, 1, 500);
    const selected = locations.slice(0, maxResults).flatMap((location): LspRenamePreview["locations"] => {
      const mapped = this.locationFromSpan(location.fileName, location.textSpan, {
        symbol: renameInfo.displayName,
        kind: renameInfo.kind,
        contextLines: input.contextLines ?? 2
      });
      const oldText = this.textForSpan(location.fileName, location.textSpan);
      return mapped
        ? [{
            ...mapped,
            oldText,
            newText: `${location.prefixText ?? ""}${input.newName}${location.suffixText ?? ""}`
          }]
        : [];
    });
    const data: LspRenamePreview = {
      canRename: true,
      displayName: renameInfo.displayName,
      fullDisplayName: renameInfo.fullDisplayName,
      triggerSpan: this.rangeFromSpan(file, renameInfo.triggerSpan),
      locations: selected,
      truncated: locations.length > selected.length
    };
    return {
      status: { code: data.truncated ? "partial" : "ready", language: this.language, provider: this.providerId, root: this.root },
      summary: `rename preview for ${renameInfo.displayName}: ${selected.length}${data.truncated ? `/${locations.length}` : ""} location(s)`,
      data,
      content: renderRenamePreview(data)
    };
  }

  async format(input: { file: string; maxResults?: number }): Promise<LspOperationResult<{ edits: LspFormatEdit[] }>> {
    await this.refreshProjectFiles([input.file]);
    const file = resolve(input.file);
    const maxResults = clamp(input.maxResults ?? 80, 1, 500);
    const edits = this.service.getFormattingEditsForDocument(file, defaultFormatOptions())
      .slice(0, maxResults)
      .map((edit): LspFormatEdit => ({
        file: this.display(file),
        range: this.rangeFromSpan(file, edit.span),
        newText: truncateText(edit.newText, 500)
      }));
    return {
      status: { code: "ready", language: this.language, provider: this.providerId, root: this.root },
      summary: `format preview produced ${edits.length} edit(s)`,
      data: { edits },
      content: edits.map((edit) => `${edit.file}:${edit.range.start.line}:${edit.range.start.column} -> ${JSON.stringify(edit.newText)}`).join("\n")
    };
  }

  private host(): ts.LanguageServiceHost {
    return {
      getCompilationSettings: () => this.options,
      getScriptFileNames: () => [...this.files],
      getScriptVersion: (fileName) => this.versions.get(resolve(fileName)) ?? "0",
      getScriptSnapshot: (fileName) => {
        const text = ts.sys.readFile(fileName);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => this.root,
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      realpath: ts.sys.realpath,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames
    };
  }

  private async refreshProjectFiles(focusFiles: string[] = []): Promise<void> {
    const now = Date.now();
    if (!this.configPath && (now - this.refreshedAt > PROJECT_REFRESH_TTL_MS || this.files.size === 0)) {
      const files = await collectSourceFiles(this.root);
      this.files.clear();
      for (const file of files) {
        this.files.add(file);
      }
      this.refreshedAt = now;
    }
    for (const file of focusFiles) {
      const resolved = resolve(file);
      if (SOURCE_EXTENSIONS.test(resolved)) {
        this.files.add(resolved);
      }
    }
    await Promise.all([...this.files].map((file) => this.updateVersion(file)));
  }

  private async updateVersion(file: string): Promise<void> {
    try {
      const info = await stat(file);
      this.versions.set(resolve(file), `${info.size}:${info.mtimeMs}`);
    } catch {
      this.versions.delete(resolve(file));
      this.files.delete(resolve(file));
    }
  }

  private isKnownSource(file: string): boolean {
    return SOURCE_EXTENSIONS.test(file) && this.files.has(resolve(file));
  }

  private mapDiagnostic(diagnostic: ts.Diagnostic, contextLines: number): LspDiagnostic | undefined {
    if (!diagnostic.file) {
      return undefined;
    }
    const file = diagnostic.file.fileName;
    const range = diagnostic.start === undefined
      ? undefined
      : this.rangeFromSpan(file, { start: diagnostic.start, length: diagnostic.length ?? 0 });
    return {
      file: this.display(file),
      severity: diagnosticSeverity(diagnostic.category),
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      source: "typescript",
      code: diagnostic.code,
      range,
      snippet: range ? this.snippet(file, range.start.line, contextLines) : undefined
    };
  }

  private symbolFromNavigateToItem(item: ts.NavigateToItem, query: string): LspSymbol | undefined {
    const location = this.locationFromSpan(item.fileName, item.textSpan, {
      symbol: item.name,
      kind: item.kind,
      container: item.containerName,
      contextLines: 0
    });
    if (!location) {
      return undefined;
    }
    return {
      name: item.name,
      kind: item.kind,
      file: location.file,
      line: location.line,
      column: location.column,
      container: item.containerName,
      detail: item.kindModifiers || undefined,
      score: symbolScore(item.name, query)
    };
  }

  private locationFromSpan(fileName: string, span: ts.TextSpan, extra: { symbol?: string; kind?: string; container?: string; contextLines: number }): LspLocation | undefined {
    if (!SOURCE_EXTENSIONS.test(fileName)) {
      return undefined;
    }
    const range = this.rangeFromSpan(fileName, span);
    return {
      file: this.display(fileName),
      line: range.start.line,
      column: range.start.column,
      endLine: range.end.line,
      endColumn: range.end.column,
      symbol: extra.symbol,
      kind: extra.kind,
      container: extra.container,
      snippet: extra.contextLines > 0 ? this.snippet(fileName, range.start.line, extra.contextLines) : undefined
    };
  }

  private positionToOffset(file: string, line: number, column: number): number {
    return this.pointToOffset(file, { line, column });
  }

  private pointToOffset(file: string, point: LspPoint): number {
    const source = this.sourceFile(file);
    const lineStarts = source.getLineStarts();
    const lineIndex = clamp(point.line - 1, 0, Math.max(0, lineStarts.length - 1));
    const start = lineStarts[lineIndex] ?? 0;
    const nextStart = lineStarts[lineIndex + 1] ?? source.text.length + 1;
    return clamp(start + Math.max(0, point.column - 1), start, Math.max(start, nextStart - 1));
  }

  private offsetToPoint(file: string, offset: number): LspPoint {
    const point = this.sourceFile(file).getLineAndCharacterOfPosition(offset);
    return { line: point.line + 1, column: point.character + 1 };
  }

  private rangeFromSpan(file: string, span: ts.TextSpan): LspRange {
    const start = this.offsetToPoint(file, span.start);
    const end = this.offsetToPoint(file, span.start + span.length);
    return { start, end };
  }

  private pointRange(file: string, line: number, column: number): LspRange {
    const offset = this.positionToOffset(file, line, column);
    return this.rangeFromSpan(file, { start: offset, length: 1 });
  }

  private sourceFile(file: string): ts.SourceFile {
    const resolved = resolve(file);
    const fromProgram = this.service.getProgram()?.getSourceFile(resolved);
    if (fromProgram) {
      return fromProgram;
    }
    const text = ts.sys.readFile(resolved) ?? "";
    return ts.createSourceFile(resolved, text, ts.ScriptTarget.Latest, true);
  }

  private textForSpan(file: string, span: ts.TextSpan): string | undefined {
    const text = this.sourceFile(file).text;
    return text.slice(span.start, span.start + span.length) || undefined;
  }

  private snippet(file: string, line: number, contextLines: number): string {
    const text = this.sourceFile(file).text;
    const lines = text.split(/\r?\n/);
    const start = Math.max(1, line - contextLines);
    const end = Math.min(lines.length, line + contextLines);
    return lines.slice(start - 1, end).map((value, index) => `${start + index}: ${value}`).join("\n");
  }

  private display(file: string): string {
    const rel = relative(this.root, resolve(file)).replace(/\\/g, "/");
    return rel.startsWith("..") ? resolve(file).replace(/\\/g, "/") : rel || ".";
  }
}

async function loadProject(root: string): Promise<{ configPath?: string; options: ts.CompilerOptions; files: string[] }> {
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json")
    ?? ts.findConfigFile(root, ts.sys.fileExists, "jsconfig.json");
  if (configPath) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!config.error) {
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
      return {
        configPath,
        options: parsed.options,
        files: parsed.fileNames.filter((file) => SOURCE_EXTENSIONS.test(file))
      };
    }
  }
  return {
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      jsx: ts.JsxEmit.ReactJSX,
      allowJs: true,
      checkJs: false,
      strict: true,
      skipLibCheck: true
    },
    files: await collectSourceFiles(root)
  };
}

async function collectSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (files.length >= MAX_PROJECT_FILES) {
      return;
    }
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= MAX_PROJECT_FILES || SKIP_DIRS.has(entry.name)) {
        continue;
      }
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.test(entry.name)) {
        files.push(fullPath);
      }
    }
  }
  await walk(resolve(root));
  return files;
}

function flattenNavigationTree<T>(tree: ts.NavigationTree, map: (span: ts.TextSpan, item: ts.NavigationTree, container?: string) => T | undefined, container?: string): T[] {
  const own = tree.spans.flatMap((span) => {
    const item = map(span, tree, container);
    return item ? [item] : [];
  });
  const childContainer = tree.text === "<global>" ? container : tree.text;
  return [
    ...own,
    ...(tree.childItems ?? []).flatMap((child) => flattenNavigationTree(child, map, childContainer))
  ];
}

function diagnosticSeverity(category: ts.DiagnosticCategory): LspDiagnostic["severity"] {
  if (category === ts.DiagnosticCategory.Error) return "error";
  if (category === ts.DiagnosticCategory.Warning) return "warning";
  if (category === ts.DiagnosticCategory.Suggestion) return "hint";
  return "info";
}

function compareDiagnostics(left: LspDiagnostic, right: LspDiagnostic): number {
  const severity = severityRank(left.severity) - severityRank(right.severity);
  if (severity !== 0) return severity;
  return left.file.localeCompare(right.file)
    || (left.range?.start.line ?? 0) - (right.range?.start.line ?? 0)
    || (left.range?.start.column ?? 0) - (right.range?.start.column ?? 0);
}

function severityRank(severity: LspDiagnostic["severity"]): number {
  return { error: 0, warning: 1, info: 2, hint: 3 }[severity];
}

function groupReferences(references: Array<LspLocation & { isDefinition?: boolean; isWriteAccess?: boolean }>): LspReferenceGroup[] {
  const groups = new Map<string, LspReferenceGroup>();
  for (const reference of references) {
    const group = groups.get(reference.file) ?? { file: reference.file, references: [] };
    group.references.push(reference);
    groups.set(reference.file, group);
  }
  return [...groups.values()].sort((left, right) => left.file.localeCompare(right.file));
}

function dedupeLocations(locations: LspLocation[]): LspLocation[] {
  const seen = new Set<string>();
  return locations.filter((location) => {
    const key = `${location.file}:${location.line}:${location.column}:${location.symbol ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function symbolScore(name: string, query: string): number {
  const normalizedName = name.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  if (normalizedName === normalizedQuery) return 100;
  if (normalizedName.startsWith(normalizedQuery)) return 80;
  if (normalizedName.includes(normalizedQuery)) return 60;
  let score = 0;
  let queryIndex = 0;
  for (const char of normalizedName) {
    if (char === normalizedQuery[queryIndex]) {
      score += 3;
      queryIndex += 1;
    }
  }
  return score;
}

function rangesOverlap(start: number, end: number, targetStart: number, targetEnd: number): boolean {
  return start <= targetEnd && end >= targetStart;
}

function defaultFormatOptions(): ts.FormatCodeSettings {
  return {
    indentSize: 2,
    tabSize: 2,
    convertTabsToSpaces: true,
    newLineCharacter: "\n",
    insertSpaceAfterCommaDelimiter: true,
    insertSpaceAfterSemicolonInForStatements: true,
    insertSpaceBeforeAndAfterBinaryOperators: true,
    insertSpaceAfterKeywordsInControlFlowStatements: true,
    insertSpaceAfterFunctionKeywordForAnonymousFunctions: true,
    placeOpenBraceOnNewLineForFunctions: false,
    placeOpenBraceOnNewLineForControlBlocks: false
  };
}

function renderDiagnostics(diagnostics: LspDiagnostic[], truncated: boolean): string {
  if (!diagnostics.length) {
    return "No diagnostics.";
  }
  const lines = diagnostics.flatMap((diagnostic) => [
    `${diagnostic.severity.toUpperCase()} ${diagnostic.file}${diagnostic.range ? `:${diagnostic.range.start.line}:${diagnostic.range.start.column}` : ""} ${diagnostic.message}`,
    diagnostic.snippet ? diagnostic.snippet : undefined
  ].filter((line): line is string => Boolean(line)));
  if (truncated) {
    lines.push("... diagnostics truncated");
  }
  return lines.join("\n");
}

function renderHover(hover: LspHover): string {
  return [
    `${hover.file}:${hover.line}:${hover.column}`,
    hover.signature,
    hover.documentation,
    hover.snippet
  ].filter(Boolean).join("\n");
}

function renderLocations(title: string, locations: LspLocation[]): string {
  return [
    title,
    ...locations.flatMap((location) => [
      `${location.file}:${location.line}:${location.column}${location.symbol ? ` ${location.symbol}` : ""}${location.kind ? ` (${location.kind})` : ""}`,
      location.snippet
    ].filter((line): line is string => Boolean(line)))
  ].join("\n");
}

function renderReferenceGroups(groups: LspReferenceGroup[], truncated: boolean): string {
  const lines: string[] = [];
  for (const group of groups) {
    lines.push(group.file);
    for (const reference of group.references) {
      lines.push(`  ${reference.line}:${reference.column}${reference.isDefinition ? " definition" : ""}${reference.isWriteAccess ? " write" : ""}`);
      if (reference.snippet) {
        lines.push(reference.snippet.split("\n").map((line) => `    ${line}`).join("\n"));
      }
    }
  }
  if (truncated) {
    lines.push("... references truncated");
  }
  return lines.join("\n");
}

function renderSymbols(title: string, symbols: LspSymbol[]): string {
  return [
    title,
    ...symbols.map((symbol) => `${symbol.file}:${symbol.line}:${symbol.column} ${symbol.name} (${symbol.kind})${symbol.container ? ` in ${symbol.container}` : ""}`)
  ].join("\n");
}

function renderRenamePreview(preview: LspRenamePreview): string {
  if (!preview.canRename) {
    return preview.reason ?? "symbol cannot be renamed";
  }
  const lines = [`Rename ${preview.displayName ?? "symbol"} -> ${preview.locations[0]?.newText ?? "(new name)"}`];
  for (const location of preview.locations) {
    lines.push(`${location.file}:${location.line}:${location.column} ${location.oldText ?? ""} -> ${location.newText}`);
    if (location.snippet) {
      lines.push(location.snippet);
    }
  }
  if (preview.truncated) {
    lines.push("... rename locations truncated");
  }
  return lines.join("\n");
}

function symbolNotFound<T>(message: string, root: string, language: string, provider: string, data: T): LspOperationResult<T> {
  return {
    status: { code: "symbol_not_found", message, language, provider, root },
    summary: message,
    data,
    content: message
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
