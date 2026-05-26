import React from "react";

export type RendererRawAnsiProps = {
  lines?: readonly string[];
  rawText?: string;
  width?: number;
  height?: number;
};

export function RawAnsi({ lines, rawText, width, height }: RendererRawAnsiProps): React.ReactElement | null {
  const text = rawText ?? lines?.join("\n") ?? "";
  if (text.length === 0) {
    return null;
  }
  return React.createElement("swarm-raw-ansi", {
    rawText: text,
    rawWidth: width,
    rawHeight: height ?? lines?.length
  });
}

export default RawAnsi;
