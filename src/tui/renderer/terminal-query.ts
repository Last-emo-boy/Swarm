import { parseCsiSequence } from "./termio/csi.js";
import { parseOscSequence } from "./termio/osc.js";

export type TuiTerminalQueryResponse = {
  raw: string;
  family: "csi" | "osc" | "escape";
  command?: string;
  params?: readonly string[];
  payload?: string;
  timestamp: number;
};

export function parseTerminalQueryResponse(raw: string, timestamp = Date.now()): TuiTerminalQueryResponse | undefined {
  const osc = parseOscSequence(raw);
  if (osc) {
    return {
      raw,
      family: "osc",
      command: osc.command,
      payload: osc.payload,
      timestamp
    };
  }
  const csi = parseCsiSequence(raw);
  if (csi && isQueryLikeCsi(csi.final, csi.prefix)) {
    return {
      raw,
      family: "csi",
      command: `${csi.prefix}${csi.final}`,
      params: csi.params,
      timestamp
    };
  }
  return undefined;
}

export class TuiTerminalQuerier {
  private readonly responses: TuiTerminalQueryResponse[] = [];

  consume(raw: string, timestamp = Date.now()): TuiTerminalQueryResponse | undefined {
    const response = parseTerminalQueryResponse(raw, timestamp);
    if (response) {
      this.responses.push(response);
    }
    return response;
  }

  history(): readonly TuiTerminalQueryResponse[] {
    return this.responses;
  }
}

function isQueryLikeCsi(final: string, prefix: string): boolean {
  return final === "c" || final === "R" || final === "n" || final === "y" || prefix.includes("?");
}

