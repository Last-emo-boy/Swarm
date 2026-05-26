import type { TuiScreen } from "./screen.js";
import type { TuiDamageRect } from "./screen.js";

export type TuiViewport = {
  width: number;
  height: number;
};

export type TuiCursor = {
  x: number;
  y: number;
  visible: boolean;
};

export type TuiFrameTiming = {
  startedAt: number;
  layoutMs: number;
  paintMs: number;
  totalMs: number;
};

export type TuiFrame = {
  screen: TuiScreen;
  viewport: TuiViewport;
  cursor: TuiCursor;
  timing: TuiFrameTiming;
  metadata: {
    renderer: "dom-renderer";
    invalidLayout: boolean;
    dirtyNodeCount: number;
    nodeCount: number;
    scrollDrainPending: boolean;
    output?: {
      fullReset: boolean;
      changedRows: number;
      scannedRows: number;
      patchOps: number;
      damageArea: number;
      damage?: TuiDamageRect;
    };
  };
};
