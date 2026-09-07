import type { Chunk } from "@vortex/shared/download";
import { describe, expect, it, vi } from "vitest";

import { normalize, urlResolver } from "./resolver";

const CHUNK: Chunk = { index: 0, range: { start: 0, end: 1023 } };

describe("urlResolver", () => {
  it("resolves a URL into a ResolvedEndpoint", async () => {
    const url = new URL("https://example.com/files/archive.zip");

    await expect(urlResolver(url)).resolves.toEqual({ url });
  });
});

describe("normalize", () => {
  it("uses a plain endpoint for both probing and chunks", async () => {
    const endpoint = { url: new URL("https://example.com/files/archive.zip") };
    const normalized = normalize(endpoint);

    expect(normalized.probeEndpoint).toBe(endpoint);
    await expect(normalized.chunkEndpoint(CHUNK)).resolves.toBe(endpoint);
  });

  it("keeps an explicitly provided chunkEndpoint", async () => {
    const probe = { url: new URL("https://example.com/files/archive.zip") };
    const chunkEndpoint = vi
      .fn()
      .mockResolvedValue({ url: new URL("https://cdn.example.com/part") });
    const normalized = normalize({ probeEndpoint: probe, chunkEndpoint });

    expect(normalized.probeEndpoint).toBe(probe);
    await normalized.chunkEndpoint(CHUNK);
    expect(chunkEndpoint).toHaveBeenCalledWith(CHUNK);
  });

  it("reuses the probe endpoint when no chunk endpoint is given", async () => {
    const probe = { url: new URL("https://example.com/files/archive.zip") };
    const normalized = normalize({ probeEndpoint: probe });

    expect(normalized.probeEndpoint).toBe(probe);
    await expect(normalized.chunkEndpoint(CHUNK)).resolves.toBe(probe);
  });
});
