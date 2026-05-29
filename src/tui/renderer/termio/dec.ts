import { CSI } from "./ansi.js";

export const ENABLE_BRACKETED_PASTE = `${CSI}?2004h`;
export const DISABLE_BRACKETED_PASTE = `${CSI}?2004l`;
export const ENABLE_FOCUS_REPORTING = `${CSI}?1004h`;
export const DISABLE_FOCUS_REPORTING = `${CSI}?1004l`;
export const ENABLE_MOUSE_TRACKING = `${CSI}?1000h${CSI}?1006h`;
export const DISABLE_MOUSE_TRACKING = `${CSI}?1006l${CSI}?1000l`;
