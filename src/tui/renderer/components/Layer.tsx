import React from "react";
import { Box, type RendererBoxProps } from "./Box.js";

export type TuiLayerName =
  | "conversation"
  | "bottom-chrome"
  | "detail"
  | "command-output"
  | "approval"
  | "onboarding"
  | "notification";

export const TUI_LAYER_Z_INDEX: Record<TuiLayerName, number> = {
  conversation: 0,
  "bottom-chrome": 10,
  detail: 20,
  "command-output": 25,
  approval: 40,
  onboarding: 50,
  notification: 60
};

export type RendererLayerProps = RendererBoxProps & {
  layer: TuiLayerName;
  modal?: boolean;
};

export function Layer({ layer, modal, children, ...props }: RendererLayerProps): React.ReactElement {
  return React.createElement(
    "swarm-box",
    {
      ...props,
      layer,
      zIndex: TUI_LAYER_Z_INDEX[layer],
      modal: Boolean(modal),
      focusable: modal || props.focusable
    },
    React.createElement(Box, { flexDirection: props.flexDirection ?? "column", width: props.width }, children)
  );
}

