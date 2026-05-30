import type { TuiFrame } from "./frame.js";
import { displayWidth } from "../display-width.js";
import { screenToLines } from "./screen.js";

export type TuiFrameSnapshotCell = {
  row: number;
  column: number;
  char: string;
  style: Record<string, unknown>;
  hyperlink?: string;
};

export type TuiFrameSnapshotCellChange = {
  row: number;
  column: number;
  previous?: TuiFrameSnapshotCell;
  next?: TuiFrameSnapshotCell;
};

export type TuiFrameSnapshot = {
  width: number;
  height: number;
  cursor: TuiFrame["cursor"];
  metadata: TuiFrame["metadata"];
  lines: string[];
  cells: TuiFrameSnapshotCell[][];
};

export function createFrameSnapshot(frame: TuiFrame): TuiFrameSnapshot {
  return {
    width: frame.screen.width,
    height: frame.screen.height,
    cursor: frame.cursor,
    metadata: frame.metadata,
    lines: screenToLines(frame.screen),
    cells: frame.screen.cells.map((row, rowIndex) =>
      row.map((cell, columnIndex) => ({
        row: rowIndex,
        column: columnIndex,
        char: cell.char,
        style: { ...cell.style },
        hyperlink: cell.hyperlink
      }))
    )
  };
}

export function diffFrameSnapshotCells(
  previous: TuiFrameSnapshot,
  next: TuiFrameSnapshot
): TuiFrameSnapshotCellChange[] {
  const changes: TuiFrameSnapshotCellChange[] = [];
  const height = Math.max(previous.height, next.height);
  const width = Math.max(previous.width, next.width);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const previousCell = previous.cells[row]?.[column];
      const nextCell = next.cells[row]?.[column];
      if (!sameSnapshotCell(previousCell, nextCell)) {
        changes.push({ row, column, previous: previousCell, next: nextCell });
      }
    }
  }
  return changes;
}

export function assertFrameHasNoOverflow(snapshot: TuiFrameSnapshot): string[] {
  const issues: string[] = [];
  snapshot.lines.forEach((line, index) => {
    if (displayWidth(line) > snapshot.width) {
      issues.push(`row ${index} overflows width ${snapshot.width}`);
    }
  });
  if (snapshot.height !== snapshot.lines.length) {
    issues.push(`height mismatch ${snapshot.height} != ${snapshot.lines.length}`);
  }
  return issues;
}

function sameSnapshotCell(left: TuiFrameSnapshotCell | undefined, right: TuiFrameSnapshotCell | undefined): boolean {
  if (!left || !right) {
    return left === right;
  }
  return left.char === right.char &&
    left.hyperlink === right.hyperlink &&
    JSON.stringify(left.style) === JSON.stringify(right.style);
}
