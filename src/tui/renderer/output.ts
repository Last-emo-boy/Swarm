import type { TuiScreen, TuiScreenCell } from "./screen.js";
import { screenToLines, unionDamage, type TuiDamageRect } from "./screen.js";
import type { TuiTerminalCapabilities } from "./terminal-capabilities.js";
import type { TuiStyle } from "./dom.js";

export type TuiFrameDiffLine = {
  row: number;
  previous: string;
  next: string;
  cells?: readonly TuiScreenCell[];
};

export type TuiFrameDiff = {
  changed: TuiFrameDiffLine[];
  fullReset: boolean;
  scannedRows: number;
  damage?: TuiDamageRect;
};

export type TuiTerminalPatch =
  | { type: "clearScreen" }
  | { type: "moveCursor"; row: number; column: number }
  | { type: "clearLine" }
  | { type: "write"; text: string };

export type TuiTerminalPatchOptions = {
  capabilities?: Partial<Pick<TuiTerminalCapabilities, "hyperlinks" | "color" | "trueColor" | "colorLevel">>;
};

export function diffScreens(previous: TuiScreen | undefined, next: TuiScreen): TuiFrameDiff {
  if (!previous || previous.width !== next.width || previous.height !== next.height) {
    return {
      changed: screenToLines(next, { trimRight: false }).map((line, row) => ({ row, previous: "", next: line, cells: next.cells[row] })),
      fullReset: true,
      scannedRows: next.height,
      damage: next.height > 0 && next.width > 0 ? { x: 0, y: 0, width: next.width, height: next.height } : undefined
    };
  }
  const previousLines = screenToLines(previous, { trimRight: false });
  const nextLines = screenToLines(next, { trimRight: false });
  const changed: TuiFrameDiffLine[] = [];
  const damage = diffDamage(previous, next);
  const startRow = damage?.y ?? 0;
  const endRow = damage ? damage.y + damage.height : nextLines.length;
  for (let row = startRow; row < endRow; row += 1) {
    if (previousLines[row] !== nextLines[row] || !sameTerminalRow(previous.cells[row], next.cells[row])) {
      changed.push({ row, previous: previousLines[row] ?? "", next: nextLines[row] ?? "", cells: next.cells[row] });
    }
  }
  return { changed, fullReset: false, scannedRows: Math.max(0, endRow - startRow), damage };
}

export function buildTerminalPatch(diff: TuiFrameDiff, options: TuiTerminalPatchOptions = {}): TuiTerminalPatch[] {
  const patch: TuiTerminalPatch[] = [];
  if (diff.fullReset) {
    patch.push({ type: "clearScreen" });
  }
  for (const line of diff.changed) {
    patch.push(
      { type: "moveCursor", row: line.row, column: 0 },
      { type: "clearLine" },
      { type: "write", text: terminalLineText(line, options) }
    );
  }
  return patch;
}

export function terminalPatchToString(patch: readonly TuiTerminalPatch[]): string {
  return patch.map((item) => {
    switch (item.type) {
      case "clearScreen":
        return "\u001B[2J";
      case "moveCursor":
        return `\u001B[${Math.max(1, Math.floor(item.row) + 1)};${Math.max(1, Math.floor(item.column) + 1)}H`;
      case "clearLine":
        return "\u001B[2K";
      case "write":
        return item.text;
    }
  }).join("");
}

function diffDamage(previous: TuiScreen, next: TuiScreen): TuiDamageRect | undefined {
  if (previous.damage && next.damage) {
    return unionDamage(previous.damage, next.damage);
  }
  return next.damage ?? previous.damage;
}

function terminalLineText(line: TuiFrameDiffLine, options: TuiTerminalPatchOptions): string {
  if (!line.cells?.some((cell) => cell.hyperlink || hasTerminalStyle(cell.style))) {
    return line.next;
  }
  let output = "";
  let activeHref: string | undefined;
  let activeStyle: TuiStyle = {};
  for (const cell of line.cells) {
    if (cell.char === "") {
      continue;
    }
    const nextHref = options.capabilities?.hyperlinks ? cell.hyperlink : undefined;
    if (nextHref !== activeHref) {
      if (activeHref) {
        output += "\u001B]8;;\u001B\\";
      }
      activeHref = nextHref;
      if (activeHref) {
        output += `\u001B]8;;${sanitizeOscValue(activeHref)}\u001B\\`;
      }
    }
    if (!sameStyle(activeStyle, cell.style)) {
      output += sgrForStyle(cell.style, {
        resetFirst: hasTerminalStyle(activeStyle),
        color: options.capabilities?.color !== false,
        trueColor: options.capabilities?.trueColor === true,
        colorLevel: options.capabilities?.colorLevel
      });
      activeStyle = { ...cell.style };
    }
    output += cell.char;
  }
  if (activeHref) {
    output += "\u001B]8;;\u001B\\";
  }
  if (hasTerminalStyle(activeStyle)) {
    output += "\u001B[0m";
  }
  return output;
}

