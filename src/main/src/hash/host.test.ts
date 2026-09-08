import { describe, expect, it } from "vitest";

import { HashWorkerPool } from "./host";
import type { HashWorker } from "./host";
import type { HashJob, HashResult } from "./protocol";

// A worker stand-in whose responses the test drives explicitly. postMessage
// records the job; the emit* helpers fire the events the pool listens for.
class FakeWorker implements HashWorker {
  readonly posted: HashJob[] = [];
  terminated = false;
  readonly #messageListeners: Array<(result: HashResult) => void> = [];
  readonly #errorListeners: Array<(err: Error) => void> = [];
  readonly #exitListeners: Array<(code: number) => void> = [];

  postMessage(message: HashJob): void {
    this.posted.push(message);
  }

  on(event: "message", listener: (result: HashResult) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "exit", listener: (code: number) => void): void;
  on(
    event: "message" | "error" | "exit",
    listener: ((result: HashResult) => void) | ((err: Error) => void) | ((code: number) => void),
  ): void {
    if (event === "message") {
      this.#messageListeners.push(listener as (result: HashResult) => void);
    } else if (event === "error") {
      this.#errorListeners.push(listener as (err: Error) => void);
    } else {
      this.#exitListeners.push(listener as (code: number) => void);
    }
  }

  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }

  unref(): void {
    // no-op: nothing to unref for a fake
  }

  emitMessage(result: HashResult): void {
    for (const listener of this.#messageListeners) {
      listener(result);
    }
  }

  emitError(err: Error): void {
    for (const listener of this.#errorListeners) {
      listener(err);
    }
  }

  emitExit(code: number): void {
    for (const listener of this.#exitListeners) {
      listener(code);
    }
  }

  get lastJob(): HashJob {
    return this.jobAt(this.posted.length - 1);
  }

  jobAt(index: number): HashJob {
    const job = this.posted[index];
    if (job === undefined) {
      throw new Error(`worker has no job at index ${index}`);
    }
    return job;
  }
}

function nthWorker(workers: FakeWorker[], index: number): FakeWorker {
  const worker = workers[index];
  if (worker === undefined) {
    throw new Error(`no worker at index ${index}`);
  }
  return worker;
}

function trackingFactory(): { factory: () => HashWorker; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  return {
    workers,
    factory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  };
}

