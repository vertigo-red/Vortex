import { describe, expect, it } from "vitest";

import { createGotTimeoutOptions } from "./timeouts";

describe("createGotTimeoutOptions", () => {
  it("returns undefined without a timeout config", () => {
    expect(createGotTimeoutOptions()).toBeUndefined();
    expect(createGotTimeoutOptions(undefined)).toBeUndefined();
  });

  it("maps TimeoutOptions onto got's delays", () => {
    expect(createGotTimeoutOptions({ lookup: 1000, connect: 2000, stall: 5000 })).toEqual({
      lookup: 1000,
      connect: 2000,
      secureConnect: 2000,
      socket: 5000,
      response: 5000,
    });
  });
});
