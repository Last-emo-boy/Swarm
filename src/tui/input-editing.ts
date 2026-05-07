export type InputEditKey = {
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  meta?: boolean;
};

export type InputEditState = {
  value: string;
  cursor: number;
};

export type InputEditResult =
  | { handled: true; state: InputEditState }
  | { handled: false };

export type DecodedInput =
  | { kind: "text"; value: string }
  | { kind: "paste"; value: string }
  | { kind: "backspace" }
  | { kind: "delete" }
  | { kind: "return" }
  | { kind: "newline" }
  | { kind: "tab" }
  | { kind: "escape" }
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "left" }
  | { kind: "right" }
  | { kind: "home" }
  | { kind: "end" }
  | { kind: "ctrl-a" }
  | { kind: "ctrl-e" }
  | { kind: "ctrl-u" }
  | { kind: "ctrl-k" }
  | { kind: "ctrl-w" }
  | { kind: "ctrl-y" };

export type InputStreamDecodeResult = {
  decoded: DecodedInput[];
  pending: string;
};

export type InputKillResult = {
  state: InputEditState;
  killed: string;
};

const KNOWN_ESCAPE_SEQUENCES: Array<{ sequence: string; decoded: DecodedInput }> = [
  { sequence: "\x1b\r", decoded: { kind: "newline" } },
  { sequence: "\x1b\n", decoded: { kind: "newline" } },
  { sequence: "\x1b[3~", decoded: { kind: "delete" } },
  { sequence: "\x1b[3$", decoded: { kind: "delete" } },
  { sequence: "\x1b[3^", decoded: { kind: "delete" } },
  { sequence: "\x1b[A", decoded: { kind: "up" } },
  { sequence: "\x1bOA", decoded: { kind: "up" } },
  { sequence: "\x1b[B", decoded: { kind: "down" } },
  { sequence: "\x1bOB", decoded: { kind: "down" } },
  { sequence: "\x1b[D", decoded: { kind: "left" } },
  { sequence: "\x1bOD", decoded: { kind: "left" } },
  { sequence: "\x1b[C", decoded: { kind: "right" } },
  { sequence: "\x1bOC", decoded: { kind: "right" } },
  { sequence: "\x1b[H", decoded: { kind: "home" } },
  { sequence: "\x1bOH", decoded: { kind: "home" } },
  { sequence: "\x1b[1~", decoded: { kind: "home" } },
  { sequence: "\x1b[7~", decoded: { kind: "home" } },
  { sequence: "\x1b[F", decoded: { kind: "end" } },
  { sequence: "\x1bOF", decoded: { kind: "end" } },
  { sequence: "\x1b[4~", decoded: { kind: "end" } },
  { sequence: "\x1b[8~", decoded: { kind: "end" } }
];

export function editInput(
  value: string,
  cursor: number,
  character: string | undefined,
  key: InputEditKey
): InputEditResult {
  const safeCursor = Math.max(0, Math.min(value.length, cursor));
  if (isBackspaceInput(character, key)) {
    if (safeCursor <= 0) {
      return { handled: true, state: { value, cursor: safeCursor } };
    }
    const next = value.slice(0, safeCursor - 1) + value.slice(safeCursor);
    return { handled: true, state: { value: next, cursor: safeCursor - 1 } };
  }

  if (isDeleteInput(character, key)) {
    if (safeCursor >= value.length) {
      return { handled: true, state: { value, cursor: safeCursor } };
    }
    const next = value.slice(0, safeCursor) + value.slice(safeCursor + 1);
    return { handled: true, state: { value: next, cursor: safeCursor } };
  }

  if (isPrintableInput(character, key)) {
    const next = value.slice(0, safeCursor) + character + value.slice(safeCursor);
    return { handled: true, state: { value: next, cursor: safeCursor + character.length } };
  }

  return { handled: false };
}

export function decodeInputStream(pending: string, chunk: string): InputStreamDecodeResult {
  return decodeInputStreamInternal(`${pending}${chunk}`, false);
}

export function flushInputStream(pending: string): InputStreamDecodeResult {
  return decodeInputStreamInternal(pending, true);
}

export function insertInputText(value: string, cursor: number, text: string): InputEditState {
  const safeCursor = Math.max(0, Math.min(value.length, cursor));
  const normalized = normalizeInputText(text);
  const next = value.slice(0, safeCursor) + normalized + value.slice(safeCursor);
  return { value: next, cursor: safeCursor + normalized.length };
}

