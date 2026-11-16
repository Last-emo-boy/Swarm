import { displayWidth } from "./display-width.js";
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

export function renderInputLineParts(value: string, cursor: number, maxRows = INPUT_RENDER_ROWS, width?: number): InputLineRenderParts {
  const safeCursor = clampCursor(value, cursor);
  const viewport = inputViewport(value, safeCursor, normalizeInputRenderRows(maxRows), width);
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

/** How many rows a line of text takes when the terminal wraps it: its display width over `width`, at least one. */
function wrappedRows(text: string, width: number | undefined): number {
  if (width === undefined || width <= 0) return 1;
  return Math.max(1, Math.ceil(displayWidth(text) / width));
}

/**
 * The prompt's viewport and how many rows it takes. `width` is the text area's width in columns; without it the count is
 * logical lines only, as a caller that cannot measure the terminal expects.
 */
export function inputViewport(value: string, cursor: number, maxRows: number, width?: number): InputViewport {
  if (!value.includes("\n")) {
    return { value, cursor, rows: Math.min(normalizeInputRenderRows(maxRows), wrappedRows(value, width)) };
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
  // Rows are what the terminal draws: each visible line wraps at the text area's width.
  const rows = Math.min(normalizeInputRenderRows(maxRows),
    visibleSource.split("\n").reduce((total, line) => total + wrappedRows(`${prefix}${line}${suffix}`, width), 0));
  return {
    value: `${prefix}${visible}${suffix}`,
    cursor: prefix.length + beforeCursor.length,
    rows
  };
}

export function visibleInputRows(value: string, cursor: number, maxRows = INPUT_RENDER_ROWS, width?: number): number {
  return inputViewport(value, cursor, normalizeInputRenderRows(maxRows), width).rows;
}

function renderViewportText(value: string): string {
  return value;
}

function normalizeInputRenderRows(value: number): number {
  return Math.max(1, Math.floor(Number.isFinite(value) ? value : INPUT_RENDER_ROWS));
}
