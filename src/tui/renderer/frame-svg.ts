import { displayWidth } from "../display-width.js";
import type { TuiScreen, TuiScreenCell } from "./screen.js";
import type { TuiStyle } from "./dom.js";

/**
 * A rendered screen as an SVG picture of the terminal: one dark panel, each run of same-styled cells placed at its
 * column. Runs are split where characters change width and given an exact `textLength`, so wide (CJK) text and box
 * drawing stay on the grid whatever monospace font the viewer has; a run of `─` becomes a line. Cells without a
 * colour take the terminal's foreground, as they do in a terminal.
 */
export function screenToSvg(screen: TuiScreen, options: {
  background?: string;
  foreground?: string;
  fontSize?: number;
  /** Width of one cell as a share of the font size; monospace fonts are about 0.6. */
  cellRatio?: number;
  lineHeight?: number;
  padding?: number;
  radius?: number;
  /** Rows to keep from the top; blank rows at the bottom are dropped either way. */
  rows?: number;
  /** Alternative text for the picture. */
  title?: string;
} = {}): string {
  const background = options.background ?? "#17191c";
  const foreground = options.foreground ?? "#e8e8e8";
  const fontSize = options.fontSize ?? 14;
  const cellWidth = fontSize * (options.cellRatio ?? 0.6);
  const lineHeight = options.lineHeight ?? Math.round(fontSize * 1.45);
  const padding = options.padding ?? 20;
  const radius = options.radius ?? 10;
  const rows = trimBlankRows(screen.cells.slice(0, options.rows ?? screen.height));
  const width = Math.ceil(screen.width * cellWidth + padding * 2);
  const height = Math.ceil(rows.length * lineHeight + padding * 2);
  const parts: string[] = [];

  rows.forEach((row, y) => {
    const top = padding + y * lineHeight;
    const baseline = top + Math.round(lineHeight * 0.72);
    for (const run of styledRuns(row)) {
      const x = padding + run.column * cellWidth;
      const runWidth = run.cells * cellWidth;
      const { fg, bg } = runColors(run.style, foreground, background);
      if (bg) {
        parts.push(`<rect x="${fmt(x)}" y="${top}" width="${fmt(runWidth)}" height="${lineHeight}" fill="${bg}"/>`);
      }
      if (!run.text.trim()) {
        continue;
      }
      if (/^─+$/u.test(run.text)) {
        const middle = top + lineHeight / 2;
        parts.push(`<line x1="${fmt(x)}" y1="${fmt(middle)}" x2="${fmt(x + runWidth)}" y2="${fmt(middle)}" stroke="${fg}" stroke-width="1"/>`);
        continue;
      }
      // On each text: browsers give <text> its own white-space, so a value on the group never reaches it.
      const attributes = [
        `xml:space="preserve"`,
        `x="${fmt(x)}"`,
        `y="${baseline}"`,
        `textLength="${fmt(runWidth)}"`,
        `lengthAdjust="spacingAndGlyphs"`,
        `fill="${fg}"`,
        run.style.bold ? `font-weight="700"` : "",
        run.style.dim ? `opacity="0.6"` : "",
        run.style.underline ? `text-decoration="underline"` : ""
      ].filter(Boolean).join(" ");
      parts.push(`<text ${attributes}>${escapeXml(run.text)}</text>`);
    }
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"${options.title ? ` aria-label="${escapeXml(options.title)}"` : ""}>`,
    options.title ? `<title>${escapeXml(options.title)}</title>` : "",
    `<rect width="${width}" height="${height}" rx="${radius}" fill="${background}"/>`,
    `<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace" font-size="${fontSize}">`,
    ...parts,
    "</g>",
    "</svg>",
    ""
  ].filter((line) => line !== "").join("\n");
}

type StyledRun = { column: number; cells: number; text: string; style: TuiStyle };

/** A row's cells as runs of one style and one character width, with their column and how many cells they cover. */
export function styledRuns(row: readonly TuiScreenCell[]): StyledRun[] {
  const runs: StyledRun[] = [];
  let current: (StyledRun & { key: string }) | undefined;
  for (let column = 0; column < row.length; column += 1) {
    const cell = row[column]!;
    if (cell.char === "") {
      // The second half of a wide character: counted with the character before it.
      continue;
    }
    const cells = Math.max(1, displayWidth(cell.char));
    const key = `${styleKey(cell.style)}|${cells}`;
    if (current && current.key === key && current.column + current.cells === column) {
      current.cells += cells;
      current.text += cell.char;
      continue;
    }
    if (current) {
      runs.push(stripKey(current));
    }
    current = { column, cells, text: cell.char, style: cell.style, key };
  }
  if (current) {
    runs.push(stripKey(current));
  }
  // Trailing spaces without a background draw nothing.
  while (runs.length && !runs.at(-1)!.style.backgroundColor && !runs.at(-1)!.style.inverse) {
    const last = runs.at(-1)!;
    const text = last.text.replace(/ +$/u, "");
    if (text) {
      last.cells -= last.text.length - text.length;
      last.text = text;
      break;
    }
    runs.pop();
  }
  return runs;
}

function stripKey(run: StyledRun & { key: string }): StyledRun {
  return { column: run.column, cells: run.cells, text: run.text, style: run.style };
}

function styleKey(style: TuiStyle): string {
  return [style.color ?? "", style.backgroundColor ?? "", style.bold ? "b" : "", style.dim ? "d" : "", style.inverse ? "i" : "", style.underline ? "u" : ""].join(",");
}

function runColors(style: TuiStyle, foreground: string, background: string): { fg: string; bg?: string } {
  const fg = cssColor(style.color) ?? foreground;
  const bg = cssColor(style.backgroundColor);
  if (style.inverse) {
    return { fg: bg ?? background, bg: fg };
  }
  return { fg, ...(bg ? { bg } : {}) };
}

const NAMED: Record<string, string> = {
  black: "#000000", red: "#cd3131", green: "#0dbc79", yellow: "#e5e510", blue: "#2472c8", magenta: "#bc3fbc",
  cyan: "#11a8cd", white: "#e5e5e5", gray: "#808080", grey: "#808080", brightRed: "#f14c4c", brightGreen: "#23d18b",
  brightYellow: "#f5f543", brightBlue: "#3b8eea", brightMagenta: "#d670d6", brightCyan: "#29b8db", brightWhite: "#ffffff"
};

function cssColor(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/u.exec(value);
  if (rgb) {
    return `#${rgb.slice(1).map((part) => Number(part).toString(16).padStart(2, "0")).join("")}`;
  }
  return NAMED[value] ?? (value.startsWith("#") ? value : undefined);
}

function trimBlankRows(rows: TuiScreenCell[][]): TuiScreenCell[][] {
  let end = rows.length;
  while (end > 0 && styledRuns(rows[end - 1]!).every((run) => !run.text.trim() && !run.style.backgroundColor)) {
    end -= 1;
  }
  return rows.slice(0, end);
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
}

function escapeXml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}
