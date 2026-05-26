export type TuiElementName =
  | "swarm-root"
  | "swarm-box"
  | "swarm-text"
  | "swarm-link"
  | "swarm-no-select"
  | "swarm-raw-ansi"
  | "swarm-virtual-text"
  | "swarm-progress"
  | "swarm-scroll";

export type TuiNodeName = TuiElementName | "#text";

export type TuiNodeAttribute = boolean | number | string | undefined;

export type TuiLayoutRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TuiStyle = {
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dim?: boolean;
  inverse?: boolean;
  underline?: boolean;
};

export type TuiScrollFields = {
  scrollTop: number;
  pendingDelta: number;
  scrollHeight: number;
  viewportHeight: number;
  viewportTop: number;
  sticky: boolean;
  clampMin?: number;
  clampMax?: number;
};

export type TuiBaseNode = {
  nodeName: TuiNodeName;
  parentNode?: TuiElement;
  dirty: boolean;
  hidden: boolean;
  layout: TuiLayoutRect;
  debugOwnerChain: string[];
};

export type TuiElement = TuiBaseNode & {
  nodeName: TuiElementName;
  attributes: Record<string, TuiNodeAttribute>;
  style: TuiStyle;
  childNodes: TuiNode[];
  focusable: boolean;
  focused: boolean;
  eventHandlers: Record<string, unknown>;
  scroll?: TuiScrollFields;
};

export type TuiTextNode = TuiBaseNode & {
  nodeName: "#text";
  nodeValue: string;
  style: TuiStyle;
};

export type TuiNode = TuiElement | TuiTextNode;

export function createElement(nodeName: TuiElementName, attributes: Record<string, TuiNodeAttribute> = {}): TuiElement {
  const node: TuiElement = {
    nodeName,
    parentNode: undefined,
    dirty: true,
    hidden: false,
    layout: { x: 0, y: 0, width: 0, height: 0 },
    debugOwnerChain: [],
    attributes: {},
    style: {},
    childNodes: [],
    focusable: false,
    focused: false,
    eventHandlers: {}
  };
  setAttributes(node, attributes);
  if (nodeName === "swarm-scroll") {
    node.scroll = createScrollFields();
  }
  return node;
}

export function createRootElement(): TuiElement {
  return createElement("swarm-root", { flexDirection: "column" });
}

export function createTextNode(value: string): TuiTextNode {
  return {
    nodeName: "#text",
    nodeValue: value,
    parentNode: undefined,
    dirty: true,
    hidden: false,
    layout: { x: 0, y: 0, width: 0, height: 0 },
    debugOwnerChain: [],
    style: {}
  };
}

export function appendChild(parent: TuiElement, child: TuiNode): void {
  if (child.parentNode) {
    removeChild(child.parentNode, child);
  }
  child.parentNode = parent;
  parent.childNodes.push(child);
  markDirty(parent);
}

export function insertBefore(parent: TuiElement, child: TuiNode, before: TuiNode): void {
  if (child.parentNode) {
    removeChild(child.parentNode, child);
  }
  const index = parent.childNodes.indexOf(before);
  child.parentNode = parent;
  if (index < 0) {
    parent.childNodes.push(child);
  } else {
    parent.childNodes.splice(index, 0, child);
  }
  markDirty(parent);
}

export function removeChild(parent: TuiElement, child: TuiNode): void {
  const index = parent.childNodes.indexOf(child);
  if (index >= 0) {
    parent.childNodes.splice(index, 1);
  }
  child.parentNode = undefined;
  markDirty(parent);
}

export function setAttribute(node: TuiElement, key: string, value: TuiNodeAttribute): void {
  if (key === "children") {
    return;
  }
  if (value === undefined || (value === false && !preservesFalseAttribute(key))) {
    if (key in node.attributes) {
      delete node.attributes[key];
      markDirty(node);
    }
    return;
  }
  if (node.attributes[key] === value) {
    return;
  }
  node.attributes[key] = value;
  applyKnownAttribute(node, key, value);
  markDirty(node);
}

