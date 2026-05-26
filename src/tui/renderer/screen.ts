import { displayWidth } from "../display-width.js";
import type { TuiStyle } from "./dom.js";

export type TuiScreenCell = {
  char: string;
  style: TuiStyle;
  hyperlink?: string;
  noSelect?: boolean;
  ownerChain?: readonly string[];
  nodeName?: string;
};

export type TuiScreenCellMetadata = {
  hyperlink?: string;
  noSelect?: boolean;
  ownerChain?: readonly string[];
  nodeName?: string;
};

export type TuiScreen = {
  width: number;
  height: number;
  cells: TuiScreenCell[][];
  damage?: TuiDamageRect;
};

export type TuiDamageRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function createScreen(width: number, height: number): TuiScreen {
  const safeWidth = Math.max(0, Math.floor(Number.isFinite(width) ? width : 0));
  const safeHeight = Math.max(0, Math.floor(Number.isFinite(height) ? height : 0));
  return {
    width: safeWidth,
    height: safeHeight,
    cells: Array.from({ length: safeHeight }, () =>
      Array.from({ length: safeWidth }, () => createCell(" "))
    )
  };
}

export function createCell(
  char: string,
  style: TuiStyle = {},
  metadataOrHyperlink?: TuiScreenCellMetadata | string
): TuiScreenCell {
  const metadata = typeof metadataOrHyperlink === "string"
    ? { hyperlink: metadataOrHyperlink }
    : metadataOrHyperlink;
  return {
    char: char.length > 0 ? char : "",
    style: { ...style },
    hyperlink: metadata?.hyperlink,
    noSelect: metadata?.noSelect || undefined,
    ownerChain: metadata?.ownerChain ? [...metadata.ownerChain] : undefined,
    nodeName: metadata?.nodeName
  };
}

export function setCell(
  screen: TuiScreen,
  x: number,
  y: number,
  char: string,
  style: TuiStyle = {},
  metadataOrHyperlink?: TuiScreenCellMetadata | string
): void {
  if (y < 0 || y >= screen.height || x < 0 || x >= screen.width) {
    return;
  }
  const metadata = cellMetadata(metadataOrHyperlink);
  clearWideBoundary(screen, x, y);
  screen.cells[y]![x] = createCell(char, style, metadata);
  const charWidth = Math.max(1, displayWidth(char));
  if (charWidth > 1 && x + 1 < screen.width) {
    screen.cells[y]![x + 1] = createCell("", style, metadata);
  }
  markDamage(screen, x, y, Math.min(charWidth, screen.width - x), 1);
}

export function screenToLines(screen: TuiScreen, options: { trimRight?: boolean } = {}): string[] {
  const trimRight = options.trimRight ?? true;
  return screen.cells.map((row) => {
    const line = row.map((cell) => cell.char).join("");
    return trimRight ? line.trimEnd() : line;
  });
}

export function screenToString(screen: TuiScreen, options: { trimRight?: boolean } = {}): string {
  return screenToLines(screen, options).join("\n");
}

export function cloneScreen(screen: TuiScreen): TuiScreen {
  return {
    width: screen.width,
    height: screen.height,
    damage: screen.damage ? { ...screen.damage } : undefined,
    cells: screen.cells.map((row) => row.map((cell) => ({
      char: cell.char,
      style: { ...cell.style },
      hyperlink: cell.hyperlink,
      noSelect: cell.noSelect,
      ownerChain: cell.ownerChain ? [...cell.ownerChain] : undefined,
      nodeName: cell.nodeName
    })))
  };
}

export function clearRegion(screen: TuiScreen, x: number, y: number, width: number, height: number): void {
  const rect = clampRect(screen, { x, y, width, height });
  if (!rect) {
    return;
  }
  for (let row = rect.y; row < rect.y + rect.height; row += 1) {
    for (let column = rect.x; column < rect.x + rect.width; column += 1) {
      clearWideBoundary(screen, column, row);
      screen.cells[row]![column] = createCell(" ");
    }
  }
  markDamage(screen, rect.x, rect.y, rect.width, rect.height);
}

