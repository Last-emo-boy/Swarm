export type MarkdownLineKind = "paragraph" | "heading" | "list" | "quote" | "code" | "table" | "divider" | "blank";

export type MarkdownLine = {
  kind: MarkdownLineKind;
  text: string;
  bold?: boolean;
  dim?: boolean;
};

export function renderMarkdownLines(input: string): MarkdownLine[] {
  const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.trim()) {
    return [];
  }

  const result: MarkdownLine[] = [];
  const lines = normalized.split("\n");
  let inFence = false;
  let fenceMarker = "";

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const fence = line.match(/^\s*(```+|~~~+)\s*([A-Za-z0-9_+.-]+)?\s*$/u);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1]?.slice(0, 3) ?? "```";
        const language = fence[2]?.trim();
        if (language) {
          result.push({ kind: "code", text: `[${language}]`, dim: true });
        }
        continue;
      }
      if (fence[1]?.startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = "";
        continue;
      }
    }

    if (inFence) {
      result.push({ kind: "code", text: line.length ? `  ${line}` : "" });
      continue;
    }

    if (!line.trim()) {
      pushBlank(result);
      continue;
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/u.test(line)) {
      result.push({ kind: "divider", text: "---", dim: true });
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u);
    if (heading) {
      result.push({ kind: "heading", text: stripInlineMarkdown(heading[2] ?? ""), bold: true });
      continue;
    }

    const quote = line.match(/^\s{0,3}>\s?(.*)$/u);
    if (quote) {
      result.push({ kind: "quote", text: `> ${stripInlineMarkdown(quote[1] ?? "")}`, dim: true });
      continue;
    }

    const unordered = line.match(/^(\s*)[-*+]\s+(.+)$/u);
    if (unordered) {
      result.push({ kind: "list", text: `${boundedIndent(unordered[1] ?? "")}- ${stripInlineMarkdown(unordered[2] ?? "")}` });
      continue;
    }

    const ordered = line.match(/^(\s*)\d+[.)]\s+(.+)$/u);
    if (ordered) {
      result.push({ kind: "list", text: `${boundedIndent(ordered[1] ?? "")}1. ${stripInlineMarkdown(ordered[2] ?? "")}` });
      continue;
    }

    const table = renderTableLine(line);
    if (table) {
      result.push(table);
      continue;
    }

    result.push({ kind: "paragraph", text: stripInlineMarkdown(line) });
  }

  while (result.at(-1)?.kind === "blank") {
    result.pop();
  }
  return result;
}

function pushBlank(lines: MarkdownLine[]): void {
  if (lines.length === 0 || lines.at(-1)?.kind === "blank") {
    return;
  }
  lines.push({ kind: "blank", text: "" });
}

function boundedIndent(value: string): string {
  return " ".repeat(Math.min(6, value.replace(/\t/g, "  ").length));
}

function renderTableLine(line: string): MarkdownLine | undefined {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) {
    return undefined;
  }
  const cells = trimmed
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split("|")
    .map((cell) => stripInlineMarkdown(cell.trim()));
  if (cells.length < 2) {
    return undefined;
  }
  const isSeparator = cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
  return {
    kind: "table",
    text: isSeparator ? cells.map(() => "---").join("  ") : cells.join("  "),
    dim: isSeparator
  };
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/__([^_]+)__/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1");
}
