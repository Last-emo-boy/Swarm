import type { TuiRoot } from "./root.js";
import { TuiInputParser, type TuiParsedInput } from "./input-parser.js";
import { TuiTerminalQuerier } from "./terminal-query.js";

export type TuiTerminalInputSink = Pick<TuiRoot, "dispatchInput">;

export type TuiTerminalInputDelivery = {
  delivered: number;
  responses: number;
  mouse: number;
  focus: number;
  malformed: number;
};

export class TuiTerminalInputController {
  readonly parser: TuiInputParser;
  readonly querier: TuiTerminalQuerier;

  constructor(
    private readonly sink: TuiTerminalInputSink,
    options: { parser?: TuiInputParser; querier?: TuiTerminalQuerier } = {}
  ) {
    this.parser = options.parser ?? new TuiInputParser();
    this.querier = options.querier ?? new TuiTerminalQuerier();
  }

  feed(chunk: string | Buffer, options: { flush?: boolean } = {}): TuiTerminalInputDelivery {
    return deliverParsedInput(this.parser.parse(chunk, options), this.sink, this.querier);
  }

  flush(): TuiTerminalInputDelivery {
    return deliverParsedInput(this.parser.flush(), this.sink, this.querier);
  }

  deliver(events: readonly TuiParsedInput[]): TuiTerminalInputDelivery {
    return deliverParsedInput(events, this.sink, this.querier);
  }
}

export function deliverParsedInput(
  events: readonly TuiParsedInput[],
  sink: TuiTerminalInputSink,
  querier = new TuiTerminalQuerier()
): TuiTerminalInputDelivery {
  const summary: TuiTerminalInputDelivery = {
    delivered: 0,
    responses: 0,
    mouse: 0,
    focus: 0,
    malformed: 0
  };
  for (const event of events) {
    switch (event.type) {
      case "key":
        sink.dispatchInput(event.input, event.key);
        summary.delivered += 1;
        break;
      case "paste":
        sink.dispatchInput(event.text, event.key);
        summary.delivered += 1;
        break;
      case "terminal-response":
        querier.consume(event.raw);
        summary.responses += 1;
        break;
      case "mouse":
        summary.mouse += 1;
        break;
      case "terminal-focus":
        summary.focus += 1;
        break;
      case "malformed":
        summary.malformed += 1;
        break;
    }
  }
  return summary;
}
