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
    paintInlineChildren(node, node.layout.x, node.layout.y, screen, style, metadata);
    return;
  }
  if (node.nodeName === "swarm-raw-ansi") {
    paintAnsiText(attributeString(node.attributes.rawText), node.layout.x, node.layout.y, screen, style, metadata);
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

function paintInlineChildren(
  node: TuiElement,
  x: number,
  y: number,
  screen: ReturnType<typeof createScreen>,
  style: TuiStyle,
  metadata: TuiScreenCellMetadata
): { x: number; y: number } {
  let cursor = { x, y };
  for (const child of node.childNodes) {
    cursor = paintInlineNode(child, cursor.x, cursor.y, x, screen, style, metadata);
  }
  return cursor;
}

function paintInlineNode(
  node: TuiNode,
  x: number,
  y: number,
  lineStartX: number,
  screen: ReturnType<typeof createScreen>,
  inheritedStyle: TuiStyle,
  inheritedMetadata: TuiScreenCellMetadata
): { x: number; y: number } {
  if (node.hidden) {
    return { x, y };
  }
  const style = node.nodeName === "#text"
    ? { ...inheritedStyle, ...node.style }
    : { ...inheritedStyle, ...node.style };
  if (node.nodeName === "#text") {
    return paintText(node.nodeValue, x, y, screen, style, inheritedMetadata, lineStartX);
  }
  const metadata: TuiScreenCellMetadata = {
    hyperlink: node.nodeName === "swarm-link" && typeof node.attributes.href === "string"
      ? node.attributes.href
      : inheritedMetadata.hyperlink,
    noSelect: inheritedMetadata.noSelect || node.nodeName === "swarm-no-select" || node.attributes.noSelect === true,
    ownerChain: node.debugOwnerChain.length ? node.debugOwnerChain : inheritedMetadata.ownerChain,
    nodeName: node.nodeName
  };
  return paintInlineChildren(node, x, y, screen, style, metadata);
}

function paintAnsiText(
  value: string,
  x: number,
  y: number,
  screen: ReturnType<typeof createScreen>,
  style: TuiStyle,
  metadata: TuiScreenCellMetadata
): void {
  let cursorX = x;
  let cursorY = y;
  for (const span of parseAnsiSpans(value, style)) {
    const painted = paintText(span.text, cursorX, cursorY, screen, span.style, metadata);
    cursorX = painted.x;
    cursorY = painted.y;
  }
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
