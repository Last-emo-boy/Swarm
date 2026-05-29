export function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    if (isCombiningMark(char)) {
      continue;
    }
    width += isWideCharacter(char) ? 2 : 1;
  }
  return width;
}

export function sliceByDisplayWidth(value: string, maxWidth: number): { head: string; tail: string } {
  const limit = Math.max(0, Math.floor(maxWidth));
  if (limit === 0) {
    return { head: "", tail: value };
  }

  let width = 0;
  let index = 0;
  for (const char of value) {
    const charWidth = isCombiningMark(char) ? 0 : isWideCharacter(char) ? 2 : 1;
    if (width + charWidth > limit) {
      break;
    }
    width += charWidth;
    index += char.length;
  }
  return {
    head: value.slice(0, index),
    tail: value.slice(index)
  };
}

export function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
}

export function ansiDisplayWidth(value: string): number {
  return displayWidth(stripAnsi(value));
}

export function fitToDisplayWidth(value: string, maxWidth: number, ellipsis = "..."): string {
  const limit = Math.max(0, Math.floor(maxWidth));
  if (limit === 0) {
    return "";
  }
  if (ansiDisplayWidth(value) <= limit) {
    return value;
  }
  const suffix = fitSuffix(ellipsis, limit);
  const headWidth = Math.max(0, limit - displayWidth(suffix));
  return `${sliceByDisplayWidth(stripAnsi(value), headWidth).head}${suffix}`;
}

export function padToDisplayWidth(value: string, width: number): string {
  const target = Math.max(0, Math.floor(width));
  const visibleWidth = ansiDisplayWidth(value);
  if (visibleWidth >= target) {
    return fitToDisplayWidth(value, target, "");
  }
  return `${value}${" ".repeat(target - visibleWidth)}`;
}

function fitSuffix(value: string, maxWidth: number): string {
  if (displayWidth(value) <= maxWidth) {
    return value;
  }
  return sliceByDisplayWidth(value, maxWidth).head;
}

function isCombiningMark(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe20 && code <= 0xfe2f);
}

function isWideCharacter(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code >= 0x1100 && (
    code <= 0x115f ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}
