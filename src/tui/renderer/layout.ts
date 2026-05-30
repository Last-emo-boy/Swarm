import { displayWidth, sliceByDisplayWidth } from "../display-width.js";
import { ansiDisplayWidth, stripAnsi } from "./ansi.js";
import { textContent, type TuiElement, type TuiLayoutRect, type TuiNode } from "./dom.js";
import { progressText } from "./progress.js";

export type TuiLayoutConstraints = {
  width: number;
  height: number;
};

export function computeLayout(root: TuiElement, constraints: TuiLayoutConstraints): boolean {
  const width = sanitizeDimension(constraints.width);
  const height = sanitizeDimension(constraints.height);
  if (width <= 0 || height < 0) {
    root.layout = { x: 0, y: 0, width: 0, height: 0 };
    return false;
  }
  layoutElement(root, { x: 0, y: 0, width, height }, width);
  return true;
}

function layoutNode(node: TuiNode, rect: TuiLayoutRect, parentWidth: number): TuiLayoutRect {
  if (node.hidden) {
    node.layout = { x: rect.x, y: rect.y, width: 0, height: 0 };
    return node.layout;
  }
  if (node.nodeName === "#text") {
    const lines = splitRenderableText(node.nodeValue, parentWidth);
    node.layout = {
      x: rect.x,
      y: rect.y,
      width: Math.min(parentWidth, Math.max(0, ...lines.map((line) => displayWidth(line)))),
      height: Math.max(1, lines.length)
    };
    return node.layout;
  }
  return layoutElement(node, rect, parentWidth);
}

function layoutElement(node: TuiElement, rect: TuiLayoutRect, parentWidth: number): TuiLayoutRect {
  const margin = edgeSpacing(node, "margin");
  const availableWidth = Math.max(0, (rect.width || parentWidth) - margin.left - margin.right);
  const availableHeight = Math.max(0, rect.height - margin.top - margin.bottom);
  const layoutX = rect.x + margin.left;
  const layoutY = rect.y + margin.top;
  const explicitWidth = dimensionAttribute(node.attributes.width, availableWidth || parentWidth);
  const explicitHeight = dimensionAttribute(node.attributes.height, availableHeight);
  const minWidth = dimensionAttribute(node.attributes.minWidth, availableWidth || parentWidth);
  const maxWidth = dimensionAttribute(node.attributes.maxWidth, availableWidth || parentWidth);
  const minHeight = dimensionAttribute(node.attributes.minHeight, availableHeight);
  const maxHeight = dimensionAttribute(node.attributes.maxHeight, availableHeight);
  const width = clampDimension(explicitWidth ?? availableWidth ?? parentWidth, minWidth, maxWidth);
  const flexDirection = node.attributes.flexDirection === "row" ? "row" : "column";
  const paddingX = Math.max(0, numericAttribute(node.attributes.paddingX) ?? 0);
  const paddingY = Math.max(0, numericAttribute(node.attributes.paddingY) ?? 0);
  const border = borderSpacing(node);
  const contentX = layoutX + border.left + paddingX;
  const contentY = layoutY + border.top + paddingY;
  const contentWidth = Math.max(0, width - border.left - border.right - paddingX * 2);
  const contentHeight = Math.max(0, (explicitHeight ?? availableHeight) - border.top - border.bottom - paddingY * 2);
  let consumedPrimary = 0;
  let cross = 0;
  const flowChildren: TuiNode[] = [];

  if (node.nodeName === "swarm-text") {
    const text = textContent(node);
    const lines = splitRenderableText(text, contentWidth || width, textWrapMode(node));
    const measuredWidth = Math.min(contentWidth || width, Math.max(0, ...lines.map((line) => displayWidth(line))));
    node.layout = {
      x: layoutX,
      y: layoutY,
      width: clampDimension(explicitWidth ?? measuredWidth + paddingX * 2 + border.left + border.right, minWidth, maxWidth),
      height: clampDimension(explicitHeight ?? Math.max(1, lines.length) + paddingY * 2 + border.top + border.bottom, minHeight, maxHeight)
    };
    layoutChildrenAsText(node, contentX, contentY, Math.max(1, contentWidth || node.layout.width));
    return node.layout;
  }

  if (node.nodeName === "swarm-raw-ansi") {
    const rawText = stringAttribute(node.attributes.rawText);
    const lines = rawText.length ? rawText.split(/\r?\n/) : [""];
    const rawWidth = dimensionAttribute(node.attributes.rawWidth, contentWidth || width);
    const rawHeight = dimensionAttribute(node.attributes.rawHeight, rect.height);
    const measuredWidth = Math.min(
      contentWidth || width,
      rawWidth ?? Math.max(0, ...lines.map((line) => ansiDisplayWidth(line)))
    );
    node.layout = {
      x: layoutX,
      y: layoutY,
      width: clampDimension(explicitWidth ?? measuredWidth + paddingX * 2 + border.left + border.right, minWidth, maxWidth),
      height: clampDimension(explicitHeight ?? rawHeight ?? Math.max(1, lines.length) + paddingY * 2 + border.top + border.bottom, minHeight, maxHeight)
    };
    return node.layout;
  }

  if (node.nodeName === "swarm-progress") {
    const value = progressText(node.attributes, contentWidth || width);
    node.layout = {
      x: layoutX,
      y: layoutY,
      width: clampDimension(explicitWidth ?? displayWidth(value) + paddingX * 2 + border.left + border.right, minWidth, maxWidth),
      height: clampDimension(explicitHeight ?? 1 + paddingY * 2 + border.top + border.bottom, minHeight, maxHeight)
    };
    return node.layout;
  }

  for (const child of node.childNodes) {
    const absolute = isAbsolutePositioned(child);
    const childRect = absolute
      ? { x: contentX, y: contentY, width: contentWidth || width, height: contentHeight || availableHeight }
      : flexDirection === "row"
        ? { x: contentX + consumedPrimary, y: contentY, width: Math.max(0, contentWidth - consumedPrimary), height: contentHeight || availableHeight }
        : { x: contentX, y: contentY + consumedPrimary, width: contentWidth || width, height: Math.max(0, (contentHeight || availableHeight) - consumedPrimary) };
    const childLayout = layoutNode(child, childRect, contentWidth || width);
    if (absolute) {
      continue;
    }
    flowChildren.push(child);
    if (flexDirection === "row") {
      consumedPrimary += outerPrimarySize(child, childLayout, "row");
      cross = Math.max(cross, outerCrossSize(child, childLayout, "row"));
    } else {
      consumedPrimary += outerPrimarySize(child, childLayout, "column");
      cross = Math.max(cross, outerCrossSize(child, childLayout, "column"));
    }
  }

  alignFlowChildren(flowChildren, flexDirection, node, {
    x: contentX,
    y: contentY,
    width: contentWidth,
    height: contentHeight || availableHeight,
    consumedPrimary,
    cross
  });

  const naturalHeight = flexDirection === "row"
    ? cross + paddingY * 2 + border.top + border.bottom
    : consumedPrimary + paddingY * 2 + border.top + border.bottom;
  const naturalWidth = flexDirection === "row"
    ? consumedPrimary + paddingX * 2 + border.left + border.right
    : Math.max(width, cross + paddingX * 2 + border.left + border.right);
  node.layout = {
    x: layoutX,
    y: layoutY,
    width: clampDimension(explicitWidth ?? Math.min(parentWidth, naturalWidth), minWidth, maxWidth),
    height: clampDimension(explicitHeight ?? Math.max(1, naturalHeight), minHeight, maxHeight)
  };
  return node.layout;
}

