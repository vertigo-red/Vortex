/** Exercise the shipped LOOT transport without binding an OS socket or loading the native ABI. */
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { runInNewContext } from "node:vm";

import type { ForkFunction, LootAsync } from "loot";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const loadDependency = createRequire(__filename);
const entry = loadDependency.resolve("loot/index.js");
const deadline = 30_000;

class TestSocket extends EventEmitter {
  messages: Array<{ type: string; args?: unknown[] }> = [];
  destroy = vi.fn(() => this.emit("close"));

  write(frame: string, callback?: (error?: Error) => void) {
    this.messages.push(JSON.parse(frame.slice(0, -1)));
    callback?.();
  }

  answer(message: unknown) {
    this.emit("data", Buffer.from(JSON.stringify(message) + "\uFFFF"));
  }
}

class TestWorker extends EventEmitter {
  kill = vi.fn();
}

class NativeMethods {
  loadPlugins() {}
  sortPlugins() {}
  getUserGroups() {}
}

async function flush() {
  // The VM transport and test caller each schedule promise continuations.
  for (let i = 0; i < 6; ++i) await Promise.resolve();
}

function setup(onFork?: () => unknown, platform = "linux") {
  const worker = new TestWorker();
  const spawn = vi.fn(() => worker);
  const socket = new TestSocket();
  let server: TestServer;
  class TestServer extends EventEmitter {
    endpoint: string;
    close = vi.fn();

    constructor() {
      super();
      server = this;
    }

    listen(endpoint: string, ready: () => void) {
      this.endpoint = endpoint;
      queueMicrotask(ready);
      return this;
    }
  }
  const loaded = { exports: {} as { LootAsync: typeof LootAsync } };
  runInNewContext(readFileSync(entry, "utf8"), {
    module: loaded,
    exports: loaded.exports,
    __dirname: path.dirname(entry),
    process: { ...process, platform },
    Buffer,
    setTimeout,
    clearTimeout,
    require: (name: string) => {
      if (name === "net") return { Server: TestServer };
      if (name === "child_process") return { spawn };
      if (name === "./build/Release/node-loot") return { Loot: NativeMethods };
      return loadDependency(name);
    },
  });
  const log = vi.fn();
  const startup = loaded.exports.LootAsync.create(
    "skyrimse",
    "/game",
    "/local",
    "en",
    log,
    onFork as ForkFunction | undefined,
  );
  return {
    worker,
    spawn,
    socket,
    server: server!,
    startup,
    async connect() {
      await flush();
      server.emit("connection", socket);
      socket.answer({ result: null });
    },
    async ready() {
      await this.connect();
      expect(socket.messages).toEqual([
        { type: "init", args: ["skyrimse", "/game", "/local", "en"] },
      ]);
      socket.answer({});
      return startup;
    },
  };
}

