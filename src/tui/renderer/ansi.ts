import { displayWidth } from "../display-width.js";
import type { TuiStyle } from "./dom.js";

export type TuiAnsiSpan = {
  text: string;
  style: TuiStyle;
};

const ANSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
const SGR_PATTERN = /^\u001B\[([0-9;]*)m$/;

const ANSI_COLORS: Record<number, string> = {
  30: "black",
  31: "red",
  32: "green",
  33: "yellow",
  34: "blue",
  35: "magenta",
  36: "cyan",
  37: "white",
  90: "brightBlack",
  91: "brightRed",
  92: "brightGreen",
  93: "brightYellow",
  94: "brightBlue",
  95: "brightMagenta",
  96: "brightCyan",
  97: "brightWhite"
};

export function parseAnsiSpans(value: string, baseStyle: TuiStyle = {}): TuiAnsiSpan[] {
  const spans: TuiAnsiSpan[] = [];
  let style: TuiStyle = { ...baseStyle };
  let offset = 0;
  ANSI_PATTERN.lastIndex = 0;
  for (const match of value.matchAll(ANSI_PATTERN)) {
    const index = match.index ?? 0;
    if (index > offset) {
      spans.push({ text: value.slice(offset, index), style: { ...style } });
    }
    const sgr = SGR_PATTERN.exec(match[0]);
    if (sgr) {
      style = applySgrCodes(style, sgrCodes(sgr[1]));
    }
    offset = index + match[0].length;
  }
  if (offset < value.length) {
    spans.push({ text: value.slice(offset), style: { ...style } });
  }
  return spans.length > 0 ? spans : [{ text: "", style }];
}

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

export function ansiDisplayWidth(value: string): number {
  return displayWidth(stripAnsi(value));
}

function sgrCodes(value: string | undefined): number[] {
  if (!value) {
    return [0];
  }
  const codes = value.split(";").map((part) => Number(part));
  return codes.every((code) => Number.isFinite(code)) ? codes : [0];
}

function applySgrCodes(style: TuiStyle, codes: number[]): TuiStyle {
  let next = { ...style };
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index] ?? 0;
    if (code === 0) {
      next = {};
      continue;
    }
    if (code === 1) {
      next.bold = true;
      continue;
    }
    if (code === 2) {
      next.dim = true;
      continue;
    }
    if (code === 4) {
      next.underline = true;
      continue;
    }
    if (code === 7) {
      next.inverse = true;
      continue;
    }
    if (code === 22) {
      delete next.bold;
      delete next.dim;
      continue;
    }
    if (code === 24) {
      delete next.underline;
      continue;
    }
    if (code === 27) {
      delete next.inverse;
      continue;
    }
    if (code === 39) {
      delete next.color;
      continue;
    }
    if (code === 49) {
      delete next.backgroundColor;
      continue;
    }
    if (code >= 30 && code <= 37 || code >= 90 && code <= 97) {
      next.color = ANSI_COLORS[code];
      continue;
    }
    if (code >= 40 && code <= 47) {
      next.backgroundColor = ANSI_COLORS[code - 10];
      continue;
    }
    if (code >= 100 && code <= 107) {
      next.backgroundColor = ANSI_COLORS[code - 10];
      continue;
    }
  }
  return next;
}
