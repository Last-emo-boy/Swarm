import { CSI } from "./ansi.js";

export type CsiSequence = {
  raw: string;
  prefix: string;
  params: readonly string[];
  final: string;
};

export function parseCsiSequence(raw: string): CsiSequence | undefined {
  if (!raw.startsWith(CSI) || raw.length < 3) {
    return undefined;
  }
  const final = raw.at(-1) ?? "";
  if (!/[@-~]/u.test(final)) {
    return undefined;
  }
  const body = raw.slice(CSI.length, -1);
  const prefixMatch = /^[?<=>!]*/u.exec(body);
  const prefix = prefixMatch?.[0] ?? "";
  const params = body.slice(prefix.length).split(";").filter((part) => part.length > 0);
  return { raw, prefix, params, final };
}

export function csiModifier(params: readonly string[]): { shift?: boolean; alt?: boolean; ctrl?: boolean } {
  if (params.length < 2) {
    return {};
  }
  const modifier = Number(params[1]);
  if (!Number.isFinite(modifier) || modifier <= 1) {
    return {};
  }
  const value = modifier - 1;
  return {
    ...(value & 1 ? { shift: true } : {}),
    ...(value & 2 ? { alt: true } : {}),
    ...(value & 4 ? { ctrl: true } : {})
  };
}
