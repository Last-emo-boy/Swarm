import type { TuiInputKey } from "./events/input-event.js";
import { parseTerminalQueryResponse, type TuiTerminalQueryResponse } from "./terminal-query.js";
import { CSI, ESC } from "./termio/ansi.js";
import { csiModifier, parseCsiSequence } from "./termio/csi.js";
import { tokenizeTermio } from "./termio/tokenize.js";

export type TuiMouseInput = {
  x: number;
  y: number;
  button: "left" | "middle" | "right" | "wheel-up" | "wheel-down" | "unknown";
  action: "press" | "release" | "drag";
};

export type TuiParsedInput =
  | { type: "key"; input?: string; key: TuiInputKey; raw: string }
  | { type: "paste"; text: string; key: TuiInputKey; raw: string }
  | { type: "mouse"; mouse: TuiMouseInput; raw: string }
  | { type: "terminal-focus"; focused: boolean; raw: string }
  | { type: "terminal-response"; response: TuiTerminalQueryResponse; raw: string }
  | { type: "malformed"; raw: string; reason: string };

export class TuiInputParser {
  private buffer = "";

  parse(chunk: string | Buffer, options: { flush?: boolean } = {}): TuiParsedInput[] {
    this.buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    const pasteAware = parsePasteAwareBuffer(this.buffer, options);
    this.buffer = pasteAware.rest;
    return pasteAware.events;
  }

  parseTokens(input: string, options: { flush?: boolean } = {}): { events: TuiParsedInput[]; rest: string } {
    if (input.length === 0) {
      return { events: [], rest: "" };
    }
    const { tokens, rest } = tokenizeTermio(input, options);
    const parsed: TuiParsedInput[] = [];
    for (const token of tokens) {
      if (token.type === "text") {
        parsed.push(...parsePlainText(token.value));
        continue;
      }
      if (token.type === "escape") {
        parsed.push(parseEscapeToken(token.raw));
      }
    }
    return { events: parsed, rest };
  }

  flush(): TuiParsedInput[] {
    return this.parse("", { flush: true });
  }

  pending(): string {
    if (this.buffer.startsWith(`${CSI}200~`)) {
      return "";
    }
    return this.buffer;
  }
}

export function parseTuiInputChunk(chunk: string | Buffer, options: { flush?: boolean } = {}): TuiParsedInput[] {
  return new TuiInputParser().parse(chunk, options);
}

function parsePlainText(value: string): TuiParsedInput[] {
  const parsed: TuiParsedInput[] = [];
  for (const char of value) {
    switch (char) {
      case "\r":
      case "\n":
        parsed.push({ type: "key", key: { return: true }, raw: char });
        break;
      case "\t":
        parsed.push({ type: "key", key: { tab: true }, raw: char });
        break;
      case "\u0003":
        parsed.push({ type: "key", input: "c", key: { ctrl: true }, raw: char });
        break;
      case "\u001A":
        parsed.push({ type: "key", input: "z", key: { ctrl: true }, raw: char });
        break;
      case "\u007F":
      case "\b":
        parsed.push({ type: "key", key: { backspace: true }, raw: char });
        break;
      default:
        parsed.push(controlKeyForChar(char) ?? { type: "key", input: char, key: {}, raw: char });
        break;
    }
  }
  return parsed;
}

function controlKeyForChar(char: string): Extract<TuiParsedInput, { type: "key" }> | undefined {
  const code = char.charCodeAt(0);
  if (code < 1 || code > 26) {
    return undefined;
  }
  return {
    type: "key",
    input: String.fromCharCode(code + 96),
    key: { ctrl: true },
    raw: char
  };
}

