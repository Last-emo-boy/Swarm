export type ConsolePatchBuffer = {
  lines: string[];
  restore: () => void;
};

export type StderrPatchBuffer = {
  lines: string[];
  restore: () => void;
};

export type StderrLike = {
  write: unknown;
};

export function patchConsoleForTui(consoleLike: Pick<Console, "log" | "error" | "warn"> = console): ConsolePatchBuffer {
  const lines: string[] = [];
  const original = {
    log: consoleLike.log,
    error: consoleLike.error,
    warn: consoleLike.warn
  };
  consoleLike.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  consoleLike.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  consoleLike.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return {
    lines,
    restore() {
      consoleLike.log = original.log;
      consoleLike.error = original.error;
      consoleLike.warn = original.warn;
    }
  };
}

export function patchStderrForTui(stderrLike: StderrLike = process.stderr): StderrPatchBuffer {
  const lines: string[] = [];
  const originalWrite = stderrLike.write;
  stderrLike.write = (chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
    const cb = typeof encodingOrCallback === "function"
      ? encodingOrCallback as (error?: Error | null) => void
      : typeof callback === "function"
        ? callback as (error?: Error | null) => void
        : undefined;
    lines.push(stderrChunkToString(chunk).trimEnd());
    cb?.();
    return true;
  };
  return {
    lines,
    restore() {
      stderrLike.write = originalWrite;
    }
  };
}

function stderrChunkToString(chunk: unknown): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString("utf8");
  }
  return String(chunk);
}
