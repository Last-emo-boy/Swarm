import { displayWidth, sliceByDisplayWidth } from "../display-width.js";
import type { TuiNodeAttribute } from "./dom.js";

export type TuiProgressAttributes = Record<string, TuiNodeAttribute>;

export function progressText(attributes: TuiProgressAttributes, availableWidth: number): string {
  const width = Math.max(1, numericAttribute(attributes.width) ?? availableWidth);
  const fraction = normalizeProgress(numericAttribute(attributes.value) ?? 0);
  const label = stringAttribute(attributes.label);
  const showPercent = attributes.showPercent !== false;
  const completeChar = singleCellChar(stringAttribute(attributes.completeChar), "#");
  const incompleteChar = singleCellChar(stringAttribute(attributes.incompleteChar), "-");
  const percent = showPercent ? ` ${Math.round(fraction * 100)}%` : "";
  const prefix = label ? `${label} ` : "";
  const chromeWidth = displayWidth(prefix) + displayWidth(percent) + 2;
  const barWidth = Math.max(1, width - chromeWidth);
  const completeWidth = Math.max(0, Math.min(barWidth, Math.round(barWidth * fraction)));
  const text = `${prefix}[${completeChar.repeat(completeWidth)}${incompleteChar.repeat(barWidth - completeWidth)}]${percent}`;
  return displayWidth(text) <= width ? text : sliceByDisplayWidth(text, width).head;
}

function normalizeProgress(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value > 1 && value <= 100) {
    return value / 100;
  }
  return Math.max(0, Math.min(1, value));
}

function numericAttribute(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringAttribute(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function singleCellChar(value: string | undefined, fallback: string): string {
  const char = [...(value ?? fallback)][0] ?? fallback;
  return displayWidth(char) === 1 ? char : fallback;
}
