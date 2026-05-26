import { strict as assert } from "node:assert";
import { PassThrough } from "node:stream";
import test from "node:test";
import { patchConsoleForTui } from "./console-patch.js";
import { acquireTerminalLifecycleForStream, TerminalLifecycleController } from "./terminal.js";

test("terminal lifecycle restores raw cursor alt-screen and console ownership on final release", () => {
  const controller = new TerminalLifecycleController();
  controller.acquire("root", { rawMode: true, hideCursor: true, altScreen: true, patchConsole: true });
  controller.acquire("modal", { rawMode: true });
  assert.deepEqual(controller.snapshot().owners, ["root", "modal"]);
  assert.equal(controller.snapshot().rawMode, true);
  controller.release("modal");
  assert.equal(controller.snapshot().rawMode, true);
  controller.release("root");
  assert.deepEqual(controller.snapshot(), {
    rawMode: false,
    cursorHidden: false,
    altScreen: false,
    consolePatched: false,
    bracketedPaste: false,
    focusReporting: false,
    extendedKeyboard: false,
    mouseTracking: false,
    owners: []
  });
});

test("console patch buffers log output until restored", () => {
  const fakeConsole = {
    log: (..._args: unknown[]) => undefined,
    error: (..._args: unknown[]) => undefined,
    warn: (..._args: unknown[]) => undefined
  };
  const patch = patchConsoleForTui(fakeConsole as Pick<Console, "log" | "error" | "warn">);
  fakeConsole.log("hello", "world");
  fakeConsole.warn("careful");
  assert.deepEqual(patch.lines, ["hello world", "careful"]);
  patch.restore();
  fakeConsole.log("after");
  assert.deepEqual(patch.lines, ["hello world", "careful"]);
});

test("terminal lifecycle enforces one root owner per stdout stream", () => {
  const stream = new PassThrough();
  const first = acquireTerminalLifecycleForStream(stream, "root-a", { rawMode: true, altScreen: true });
  assert.equal(first.snapshot().rawMode, true);
  assert.equal(first.snapshot().altScreen, true);
  assert.throws(
    () => acquireTerminalLifecycleForStream(stream, "root-b", { rawMode: true }),
    /already owned by root-a/
  );
  assert.deepEqual(first.release(), {
    rawMode: false,
    cursorHidden: false,
    altScreen: false,
    consolePatched: false,
    bracketedPaste: false,
    focusReporting: false,
    extendedKeyboard: false,
    mouseTracking: false,
    owners: []
  });
  const second = acquireTerminalLifecycleForStream(stream, "root-b", { focusReporting: true });
  assert.equal(second.snapshot().focusReporting, true);
  second.release();
});

test("terminal lifecycle applies and restores terminal side effects on a TTY stream", () => {
  const writes: string[] = [];
  const stderrWrites: string[] = [];
  const rawModes: boolean[] = [];
  const refs: string[] = [];
  const fakeStdout = {
    isTTY: true,
    write(chunk: string) {
      writes.push(chunk);
      return true;
    }
  };
  const fakeStdin = {
    isTTY: true,
    setRawMode(mode: boolean) {
      rawModes.push(mode);
    },
    ref() {
      refs.push("ref");
    },
    unref() {
      refs.push("unref");
    }
  };
  const fakeConsole = {
    log: (..._args: unknown[]) => undefined,
    error: (..._args: unknown[]) => undefined,
    warn: (..._args: unknown[]) => undefined
  };
  const fakeStderr = {
    write(chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) {
      stderrWrites.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      cb?.();
      return true;
    }
  };
  const originalLog = fakeConsole.log;
  const originalStderrWrite = fakeStderr.write;

  const controller = new TerminalLifecycleController({
    stdout: fakeStdout,
    stdin: fakeStdin,
    stderr: fakeStderr,
    consoleLike: fakeConsole as Pick<Console, "log" | "error" | "warn">
  });

  controller.acquire("root", {
    rawMode: true,
    hideCursor: true,
    altScreen: true,
    patchConsole: true,
    bracketedPaste: true,
    focusReporting: true,
    extendedKeyboard: true,
    mouseTracking: true
  });
  controller.acquire("modal", { rawMode: true });

  assert.notEqual(fakeConsole.log, originalLog);
  assert.notEqual(fakeStderr.write, originalStderrWrite);
  let stderrCallbackCalled = false;
  fakeStderr.write("hidden runtime log\n", () => {
    stderrCallbackCalled = true;
  });
  assert.equal(stderrCallbackCalled, true);
  assert.deepEqual(stderrWrites, []);
  assert.deepEqual(rawModes, [true]);
  assert.deepEqual(refs, ["ref"]);
  const enableOutput = writes.join("");
  assert.match(enableOutput, /\u001B\[\?1049h\u001B\[2J\u001B\[H/);
  assert.match(enableOutput, /\u001B\[\?25l/);
  assert.match(enableOutput, /\u001B\[\?2004h/);
  assert.match(enableOutput, /\u001B\[\?1004h/);
  assert.match(enableOutput, /\u001B\[\?1000h\u001B\[\?1006h/);
  assert.match(enableOutput, /\u001B\[>1u\u001B\[>4;2m/);

  writes.length = 0;
  controller.release("modal");
  assert.deepEqual(rawModes, [true]);
  assert.deepEqual(writes, []);

  controller.release("root");

  assert.equal(fakeConsole.log, originalLog);
  assert.equal(fakeStderr.write, originalStderrWrite);
  fakeStderr.write("visible after restore");
  assert.deepEqual(stderrWrites, ["visible after restore"]);
  assert.deepEqual(rawModes, [true, false]);
  assert.deepEqual(refs, ["ref", "unref"]);
  const disableOutput = writes.join("");
  assert.match(disableOutput, /\u001B\[>4m\u001B\[<u/);
  assert.match(disableOutput, /\u001B\[\?1006l\u001B\[\?1000l/);
  assert.match(disableOutput, /\u001B\[\?1004l/);
  assert.match(disableOutput, /\u001B\[\?2004l/);
  assert.match(disableOutput, /\u001B\[\?25h/);
  assert.match(disableOutput, /\u001B\[\?1049l/);
});

test("terminal lifecycle does not write terminal mode sequences for non-TTY streams", () => {
  const writes: string[] = [];
  const controller = new TerminalLifecycleController({
    stdout: {
      isTTY: false,
      write(chunk: string) {
        writes.push(chunk);
        return true;
      }
    },
    stdin: {
      isTTY: false,
      setRawMode() {
        throw new Error("raw mode should not be touched for non-TTY stdin");
      }
    }
  });

  controller.acquire("root", {
    rawMode: true,
    hideCursor: true,
    altScreen: true,
    bracketedPaste: true,
    focusReporting: true,
    extendedKeyboard: true,
    mouseTracking: true
  });
  controller.release("root");

  assert.deepEqual(writes, []);
});
