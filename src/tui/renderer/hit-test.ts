import type { TuiElement } from "./dom.js";
import type { TuiScreen, TuiScreenCell } from "./screen.js";

export type TuiHitTarget = {
  x: number;
  y: number;
  cell: TuiScreenCell;
  hyperlink?: string;
  noSelect: boolean;
  ownerChain: readonly string[];
  nodeName?: string;
};

export function hitTestScreen(screen: TuiScreen, x: number, y: number): TuiHitTarget | undefined {
  const column = Math.floor(x);
  const row = Math.floor(y);
  const cell = screen.cells[row]?.[column];
  if (!cell) {
    return undefined;
  }
  return {
    x: column,
    y: row,
    cell,
    hyperlink: cell.hyperlink,
    noSelect: Boolean(cell.noSelect),
    ownerChain: cell.ownerChain ?? [],
    nodeName: cell.nodeName
  };
}

export function hitTestLink(screen: TuiScreen, x: number, y: number): string | undefined {
  return hitTestScreen(screen, x, y)?.hyperlink;
}

export function hitTestDom(root: TuiElement, x: number, y: number): TuiElement | undefined {
  const column = Math.floor(x);
  const row = Math.floor(y);
  let best: TuiElement | undefined;
  visit(root);
  return best;

  function visit(node: TuiElement): void {
    if (node.hidden) {
      return;
    }
    if (
      column >= node.layout.x &&
      column < node.layout.x + node.layout.width &&
      row >= node.layout.y &&
      row < node.layout.y + node.layout.height
    ) {
      best = node;
      for (const child of node.childNodes) {
        if (child.nodeName !== "#text") {
          visit(child);
        }
      }
    }
  }
}

