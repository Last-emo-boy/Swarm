import React from "react";
import { Layer, type TuiLayerName } from "./Layer.js";

export type ModalRootProps = {
  active?: boolean;
  layer?: Extract<TuiLayerName, "approval" | "onboarding" | "detail" | "command-output">;
  children?: React.ReactNode;
};

export function ModalRoot({ active = true, layer = "detail", children }: ModalRootProps): React.ReactElement | null {
  if (!active) {
    return null;
  }
  return React.createElement(Layer, { layer, modal: true, flexDirection: "column", width: 80 }, children);
}

