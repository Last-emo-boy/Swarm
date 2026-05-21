import { clampCursor, nextGraphemeBoundary } from "./input-editing.js";

export const INPUT_RENDER_ROWS = 4;

export type InputViewport = {
  value: string;
  cursor: number;
  rows: number;
};

export type InputLineRenderParts = {
  before: string;
  current: string;
  after: string;
};

export function renderInputLineParts(value: string, cursor: number, maxRows = INPUT_RENDER_ROWS): InputLineRenderParts {
  const safeCursor = clampCursor(value, cursor);
  const viewport = inputViewport(value, safeCursor, normalizeInputRenderRows(maxRows));
  const before = viewport.value.slice(0, viewport.cursor);
  const currentEnd = nextGraphemeBoundary(viewport.value, viewport.cursor);
  const current = viewport.value.slice(viewport.cursor, currentEnd);
  if (current === "\n") {
    return {
      before,
      current: " ",
      after: viewport.value.slice(viewport.cursor)
    };
  }
  return {
    before,
    current: current || " ",
    after: viewport.value.slice(currentEnd)
  };
}

export function inputViewport(value: string, cursor: number, maxRows: number): InputViewport {
  if (!value.includes("\n")) {
    return { value, cursor, rows: 1 };
  }
  const lineStarts = [0];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\n") {
      lineStarts.push(index + 1);
    }
  }
  const cursorLine = Math.max(
    0,
    lineStarts.findIndex((start, index) => cursor >= start && (index === lineStarts.length - 1 || cursor < lineStarts[index + 1]))
  );
  const windowRows = normalizeInputRenderRows(maxRows);
  let startLine = Math.max(0, cursorLine - windowRows + 1);
  let endLine = Math.min(lineStarts.length - 1, startLine + windowRows - 1);
  if (endLine < cursorLine) {
    endLine = cursorLine;
    startLine = Math.max(0, endLine - windowRows + 1);
  }
  const start = lineStarts[startLine] ?? 0;
  const end = endLine + 1 < lineStarts.length ? lineStarts[endLine + 1] - 1 : value.length;
  const prefix = startLine > 0 ? "... " : "";
  const suffix = endLine < lineStarts.length - 1 ? " ..." : "";
  const visibleSource = value.slice(start, end);
  const visible = renderViewportText(visibleSource);
  const beforeCursor = renderViewportText(value.slice(start, Math.max(start, Math.min(cursor, end))));
  return {
    value: `${prefix}${visible}${suffix}`,
    cursor: prefix.length + beforeCursor.length,
    rows: endLine - startLine + 1
  };
}

export function visibleInputRows(value: string, cursor: number, maxRows = INPUT_RENDER_ROWS): number {
  return inputViewport(value, cursor, normalizeInputRenderRows(maxRows)).rows;
}

function renderViewportText(value: string): string {
  return value;
}

function normalizeInputRenderRows(value: number): number {
  return Math.max(1, Math.floor(Number.isFinite(value) ? value : INPUT_RENDER_ROWS));
}
