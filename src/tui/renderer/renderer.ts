import { performance } from "node:perf_hooks";
import { displayWidth } from "../display-width.js";
import { parseAnsiSpans } from "./ansi.js";
import { clearDirty, walkTuiTree, type TuiElement, type TuiNode, type TuiStyle } from "./dom.js";
import { borderSpacing, computeLayout } from "./layout.js";
import { createScreen, setCell } from "./screen.js";
import type { TuiScreenCellMetadata } from "./screen.js";
import type { TuiFrame } from "./frame.js";
import { progressText } from "./progress.js";

export type RenderDomOptions = {
  columns: number;
  rows: number;
};

export function renderDomToFrame(root: TuiElement, options: RenderDomOptions): TuiFrame {
  const startedAt = performance.now();
  const beforeLayout = performance.now();
  const validLayout = computeLayout(root, { width: options.columns, height: options.rows });
  const afterLayout = performance.now();
  const screen = createScreen(options.columns, validLayout ? options.rows : 0);
  if (validLayout) {
    paintNode(root, screen, {});
  }
  const afterPaint = performance.now();
  const counters = countNodes(root);
  clearDirty(root);
  return {
    screen,
    viewport: {
      width: Math.max(0, Math.floor(options.columns)),
      height: Math.max(0, Math.floor(options.rows))
    },
    cursor: {
      x: 0,
      y: Math.max(0, Math.min(screen.height, options.rows) - 1),
      visible: screen.height === 0
    },
    timing: {
      startedAt,
      layoutMs: afterLayout - beforeLayout,
      paintMs: afterPaint - afterLayout,
      totalMs: afterPaint - startedAt
    },
    metadata: {
      renderer: "dom-renderer",
      invalidLayout: !validLayout,
      dirtyNodeCount: counters.dirty,
      nodeCount: counters.total,
      scrollDrainPending: counters.scrollDrainPending
    }
  };
}

function paintNode(
  node: TuiNode,
  screen: ReturnType<typeof createScreen>,
  inheritedStyle: TuiStyle,
  inheritedMetadata: TuiScreenCellMetadata = {}
): void {
  if (node.hidden) {
    return;
  }
  const style = node.nodeName === "#text"
    ? { ...inheritedStyle, ...node.style }
    : { ...inheritedStyle, ...node.style };
  if (node.nodeName === "#text") {
    paintText(node.nodeValue, node.layout.x, node.layout.y, screen, style, inheritedMetadata);
    return;
  }
  const hyperlink = node.nodeName === "swarm-link" && typeof node.attributes.href === "string"
    ? node.attributes.href
    : inheritedMetadata.hyperlink;
  const metadata: TuiScreenCellMetadata = {
    hyperlink,
    noSelect: inheritedMetadata.noSelect || node.nodeName === "swarm-no-select" || node.attributes.noSelect === true,
    ownerChain: node.debugOwnerChain.length ? node.debugOwnerChain : inheritedMetadata.ownerChain,
    nodeName: node.nodeName
  };
  if (node.nodeName === "swarm-text") {
    paintBoundedInlineChildren(node, node.layout.x, node.layout.y, screen, style, metadata);
    return;
  }
  if (node.nodeName === "swarm-raw-ansi") {
    paintBoundedAnsiText(node, screen, style, metadata);
    return;
  }
  if (node.nodeName === "swarm-progress") {
    paintText(progressText(node.attributes, Math.max(1, node.layout.width)), node.layout.x, node.layout.y, screen, style, metadata);
    return;
  }
  paintBorder(node, screen, style, metadata);
  for (const child of node.childNodes) {
    paintNode(child, screen, style, metadata);
  }
}

