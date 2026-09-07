import { describe, it, expect } from "vitest";

import { createGotTimeoutOptions } from "./timeouts";

describe("createGotTimeoutOptions", () => {
  it("returns undefined for no timeout", () => {
    expect(createGotTimeoutOptions(undefined)).toBeUndefined();
  });

  it("maps lookup, connect and stall units onto the got options", () => {
    expect(createGotTimeoutOptions({ lookup: 100, connect: 200, stall: 300 })).toEqual({
      lookup: 100,
      connect: 200,
      secureConnect: 200,
      socket: 300,
      response: 300,
    });
  });

  it("does not share the connect value into unrelated fields", () => {
    const options = createGotTimeoutOptions({ lookup: 5, connect: 6, stall: 7 })!;
    expect(options).toEqual({
      lookup: 5,
      connect: 6,
      secureConnect: 6,
      socket: 7,
      response: 7,
    });
  });
});