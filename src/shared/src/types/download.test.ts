import { describe, it, expect } from "vitest";

import { noRetry } from "./download";

describe("noRetry", () => {
  it("never retries", () => {
    expect(noRetry({ attempt: 1, error: new Error("x") })).toEqual({ retry: false });
  });

  it("ignores the attempt count", () => {
    expect(noRetry({ attempt: 99, error: new Error("x") })).toEqual({ retry: false });
  });

  it("ignores the error", () => {
    const err = Object.assign(new Error("transient"), { code: "ETIMEDOUT" });
    expect(noRetry({ attempt: 1, error: err })).toEqual({ retry: false });
  });
});