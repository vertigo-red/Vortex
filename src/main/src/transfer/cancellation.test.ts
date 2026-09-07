import { AbortError } from "got";
import { describe, expect, it } from "vitest";

import { isCancellation } from "./cancellation";

describe("isCancellation", () => {
  it("recognizes got's AbortError", () => {
    expect(isCancellation(new AbortError({} as never))).toBe(true);
  });

  it("recognizes an AbortError DOMException", () => {
    expect(isCancellation(new DOMException("aborted", "AbortError"))).toBe(true);
  });

  it("does not treat other DOMExceptions as cancellations", () => {
    expect(isCancellation(new DOMException("timed out", "TimeoutError"))).toBe(false);
  });

  it("does not treat ordinary values as cancellations", () => {
    expect(isCancellation(new Error("boom"))).toBe(false);
    expect(isCancellation("aborted")).toBe(false);
    expect(isCancellation(undefined)).toBe(false);
  });
});
