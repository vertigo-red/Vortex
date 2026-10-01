import { homedir, tmpdir } from "node:os";
import { join } from "node:path/posix";

import { XDG, NativePathResolver } from "@vortex/shared/filesystem";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LinuxPathProvider } from "./paths.linux";

const provider = new LinuxPathProvider();
const resolver = new NativePathResolver();
const resolveBase = async (base: Parameters<LinuxPathProvider["fromBase"]>[0]) =>
  resolver.resolve(await provider.fromBase(base));
afterEach(() => vi.unstubAllEnvs());
describe("Linux XDG paths", () => {
  it.each([
    [XDG.data, ".local/share"],
    [XDG.cache, ".cache"],
    [XDG.config, ".config"],
    [XDG.state, ".local/state"],
  ] as const)("uses %s only when it is absolute", async (base, fallback) => {
    vi.stubEnv(base, "/custom/location");
    expect(await resolveBase(base)).toBe("/custom/location");
    vi.stubEnv(base, "relative");
    expect(await resolveBase(base)).toBe(join(homedir(), fallback));
  });
  it("ignores a relative XDG_RUNTIME_DIR", async () => {
    vi.stubEnv("XDG_RUNTIME_DIR", "relative");
    expect(await resolveBase(XDG.runtime)).toBe(tmpdir());
  });
});
