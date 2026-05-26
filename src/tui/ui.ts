import React from "react";
import { Box as RendererBox, type RendererBoxProps } from "./renderer/components/Box.js";
import { Text as RendererText, type RendererTextProps } from "./renderer/components/Text.js";
import { useRendererApp, type RendererAppContextValue } from "./renderer/hooks/use-app.js";
import { useRendererInput, type RendererInputHandler, type RendererInputOptions } from "./renderer/hooks/use-input.js";
import { useRendererStdout, type RendererStdout } from "./renderer/hooks/use-stdout.js";
import { terminalPatchToString } from "./renderer/output.js";
import { createTuiRoot } from "./renderer/root.js";
import { detectTuiTerminalCapabilities } from "./renderer/terminal-capabilities.js";

export type TuiRendererMode = "dom-renderer";
export type TuiRendererModeInput = TuiRendererMode | "legacy" | "auto";
export type BoxProps = RendererBoxProps & Record<string, unknown>;
export type TextProps = RendererTextProps & Record<string, unknown>;
export type UseInputOptions = RendererInputOptions;
export type UseInputHandler = RendererInputHandler;
export type TuiRenderOptions = {
  mode?: TuiRendererModeInput;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
  columns?: number;
  rows?: number;
  patchConsole?: boolean;
  [key: string]: unknown;
} | NodeJS.WriteStream;

export type TuiRenderInstance = {
  rerender(nextNode: React.ReactNode): void;
  unmount(): void;
  waitUntilExit(): Promise<void>;
};

export function resolveTuiRendererMode(input: string | undefined = process.env.SWARM_TUI_RENDERER): TuiRendererMode {
  void input;
  return "dom-renderer";
}

export function withTuiRendererMode<T>(mode: TuiRendererModeInput, run: () => T): T {
  void mode;
  return run();
}

export function Box(props: BoxProps): React.ReactElement {
  return React.createElement(RendererBox, props as RendererBoxProps);
}

export function Text(props: TextProps): React.ReactElement {
  return React.createElement(RendererText, props as RendererTextProps);
}

export function useInput(handler: UseInputHandler, options?: UseInputOptions): void {
  useRendererInput(handler, options);
}

export function useApp(): RendererAppContextValue {
  return useRendererApp();
}

export function useStdout(): RendererStdout {
  return useRendererStdout();
}

export function render(node: React.ReactNode, options?: TuiRenderOptions): TuiRenderInstance {
  const normalizedOptions = normalizeRenderOptions(options);
  const stdout = normalizedOptions.stdout ?? process.stdout;
  const stdin = normalizedOptions.stdin ?? (stdout === process.stdout && process.stdin.isTTY === true ? process.stdin : undefined);
  let exited = false;
  let root: ReturnType<typeof createTuiRoot>;

  function flush(): void {
    if (exited) {
      return;
    }
    const patch = root.getLastPatch();
    if (patch.length === 0) {
      return;
    }
    const output = terminalPatchToString(patch);
    if (typeof stdout.write === "function") {
      stdout.write(output);
    }
  }

  root = createTuiRoot({
    columns: normalizedOptions.columns ?? stdout.columns ?? 80,
    rows: normalizedOptions.rows ?? stdout.rows ?? 24,
    stdout,
    stderr: normalizedOptions.stderr,
    stdin,
    patchConsole: normalizedOptions.patchConsole,
    terminalCapabilities: detectTuiTerminalCapabilities(process.env, stdout),
    onFrame: flush
  });

  const rawInputCleanup = attachRawInput(stdin, root);
  const redrawCleanup = attachSafeRedrawHandlers(stdout, root);
  const cleanup = () => {
    if (exited) {
      return;
    }
    exited = true;
    redrawCleanup?.();
    rawInputCleanup?.();
  };
  void root.waitUntilExit().then(cleanup, cleanup);

  root.render(node);

  return {
    rerender(nextNode: React.ReactNode) {
      root.render(nextNode);
    },
    unmount() {
      cleanup();
      root.unmount();
    },
    waitUntilExit() {
      return root.waitUntilExit();
    }
  };
}

function normalizeRenderOptions(options: TuiRenderOptions | undefined): {
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
  columns?: number;
  rows?: number;
  patchConsole?: boolean;
} {
  if (!options) {
    return {};
  }
  if (typeof (options as NodeJS.WriteStream).write === "function") {
    return { stdout: options as NodeJS.WriteStream };
  }
  const record = options as {
    stdout?: NodeJS.WriteStream;
    stderr?: NodeJS.WriteStream;
    stdin?: NodeJS.ReadStream;
    columns?: number;
    rows?: number;
    patchConsole?: boolean;
  };
  return {
    stdout: record.stdout,
    stderr: record.stderr,
    stdin: record.stdin,
    columns: record.columns,
    rows: record.rows,
    patchConsole: record.patchConsole
  };
}

function attachSafeRedrawHandlers(
  stdout: NodeJS.WriteStream,
  root: ReturnType<typeof createTuiRoot>
): (() => void) | undefined {
  const cleanups: Array<() => void> = [];
  const redraw = () => {
    root.resize(stdout.columns, stdout.rows);
  };
  if (typeof stdout.on === "function") {
    stdout.on("resize", redraw);
    cleanups.push(() => stdout.off?.("resize", redraw));
  }
  const sigcont = () => {
    root.forceFullRedraw();
  };
  process.on("SIGCONT", sigcont);
  cleanups.push(() => process.off("SIGCONT", sigcont));
  return () => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  };
}

function attachRawInput(stdin: NodeJS.ReadStream | undefined, root: ReturnType<typeof createTuiRoot>): (() => void) | undefined {
  if (!stdin || typeof stdin.on !== "function") {
    return undefined;
  }
  const onData = (chunk: Buffer | string) => {
    root.dispatchRawInput(chunk);
  };
  stdin.on("data", onData);
  return () => {
    stdin.off?.("data", onData);
    root.flushRawInput();
  };
}
