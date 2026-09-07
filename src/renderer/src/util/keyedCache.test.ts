import { describe, it, expect, vi, afterEach } from "vitest";

import { createKeyedCache } from "./keyedCache";

describe("createKeyedCache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns undefined for a missing key", () => {
    vi.useFakeTimers();
    const cache = createKeyedCache<number>(100);
    expect(cache.get("nope")).toBeUndefined();
  });

  it("returns the stored value before expiry", () => {
    vi.useFakeTimers();
    const cache = createKeyedCache<number>(100);
    cache.set("a", 1);
    vi.advanceTimersByTime(99);
    expect(cache.get("a")).toBe(1);
  });

  it("expires entries after the ttl", () => {
    vi.useFakeTimers();
    const cache = createKeyedCache<number>(100);
    cache.set("a", 1);
    vi.advanceTimersByTime(100);
    expect(cache.get("a")).toBeUndefined();
  });

  it("evicts a single expired entry without affecting the others", () => {
    vi.useFakeTimers();
    const cache = createKeyedCache<number>(100);
    cache.set("a", 1);
    vi.advanceTimersByTime(50);
    cache.set("b", 2);
    vi.advanceTimersByTime(60);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
  });

  it("resets the ttl when a key is overwritten", () => {
    vi.useFakeTimers();
    const cache = createKeyedCache<number>(100);
    cache.set("a", 1);
    vi.advanceTimersByTime(99);
    cache.set("a", 2);
    vi.advanceTimersByTime(99);
    expect(cache.get("a")).toBe(2);
  });

  it("clear drops every entry", () => {
    vi.useFakeTimers();
    const cache = createKeyedCache<string>(100);
    cache.set("a", "x");
    cache.set("b", "y");
    cache.clear();
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
  });
});