function layoutChildrenAsText(node: TuiElement, x: number, y: number, width: number): void {
  let cursorY = y;
  for (const child of node.childNodes) {
    const layout = layoutNode(child, { x, y: cursorY, width, height: 1 }, width);
    cursorY += layout.height;
  }
}

type Edges = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

function edgeSpacing(node: TuiElement, prefix: "margin"): Edges {
  return {
    top: Math.max(0, numericAttribute(node.attributes[`${prefix}Top`]) ?? 0),
    right: Math.max(0, numericAttribute(node.attributes[`${prefix}Right`]) ?? 0),
    bottom: Math.max(0, numericAttribute(node.attributes[`${prefix}Bottom`]) ?? 0),
    left: Math.max(0, numericAttribute(node.attributes[`${prefix}Left`]) ?? 0)
  };
}

export function borderSpacing(node: TuiElement): Edges {
  if (typeof node.attributes.borderStyle !== "string") {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }
  return {
    top: node.attributes.borderTop === false ? 0 : 1,
    right: node.attributes.borderRight === false ? 0 : 1,
    bottom: node.attributes.borderBottom === false ? 0 : 1,
    left: node.attributes.borderLeft === false ? 0 : 1
  };
}

function isAbsolutePositioned(node: TuiNode): boolean {
  return node.nodeName !== "#text" && node.attributes.position === "absolute";
}

function outerPrimarySize(node: TuiNode, layout: TuiLayoutRect, direction: "row" | "column"): number {
  const margin = node.nodeName === "#text" ? { top: 0, right: 0, bottom: 0, left: 0 } : edgeSpacing(node, "margin");
  return direction === "row"
    ? margin.left + layout.width + margin.right
    : margin.top + layout.height + margin.bottom;
}