export function killInputBackward(value: string, cursor: number): InputKillResult {
  const safeCursor = Math.max(0, Math.min(value.length, cursor));
  if (safeCursor <= 0) {
    return { state: { value, cursor: safeCursor }, killed: "" };
  }
  return {
    state: { value: value.slice(safeCursor), cursor: 0 },
    killed: value.slice(0, safeCursor)
  };
}

export function killInputToLineEnd(value: string, cursor: number): InputKillResult {
  const safeCursor = Math.max(0, Math.min(value.length, cursor));
  if (safeCursor >= value.length) {
    return { state: { value, cursor: safeCursor }, killed: "" };
  }
  const newlineIndex = value.indexOf("\n", safeCursor);
  const killEnd = newlineIndex === -1
    ? value.length
    : newlineIndex === safeCursor
      ? newlineIndex + 1
      : newlineIndex;
  return {
    state: { value: value.slice(0, safeCursor) + value.slice(killEnd), cursor: safeCursor },
    killed: value.slice(safeCursor, killEnd)
  };
}

export function killInputWordBackward(value: string, cursor: number): InputKillResult {
  const safeCursor = Math.max(0, Math.min(value.length, cursor));
  if (safeCursor <= 0) {
    return { state: { value, cursor: safeCursor }, killed: "" };
  }
  let start = safeCursor;
  while (start > 0 && /\s/.test(value[start - 1] ?? "")) {
    start -= 1;
  }
  while (start > 0 && !/\s/.test(value[start - 1] ?? "")) {
    start -= 1;
  }
  return {
    state: { value: value.slice(0, start) + value.slice(safeCursor), cursor: start },
    killed: value.slice(start, safeCursor)
  };
}

export function isBackspaceInput(character: string | undefined, key: InputEditKey): boolean {
  return Boolean(
    key.backspace
      || character === "\b"
      || character === "\x7f"
      || isTerminalDelAsDelete(character, key)
  );
}

export function isDeleteInput(character: string | undefined, key: InputEditKey): boolean {
  return Boolean(
    character === "\x1b[3~"
      || character === "[3~"
      || character === "\x1b[3$"
      || character === "[3$"
      || character === "\x1b[3^"
      || character === "[3^"
      || (key.delete && Boolean(character))
  );
}

function isTerminalDelAsDelete(character: string | undefined, key: InputEditKey): boolean {
  return Boolean(key.delete && !character);
}

export function decodeInputChunk(chunk: string): DecodedInput | undefined {
  const pasted = bracketedPasteContent(chunk);
  if (pasted !== undefined) {
    return { kind: "paste", value: normalizeInputText(pasted) };
  }

  switch (chunk) {
    case "\r":
      return { kind: "return" };
    case "\n":
    case "\x1b\r":
    case "\x1b\n":
      return { kind: "newline" };
    case "\t":
      return { kind: "tab" };
    case "\x1b":
      return { kind: "escape" };
    case "\x7f":
    case "\b":
      return { kind: "backspace" };
    case "\x1b[3~":
    case "\x1b[3$":
    case "\x1b[3^":
      return { kind: "delete" };
    case "\x1b[A":
    case "\x1bOA":
      return { kind: "up" };
    case "\x1b[B":
    case "\x1bOB":
      return { kind: "down" };
    case "\x1b[D":
    case "\x1bOD":
      return { kind: "left" };
    case "\x1b[C":
    case "\x1bOC":
      return { kind: "right" };
    case "\x1b[H":
    case "\x1bOH":
    case "\x1b[1~":
    case "\x1b[7~":
      return { kind: "home" };
    case "\x1b[F":
    case "\x1bOF":
    case "\x1b[4~":
    case "\x1b[8~":
      return { kind: "end" };
    case "\x01":
      return { kind: "ctrl-a" };
    case "\x05":
      return { kind: "ctrl-e" };
    case "\x15":
      return { kind: "ctrl-u" };
    case "\x0b":
      return { kind: "ctrl-k" };
    case "\x17":
      return { kind: "ctrl-w" };
    case "\x19":
      return { kind: "ctrl-y" };
    default:
      if (chunk.startsWith("\x1b")) {
        return undefined;
      }
      if (isPastedTextChunk(chunk)) {
        return { kind: "paste", value: normalizeInputText(chunk) };
      }
      return isPrintableChunk(chunk) ? { kind: "text", value: chunk } : undefined;
  }
}