describe("HashWorkerPool", () => {
  it("spawns the pool lazily and resolves a job with the worker's result", async () => {
    const { factory, workers } = trackingFactory();
    const pool = new HashWorkerPool(factory, 2);

    const result = pool.hashFile("md5", "/a");
    expect(workers).toHaveLength(2);

    const worker = nthWorker(workers, 0);
    worker.emitMessage({ id: worker.lastJob.id, hash: "abc", numBytes: 10 });

    await expect(result).resolves.toEqual({ hash: "abc", numBytes: 10 });
  });

  it("queues jobs beyond the pool size and dispatches them as workers free up", async () => {
    const { factory, workers } = trackingFactory();
    const pool = new HashWorkerPool(factory, 2);

    const p1 = pool.hashFile("md5", "/1");
    const p2 = pool.hashFile("md5", "/2");
    const p3 = pool.hashFile("md5", "/3");

    // Two workers, three jobs: two dispatched, one queued.
    expect(workers.flatMap((w) => w.posted)).toHaveLength(2);

    const w0 = nthWorker(workers, 0);
    const w1 = nthWorker(workers, 1);
    w0.emitMessage({ id: w0.lastJob.id, hash: "h1", numBytes: 1 });
    // Freeing w0 pulls the queued third job onto it.
    expect(w0.posted).toHaveLength(2);
    expect(w0.jobAt(1).filePath).toBe("/3");

    w0.emitMessage({ id: w0.lastJob.id, hash: "h3", numBytes: 3 });
    w1.emitMessage({ id: w1.lastJob.id, hash: "h2", numBytes: 2 });

    await expect(p1).resolves.toEqual({ hash: "h1", numBytes: 1 });
    await expect(p2).resolves.toEqual({ hash: "h2", numBytes: 2 });
    await expect(p3).resolves.toEqual({ hash: "h3", numBytes: 3 });
  });

  it("rejects only the crashed worker's job and replaces the worker", async () => {
    const { factory, workers } = trackingFactory();
    const pool = new HashWorkerPool(factory, 2);

    const p1 = pool.hashFile("md5", "/1");
    const p2 = pool.hashFile("md5", "/2");

    const w0 = nthWorker(workers, 0);
    const w1 = nthWorker(workers, 1);
    w0.emitError(new Error("boom"));

    await expect(p1).rejects.toThrow("boom");
    // A replacement worker was spawned to restore the pool.
    expect(workers).toHaveLength(3);

    // The other in-flight job is unaffected.
    w1.emitMessage({ id: w1.lastJob.id, hash: "h2", numBytes: 2 });
    await expect(p2).resolves.toEqual({ hash: "h2", numBytes: 2 });
  });

  it("rejects the job and drops it from the queue when a worker cannot be spawned", async () => {
    const workers: FakeWorker[] = [];
    let calls = 0;
    const factory = (): HashWorker => {
      calls += 1;
      if (calls === 1) {
        throw new Error("spawn failed");
      }
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    };
    const pool = new HashWorkerPool(factory, 1);

    await expect(pool.hashFile("md5", "/first")).rejects.toThrow("spawn failed");

    // The second call spawns successfully; the first job must not linger in the
    // queue and run on this worker, or it would hash for an already-rejected
    // promise.
    const p2 = pool.hashFile("md5", "/second");
    const worker = nthWorker(workers, 0);
    expect(worker.posted).toHaveLength(1);
    expect(worker.jobAt(0).filePath).toBe("/second");

    worker.emitMessage({ id: worker.lastJob.id, hash: "ok", numBytes: 1 });
    await expect(p2).resolves.toEqual({ hash: "ok", numBytes: 1 });
  });

  it("does not park a worker when a message arrives with an unexpected id", async () => {
    const { factory, workers } = trackingFactory();
    const pool = new HashWorkerPool(factory, 1);

    const p1 = pool.hashFile("md5", "/1");
    const p2 = pool.hashFile("md5", "/2");

    const worker = nthWorker(workers, 0);
    expect(worker.posted).toHaveLength(1);

    // A stray message whose id matches no outstanding job must still free the
    // slot so the queued job is picked up.
    worker.emitMessage({ id: worker.lastJob.id + 999, hash: "stray", numBytes: 0 });
    expect(worker.posted).toHaveLength(2);
    expect(worker.jobAt(1).filePath).toBe("/2");

    worker.emitMessage({ id: worker.lastJob.id, hash: "ok", numBytes: 5 });
    await expect(p2).resolves.toEqual({ hash: "ok", numBytes: 5 });

    // p1's job was abandoned by the protocol violation; it stays pending.
    void p1;
  });

  it("terminates every worker on shutdown", async () => {
    const { factory, workers } = trackingFactory();
    const pool = new HashWorkerPool(factory, 3);

    void pool.hashFile("md5", "/1");
    expect(workers).toHaveLength(3);

    await pool.shutdown();
    expect(workers.every((w) => w.terminated)).toBe(true);
  });

  it("rejects the job as a setup-error when the worker answers with an error message", async () => {
    const { factory, workers } = trackingFactory();
    const pool = new HashWorkerPool(factory, 1);

    const p = pool.hashFile("md5", "/a");
    const worker = nthWorker(workers, 0);
    worker.emitMessage({ id: worker.lastJob.id, error: "unsupported algorithm" });

    await expect(p).rejects.toMatchObject({
      message: "unsupported algorithm",
      data: { kind: "setup-error", component: "hash-worker" },
    });
  });

  it("defaults missing hash and byte count on the result", async () => {
    const { factory, workers } = trackingFactory();
    const pool = new HashWorkerPool(factory, 1);

    const p = pool.hashFile("md5", "/a");
    const worker = nthWorker(workers, 0);
    worker.emitMessage({ id: worker.lastJob.id });

    await expect(p).resolves.toEqual({ hash: "", numBytes: 0 });
  });

  it("rejects the running job and replaces the worker on a non-zero exit", async () => {
    const { factory, workers } = trackingFactory();
    const pool = new HashWorkerPool(factory, 1);

    const p1 = pool.hashFile("md5", "/1");
    const worker = nthWorker(workers, 0);

    worker.emitExit(1);

    await expect(p1).rejects.toMatchObject({
      message: "hash worker stopped unexpectedly (exit code 1)",
      data: { kind: "setup-error", component: "hash-worker" },
    });
    // The crashed worker was dropped and a replacement joined the pool.
    expect(workers).toHaveLength(2);

    const p2 = pool.hashFile("md5", "/2");
    const replacement = nthWorker(workers, 1);
    expect(replacement.jobAt(0).filePath).toBe("/2");
    replacement.emitMessage({ id: replacement.lastJob.id, hash: "ok", numBytes: 3 });
    await expect(p2).resolves.toEqual({ hash: "ok", numBytes: 3 });
  });

  it("keeps the worker when it exits cleanly with code zero", async () => {
    const { factory, workers } = trackingFactory();
    const pool = new HashWorkerPool(factory, 1);

    const p1 = pool.hashFile("md5", "/1");
    const worker = nthWorker(workers, 0);

    worker.emitExit(0);

    // The in-flight job still completes, and the worker stays in the pool.
    worker.emitMessage({ id: worker.lastJob.id, hash: "ok", numBytes: 1 });
    await expect(p1).resolves.toEqual({ hash: "ok", numBytes: 1 });

    const p2 = pool.hashFile("md5", "/2");
    expect(worker.posted).toHaveLength(2);
    expect(worker.jobAt(1).filePath).toBe("/2");
    worker.emitMessage({ id: worker.lastJob.id, hash: "ok2", numBytes: 2 });
    await expect(p2).resolves.toEqual({ hash: "ok2", numBytes: 2 });
  });

  it("hands a queued job to the replacement worker after a crash", async () => {
    const { factory, workers } = trackingFactory();
    const pool = new HashWorkerPool(factory, 2);

    const p1 = pool.hashFile("md5", "/1");
    const p2 = pool.hashFile("md5", "/2");
    const p3 = pool.hashFile("md5", "/3");

    const w0 = nthWorker(workers, 0);
    const w1 = nthWorker(workers, 1);
    expect(w0.posted).toHaveLength(1);
    expect(w1.posted).toHaveLength(1);

    // w0 crashes while running /1; its promise rejects, the worker is dropped,
    // and the replacement (being idle) takes the queued /3.
    w0.emitError(new Error("boom"));
    await expect(p1).rejects.toThrow("boom");
    expect(workers).toHaveLength(3);

    const w2 = nthWorker(workers, 2);
    expect(w2.jobAt(0).filePath).toBe("/3");

    w1.emitMessage({ id: w1.lastJob.id, hash: "h2", numBytes: 2 });
    w2.emitMessage({ id: w2.lastJob.id, hash: "h3", numBytes: 3 });
    await expect(p2).resolves.toEqual({ hash: "h2", numBytes: 2 });
    await expect(p3).resolves.toEqual({ hash: "h3", numBytes: 3 });
  });
});
