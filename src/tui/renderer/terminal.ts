import {
  patchConsoleForTui,
  patchStderrForTui,
  type ConsolePatchBuffer,
  type StderrLike,
  type StderrPatchBuffer
} from "./console-patch.js";
import { terminalModeSequences } from "./terminal-capabilities.js";
import { CSI } from "./termio/ansi.js";

export type TerminalLifecycleState = {
  rawMode: boolean;
  cursorHidden: boolean;
  altScreen: boolean;
  consolePatched: boolean;
  bracketedPaste: boolean;
  focusReporting: boolean;
  extendedKeyboard: boolean;
  mouseTracking: boolean;
  owners: string[];
};

export type TerminalLifecycleSnapshot = Omit<Readonly<TerminalLifecycleState>, "owners"> & {
  readonly owners: readonly string[];
};

export type TerminalLifecycleAcquireOptions = {
  rawMode?: boolean;
  hideCursor?: boolean;
  altScreen?: boolean;
  patchConsole?: boolean;
  bracketedPaste?: boolean;
  focusReporting?: boolean;
  extendedKeyboard?: boolean;
  mouseTracking?: boolean;
};

export type TerminalLifecycleWriteStream = {
  isTTY?: boolean;
  write?: (chunk: string) => unknown;
};

export type TerminalLifecycleInputStream = {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => void;
  ref?: () => unknown;
  unref?: () => unknown;
};

export type TerminalLifecycleControllerOptions = {
  stdout?: TerminalLifecycleWriteStream;
  stdin?: TerminalLifecycleInputStream;
  stderr?: StderrLike;
  consoleLike?: Pick<Console, "log" | "error" | "warn">;
};

export type TerminalLifecycleLease = {
  owner: string;
  snapshot: () => TerminalLifecycleSnapshot;
  release: () => TerminalLifecycleSnapshot;
};

const lifecycleByStream = new WeakMap<object, TerminalLifecycleController>();
const activeRootOwnerByStream = new WeakMap<object, string>();
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;
const ENTER_ALT_SCREEN = `${CSI}?1049h`;
const EXIT_ALT_SCREEN = `${CSI}?1049l`;
const ENABLE_KITTY_KEYBOARD = `${CSI}>1u`;
const DISABLE_KITTY_KEYBOARD = `${CSI}<u`;
const ENABLE_MODIFY_OTHER_KEYS = `${CSI}>4;2m`;
const DISABLE_MODIFY_OTHER_KEYS = `${CSI}>4m`;

export function acquireTerminalLifecycleForStream(
  stream: object,
  owner: string,
  options: TerminalLifecycleAcquireOptions = {},
  controllerOptions: TerminalLifecycleControllerOptions = {}
): TerminalLifecycleLease {
  const activeOwner = activeRootOwnerByStream.get(stream);
  if (activeOwner && activeOwner !== owner) {
    throw new Error(`TUI terminal lifecycle for this stdout is already owned by ${activeOwner}.`);
  }
  let controller = lifecycleByStream.get(stream);
  if (!controller) {
    controller = new TerminalLifecycleController({
      stdout: controllerOptions.stdout ?? stream as TerminalLifecycleWriteStream,
      stdin: controllerOptions.stdin ?? process.stdin as TerminalLifecycleInputStream,
      stderr: controllerOptions.stderr,
      consoleLike: controllerOptions.consoleLike
    });
    lifecycleByStream.set(stream, controller);
  }
  activeRootOwnerByStream.set(stream, owner);
  controller.acquire(owner, options);
  let released = false;
  return {
    owner,
    snapshot: () => controller.snapshot(),
    release: () => {
      if (released) {
        return controller.snapshot();
      }
      released = true;
      activeRootOwnerByStream.delete(stream);
      return controller.release(owner);
    }
  };
}

export class TerminalLifecycleController {
  private readonly requests = new Map<string, TerminalLifecycleAcquireOptions>();
  private readonly stdout?: TerminalLifecycleWriteStream;
  private readonly stdin?: TerminalLifecycleInputStream;
  private readonly stderr?: StderrLike;
  private readonly consoleLike?: Pick<Console, "log" | "error" | "warn">;
  private consolePatch: ConsolePatchBuffer | undefined;
  private stderrPatch: StderrPatchBuffer | undefined;
  private state: TerminalLifecycleState = {
    rawMode: false,
    cursorHidden: false,
    altScreen: false,
    consolePatched: false,
    bracketedPaste: false,
    focusReporting: false,
    extendedKeyboard: false,
    mouseTracking: false,
    owners: []
  };

  constructor(options: TerminalLifecycleControllerOptions = {}) {
    this.stdout = options.stdout;
    this.stdin = options.stdin ?? process.stdin as TerminalLifecycleInputStream;
    this.stderr = options.stderr ?? process.stderr;
    this.consoleLike = options.consoleLike;
  }

  acquire(owner: string, options: TerminalLifecycleAcquireOptions = {}): TerminalLifecycleSnapshot {
    const previous = this.state;
    this.requests.set(owner, options);
    this.state = this.computeState();
    this.applyTransitions(previous, this.state);
    return this.snapshot();
  }

  release(owner: string): TerminalLifecycleSnapshot {
    const previous = this.state;
    this.requests.delete(owner);
    this.state = this.computeState();
    this.applyTransitions(previous, this.state);
    return this.snapshot();
  }

