import { clampCursor, nextGraphemeBoundary } from "./input-editing.js";

export const INPUT_RENDER_ROWS = 4;

export type InputViewport = {
  value: string;
  cursor: number;
};

export type InputLineRenderParts = {
  before: string;
  current: string;
  after: string;
};

export function renderInputLineParts(value: string, cursor: number, maxRows = INPUT_RENDER_ROWS): InputLineRenderParts {
  const safeCursor = clampCursor(value, cursor);
  const viewport = inputViewport(value, safeCursor, maxRows);
  const before = viewport.value.slice(0, viewport.cursor);
  const currentEnd = nextGraphemeBoundary(viewport.value, viewport.cursor);
  return {
    before,
    current: viewport.value.slice(viewport.cursor, currentEnd) || " ",
    after: viewport.value.slice(currentEnd)
  };
}

export function inputViewport(value: string, cursor: number, maxRows: number): InputViewport {
  if (!value.includes("\n")) {
    return { value, cursor };
  }
  const lineStarts = [0];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\n") {
      lineStarts.push(index + 1);
    }
  }
  const cursorLine = Math.max(0, lineStarts.findIndex((start, index) => cursor >= start && (index === lineStarts.length - 1 || cursor < lineStarts[index + 1])));
  const startLine = Math.max(0, cursorLine - maxRows + 1);
  const start = lineStarts[startLine] ?? 0;
  const nextLineStart = cursorLine + 1 < lineStarts.length ? lineStarts[cursorLine + 1] : undefined;
  const cursorLineEnd = nextLineStart === undefined ? value.length : Math.max(start, nextLineStart - 1);
  const prefix = start > 0 ? "... " : "";
  const visibleSource = value.slice(start, cursorLineEnd);
  const visible = renderViewportText(visibleSource);
  const beforeCursor = renderViewportText(value.slice(start, Math.max(start, Math.min(cursor, cursorLineEnd))));
  return {
    value: `${prefix}${visible}`,
    cursor: prefix.length + beforeCursor.length
  };
}

function renderViewportText(value: string): string {
  return value.replace(/\n/g, " / ");
}
