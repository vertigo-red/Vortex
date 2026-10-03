import * as path from "node:path";

import type { types } from "@nexusmods/vortex-api";
import { describe, expect, it, vi } from "vitest";

import init from "./index";

vi.mock("process", () => ({
  platform: "win32",
  env: { JAVA_HOME: "C:\\Java", windir: "C:\\Windows" },
}));
vi.mock("which", () => ({ sync: vi.fn<() => string>(() => "python-runtime") }));

describe("Windows tool interpreters", () => {
  const interpreters = new Map<string, (input: types.IRunParameters) => types.IRunParameters>();
  init({
    registerInterpreter: (extension, apply) => {
      interpreters.set(extension, apply);
    },
  });
  const input: types.IRunParameters = {
    executable: "C:\\Tools\\tool script",
    args: ['"two words"'],
    options: { shell: true, env: { VORTEX_TOOL_TEST: "kept" } },
  };

  it("keeps Java and Python paths and Windows argument quoting", () => {
    expect(interpreters.get(".jar")(input)).toEqual({
      ...input,
      executable: path.join("C:\\Java", "bin", "java.exe"),
      args: ["-jar", input.executable, ...input.args],
    });
    expect(interpreters.get(".py")(input)).toEqual({
      ...input,
      executable: "python-runtime",
      args: [input.executable, ...input.args],
    });
  });

  it("keeps Windows Script Host and batch interpreter registrations", () => {
    expect(interpreters.get(".vbs")(input)).toEqual({
      ...input,
      executable: path.join("C:\\Windows", "system32", "cscript.exe"),
      args: [input.executable, ...input.args],
    });
    expect(interpreters.get(".cmd")(input).args).toEqual([
      "/K",
      `"${input.executable}"`,
      ...input.args,
    ]);
    expect(
      interpreters.get(".bat")({ ...input, options: { ...input.options, shell: false } }).options
        .shell,
    ).toBe(true);
  });
});
