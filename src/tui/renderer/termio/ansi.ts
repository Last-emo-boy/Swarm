export const ESC = "\u001B";
export const CSI = `${ESC}[`;
export const OSC = `${ESC}]`;
export const ST = `${ESC}\\`;
export const BEL = "\u0007";

export function isEscapeSequenceStart(value: string, index: number): boolean {
  return value[index] === ESC;
}

export function stripControlPrefix(value: string): string {
  return value.startsWith(ESC) ? value.slice(1) : value;
}