function paintBorder(
  node: TuiElement,
  screen: ReturnType<typeof createScreen>,
  inheritedStyle: TuiStyle,
  metadata: TuiScreenCellMetadata
): void {
  if (typeof node.attributes.borderStyle !== "string") {
    return;
  }
  const border = borderSpacing(node);
  if (border.top + border.right + border.bottom + border.left === 0) {
    return;
  }
  const x = node.layout.x;
  const y = node.layout.y;
  const width = node.layout.width;
  const height = node.layout.height;
  if (width <= 0 || height <= 0) {
    return;
  }
  const chars = node.attributes.borderStyle === "round"
    ? { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" }
    : { topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘", horizontal: "─", vertical: "│" };
  const style = {
    ...inheritedStyle,
    ...(typeof node.attributes.borderColor === "string" ? { color: node.attributes.borderColor } : {})
  };
  const rightX = x + width - 1;
  const bottomY = y + height - 1;

  if (border.top) {
    for (let column = x + border.left; column < x + width - border.right; column += 1) {
      setCell(screen, column, y, chars.horizontal, style, metadata);
    }
    if (border.left) {
      setCell(screen, x, y, chars.topLeft, style, metadata);
    }
    if (border.right) {
      setCell(screen, rightX, y, chars.topRight, style, metadata);
    }
  }
  if (border.bottom && bottomY !== y) {
    for (let column = x + border.left; column < x + width - border.right; column += 1) {
      setCell(screen, column, bottomY, chars.horizontal, style, metadata);
    }
    if (border.left) {
      setCell(screen, x, bottomY, chars.bottomLeft, style, metadata);
    }
    if (border.right) {
      setCell(screen, rightX, bottomY, chars.bottomRight, style, metadata);
    }
  }
  if (border.left) {
    for (let row = y + border.top; row < y + height - border.bottom; row += 1) {
      setCell(screen, x, row, chars.vertical, style, metadata);
    }
  }
  if (border.right && rightX !== x) {
    for (let row = y + border.top; row < y + height - border.bottom; row += 1) {
      setCell(screen, rightX, row, chars.vertical, style, metadata);
    }
  }
}

type BoundedInlineCursor = {
  y: number;
  line: BoundedInlineCell[];
  lineWidth: number;
  skippingLine: boolean;
  stopped: boolean;
};

type BoundedInlineCell = {
  char: string;
  width: number;
  style: TuiStyle;
  metadata: TuiScreenCellMetadata;
};

type BoundedInlinePaintBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  mode: "wrap" | "truncate";
};

function paintBoundedInlineChildren(
  node: TuiElement,
  x: number,
  y: number,
  screen: ReturnType<typeof createScreen>,
  style: TuiStyle,
  metadata: TuiScreenCellMetadata
): void {
  const bounds: BoundedInlinePaintBounds = {
    x,
    y,
    width: Math.max(1, node.layout.width),
    height: Math.max(1, node.layout.height),
    mode: node.attributes.wrap === "truncate" ? "truncate" : "wrap"
  };
  const cursor: BoundedInlineCursor = { y, line: [], lineWidth: 0, skippingLine: false, stopped: false };
  for (const child of node.childNodes) {
    paintBoundedInlineNode(child, cursor, bounds, screen, style, metadata);
    if (cursor.stopped) {
      return;
    }
  }
  flushBoundedLine(cursor, bounds, screen);
}

function paintBoundedInlineNode(
  node: TuiNode,
  cursor: BoundedInlineCursor,
  bounds: BoundedInlinePaintBounds,
  screen: ReturnType<typeof createScreen>,
  inheritedStyle: TuiStyle,
  inheritedMetadata: TuiScreenCellMetadata
): void {
  if (node.hidden || cursor.stopped) {
    return;
  }
  const style = node.nodeName === "#text"
    ? { ...inheritedStyle, ...node.style }
    : { ...inheritedStyle, ...node.style };
  if (node.nodeName === "#text") {
    paintBoundedText(node.nodeValue, cursor, bounds, screen, style, inheritedMetadata);
    return;
  }
  const metadata: TuiScreenCellMetadata = {
    hyperlink: node.nodeName === "swarm-link" && typeof node.attributes.href === "string"
      ? node.attributes.href
      : inheritedMetadata.hyperlink,
    noSelect: inheritedMetadata.noSelect || node.nodeName === "swarm-no-select" || node.attributes.noSelect === true,
    ownerChain: node.debugOwnerChain.length ? node.debugOwnerChain : inheritedMetadata.ownerChain,
    nodeName: node.nodeName
  };
  for (const child of node.childNodes) {
    paintBoundedInlineNode(child, cursor, bounds, screen, style, metadata);
    if (cursor.stopped) {
      return;
    }
  }
}

function paintBoundedText(
  value: string,
  cursor: BoundedInlineCursor,
  bounds: BoundedInlinePaintBounds,
  screen: ReturnType<typeof createScreen>,
  style: TuiStyle,
  metadata: TuiScreenCellMetadata
): void {
  for (const char of value) {
    if (cursor.stopped) {
      return;
    }
    if (char === "\n") {
      flushBoundedLine(cursor, bounds, screen);
      advanceBoundedLine(cursor, bounds);
      continue;
    }
    if (cursor.skippingLine) {
      continue;
    }

    const charWidth = displayWidth(char);
    if (charWidth === 0) {
      if (cursor.line.length > 0) {
        cursor.line[cursor.line.length - 1]!.char += char;
      }
      continue;
    }
    if (charWidth > bounds.width) {
      if (bounds.mode === "truncate") {
        cursor.skippingLine = true;
      } else if (cursor.line.length > 0) {
        flushBoundedLine(cursor, bounds, screen);
        advanceBoundedLine(cursor, bounds);
      }
      continue;
    }
    if (cursor.lineWidth + charWidth > bounds.width) {
      if (bounds.mode === "truncate") {
        cursor.skippingLine = true;
        continue;
      }
      wrapBoundedLine(cursor, bounds, screen, {
        char,
        width: charWidth,
        style,
        metadata
      });
      if (cursor.stopped) {
        return;
      }
      continue;
    }

    appendBoundedCell(cursor, { char, width: charWidth, style, metadata });
  }
}

function appendBoundedCell(cursor: BoundedInlineCursor, cell: BoundedInlineCell): void {
  cursor.line.push(cell);
  cursor.lineWidth += cell.width;
}

function wrapBoundedLine(
  cursor: BoundedInlineCursor,
  bounds: BoundedInlinePaintBounds,
  screen: ReturnType<typeof createScreen>,
  overflowCell: BoundedInlineCell
): void {
  const candidate = [...cursor.line, overflowCell];
  const breakPoint = findInlineBreakPoint(candidate);
  if (breakPoint && breakPoint.head.length > 0) {
    cursor.line = breakPoint.head;
    cursor.lineWidth = lineCellsWidth(cursor.line);
    flushBoundedLine(cursor, bounds, screen);
    advanceBoundedLine(cursor, bounds);
    if (cursor.stopped) {
      return;
    }
    cursor.line = breakPoint.tail;
    cursor.lineWidth = lineCellsWidth(cursor.line);
    return;
  }

  flushBoundedLine(cursor, bounds, screen);
  advanceBoundedLine(cursor, bounds);
  if (!cursor.stopped) {
    appendBoundedCell(cursor, overflowCell);
  }
}

function flushBoundedLine(
  cursor: BoundedInlineCursor,
  bounds: BoundedInlinePaintBounds,
  screen: ReturnType<typeof createScreen>
): void {
  let x = bounds.x;
  for (const cell of cursor.line) {
    if (x >= bounds.x + bounds.width) {
      break;
    }
    setCell(screen, x, cursor.y, cell.char, cell.style, cell.metadata);
    x += cell.width;
  }
}

function advanceBoundedLine(cursor: BoundedInlineCursor, bounds: BoundedInlinePaintBounds): void {
  cursor.y += 1;
  cursor.line = [];
  cursor.lineWidth = 0;
  cursor.skippingLine = false;
  cursor.stopped = cursor.y >= bounds.y + bounds.height;
}

function findInlineBreakPoint(cells: BoundedInlineCell[]): { head: BoundedInlineCell[]; tail: BoundedInlineCell[] } | undefined {
  let breakAfter = -1;
  let dropBreakCell = false;
  for (let index = 0; index < cells.length - 1; index += 1) {
    const char = cells[index]?.char ?? "";
    if (/\s/u.test(char)) {
      breakAfter = index;
      dropBreakCell = true;
      continue;
    }
    if (char === "/" || char === "\\") {
      breakAfter = index;
      dropBreakCell = false;
    }
  }
  if (breakAfter < 0) {
    return undefined;
  }

  const headEnd = dropBreakCell ? breakAfter : breakAfter + 1;
  const tailStart = breakAfter + 1;
  return {
    head: trimTrailingWhitespaceCells(cells.slice(0, headEnd)),
    tail: trimLeadingWhitespaceCells(cells.slice(tailStart))
  };
}

function trimTrailingWhitespaceCells(cells: BoundedInlineCell[]): BoundedInlineCell[] {
  let end = cells.length;
  while (end > 0 && /^\s$/u.test(cells[end - 1]?.char ?? "")) {
    end -= 1;
  }
  return cells.slice(0, end);
}

function trimLeadingWhitespaceCells(cells: BoundedInlineCell[]): BoundedInlineCell[] {
  let start = 0;
  while (start < cells.length && /^\s$/u.test(cells[start]?.char ?? "")) {
    start += 1;
  }
  return cells.slice(start);
}

function lineCellsWidth(cells: BoundedInlineCell[]): number {
  return cells.reduce((sum, cell) => sum + cell.width, 0);
}

function paintBoundedAnsiText(
  node: TuiElement,
  screen: ReturnType<typeof createScreen>,
  inheritedStyle: TuiStyle,
  metadata: TuiScreenCellMetadata
): void {
  const bounds: BoundedInlinePaintBounds = {
    x: node.layout.x,
    y: node.layout.y,
    width: Math.max(1, node.layout.width),
    height: Math.max(1, node.layout.height),
    mode: "wrap"
  };
  const cursor: BoundedInlineCursor = { y: bounds.y, line: [], lineWidth: 0, skippingLine: false, stopped: false };
  for (const span of parseAnsiSpans(attributeString(node.attributes.rawText), inheritedStyle)) {
    paintBoundedText(span.text, cursor, bounds, screen, span.style, metadata);
    if (cursor.stopped) {
      return;
    }
  }
  flushBoundedLine(cursor, bounds, screen);
}

function paintText(
  value: string,
  x: number,
  y: number,
  screen: ReturnType<typeof createScreen>,
  style: TuiStyle,
  metadata: TuiScreenCellMetadata,
  lineStartX = x
): { x: number; y: number } {
  let cursorX = x;
  let cursorY = y;
  for (const char of value) {
    if (char === "\n") {
      cursorX = lineStartX;
      cursorY += 1;
      continue;
    }
    const charWidth = displayWidth(char);
    if (charWidth === 0) {
      appendCombiningMark(screen, cursorX - 1, cursorY, char);
      continue;
    }
    setCell(screen, cursorX, cursorY, char, style, metadata);
    cursorX += charWidth;
    if (cursorX >= screen.width) {
      cursorX = lineStartX;
      cursorY += 1;
    }
  }
  return { x: cursorX, y: cursorY };
}

function appendCombiningMark(screen: ReturnType<typeof createScreen>, x: number, y: number, mark: string): void {
  if (y < 0 || y >= screen.height || x < 0 || x >= screen.width) {
    return;
  }
  const cell = screen.cells[y]?.[x];
  if (!cell) {
    return;
  }
  cell.char += mark;
}

function attributeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function countNodes(root: TuiNode): { total: number; dirty: number; scrollDrainPending: boolean } {
  let total = 0;
  let dirty = 0;
  let scrollDrainPending = false;
  walkTuiTree(root, (node) => {
    total += 1;
    if (node.dirty) {
      dirty += 1;
    }
    if (node.nodeName !== "#text" && node.scroll?.pendingDelta) {
      scrollDrainPending = true;
    }
  });
  return { total, dirty, scrollDrainPending };
}
