import { formatWithOptions, inspect, type InspectOptions } from "node:util";
import {
  buildHeadlessStreamRecord,
  headlessStreamJson
} from "./headless-artifacts.js";

export type HeadlessStreamRecordInput = Parameters<typeof buildHeadlessStreamRecord>[0];

export type HeadlessStdoutGuard = {
  enabled: boolean;
  brokenPipe(): boolean;
  restore(): void;
  writeLine(line: string): boolean;
  writeRecord(record: HeadlessStreamRecordInput): boolean;
};

export function installHeadlessStdoutGuard(input: {
  enabled: boolean;
  onBrokenPipe?: () => void;
}): HeadlessStdoutGuard {
  if (!input.enabled) {
    return {
      enabled: false,
      brokenPipe: () => false,
      restore: () => undefined,
      writeLine: (line) => {
        console.log(line);
        return true;
      },
      writeRecord: (record) => {
        console.log(headlessStreamJson(buildHeadlessStreamRecord(record)));
        return true;
      }
    };
  }

  let restored = false;
  let brokenPipe = false;
  const originalConsole = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    dir: console.dir
  };

  const markBrokenPipe = () => {
    if (brokenPipe) {
      return;
    }
    brokenPipe = true;
    process.exitCode ??= 0;
    input.onBrokenPipe?.();
  };

  const handleStdoutError = (error: Error & { code?: string }) => {
    if (isBrokenPipeError(error)) {
      markBrokenPipe();
      return;
    }
    throw error;
  };

  process.stdout.on("error", handleStdoutError);

  console.log = (...values: unknown[]) => {
    writeStderr(`${formatWithOptions({ colors: false }, ...values)}\n`);
  };
  console.info = console.log;
  console.debug = console.log;
  console.dir = (object?: unknown, options?: InspectOptions) => {
    writeStderr(`${inspect(object, { colors: false, ...options })}\n`);
  };

  const restore = () => {
    if (restored) {
      return;
    }
    restored = true;
    process.stdout.off("error", handleStdoutError);
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.debug = originalConsole.debug;
    console.dir = originalConsole.dir;
  };

  const writeLine = (line: string) => {
    if (brokenPipe) {
      return false;
    }
    try {
      process.stdout.write(`${line}\n`);
      return true;
    } catch (error) {
      if (isBrokenPipeError(error)) {
        markBrokenPipe();
        return false;
      }
      throw error;
    }
  };

  return {
    enabled: true,
    brokenPipe: () => brokenPipe,
    restore,
    writeLine,
    writeRecord: (record) => writeLine(headlessStreamJson(buildHeadlessStreamRecord(record)))
  };
}

function writeStderr(text: string): void {
  try {
    process.stderr.write(text);
  } catch {
    // There is nowhere useful to report stderr failures while guarding stdout.
  }
}

function isBrokenPipeError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "EPIPE"
  );
}