function decodeInputStreamInternal(input: string, flush: boolean): InputStreamDecodeResult {
  const decoded: DecodedInput[] = [];
  let index = 0;

  while (index < input.length) {
    const rest = input.slice(index);
    const pasted = bracketedPasteContent(rest);
    if (pasted !== undefined) {
      const end = rest.lastIndexOf("\x1b[201~") + "\x1b[201~".length;
      decoded.push({ kind: "paste", value: normalizeInputText(pasted) });
      index += end;
      continue;
    }

    if (isIncompleteBracketedPaste(rest)) {
      if (rest.startsWith("\x1b[200~") || !flush) {
        return { decoded, pending: rest };
      }
    }

    const escapeSequence = KNOWN_ESCAPE_SEQUENCES.find((candidate) => rest.startsWith(candidate.sequence));
    if (escapeSequence) {
      decoded.push(escapeSequence.decoded);
      index += escapeSequence.sequence.length;
      continue;
    }

    if (isIncompleteEscapeSequence(rest)) {
      if (!flush) {
        return { decoded, pending: rest };
      }
      if (rest !== "\x1b") {
        return { decoded, pending: rest };
      }
      decoded.push({ kind: "escape" });
      index += 1;
      continue;
    }

    if (rest[0] === "\x1b") {
      const single = decodeInputChunk(rest[0]);
      if (single) {
        decoded.push(single);
      }
      index += 1;
      continue;
    }

    const pastedPlainText = plainMultilinePastePrefix(rest);
    if (pastedPlainText) {
      decoded.push({ kind: "paste", value: normalizeInputText(pastedPlainText) });
      index += pastedPlainText.length;
      continue;
    }

    const single = decodeInputChunk(rest[0]);
    if (single && single.kind !== "text") {
      decoded.push(single);
      index += 1;
      continue;
    }

    const text = printableTextPrefix(rest);
    if (text) {
      decoded.push({ kind: "text", value: text });
      index += text.length;
      continue;
    }

    index += 1;
  }

  return { decoded, pending: "" };
}

export function normalizeInputText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function isPrintableInput(character: string | undefined, key: InputEditKey): character is string {
  if (!character || key.ctrl || key.meta) {
    return false;
  }
  return !isBackspaceInput(character, key) && !isDeleteInput(character, key) && !isControlSequence(character);
}

function isControlSequence(value: string): boolean {
  return value.length === 1 && value.charCodeAt(0) < 32;
}

function isPrintableChunk(value: string): boolean {
  return [...value].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 32 && code !== 127;
  });
}

function bracketedPasteContent(value: string): string | undefined {
  const start = "\x1b[200~";
  const end = "\x1b[201~";
  if (!value.startsWith(start)) {
    return undefined;
  }
  const endIndex = value.lastIndexOf(end);
  if (endIndex < start.length) {
    return undefined;
  }
  return value.slice(start.length, endIndex);
}

function isIncompleteBracketedPaste(value: string): boolean {
  const start = "\x1b[200~";
  const end = "\x1b[201~";
  return start.startsWith(value) || (value.startsWith(start) && !value.includes(end));
}

function isIncompleteEscapeSequence(value: string): boolean {
  return KNOWN_ESCAPE_SEQUENCES.some((candidate) => candidate.sequence.startsWith(value));
}

function plainMultilinePastePrefix(value: string): string | undefined {
  let index = 0;
  let sawNewline = false;
  while (index < value.length) {
    const character = value[index];
    if (character === "\x1b" || character === "\x7f" || character === "\b" || character === "\t") {
      break;
    }
    if (character === "\r" || character === "\n") {
      sawNewline = true;
      index += 1;
      continue;
    }
    const code = character.codePointAt(0) ?? 0;
    if (code < 32) {
      break;
    }
    index += character.length;
  }
  const prefix = value.slice(0, index);
  return sawNewline && isPastedTextChunk(prefix) ? prefix : undefined;
}

function printableTextPrefix(value: string): string | undefined {
  let index = 0;
  while (index < value.length) {
    const character = value[index];
    const code = character.codePointAt(0) ?? 0;
    if (character === "\x1b" || code < 32 || code === 127) {
      break;
    }
    index += character.length;
  }
  return index > 0 ? value.slice(0, index) : undefined;
}

function isPastedTextChunk(value: string): boolean {
  if (!/[\r\n]/.test(value) || value === "\r" || value === "\n") {
    return false;
  }
  return [...normalizeInputText(value)].every((character) => {
    if (character === "\n") {
      return true;
    }
    const code = character.codePointAt(0) ?? 0;
    return code >= 32 && code !== 127;
  });
}
