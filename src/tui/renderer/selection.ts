import { displayWidth } from "../display-width.js";
import type { TuiScreen } from "./screen.js";

export type TuiScreenPoint = {
  x: number;
  y: number;
};

export type TuiSelectionRange = {
  anchor: TuiScreenPoint;
  focus: TuiScreenPoint;
};

export function normalizeSelectionRange(range: TuiSelectionRange): {
  start: TuiScreenPoint;
  end: TuiScreenPoint;
} {
  const anchor = sanitizePoint(range.anchor);
  const focus = sanitizePoint(range.focus);
  if (anchor.y < focus.y || (anchor.y === focus.y && anchor.x <= focus.x)) {
    return { start: anchor, end: focus };
  }
  return { start: focus, end: anchor };
}

export function selectedTextFromScreen(
  screen: TuiScreen,
  range: TuiSelectionRange,
  options: { trimRight?: boolean } = {}
): string {
  const { start, end } = normalizeSelectionRange(range);
  const rows: string[] = [];
  for (let row = start.y; row <= end.y; row += 1) {
    const cells = screen.cells[row];
    if (!cells) {
      continue;
    }
    const startColumn = row === start.y ? start.x : 0;
    const endColumn = row === end.y ? end.x : screen.width - 1;
    let line = "";
    for (let column = startColumn; column <= endColumn; column += 1) {
      const cell = cells[column];
      if (!cell || cell.noSelect || cell.char === "") {
        continue;
      }
      line += cell.char;
    }
    rows.push(options.trimRight ?? true ? line.trimEnd() : line);
  }
  return rows.join("\n");
}

export function shiftSelectionRange(range: TuiSelectionRange, rowOffset: number): TuiSelectionRange {
  const offset = Math.floor(rowOffset);
  return {
    anchor: { x: range.anchor.x, y: Math.max(0, Math.floor(range.anchor.y + offset)) },
    focus: { x: range.focus.x, y: Math.max(0, Math.floor(range.focus.y + offset)) }
  };
}

export function wordSelectionAt(screen: TuiScreen, point: TuiScreenPoint): TuiSelectionRange | undefined {
  const y = Math.floor(point.y);
  const row = screen.cells[y];
  if (!row) {
    return undefined;
  }
  const x = Math.max(0, Math.min(screen.width - 1, Math.floor(point.x)));
  const char = row[x]?.char ?? "";
  if (!isWordChar(char)) {
    return undefined;
  }
  let start = x;
  let end = x;
  while (start > 0 && isWordChar(row[start - 1]?.char ?? "")) {
    start -= 1;
  }
  while (end + 1 < row.length && isWordChar(row[end + 1]?.char ?? "")) {
    end += Math.max(1, displayWidth(row[end + 1]?.char ?? ""));
  }
  return {
    anchor: { x: start, y },
    focus: { x: end, y }
  };
}

function sanitizePoint(point: TuiScreenPoint): TuiScreenPoint {
  return {
    x: Math.max(0, Math.floor(point.x)),
    y: Math.max(0, Math.floor(point.y))
  };
}

function isWordChar(value: string): boolean {
  return /^[\p{Letter}\p{Number}_-]$/u.test(value);
}

