import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./util", () => ({ delay: vi.fn() }));

import ConcurrencyLimiter from "./ConcurrencyLimiter";
import { delay } from "./util";

const mockDelay = vi.mocked(delay);

describe("ConcurrencyLimiter", () => {
  beforeEach(() => {
    mockDelay.mockReset();
    mockDelay.mockResolvedValue(undefined);
  });

  it("returns the callback results", async () => {
    const limiter = new ConcurrencyLimiter(2);
    const results = await Promise.all([0, 1, 2, 3].map((i) => limiter.do(async () => i)));
    expect(results).toEqual([0, 1, 2, 3]);
  });

  it("never exceeds the configured concurrency limit", async () => {
    const limiter = new ConcurrencyLimiter(2);
    let active = 0;
    let maxActive = 0;

    await Promise.all(
      Array.from({ length: 6 }, () =>
        limiter.do(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
        }),
      ),
    );

    expect(maxActive).toBeLessThanOrEqual(2);
    expect(active).toBe(0);
  });

  it("starts queued jobs after the previous one finishes (fifo)", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const order: number[] = [];

    await Promise.all(
      [1, 2, 3].map((i, index) =>
        limiter.do(async () => {
          order.push(index);
          await new Promise((resolve) => setTimeout(resolve, 1));
          return i;
        }),
      ),
    );

    expect(order).toEqual([0, 1, 2]);
  });

  it("propagates failures", async () => {
    const limiter = new ConcurrencyLimiter(1);
    await expect(limiter.do(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  });

  it("retries a failing job while repeatTest accepts the error", async () => {
    const limiter = new ConcurrencyLimiter(1, () => true);
    const cb = vi
      .fn()
      .mockRejectedValueOnce(new Error("temp"))
      .mockRejectedValueOnce(new Error("temp"))
      .mockResolvedValueOnce("ok");

    await expect(limiter.do(cb)).resolves.toBe("ok");

    expect(cb).toHaveBeenCalledTimes(3);
    expect(mockDelay).toHaveBeenCalledTimes(2);
  });

  it("does not retry when repeatTest rejects the error", async () => {
    const limiter = new ConcurrencyLimiter(1, () => false);
    const cb = vi.fn().mockRejectedValue(new Error("nope"));

    await expect(limiter.do(cb)).rejects.toThrow("nope");

    expect(cb).toHaveBeenCalledTimes(1);
    expect(mockDelay).not.toHaveBeenCalled();
  });

  it("passes an Error to repeatTest even for a non-Error throw", async () => {
    const repeatTest = vi.fn().mockReturnValue(false);
    const limiter = new ConcurrencyLimiter(1, repeatTest);

    await expect(limiter.do(async () => Promise.reject("string error"))).rejects.toThrow(
      "string error",
    );

    expect(repeatTest).toHaveBeenCalledWith(expect.any(Error));
  });

  it("keeps working after clearQueue", async () => {
    const limiter = new ConcurrencyLimiter(1);
    let release: () => void = () => undefined;
    const first = limiter.do(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    expect(release).not.toBe(undefined);

    limiter.clearQueue();

    await expect(limiter.do(async () => "after-clear")).resolves.toBe("after-clear");

    release();
    await first;
  });
});