function sanitizeOscValue(value: string): string {
  return value.replace(/[\u0007\u001B]/gu, "");
}

function sameTerminalRow(left: readonly TuiScreenCell[] | undefined, right: readonly TuiScreenCell[] | undefined): boolean {
  if (!left || !right || left.length !== right.length) {
    return left === right;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftCell = left[index]!;
    const rightCell = right[index]!;
    if (leftCell.char !== rightCell.char ||
      leftCell.hyperlink !== rightCell.hyperlink ||
      !sameStyle(leftCell.style, rightCell.style)) {
      return false;
    }
  }
  return true;
}

function hasTerminalStyle(style: TuiStyle | undefined): boolean {
  return Boolean(style?.color || style?.backgroundColor || style?.bold || style?.dim || style?.inverse || style?.underline);
}

function sameStyle(left: TuiStyle | undefined, right: TuiStyle | undefined): boolean {
  return (left?.color ?? undefined) === (right?.color ?? undefined) &&
    (left?.backgroundColor ?? undefined) === (right?.backgroundColor ?? undefined) &&
    Boolean(left?.bold) === Boolean(right?.bold) &&
    Boolean(left?.dim) === Boolean(right?.dim) &&
    Boolean(left?.inverse) === Boolean(right?.inverse) &&
    Boolean(left?.underline) === Boolean(right?.underline);
}

function sgrForStyle(
  style: TuiStyle,
  options: { resetFirst?: boolean; color?: boolean; trueColor?: boolean; colorLevel?: 0 | 1 | 2 | 3 } = {}
): string {
  if (!hasTerminalStyle(style)) {
    return "\u001B[0m";
  }
  const codes: number[] = [];
  if (options.resetFirst) {
    codes.push(0);
  }
  if (style.bold) {
    codes.push(1);
  }
  if (style.dim) {
    codes.push(2);
  }
  if (style.underline) {
    codes.push(4);
  }
  if (style.inverse) {
    codes.push(7);
  }
  if (options.color !== false) {
    const colorLevel = options.colorLevel ?? (options.trueColor === true ? 3 : 1);
    const foreground = colorCodes(style.color, "foreground", {
      trueColor: options.trueColor === true,
      colorLevel
    });
    if (foreground.length) {
      codes.push(...foreground);
    }
    const background = colorCodes(style.backgroundColor, "background", {
      trueColor: options.trueColor === true,
      colorLevel
    });
    if (background.length) {
      codes.push(...background);
    }
  }
  return codes.length ? `\u001B[${codes.join(";")}m` : "\u001B[0m";
}

function colorCodes(
  color: string | undefined,
  type: "foreground" | "background",
  options: { trueColor: boolean; colorLevel: 0 | 1 | 2 | 3 }
): number[] {
  if (!color) {
    return [];
  }
  if (options.colorLevel <= 0) {
    return [];
  }
  const ansi256 = parseAnsi256(color);
  if (ansi256 !== undefined && options.colorLevel >= 2) {
    return [type === "foreground" ? 38 : 48, 5, ansi256];
  }
  const rgb = parseRgbColor(color);
  if (rgb && options.trueColor) {
    return [type === "foreground" ? 38 : 48, 2, rgb.r, rgb.g, rgb.b];
  }
  if (rgb && options.colorLevel >= 2) {
    return [type === "foreground" ? 38 : 48, 5, rgbToAnsi256(rgb)];
  }
  if (rgb && options.colorLevel >= 1) {
    return ansi16Codes(rgbToAnsi16(rgb), type);
  }
  if (ansi256 !== undefined && options.colorLevel >= 1) {
    return ansi16Codes(rgbToAnsi16(ansi256ToRgb(ansi256)), type);
  }
  const normalized = normalizeColorName(color);
  const foreground = ANSI_FOREGROUND_COLORS[normalized];
  if (foreground === undefined) {
    return [];
  }
  if (type === "foreground") {
    return [foreground];
  }
  if (foreground >= 90) {
    return [foreground + 10];
  }
  return [foreground + 10];
}

function ansi16Codes(foreground: number, type: "foreground" | "background"): number[] {
  if (type === "foreground") {
    return [foreground];
  }
  return [foreground >= 90 ? foreground + 10 : foreground + 10];
}

function parseAnsi256(color: string): number | undefined {
  const match = /^ansi256\((\d{1,3})\)$/iu.exec(color.trim());
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    return undefined;
  }
  return value;
}