describe("LOOT worker lifecycle", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => vi.useRealTimers());

  test("rejects and removes the endpoint when the process promise ends before connecting", async () => {
    const harness = setup(() => Promise.resolve());
    await expect(harness.startup).rejects.toMatchObject({ name: "RemoteDied", call: "init" });
    expect(harness.server.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("preserves the failed process's code before it connects", async () => {
    const harness = setup(() =>
      Promise.reject(Object.assign(new Error("missing library"), { exitCode: 127 })),
    );
    await expect(harness.startup).rejects.toMatchObject({
      name: "RemoteDied",
      call: "init",
      code: "127",
    });
    expect(harness.server.close).toHaveBeenCalledOnce();
  });

  test("handles a spawn exception and cleans up", async () => {
    const failure = Object.assign(new Error("spawn failed"), { code: "EACCES" });
    const harness = setup(() => {
      throw failure;
    });
    await expect(harness.startup).rejects.toBe(failure);
    expect(harness.server.close).toHaveBeenCalledOnce();
  });

  test("handles a ChildProcess error before it connects", async () => {
    const harness = setup();
    const rejection = expect(harness.startup).rejects.toMatchObject({
      name: "RemoteDied",
      code: "ENOENT",
    });
    await flush();
    harness.worker.emit("error", Object.assign(new Error("spawn failed"), { code: "ENOENT" }));
    await rejection;
    expect(harness.worker.kill).toHaveBeenCalledOnce();
    expect(harness.server.close).toHaveBeenCalledOnce();
  });

  test("handles a ChildProcess exit before it connects", async () => {
    const harness = setup();
    const rejection = expect(harness.startup).rejects.toMatchObject({
      name: "RemoteDied",
      code: "1",
    });
    await flush();
    harness.worker.emit("exit", 1, null);
    await rejection;
    expect(harness.server.close).toHaveBeenCalledOnce();
  });

  test("bounds startup for callers that return no process handle", async () => {
    const harness = setup(() => undefined);
    const rejection = expect(harness.startup).rejects.toMatchObject({ code: "ETIMEDOUT" });
    await vi.advanceTimersByTimeAsync(deadline);
    await rejection;
    expect(harness.server.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("bounds native initialization after the worker connects", async () => {
    const harness = setup();
    const rejection = expect(harness.startup).rejects.toMatchObject({ code: "ETIMEDOUT" });
    await harness.connect();
    await vi.advanceTimersByTimeAsync(deadline);
    await rejection;
    expect(harness.socket.destroy).toHaveBeenCalledOnce();
    expect(harness.worker.kill).toHaveBeenCalledOnce();
    expect(harness.server.close).toHaveBeenCalledOnce();
  });

  test("rejects a lost connection during the readiness handshake", async () => {
    const harness = setup();
    const rejection = expect(harness.startup).rejects.toMatchObject({
      name: "RemoteDied",
      call: "init",
    });
    await flush();
    harness.server.emit("connection", harness.socket);
    harness.socket.emit("close");
    await rejection;
    expect(harness.server.close).toHaveBeenCalledOnce();
  });

  test("closes the endpoint and worker when native initialization fails", async () => {
    const harness = setup();
    const rejection = expect(harness.startup).rejects.toMatchObject({
      message: "invalid game",
      code: "EINVAL",
    });
    await harness.connect();
    harness.socket.answer({ error: "invalid game", extraArgs: JSON.stringify({ code: "EINVAL" }) });
    await rejection;
    expect(harness.server.close).toHaveBeenCalledOnce();
    expect(harness.worker.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("removes the endpoint when listening fails", async () => {
    const harness = setup();
    const error = Object.assign(new Error("endpoint unavailable"), { code: "EADDRINUSE" });
    const rejection = expect(harness.startup).rejects.toBe(error);
    harness.server.emit("error", error);
    await rejection;
    expect(harness.server.close).toHaveBeenCalledOnce();
  });

  test("keeps Unix socket and Windows named-pipe endpoint formats", async () => {
    for (const platform of ["linux", "win32"]) {
      const harness = setup(undefined, platform);
      const loot = await harness.ready();
      expect(harness.server.endpoint).toMatch(
        platform === "linux" ? /loot-ipc-[\w-]+\.sock$/ : /^\\\\\?\\pipe\\loot-ipc-/,
      );
      loot.close();
      harness.socket.answer({});
    }
  });

  test("decodes split Unicode frames and closes cleanly without a startup timer", async () => {
    const harness = setup();
    const loot = await harness.ready();
    expect(vi.getTimerCount()).toBe(0);
    const result = loot.getUserGroups();
    const groups = [{ name: "Журнал 🎲", afterGroups: ["Главная"] }];
    const frame = Buffer.from(JSON.stringify({ result: groups }) + "\uFFFF");
    const split = frame.indexOf(Buffer.from("Ж")) + 1;
    harness.socket.emit("data", frame.subarray(0, split));
    harness.socket.emit("data", frame.subarray(split));
    await expect(result).resolves.toEqual(groups);
    loot.close();
    harness.socket.answer({});
    expect(loot.isClosed()).toBe(true);
    expect(harness.server.close).toHaveBeenCalledOnce();
    await expect(loot.getUserGroups()).rejects.toMatchObject({ name: "AlreadyClosed" });
  });

  test("rejects every queued call with its own name when the worker dies", async () => {
    const harness = setup();
    const loot = await harness.ready();
    const sorting = expect(loot.sortPlugins(["One.esp"])).rejects.toMatchObject({
      name: "RemoteDied",
      call: "sortPlugins",
      code: "ECONNRESET",
    });
    const groups = expect(loot.getUserGroups()).rejects.toMatchObject({
      name: "RemoteDied",
      call: "getUserGroups",
      code: "ECONNRESET",
    });
    harness.socket.emit("error", Object.assign(new Error("lost socket"), { code: "ECONNRESET" }));
    harness.socket.emit("close");
    await Promise.all([sorting, groups]);
    expect(loot.isClosed()).toBe(true);
    expect(harness.server.close).toHaveBeenCalledOnce();
    loot.close();
    expect(harness.server.close).toHaveBeenCalledOnce();
  });

  test("exits the native worker when its parent closes the socket", async () => {
    const client = new TestSocket();
    const exit = vi.fn();
    runInNewContext(readFileSync(path.join(path.dirname(entry), "async.js"), "utf8"), {
      process: { argv: ["node", "async.js", "/socket"], on: vi.fn(), exit },
      console,
      require: (name: string) => {
        if (name === "net")
          return {
            connect: (_endpoint: string, ready: () => void) => {
              queueMicrotask(ready);
              return client;
            },
          };
        if (name === "./build/Release/node-loot") return { Loot: NativeMethods };
        return loadDependency(name);
      },
    });
    await flush();
    client.emit("close");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
