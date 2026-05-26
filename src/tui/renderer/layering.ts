import { TUI_LAYER_Z_INDEX, type TuiLayerName } from "./components/Layer.js";

export type TuiLayerState = {
  layer: TuiLayerName;
  open: boolean;
  focusOwner: string;
  previousFocusOwner?: string;
};

export function activeLayers(layers: readonly TuiLayerState[]): TuiLayerState[] {
  return layers
    .filter((layer) => layer.open)
    .sort((left, right) => TUI_LAYER_Z_INDEX[left.layer] - TUI_LAYER_Z_INDEX[right.layer]);
}

export function topLayer(layers: readonly TuiLayerState[]): TuiLayerState | undefined {
  return activeLayers(layers).at(-1);
}

export function closeTopLayer(layers: readonly TuiLayerState[]): {
  layers: TuiLayerState[];
  restoredFocusOwner?: string;
} {
  const top = topLayer(layers);
  if (!top) {
    return { layers: [...layers] };
  }
  return {
    layers: layers.map((layer) => layer === top ? { ...layer, open: false } : layer),
    restoredFocusOwner: top.previousFocusOwner ?? "input"
  };
}

