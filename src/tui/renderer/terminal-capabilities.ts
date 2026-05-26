import {
  DISABLE_BRACKETED_PASTE,
  DISABLE_FOCUS_REPORTING,
  DISABLE_MOUSE_TRACKING,
  ENABLE_BRACKETED_PASTE,
  ENABLE_FOCUS_REPORTING,
  ENABLE_MOUSE_TRACKING
} from "./termio/dec.js";

export type TuiTerminalCapabilities = {
  rawMode: boolean;
  bracketedPaste: boolean;
  extendedKeyboard: boolean;
  mouse: boolean;
  focusReporting: boolean;
  hyperlinks: boolean;
  color: boolean;
  trueColor: boolean;
  colorLevel: 0 | 1 | 2 | 3;
  clipboard: boolean;
  notifications: boolean;
  tabStatus: boolean;
};

export type TuiTerminalCapabilityEnv = Record<string, string | undefined>;

export function detectTuiTerminalCapabilities(
  env: TuiTerminalCapabilityEnv = process.env,
  stream: { isTTY?: boolean } = process.stdout
): TuiTerminalCapabilities {
  const termProgram = (env.TERM_PROGRAM ?? "").toLowerCase();
  const term = (env.TERM ?? "").toLowerCase();
  const windowsTerminal = Boolean(env.WT_SESSION) || /windows[_\s-]?terminal/u.test(termProgram);
  const isTty = stream.isTTY === true;
  const modernTerminal = windowsTerminal ||
    /wezterm|iterm|vscode|ghostty|kitty/u.test(termProgram) ||
    /xterm|screen|tmux|rxvt|alacritty|kitty/u.test(term);
  const explicitNoColor = env.NO_COLOR !== undefined || env.SWARM_TUI_NO_COLOR === "1" || env.FORCE_COLOR === "0";
  const explicitNoHyperlinks = explicitNoColor || env.SWARM_TUI_NO_HYPERLINKS === "1";
  const colorDisabled = explicitNoColor;
  const colorTerm = (env.COLORTERM ?? "").toLowerCase();
  const isTmux = Boolean(env.TMUX) || term.includes("tmux");
  const tmuxTrueColor = env.SWARM_TUI_TMUX_TRUECOLOR === "1";
  const forcedColorLevel = forcedTerminalColorLevel(env.FORCE_COLOR);
  const trueColorRequested = (
    colorTerm.includes("truecolor") ||
    colorTerm.includes("24bit") ||
    windowsTerminal ||
    /wezterm|iterm|vscode|ghostty|kitty|alacritty/u.test(termProgram) ||
    env.SWARM_TUI_TRUECOLOR === "1" ||
    tmuxTrueColor ||
    forcedColorLevel === 3
  );
  const trueColor = !colorDisabled && trueColorRequested && (!isTmux || tmuxTrueColor);
  const colorLevel = colorDisabled ? 0 : terminalColorLevel({
    forcedColorLevel,
    trueColor,
    isTmux,
    term,
    termProgram,
    modernTerminal
  });
  return {
    rawMode: isTty,
    bracketedPaste: isTty && modernTerminal,
    extendedKeyboard: isTty && (/kitty/u.test(termProgram) || /kitty/u.test(term) || env.SWARM_TUI_EXTENDED_KEYS === "1"),
    mouse: isTty && modernTerminal && env.SWARM_TUI_MOUSE !== "0",
    focusReporting: isTty && modernTerminal,
    hyperlinks: isTty && modernTerminal && !explicitNoHyperlinks,
    color: !colorDisabled,
    trueColor,
    colorLevel,
    clipboard: isTty && (termProgram.includes("wezterm") || termProgram.includes("iterm") || env.SWARM_TUI_CLIPBOARD === "1"),
    notifications: isTty && (termProgram.includes("wezterm") || termProgram.includes("iterm")),
    tabStatus: isTty && (termProgram.includes("wezterm") || termProgram.includes("iterm") || termProgram.includes("vscode"))
  };
}

function forcedTerminalColorLevel(value: string | undefined): 0 | 1 | 2 | 3 | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (value === "true") {
    return 1;
  }
  const level = Number(value);
  if (level === 0 || level === 1 || level === 2 || level === 3) {
    return level;
  }
  return undefined;
}

function terminalColorLevel(input: {
  forcedColorLevel: 0 | 1 | 2 | 3 | undefined;
  trueColor: boolean;
  isTmux: boolean;
  term: string;
  termProgram: string;
  modernTerminal: boolean;
}): 0 | 1 | 2 | 3 {
  if (input.forcedColorLevel !== undefined) {
    if (input.forcedColorLevel === 3 && input.isTmux && !input.trueColor) {
      return 2;
    }
    return input.forcedColorLevel;
  }
  if (input.trueColor) {
    return 3;
  }
  if (input.isTmux || input.term.includes("256color") || input.term.includes("screen") || /vscode/u.test(input.termProgram)) {
    return 2;
  }
  return input.modernTerminal ? 1 : 1;
}

export function terminalModeSequences(capabilities: Partial<TuiTerminalCapabilities>, enabled: boolean): string {
  let output = "";
  if (capabilities.bracketedPaste) {
    output += enabled ? ENABLE_BRACKETED_PASTE : DISABLE_BRACKETED_PASTE;
  }
  if (capabilities.focusReporting) {
    output += enabled ? ENABLE_FOCUS_REPORTING : DISABLE_FOCUS_REPORTING;
  }
  if (capabilities.mouse) {
    output += enabled ? ENABLE_MOUSE_TRACKING : DISABLE_MOUSE_TRACKING;
  }
  return output;
}

export function terminalNotificationSequence(
  message: string,
  capabilities: Partial<TuiTerminalCapabilities>
): string {
  if (!capabilities.notifications) {
    return "";
  }
  return `\u001B]777;notify;Swarm;${sanitizeTerminalControlPayload(message)}\u0007`;
}

export function terminalClipboardSequence(
  text: string,
  capabilities: Partial<TuiTerminalCapabilities>
): string {
  if (!capabilities.clipboard) {
    return "";
  }
  const payload = Buffer.from(sanitizeTerminalControlPayload(text), "utf8").toString("base64");
  return `\u001B]52;c;${payload}\u0007`;
}

export function terminalTabStatusSequence(
  status: string,
  capabilities: Partial<TuiTerminalCapabilities>
): string {
  if (!capabilities.tabStatus) {
    return "";
  }
  return `\u001B]0;${sanitizeTerminalControlPayload(status)}\u0007`;
}

export function sanitizeTerminalControlPayload(value: string): string {
  return value.replace(/sk-[A-Za-z0-9_-]+/gu, "sk-REDACTED").replace(/[\u0000-\u001F\u007F]/gu, " ").trim();
}