function outerCrossSize(node: TuiNode, layout: TuiLayoutRect, direction: "row" | "column"): number {
  const margin = node.nodeName === "#text" ? { top: 0, right: 0, bottom: 0, left: 0 } : edgeSpacing(node, "margin");
  return direction === "row"
    ? margin.top + layout.height + margin.bottom
    : margin.left + layout.width + margin.right;
}

function alignFlowChildren(
  children: TuiNode[],
  direction: "row" | "column",
  node: TuiElement,
  content: TuiLayoutRect & { consumedPrimary: number; cross: number }
): void {
  const primarySize = direction === "row" ? content.width : content.height;
  const justifyOffset = alignmentOffset(node.attributes.justifyContent, primarySize - content.consumedPrimary);
  for (const child of children) {
    const crossSize = direction === "row" ? content.height : content.width;
    const childCrossSize = direction === "row" ? child.layout.height : child.layout.width;
    const alignOffset = alignmentOffset(node.attributes.alignItems, crossSize - childCrossSize);
    translateNode(
      child,
      direction === "row" ? justifyOffset : alignOffset,
      direction === "row" ? alignOffset : justifyOffset
    );
  }
}

function alignmentOffset(value: unknown, freeSpace: number): number {
  const safeFreeSpace = Math.max(0, Math.floor(freeSpace));
  if (value === "center") {
    return Math.floor(safeFreeSpace / 2);
  }
  if (value === "flex-end") {
    return safeFreeSpace;
  }
  return 0;
}

function translateNode(node: TuiNode, dx: number, dy: number): void {
  if (dx === 0 && dy === 0) {
    return;
  }
  node.layout = {
    ...node.layout,
    x: node.layout.x + dx,
    y: node.layout.y + dy
  };
  if (node.nodeName === "#text") {
    return;
  }
  for (const child of node.childNodes) {
    translateNode(child, dx, dy);
  }
}

export function splitRenderableText(value: string, width: number, mode: "wrap" | "truncate" = "wrap"): string[] {
  const safeWidth = Math.max(1, sanitizeDimension(width));
  const rawLines = value.length ? stripAnsi(value).split(/\r?\n/) : [""];
  const lines: string[] = [];
  for (const raw of rawLines) {
    if (mode === "truncate") {
      lines.push(sliceByDisplayWidth(raw, safeWidth).head);
      continue;
    }
    if (displayWidth(raw) <= safeWidth) {
      lines.push(raw);
      continue;
    }
    let current = "";
    for (const char of raw) {
      const charWidth = displayWidth(char);
      if (charWidth === 0) {
        current += char;
        continue;
      }
      if (charWidth > safeWidth) {
        if (current) {
          lines.push(current);
          current = "";
        }
        continue;
      }
      if (displayWidth(current) + charWidth <= safeWidth) {
        current += char;
        continue;
      }

      const wrapped = splitAtPreferredBreak(`${current}${char}`);
      if (wrapped && wrapped.head) {
        lines.push(wrapped.head);
        current = wrapped.tail;
      } else {
        lines.push(current);
        current = char;
      }
    }
    lines.push(current);
  }
  return lines.length ? lines : [""];
}

function splitAtPreferredBreak(value: string): { head: string; tail: string } | undefined {
  let breakAfter = -1;
  let dropBreakChar = false;
  const chars = [...value];
  for (let index = 0; index < chars.length - 1; index += 1) {
    const char = chars[index] ?? "";
    if (/\s/u.test(char)) {
      breakAfter = index;
      dropBreakChar = true;
      continue;
    }
    if (char === "/" || char === "\\") {
      breakAfter = index;
      dropBreakChar = false;
    }
  }
  if (breakAfter < 0) {
    return undefined;
  }
  const headEnd = dropBreakChar ? breakAfter : breakAfter + 1;
  return {
    head: chars.slice(0, headEnd).join("").trimEnd(),
    tail: chars.slice(breakAfter + 1).join("").trimStart()
  };
}

function dimensionAttribute(value: unknown, available: number): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    if (value.endsWith("%")) {
      const percentage = Number(value.slice(0, -1));
      return Number.isFinite(percentage) ? Math.floor(Math.max(0, available) * percentage / 100) : undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
  }
  return undefined;
}

function numericAttribute(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
  }
  return undefined;
}

function stringAttribute(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function textWrapMode(node: TuiElement): "wrap" | "truncate" {
  return node.attributes.wrap === "truncate" ? "truncate" : "wrap";
}

function sanitizeDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function clampDimension(value: number, min: number | undefined, max: number | undefined): number {
  const safe = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  const lower = min === undefined ? 0 : Math.max(0, min);
  const upper = max === undefined ? Number.POSITIVE_INFINITY : Math.max(lower, max);
  return Math.max(lower, Math.min(upper, safe));
}