  restore(): TerminalLifecycleSnapshot {
    const previous = this.state;
    this.requests.clear();
    this.state = emptyLifecycleState();
    this.applyTransitions(previous, this.state);
    return this.snapshot();
  }

  snapshot(): TerminalLifecycleSnapshot {
    return Object.freeze({
      rawMode: this.state.rawMode,
      cursorHidden: this.state.cursorHidden,
      altScreen: this.state.altScreen,
      consolePatched: this.state.consolePatched,
      bracketedPaste: this.state.bracketedPaste,
      focusReporting: this.state.focusReporting,
      extendedKeyboard: this.state.extendedKeyboard,
      mouseTracking: this.state.mouseTracking,
      owners: Object.freeze([...this.state.owners])
    });
  }

  private computeState(): TerminalLifecycleState {
    const requests = [...this.requests.values()];
    return {
      rawMode: requests.some((options) => options.rawMode),
      cursorHidden: requests.some((options) => options.hideCursor),
      altScreen: requests.some((options) => options.altScreen),
      consolePatched: requests.some((options) => options.patchConsole),
      bracketedPaste: requests.some((options) => options.bracketedPaste),
      focusReporting: requests.some((options) => options.focusReporting),
      extendedKeyboard: requests.some((options) => options.extendedKeyboard),
      mouseTracking: requests.some((options) => options.mouseTracking),
      owners: [...this.requests.keys()]
    };
  }

  private applyTransitions(previous: TerminalLifecycleState, next: TerminalLifecycleState): void {
    if (!previous.consolePatched && next.consolePatched) {
      this.consolePatch = patchConsoleForTui(this.consoleLike);
      if (this.stderr && this.stderr !== this.stdout) {
        this.stderrPatch = patchStderrForTui(this.stderr);
      }
    }
    if (!previous.rawMode && next.rawMode) {
      this.setRawMode(true);
    }
    if (!previous.altScreen && next.altScreen) {
      this.write(`${ENTER_ALT_SCREEN}${CSI}2J${CSI}H`);
    }
    if (!previous.cursorHidden && next.cursorHidden) {
      this.write(HIDE_CURSOR);
    }
    if (!previous.bracketedPaste && next.bracketedPaste) {
      this.writeTerminalMode("bracketedPaste", true);
    }
    if (!previous.focusReporting && next.focusReporting) {
      this.writeTerminalMode("focusReporting", true);
    }
    if (!previous.mouseTracking && next.mouseTracking) {
      this.writeTerminalMode("mouseTracking", true);
    }
    if (!previous.extendedKeyboard && next.extendedKeyboard) {
      this.write(`${ENABLE_KITTY_KEYBOARD}${ENABLE_MODIFY_OTHER_KEYS}`);
    }

    if (previous.extendedKeyboard && !next.extendedKeyboard) {
      this.write(`${DISABLE_MODIFY_OTHER_KEYS}${DISABLE_KITTY_KEYBOARD}`);
    }
    if (previous.mouseTracking && !next.mouseTracking) {
      this.writeTerminalMode("mouseTracking", false);
    }
    if (previous.focusReporting && !next.focusReporting) {
      this.writeTerminalMode("focusReporting", false);
    }
    if (previous.bracketedPaste && !next.bracketedPaste) {
      this.writeTerminalMode("bracketedPaste", false);
    }
    if (previous.cursorHidden && !next.cursorHidden) {
      this.write(SHOW_CURSOR);
    }
    if (previous.altScreen && !next.altScreen) {
      this.write(EXIT_ALT_SCREEN);
    }
    if (previous.rawMode && !next.rawMode) {
      this.setRawMode(false);
    }
    if (previous.consolePatched && !next.consolePatched) {
      this.stderrPatch?.restore();
      this.consolePatch?.restore();
      this.stderrPatch = undefined;
      this.consolePatch = undefined;
    }
  }

  private writeTerminalMode(
    key: "bracketedPaste" | "focusReporting" | "mouseTracking",
    enabled: boolean
  ): void {
    const capabilities = key === "mouseTracking"
      ? { mouse: true }
      : key === "focusReporting"
        ? { focusReporting: true }
        : { bracketedPaste: true };
    this.write(terminalModeSequences(capabilities, enabled));
  }

  private setRawMode(enabled: boolean): void {
    if (!this.stdin?.isTTY || typeof this.stdin.setRawMode !== "function") {
      return;
    }
    try {
      this.stdin.setRawMode(enabled);
      if (enabled) {
        this.stdin.ref?.();
      } else {
        this.stdin.unref?.();
      }
    } catch {
      // Terminal ownership should degrade cleanly on revoked or unsupported TTYs.
    }
  }

  private write(sequence: string): void {
    if (!sequence || this.stdout?.isTTY !== true || typeof this.stdout.write !== "function") {
      return;
    }
    try {
      this.stdout.write(sequence);
    } catch {
      // Best-effort terminal mode writes; state cleanup still proceeds.
    }
  }
}

function emptyLifecycleState(): TerminalLifecycleState {
  return {
    rawMode: false,
    cursorHidden: false,
    altScreen: false,
    consolePatched: false,
    bracketedPaste: false,
    focusReporting: false,
    extendedKeyboard: false,
    mouseTracking: false,
    owners: []
  };
}