function parsePasteAwareBuffer(input: string, options: { flush?: boolean }): { events: TuiParsedInput[]; rest: string } {
  const startMarker = `${CSI}200~`;
  const endMarker = `${CSI}201~`;
  const parser = new TuiInputParser();
  const events: TuiParsedInput[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    const start = input.indexOf(startMarker, cursor);
    if (start < 0) {
      const tail = parser.parseTokens(input.slice(cursor), options);
      events.push(...tail.events);
      return { events, rest: tail.rest };
    }
    const prefix = parser.parseTokens(input.slice(cursor, start), { flush: false });
    events.push(...prefix.events);
    if (prefix.rest.length > 0) {
      return { events, rest: prefix.rest + input.slice(start) };
    }
    const end = input.indexOf(endMarker, start + startMarker.length);
    if (end < 0) {
      if (!options.flush) {
        return { events, rest: input.slice(start) };
      }
      events.push({
        type: "paste",
        text: input.slice(start + startMarker.length),
        key: { paste: true },
        raw: input.slice(start)
      });
      return { events, rest: "" };
    }
    events.push({
      type: "paste",
      text: input.slice(start + startMarker.length, end),
      key: { paste: true },
      raw: input.slice(start, end + endMarker.length)
    });
    cursor = end + endMarker.length;
  }
  return { events, rest: "" };
}

function parseEscapeToken(raw: string): TuiParsedInput {
  const response = parseTerminalQueryResponse(raw);
  if (response) {
    return { type: "terminal-response", response, raw };
  }
  if (raw === ESC) {
    return { type: "key", key: { escape: true }, raw };
  }
  if (raw === `${CSI}200~` || raw === `${CSI}201~`) {
    return { type: "key", key: { paste: true }, raw };
  }
  if (raw.startsWith(`${CSI}200~`) && raw.endsWith(`${CSI}201~`)) {
    return {
      type: "paste",
      text: raw.slice(`${CSI}200~`.length, -`${CSI}201~`.length),
      key: { paste: true },
      raw
    };
  }
  if (raw === `${CSI}I`) {
    return { type: "terminal-focus", focused: true, raw };
  }
  if (raw === `${CSI}O`) {
    return { type: "terminal-focus", focused: false, raw };
  }
  const mouse = parseMouse(raw);
  if (mouse) {
    return { type: "mouse", mouse, raw };
  }
  const key = parseCsiKey(raw);
  if (key) {
    return { type: "key", key, raw };
  }
  if (raw.length === 2 && raw.startsWith(ESC)) {
    const input = raw.slice(1);
    return { type: "key", input, key: { alt: true }, raw };
  }
  return { type: "malformed", raw, reason: "unsupported escape sequence" };
}

function parseCsiKey(raw: string): TuiInputKey | undefined {
  const csi = parseCsiSequence(raw);
  if (!csi) {
    return undefined;
  }
  const modifiers = csiModifier(csi.params);
  switch (csi.final) {
    case "A":
      return { upArrow: true, ...modifiers };
    case "B":
      return { downArrow: true, ...modifiers };
    case "C":
      return { rightArrow: true, ...modifiers };
    case "D":
      return { leftArrow: true, ...modifiers };
    case "H":
      return { home: true, ...modifiers };
    case "F":
      return { end: true, ...modifiers };
    case "~":
      return numberedCsiKey(csi.params[0], modifiers);
    default:
      return undefined;
  }
}

function numberedCsiKey(value: string | undefined, modifiers: TuiInputKey): TuiInputKey | undefined {
  switch (value) {
    case "1":
    case "7":
      return { home: true, ...modifiers };
    case "3":
      return { delete: true, ...modifiers };
    case "4":
    case "8":
      return { end: true, ...modifiers };
    case "5":
      return { pageUp: true, ...modifiers };
    case "6":
      return { pageDown: true, ...modifiers };
    default:
      return undefined;
  }
}

function parseMouse(raw: string): TuiMouseInput | undefined {
  const match = /^\u001B\[<(\d+);(\d+);(\d+)([mM])$/u.exec(raw);
  if (!match) {
    return undefined;
  }
  const code = Number(match[1]);
  const x = Math.max(0, Number(match[2]) - 1);
  const y = Math.max(0, Number(match[3]) - 1);
  const button = mouseButton(code);
  return {
    x,
    y,
    button,
    action: match[4] === "m" ? "release" : code >= 32 && code < 64 ? "drag" : "press"
  };
}

function mouseButton(code: number): TuiMouseInput["button"] {
  const button = code & 0b11;
  if (code === 64) return "wheel-up";
  if (code === 65) return "wheel-down";
  if (button === 0) return "left";
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return "unknown";
}
