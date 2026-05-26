import { BEL, CSI, ESC, OSC, ST } from "./ansi.js";

export type TermioToken =
  | { type: "text"; value: string; raw: string }
  | { type: "escape"; value: string; raw: string }
  | { type: "incomplete"; raw: string };

export function tokenizeTermio(input: string, options: { flush?: boolean } = {}): {
  tokens: TermioToken[];
  rest: string;
} {
  const tokens: TermioToken[] = [];
  let index = 0;
  while (index < input.length) {
    const escIndex = input.indexOf(ESC, index);
    if (escIndex < 0) {
      tokens.push({ type: "text", value: input.slice(index), raw: input.slice(index) });
      return { tokens, rest: "" };
    }
    if (escIndex > index) {
      tokens.push({ type: "text", value: input.slice(index, escIndex), raw: input.slice(index, escIndex) });
      index = escIndex;
    }
    const parsed = readEscape(input, index);
    if (!parsed) {
      const rest = input.slice(index);
      if (options.flush) {
        tokens.push({ type: "escape", value: rest, raw: rest });
        return { tokens, rest: "" };
      }
      return { tokens, rest };
    }
    tokens.push({ type: "escape", value: parsed.raw, raw: parsed.raw });
    index = parsed.end;
  }
  return { tokens, rest: "" };
}

function readEscape(input: string, index: number): { raw: string; end: number } | undefined {
  const next = input[index + 1];
  if (!next) {
    return undefined;
  }
  if (input.startsWith(CSI, index)) {
    for (let cursor = index + CSI.length; cursor < input.length; cursor += 1) {
      const char = input[cursor] ?? "";
      if (/[@-~]/u.test(char)) {
        return { raw: input.slice(index, cursor + 1), end: cursor + 1 };
      }
    }
    return undefined;
  }
  if (input.startsWith(OSC, index)) {
    const bel = input.indexOf(BEL, index + OSC.length);
    const st = input.indexOf(ST, index + OSC.length);
    const end = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st);
    if (end < 0) {
      return undefined;
    }
    return { raw: input.slice(index, end + (end === st ? ST.length : BEL.length)), end: end + (end === st ? ST.length : BEL.length) };
  }
  if (isControlCharacter(next)) {
    return { raw: input.slice(index, index + 1), end: index + 1 };
  }
  return { raw: input.slice(index, index + 2), end: index + 2 };
}

function isControlCharacter(value: string): boolean {
  const code = value.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
}