function parseRgbColor(color: string): { r: number; g: number; b: number } | undefined {
  const value = color.trim();
  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/iu.exec(value);
  if (rgb) {
    return rgbTuple(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(value);
  if (!hex) {
    return undefined;
  }
  const raw = hex[1]!;
  if (raw.length === 3) {
    return rgbTuple(
      Number.parseInt(raw[0]! + raw[0]!, 16),
      Number.parseInt(raw[1]! + raw[1]!, 16),
      Number.parseInt(raw[2]! + raw[2]!, 16)
    );
  }
  return rgbTuple(
    Number.parseInt(raw.slice(0, 2), 16),
    Number.parseInt(raw.slice(2, 4), 16),
    Number.parseInt(raw.slice(4, 6), 16)
  );
}

function rgbTuple(r: number, g: number, b: number): { r: number; g: number; b: number } | undefined {
  if (![r, g, b].every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
    return undefined;
  }
  return { r, g, b };
}

function rgbToAnsi256(rgb: { r: number; g: number; b: number }): number {
  const { r, g, b } = rgb;
  if (r === g && g === b) {
    if (r < 8) {
      return 16;
    }
    if (r > 248) {
      return 231;
    }
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const red = Math.round((r / 255) * 5);
  const green = Math.round((g / 255) * 5);
  const blue = Math.round((b / 255) * 5);
  return 16 + (36 * red) + (6 * green) + blue;
}

function ansi256ToRgb(value: number): { r: number; g: number; b: number } {
  if (value < 16) {
    return ANSI16_RGB[value] ?? { r: 255, g: 255, b: 255 };
  }
  if (value >= 232) {
    const gray = 8 + ((value - 232) * 10);
    return { r: gray, g: gray, b: gray };
  }
  const index = value - 16;
  return {
    r: ANSI256_STEPS[Math.floor(index / 36)] ?? 0,
    g: ANSI256_STEPS[Math.floor((index % 36) / 6)] ?? 0,
    b: ANSI256_STEPS[index % 6] ?? 0
  };
}

function rgbToAnsi16(rgb: { r: number; g: number; b: number }): number {
  let bestColor = 37;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [code, candidate] of ANSI16_CODE_RGB) {
    const distance = ((rgb.r - candidate.r) ** 2) + ((rgb.g - candidate.g) ** 2) + ((rgb.b - candidate.b) ** 2);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestColor = code;
    }
  }
  return bestColor;
}

function normalizeColorName(color: string): string {
  return color
    .trim()
    .replace(/^ansi:/u, "")
    .replace(/bright$/iu, "Bright")
    .replace(/[-_\s]/gu, "")
    .toLowerCase();
}

const ANSI_FOREGROUND_COLORS: Record<string, number> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
  grey: 90,
  brightblack: 90,
  brightred: 91,
  brightgreen: 92,
  brightyellow: 93,
  brightblue: 94,
  brightmagenta: 95,
  brightcyan: 96,
  brightwhite: 97,
  blackbright: 90,
  redbright: 91,
  greenbright: 92,
  yellowbright: 93,
  bluebright: 94,
  magentabright: 95,
  cyanbright: 96,
  whitebright: 97
};

const ANSI256_STEPS = [0, 95, 135, 175, 215, 255] as const;

const ANSI16_RGB: Array<{ r: number; g: number; b: number } | undefined> = [
  { r: 0, g: 0, b: 0 },
  { r: 128, g: 0, b: 0 },
  { r: 0, g: 128, b: 0 },
  { r: 128, g: 128, b: 0 },
  { r: 0, g: 0, b: 128 },
  { r: 128, g: 0, b: 128 },
  { r: 0, g: 128, b: 128 },
  { r: 192, g: 192, b: 192 },
  { r: 128, g: 128, b: 128 },
  { r: 255, g: 0, b: 0 },
  { r: 0, g: 255, b: 0 },
  { r: 255, g: 255, b: 0 },
  { r: 0, g: 0, b: 255 },
  { r: 255, g: 0, b: 255 },
  { r: 0, g: 255, b: 255 },
  { r: 255, g: 255, b: 255 }
];

const ANSI16_CODE_RGB: Array<[number, { r: number; g: number; b: number }]> = [
  [30, ANSI16_RGB[0]!],
  [31, ANSI16_RGB[1]!],
  [32, ANSI16_RGB[2]!],
  [33, ANSI16_RGB[3]!],
  [34, ANSI16_RGB[4]!],
  [35, ANSI16_RGB[5]!],
  [36, ANSI16_RGB[6]!],
  [37, ANSI16_RGB[7]!],
  [90, ANSI16_RGB[8]!],
  [91, ANSI16_RGB[9]!],
  [92, ANSI16_RGB[10]!],
  [93, ANSI16_RGB[11]!],
  [94, ANSI16_RGB[12]!],
  [95, ANSI16_RGB[13]!],
  [96, ANSI16_RGB[14]!],
  [97, ANSI16_RGB[15]!]
];
