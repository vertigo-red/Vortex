import { describe, expect, it, vi } from "vitest";

import { log } from "../logging";
import type QueryRegistry from "./QueryRegistry";
import QueryWatcher from "./QueryWatcher";

vi.mock("../logging", () => ({
  log: vi.fn(),
}));

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const makeRegistry = () =>
  ({
    executeQuery: vi.fn(),
  }) as unknown as QueryRegistry;

describe("QueryWatcher", () => {
  it("establishes a baseline without notifying the callback", async () => {
    const registry = makeRegistry();
    registry.executeQuery.mockResolvedValue([{ a: 1 }]);
    const watcher = new QueryWatcher(registry);
    const callback = vi.fn();

    watcher.watch("q1", { tag: "x" }, callback);
    await flush();

    expect(registry.executeQuery).toHaveBeenCalledWith("q1", { tag: "x" });
    await watcher.onQueriesInvalidated(["q1"]);
    expect(callback).not.toHaveBeenCalled();
  });

  it("notifies the callback when the query result changes", async () => {
    const registry = makeRegistry();
    registry.executeQuery.mockResolvedValueOnce([{ a: 1 }]).mockResolvedValueOnce([{ a: 2 }]);
    const watcher = new QueryWatcher(registry);
    const callback = vi.fn();

    watcher.watch("q1", {}, callback);
    await flush();
    await watcher.onQueriesInvalidated(["q1"]);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({
      queryName: "q1",
      previous: [{ a: 1 }],
      current: [{ a: 2 }],
    });
  });

  it("does not notify the callback when the result is unchanged", async () => {
    const registry = makeRegistry();
    registry.executeQuery.mockResolvedValue([{ a: 1 }]);
    const watcher = new QueryWatcher(registry);
    const callback = vi.fn();

    watcher.watch("q1", {}, callback);
    await flush();
    await watcher.onQueriesInvalidated(["q1"]);

    expect(registry.executeQuery).toHaveBeenCalledTimes(2);
    expect(callback).not.toHaveBeenCalled();
  });

  it("only re-executes affected watched queries", async () => {
    const registry = makeRegistry();
    registry.executeQuery
      .mockResolvedValueOnce([{ a: 1 }])
      .mockResolvedValueOnce([{ b: 1 }])
      .mockResolvedValueOnce([{ b: 2 }]);
    const watcher = new QueryWatcher(registry);
    const callbackA = vi.fn();
    const callbackB = vi.fn();

    watcher.watch("qA", {}, callbackA);
    watcher.watch("qB", {}, callbackB);
    await flush();
    await watcher.onQueriesInvalidated(["qB"]);

    expect(callbackA).not.toHaveBeenCalled();
    expect(callbackB).toHaveBeenCalledTimes(1);
    expect(registry.executeQuery).toHaveBeenCalledTimes(3);
    expect(registry.executeQuery).toHaveBeenNthCalledWith(1, "qA", {});
    expect(registry.executeQuery).toHaveBeenNthCalledWith(2, "qB", {});
    expect(registry.executeQuery).toHaveBeenNthCalledWith(3, "qB", {});
  });

  it("stops notifying after unsubscribing", async () => {
    const registry = makeRegistry();
    registry.executeQuery.mockResolvedValueOnce([{ a: 1 }]).mockResolvedValueOnce([{ a: 2 }]);
    const watcher = new QueryWatcher(registry);
    const callback = vi.fn();

    const unsubscribe = watcher.watch("q1", {}, callback);
    await flush();
    unsubscribe();
    await watcher.onQueriesInvalidated(["q1"]);

    expect(callback).not.toHaveBeenCalled();
  });

  it("ignores the baseline for an entry unsubscribed before it arrives", async () => {
    const registry = makeRegistry();
    registry.executeQuery.mockResolvedValue([{ a: 1 }]);
    const watcher = new QueryWatcher(registry);
    const callback = vi.fn();

    const unsubscribe = watcher.watch("q1", {}, callback);
    unsubscribe();
    await flush();
    await watcher.onQueriesInvalidated(["q1"]);

    expect(callback).not.toHaveBeenCalled();
  });

  it("logs a warning when the initial fetch fails", async () => {
    const registry = makeRegistry();
    registry.executeQuery.mockRejectedValue(new Error("no such table"));
    const watcher = new QueryWatcher(registry);

    watcher.watch("q1", {}, vi.fn());
    await flush();

    expect(log).toHaveBeenCalledWith(
      "warn",
      "QueryWatcher: initial fetch failed",
      expect.objectContaining({ queryName: "q1", error: "no such table" }),
    );
  });

  it("continues watching other queries when one re-fetch fails", async () => {
    const registry = makeRegistry();
    registry.executeQuery
      .mockResolvedValueOnce([{ a: 1 }])
      .mockResolvedValueOnce([{ b: 1 }])
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce([{ b: 2 }]);
    const watcher = new QueryWatcher(registry);
    const callbackA = vi.fn();
    const callbackB = vi.fn();

    watcher.watch("qA", {}, callbackA);
    watcher.watch("qB", {}, callbackB);
    await flush();

    await expect(watcher.onQueriesInvalidated(["qA", "qB"])).resolves.toBeUndefined();
    expect(callbackA).not.toHaveBeenCalled();
    expect(callbackB).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "warn",
      "QueryWatcher: re-fetch failed",
      expect.objectContaining({ queryName: "qA", error: "boom" }),
    );
  });
});