export function setAttributes(node: TuiElement, attributes: Record<string, TuiNodeAttribute>): void {
  for (const [key, value] of Object.entries(attributes)) {
    setAttribute(node, key, value);
  }
}

export function setTextNodeValue(node: TuiTextNode, value: string): void {
  if (node.nodeValue === value) {
    return;
  }
  node.nodeValue = value;
  markDirty(node);
}

export function markDirty(node: TuiNode): void {
  node.dirty = true;
  let parent = node.parentNode;
  while (parent) {
    parent.dirty = true;
    parent = parent.parentNode;
  }
}

export function clearDirty(node: TuiNode): void {
  node.dirty = false;
  if (node.nodeName !== "#text") {
    for (const child of node.childNodes) {
      clearDirty(child);
    }
  }
}

export function walkTuiTree(node: TuiNode, visit: (node: TuiNode) => void): void {
  visit(node);
  if (node.nodeName === "#text") {
    return;
  }
  for (const child of node.childNodes) {
    walkTuiTree(child, visit);
  }
}

export function textContent(node: TuiNode): string {
  if (node.nodeName === "#text") {
    return node.nodeValue;
  }
  return node.childNodes.map((child) => textContent(child)).join("");
}

export function updateScrollFields(node: TuiElement, fields: Partial<TuiScrollFields>): TuiScrollFields {
  node.scroll ??= createScrollFields();
  node.scroll = {
    ...node.scroll,
    ...fields,
    scrollTop: sanitizeRow(fields.scrollTop ?? node.scroll.scrollTop),
    pendingDelta: sanitizeRow(fields.pendingDelta ?? node.scroll.pendingDelta),
    scrollHeight: Math.max(0, sanitizeRow(fields.scrollHeight ?? node.scroll.scrollHeight)),
    viewportHeight: Math.max(0, sanitizeRow(fields.viewportHeight ?? node.scroll.viewportHeight)),
    viewportTop: sanitizeRow(fields.viewportTop ?? node.scroll.viewportTop),
    sticky: fields.sticky ?? node.scroll.sticky
  };
  markDirty(node);
  return node.scroll;
}

export function maxScrollTop(fields: Pick<TuiScrollFields, "scrollHeight" | "viewportHeight">): number {
  return Math.max(0, sanitizeRow(fields.scrollHeight) - Math.max(0, sanitizeRow(fields.viewportHeight)));
}

export function clampScrollTop(fields: TuiScrollFields, value: number): number {
  const upperFromHeight = maxScrollTop(fields);
  const upper = Math.max(0, Math.min(upperFromHeight, fields.clampMax ?? upperFromHeight));
  const lower = Math.max(0, Math.min(fields.clampMin ?? 0, upper));
  return Math.max(lower, Math.min(upper, sanitizeRow(value)));
}

export function sanitizeRow(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.floor(value);
}

function createScrollFields(): TuiScrollFields {
  return {
    scrollTop: 0,
    pendingDelta: 0,
    scrollHeight: 0,
    viewportHeight: 0,
    viewportTop: 0,
    sticky: false
  };
}

function applyKnownAttribute(node: TuiElement, key: string, value: TuiNodeAttribute): void {
  if (key === "focusable") {
    node.focusable = Boolean(value);
    return;
  }
  if (key === "focused") {
    node.focused = Boolean(value);
    return;
  }
  if (key === "hidden") {
    node.hidden = Boolean(value);
    return;
  }
  if (key === "dimColor") {
    node.style = { ...node.style, dim: Boolean(value) };
    return;
  }
  if (["color", "backgroundColor", "bold", "dim", "inverse", "underline"].includes(key)) {
    node.style = { ...node.style, [key]: value };
  }
}

function preservesFalseAttribute(key: string): boolean {
  return key === "borderTop" || key === "borderBottom" || key === "borderLeft" || key === "borderRight";
}