export function blitRegion(
  source: TuiScreen,
  target: TuiScreen,
  sourceX: number,
  sourceY: number,
  width: number,
  height: number,
  targetX: number,
  targetY: number
): void {
  const sourceRect = clampRect(source, { x: sourceX, y: sourceY, width, height });
  if (!sourceRect) {
    return;
  }
  const targetRect = clampRect(target, {
    x: targetX + (sourceRect.x - sourceX),
    y: targetY + (sourceRect.y - sourceY),
    width: sourceRect.width,
    height: sourceRect.height
  });
  if (!targetRect) {
    return;
  }
  const copyWidth = Math.min(sourceRect.width, targetRect.width);
  const copyHeight = Math.min(sourceRect.height, targetRect.height);
  const rows = Array.from({ length: copyHeight }, (_, rowOffset) =>
    Array.from({ length: copyWidth }, (_, columnOffset) => {
      const cell = source.cells[sourceRect.y + rowOffset]![sourceRect.x + columnOffset]!;
      return createCell(cell.char, cell.style, cellMetadataFromCell(cell));
    })
  );
  for (let rowOffset = 0; rowOffset < copyHeight; rowOffset += 1) {
    for (let columnOffset = 0; columnOffset < copyWidth; columnOffset += 1) {
      const row = targetRect.y + rowOffset;
      const column = targetRect.x + columnOffset;
      clearWideBoundary(target, column, row);
      target.cells[row]![column] = rows[rowOffset]![columnOffset]!;
    }
  }
  markDamage(target, targetRect.x, targetRect.y, copyWidth, copyHeight);
}

export function shiftRows(screen: TuiScreen, top: number, bottom: number, offset: number): void {
  const start = Math.max(0, Math.floor(top));
  const end = Math.min(screen.height - 1, Math.floor(bottom));
  const delta = Math.floor(offset);
  if (start > end || delta === 0) {
    return;
  }
  const height = end - start + 1;
  const snapshot = screen.cells.slice(start, end + 1).map((row) =>
    row.map((cell) => createCell(cell.char, cell.style, cellMetadataFromCell(cell)))
  );
  for (let rowOffset = 0; rowOffset < height; rowOffset += 1) {
    const sourceIndex = rowOffset - delta;
    const targetRow = start + rowOffset;
    if (sourceIndex < 0 || sourceIndex >= snapshot.length) {
      screen.cells[targetRow] = Array.from({ length: screen.width }, () => createCell(" "));
      continue;
    }
    screen.cells[targetRow] = snapshot[sourceIndex]!.map((cell) => createCell(cell.char, cell.style, cellMetadataFromCell(cell)));
  }
  markDamage(screen, 0, start, screen.width, height);
}

export function markDamage(screen: TuiScreen, x: number, y: number, width: number, height: number): void {
  const rect = clampRect(screen, { x, y, width, height });
  if (!rect) {
    return;
  }
  screen.damage = screen.damage ? unionDamage(screen.damage, rect) : rect;
}

function clearWideBoundary(screen: TuiScreen, x: number, y: number): void {
  const row = screen.cells[y];
  if (!row) {
    return;
  }
  const previous = row[x - 1];
  if (previous && displayWidth(previous.char) > 1) {
    row[x - 1] = createCell(" ", previous.style, cellMetadataFromCell(previous));
  }
  const current = row[x];
  if (current && displayWidth(current.char) > 1 && x + 1 < screen.width) {
    row[x + 1] = createCell(" ", current.style, cellMetadataFromCell(current));
  }
  if (current && current.char === "" && x > 0) {
    const head = row[x - 1];
    row[x - 1] = createCell(" ", head?.style, head ? cellMetadataFromCell(head) : undefined);
  }
}

export function clearDamage(screen: TuiScreen): void {
  screen.damage = undefined;
}

export function unionDamage(left: TuiDamageRect, right: TuiDamageRect): TuiDamageRect {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const maxX = Math.max(left.x + left.width, right.x + right.width);
  const maxY = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: maxX - x, height: maxY - y };
}

function clampRect(screen: TuiScreen, rect: TuiDamageRect): TuiDamageRect | undefined {
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const maxX = Math.min(screen.width, Math.floor(rect.x + rect.width));
  const maxY = Math.min(screen.height, Math.floor(rect.y + rect.height));
  if (x >= maxX || y >= maxY) {
    return undefined;
  }
  return { x, y, width: maxX - x, height: maxY - y };
}

function cellMetadata(value: TuiScreenCellMetadata | string | undefined): TuiScreenCellMetadata | undefined {
  return typeof value === "string" ? { hyperlink: value } : value;
}

function cellMetadataFromCell(cell: TuiScreenCell): TuiScreenCellMetadata {
  return {
    hyperlink: cell.hyperlink,
    noSelect: cell.noSelect,
    ownerChain: cell.ownerChain,
    nodeName: cell.nodeName
  };
}
