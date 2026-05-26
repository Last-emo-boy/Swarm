import { BEL, OSC, ST } from "./ansi.js";

export type OscSequence = {
  raw: string;
  command: string;
  payload: string;
};

export function parseOscSequence(raw: string): OscSequence | undefined {
  if (!raw.startsWith(OSC)) {
    return undefined;
  }
  const terminatorLength = raw.endsWith(ST) ? ST.length : raw.endsWith(BEL) ? BEL.length : 0;
  if (!terminatorLength) {
    return undefined;
  }
  const body = raw.slice(OSC.length, raw.length - terminatorLength);
  const separator = body.indexOf(";");
  if (separator < 0) {
    return { raw, command: body, payload: "" };
  }
  return {
    raw,
    command: body.slice(0, separator),
    payload: body.slice(separator + 1)
  };
}

export function sanitizeOscPayload(value: string): string {
  return value.replace(/[\u0007\u001B]/gu, "");
}

