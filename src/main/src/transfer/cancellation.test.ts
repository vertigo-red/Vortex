import { AbortError } from "got";
import { describe, it, expect } from "vitest";

import { isCancellation } from "./cancellation";

describe("isCancellation", () => {
  it("recognises the got AbortError", () => {
    expect(isCancellation(new AbortError({ options: {} } as never))).toBe(true);
  });

  it("recognises a DOMException named AbortError", () => {
    expect(isCancellation(new DOMException("aborted", "AbortError"))).toBe(true);
  });

  it("recognises a bare AbortController abort signal", () => {
    const controller = new AbortController();
    controller.abort();
    expect(isCancellation(controller.signal.reason)).toBe(true);
  });

  it("rejects a DOMException with a different name", () => {
    expect(isCancellation(new DOMException("nope", "InvalidStateError"))).toBe(false);
  });

  it("rejects a plain Error", () => {
    expect(isCancellation(new Error("boom"))).toBe(false);
  });

  it("rejects a plain error object with name AbortError", () => {
    const err = Object.assign(new Error("boom"), { name: "AbortError" });
    expect(isCancellation(err)).toBe(false);
  });

  it.each([undefined, null, "aborted", 42])("rejects non-error value %s", (value) => {
    expect(isCancellation(value)).toBe(false);
  });
});