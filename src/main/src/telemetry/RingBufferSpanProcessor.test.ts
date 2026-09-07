import { SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";

import { RingBufferSpanProcessor } from "./RingBufferSpanProcessor";

type SpanProps = {
  traceId?: string;
  spanId?: string;
  startSeconds?: number;
  error?: boolean;
};

const makeSpan = (props: SpanProps = {}): ReadableSpan => {
  const { traceId = "t1", spanId = "s1", startSeconds = 0, error = false } = props;
  return {
    name: "span",
    kind: 1,
    status: { code: error ? SpanStatusCode.ERROR : SpanStatusCode.OK },
    startTime: [startSeconds, 0],
    endTime: [startSeconds, 0],
    spanContext: () => ({ traceId, spanId, traceFlags: 0, isRemote: false }),
  } as unknown as ReadableSpan;
};

const traceIds = (spans: ReadableSpan[]): string[] =>
  spans.map((span) => span.spanContext().traceId);

describe("RingBufferSpanProcessor", () => {
  it("buffers non-error spans in insertion order", () => {
    const processor = new RingBufferSpanProcessor();
    processor.onEnd(makeSpan({ spanId: "s1", startSeconds: 0 }));
    processor.onEnd(makeSpan({ spanId: "s2", startSeconds: 1 }));

    const buffered = processor.getBufferedSpans();
    expect(buffered.map((span) => span.spanContext().spanId)).toEqual(["s1", "s2"]);
  });

  it("evicts the oldest span once the buffer is full", () => {
    const processor = new RingBufferSpanProcessor({ maxSpans: 3 });
    for (let i = 0; i < 4; i++) {
      processor.onEnd(makeSpan({ traceId: `t${i}`, spanId: `s${i}`, startSeconds: i }));
    }

    expect(traceIds(processor.getBufferedSpans())).toEqual(["t1", "t2", "t3"]);
  });

  it("exports an error trace immediately and removes it from the buffer", () => {
    const onExportSpans = vi.fn();
    const processor = new RingBufferSpanProcessor({ onExportSpans });

    const unrelated = makeSpan({ spanId: "sA", traceId: "tA", startSeconds: 1 });
    const failing = makeSpan({ spanId: "sE", traceId: "tE", startSeconds: 0, error: true });
    processor.onEnd(unrelated);
    processor.onEnd(failing);

    expect(onExportSpans).toHaveBeenCalledTimes(1);
    expect(onExportSpans).toHaveBeenCalledWith([failing]);
    expect(traceIds(processor.getBufferedSpans())).toEqual(["tA"]);
  });

  it("exports all buffered spans of an error trace sorted by start time", () => {
    const onExportSpans = vi.fn();
    const processor = new RingBufferSpanProcessor({ onExportSpans });

    const late = makeSpan({ spanId: "s2", traceId: "tX", startSeconds: 2 });
    const early = makeSpan({ spanId: "s0", traceId: "tX", startSeconds: 0 });
    const failing = makeSpan({ spanId: "s1", traceId: "tX", startSeconds: 1, error: true });
    processor.onEnd(late);
    processor.onEnd(early);
    processor.onEnd(failing);

    expect(onExportSpans).toHaveBeenCalledWith([early, failing, late]);
    expect(processor.getBufferedSpans()).toEqual([]);
  });

  it("exports late-arriving spans of an exported trace immediately", () => {
    const onExportSpans = vi.fn();
    const processor = new RingBufferSpanProcessor({ onExportSpans });

    const failing = makeSpan({ spanId: "sE", traceId: "tE", startSeconds: 0, error: true });
    processor.onEnd(failing);

    const child = makeSpan({ spanId: "sC", traceId: "tE", startSeconds: 1 });
    processor.onEnd(child);

    expect(onExportSpans).toHaveBeenCalledTimes(2);
    expect(onExportSpans).toHaveBeenLastCalledWith([child]);
    expect(processor.getBufferedSpans()).toEqual([]);
  });

  it("does not export healthy traces", () => {
    const onExportSpans = vi.fn();
    const processor = new RingBufferSpanProcessor({ onExportSpans });
    processor.onEnd(makeSpan({ spanId: "s1" }));
    processor.onEnd(makeSpan({ spanId: "s2" }));

    expect(onExportSpans).not.toHaveBeenCalled();
  });

  it("swallows callback exceptions", () => {
    const processor = new RingBufferSpanProcessor({
      onExportSpans: () => {
        throw new Error("boom");
      },
    });

    expect(() => processor.onEnd(makeSpan({ traceId: "tE", error: true }))).not.toThrow();
  });

  it("re-buffers spans of a trace whose export record was evicted", () => {
    const onExportSpans = vi.fn();
    const processor = new RingBufferSpanProcessor({ onExportSpans });

    for (let i = 0; i < 1001; i++) {
      processor.onEnd(makeSpan({ traceId: `t${i}`, spanId: `s${i}`, error: true }));
    }

    const shouldExport = makeSpan({ spanId: "sNew", traceId: "t1000" });
    processor.onEnd(shouldExport);
    expect(onExportSpans).toHaveBeenLastCalledWith([shouldExport]);

    const reBuffered = makeSpan({ spanId: "sOld", traceId: "t0" });
    processor.onEnd(reBuffered);
    expect(onExportSpans).toHaveBeenCalledTimes(1002);
    expect(processor.getBufferedSpans()).toContain(reBuffered);
  });

  it("clears buffered and exported state on shutdown", () => {
    const onExportSpans = vi.fn();
    const processor = new RingBufferSpanProcessor({ onExportSpans });

    const failing = makeSpan({ spanId: "sE", traceId: "tE", error: true });
    processor.onEnd(failing);
    expect(onExportSpans).toHaveBeenCalledTimes(1);

    return processor.shutdown().then(() => {
      const child = makeSpan({ spanId: "sC", traceId: "tE" });
      processor.onEnd(child);

      expect(onExportSpans).toHaveBeenCalledTimes(1);
      expect(processor.getBufferedSpans()).toEqual([child]);
    });
  });
});
