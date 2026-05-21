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
