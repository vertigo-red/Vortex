import { describe, expect, it } from "vitest";

import { applyNxmProtocolArgument } from "./protocolArguments";

describe("applyNxmProtocolArgument", () => {
  it("promotes a bare nxm URL to download", () => {
    const url = "nxm://dragonage/mods/202/files/6043?key=test";

    expect(applyNxmProtocolArgument({}, ["/opt/Vortex/vortex", url])).toEqual({
      download: url,
    });
  });

  it("matches the nxm scheme case-insensitively", () => {
    const url = "NXM://dragonage/mods/202/files/6043";

    expect(applyNxmProtocolArgument({}, [url])).toEqual({ download: url });
  });

  it("preserves explicit transfer options", () => {
    const url = "nxm://dragonage/mods/202/files/6043";

    expect(
      applyNxmProtocolArgument({ download: "https://example.invalid/mod.zip" }, [url]),
    ).toEqual({ download: "https://example.invalid/mod.zip" });
    expect(
      applyNxmProtocolArgument({ install: "https://example.invalid/mod.zip" }, [url]),
    ).toEqual({ install: "https://example.invalid/mod.zip" });
    expect(applyNxmProtocolArgument({ installArchive: "/tmp/mod.7z" }, [url])).toEqual({
      installArchive: "/tmp/mod.7z",
    });
  });

  it("ignores unrelated positional arguments", () => {
    expect(
      applyNxmProtocolArgument({}, ["/opt/Vortex/vortex", "https://example.invalid/"]),
    ).toEqual({});
  });
});
