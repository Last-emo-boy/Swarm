import { describe, it } from "node:test";
import { expect } from "./testing/expect.js";
import { transient } from "./messages.js";

describe("passing failures", () => {
  it("counts a dropped connection, a busy provider and a model that answered nothing as passing, and nothing else", () => {
    expect(transient(Object.assign(new Error("Service Unavailable"), { status: 503 }))).toBe(true);
    expect(transient(new Error("socket hang up"))).toBe(true);
    expect(transient(new Error('Provider "deepseek" returned an empty response for model "deepseek-flash". (finish_reason=stop)'))).toBe(true);
    expect(transient(Object.assign(new Error("Bad request"), { status: 400 }))).toBe(false);
    expect(transient(new Error("Missing API key for provider \"deepseek\"."))).toBe(false);
  });
});
