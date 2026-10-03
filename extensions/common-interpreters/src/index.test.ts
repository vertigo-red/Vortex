import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { types, util } from "@nexusmods/vortex-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as which from "which";

type Interpreter = (input: types.IRunParameters) => types.IRunParameters;

const PYTHON =
  process.platform === "linux"
    ? (which.sync("python3", { nothrow: true }) ?? undefined)
    : undefined;

const quote = (arg: string) => `'${arg.replace(/'/g, `'"'"'`)}'`;

async function run(call: types.IRunParameters): Promise<string> {
  let stdout = "";
  let stderr = "";
  const child = spawn(call.executable, call.args, {
    cwd: call.options.cwd,
    env: { ...process.env, PATH: process.env.PATH_ORIG || process.env.PATH, ...call.options.env },
    shell: call.options.shell,
  });
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const [code] = await once(child, "close");
  if (code !== 0) throw new Error(stderr);
  return stdout;
}

describe.skipIf(process.platform !== "linux")("Native tool interpreters", () => {
  let root: string;
  let bin: string;
  let script: string;
  let interpreters: Map<string, Interpreter>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "vortex-interpreters-"));
    bin = path.join(root, "bin");
    await mkdir(bin);
    script = path.join(root, 'Tool\'s "quoted" $HOME `name` — скрипт.py');
    vi.stubEnv("PATH", bin);
    vi.stubEnv("PATH_ORIG", undefined);
    vi.stubEnv("JAVA_HOME", undefined);
    interpreters = new Map();
    const { default: init } = await import("./index");
    init({
      registerInterpreter: (extension, apply) => {
        interpreters.set(extension, apply);
      },
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  const input = (options: types.IRunOptions = {}, args: string[] = []): types.IRunParameters => ({
    executable: script,
    args,
    options: { cwd: root, detach: false, expectSuccess: true, ...options },
  });

  const interpret = (extension: string, options: types.IRunOptions = {}, args: string[] = []) =>
    interpreters.get(extension)(input(options, args));

  const createRuntime = async (name: string, directory?: string) => {
    const runtimeDirectory = directory ?? bin;
    await mkdir(runtimeDirectory, { recursive: true });
    const executable = path.join(runtimeDirectory, name);
    await writeFile(
      executable,
      `#!${process.execPath}\nconsole.log(JSON.stringify({
        args: process.argv.slice(2), cwd: process.cwd(), marker: process.env.VORTEX_TOOL_TEST
      }));`,
      { mode: 0o755 },
    );
    return executable;
  };

  it.skipIf(PYTHON === undefined).each([false, true])(
    "runs a real Python 3 script with spaces, quotes and Unicode (shell: %s)",
    async (shell) => {
      await symlink(PYTHON, path.join(bin, "python3"));
      const output = path.join(root, "result.json");
      await writeFile(
        script,
        `import json, os, sys
with open(sys.argv[1], "w") as output:
    json.dump({
        "args": sys.argv[2:], "cwd": os.getcwd(), "marker": os.environ["VORTEX_TOOL_TEST"]
    }, output)
`,
      );
      const args = [
        "two words",
        '"quoted"',
        '{"mod":"Пример"}',
        "",
        "$HOME; `echo ignored`",
        "C:\\Games\\Tool",
      ];
      const onSpawned = vi.fn<NonNullable<types.IRunOptions["onSpawned"]>>();
      const call = interpret(
        ".py",
        { shell, env: { VORTEX_TOOL_TEST: "kept" }, onSpawned },
        shell ? [output, ...args].map(quote) : [output, ...args],
      );
      expect(call.options.onSpawned).toBe(onSpawned);
      await run(call);
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
        args,
        cwd: root,
        marker: "kept",
      });
    },
  );

  it("prefers Python 3 when both Python names are installed", async () => {
    const python3 = await createRuntime("python3");
    await createRuntime("python");
    expect(interpret(".py").executable).toBe(python3);
  });

  it("uses the python alias when python3 is unavailable", async () => {
    const python = await createRuntime("python");
    expect(interpret(".py").executable).toBe(python);
  });

  it("finds runtimes installed after the extension was initialized", async () => {
    expect(() => interpret(".py")).toThrow(util.MissingInterpreter);
    const python3 = await createRuntime("python3");
    expect(interpret(".py").executable).toBe(python3);
  });

  it("resolves the current tool PATH on each launch instead of keeping a cached runtime", async () => {
    await createRuntime("python3");
    const environment = path.join(root, "venv", "bin");
    const python3 = await createRuntime("python3", environment);
    expect(interpret(".py").executable).toBe(path.join(bin, "python3"));
    const call = interpret(".py", { env: { PATH: environment, VORTEX_TOOL_TEST: "venv" } }, [
      "literal value",
    ]);
    expect(call.executable).toBe(python3);
    expect(JSON.parse(await run(call))).toEqual({
      args: [script, "literal value"],
      cwd: root,
      marker: "venv",
    });
  });

  it("uses PATH_ORIG, with the tool PATH taking precedence", async () => {
    await createRuntime("python3");
    const original = path.join(root, "original");
    const python = await createRuntime("python3", original);
    vi.stubEnv("PATH_ORIG", original);
    expect(interpret(".py").executable).toBe(python);
    expect(interpret(".py", { env: { PATH: bin } }).executable).toBe(path.join(bin, "python3"));
  });

  it.each(["bin", ""])(
    "resolves relative and empty PATH entries in the tool working directory (%j)",
    async (toolPath) => {
      const directory = toolPath === "" ? root : bin;
      const python = await createRuntime("python3", directory);
      const call = interpret(".py", { env: { PATH: toolPath } });
      expect(call.executable).toBe(python);
      expect(JSON.parse(await run(call)).cwd).toBe(root);
    },
  );

  it("skips a non-executable Python 3 file and uses the executable alias", async () => {
    const python3 = await createRuntime("python3");
    await chmod(python3, 0o644);
    const python = await createRuntime("python");
    expect(interpret(".py").executable).toBe(python);
  });

  it.each([
    [".py", "python3"],
    [".jar", "java"],
  ])(
    "keeps the script directory as the default working directory for %s",
    async (extension, runtime) => {
      await createRuntime(runtime);
      const call = interpret(extension, { cwd: undefined, env: { PATH: "bin" } });
      expect(call.options.cwd).toBe(root);
      expect(JSON.parse(await run(call)).cwd).toBe(root);
    },
  );

  it("finds Java on PATH without JAVA_HOME and runs the jar with literal arguments", async () => {
    const java = await createRuntime("java");
    const args = ['{"name":"mod"}', "two words", ""];
    const call = interpret(".jar", { env: { VORTEX_TOOL_TEST: "java" } }, args);
    expect(call.executable).toBe(java);
    expect(JSON.parse(await run(call))).toEqual({
      args: ["-jar", script, ...args],
      cwd: root,
      marker: "java",
    });
  });

  it("prefers an executable JAVA_HOME runtime over PATH", async () => {
    await createRuntime("java");
    const home = path.join(root, "jdk");
    const java = await createRuntime("java", path.join(home, "bin"));
    vi.stubEnv("JAVA_HOME", home);
    expect(interpret(".jar").executable).toBe(java);
  });

  it("uses a tool's JAVA_HOME in its working directory before the inherited home", async () => {
    const inherited = path.join(root, "inherited");
    await createRuntime("java", path.join(inherited, "bin"));
    vi.stubEnv("JAVA_HOME", inherited);
    const java = await createRuntime("java", path.join(root, "tool-jdk", "bin"));
    expect(interpret(".jar", { env: { JAVA_HOME: "tool-jdk" } }).executable).toBe(java);
  });

  it("lets a tool clear the inherited JAVA_HOME and use Java from PATH", async () => {
    const java = await createRuntime("java");
    const home = path.join(root, "inherited-jdk");
    await createRuntime("java", path.join(home, "bin"));
    vi.stubEnv("JAVA_HOME", home);
    expect(interpret(".jar", { env: { JAVA_HOME: "" } }).executable).toBe(java);
  });

  it.each(["missing", "non-executable", "directory"])(
    "falls back to PATH when JAVA_HOME/bin/java is %s",
    async (kind) => {
      const java = await createRuntime("java");
      const home = path.join(root, "invalid-jdk");
      if (kind === "non-executable") {
        await chmod(await createRuntime("java", path.join(home, "bin")), 0o644);
      } else if (kind === "directory") {
        await mkdir(path.join(home, "bin", "java"), { recursive: true });
      }
      vi.stubEnv("JAVA_HOME", home);
      expect(interpret(".jar").executable).toBe(java);
    },
  );

  it("quotes the jar path in shell mode while retaining user shell expansion", async () => {
    await createRuntime("java");
    const call = interpret(".jar", { shell: true, env: { VORTEX_TOOL_TEST: "expanded value" } }, [
      '"$VORTEX_TOOL_TEST"',
    ]);
    expect(JSON.parse(await run(call))).toEqual({
      args: ["-jar", script, "expanded value"],
      cwd: root,
      marker: "expanded value",
    });
  });

  it.each([".py", ".jar"])(
    "reports a missing %s runtime without throwing a generic launch error",
    (extension) => {
      expect(() => interpret(extension)).toThrow(util.MissingInterpreter);
    },
  );

  it("reports Windows Script Host as unsupported for native VBScript launches", () => {
    expect(() => interpret(".vbs")).toThrow(util.MissingInterpreter);
    expect(() => interpret(".vbs")).toThrow(/Windows Script Host/);
  });
});
