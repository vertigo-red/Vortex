import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildDivineArgs,
  DivineAborted,
  DivineExecMissing,
  DivineLaunchFailed,
  DivineMissingDotNet,
  DivinePakInvalid,
  DivineTimedOut,
  DivineUnsupportedToolPath,
  resolveDivineExecutable,
  runDivineCore,
} from "./divineCore";
import { executeDivine } from "./divineProcess";

let root: string;
let executable: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vortex-divine-process-"));
  executable = path.join(root, "Divine.exe");
  await writeFile(executable, "test CLI target");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function command(script: string, args: string[] = []) {
  return { executable: process.execPath, args: ["-e", script, "--", ...args], env: {} };
}

describe("Divine shell-free execution", () => {
  it.skipIf(process.platform !== "linux")(
    "runs Proton from Divine's tools directory instead of an unmapped host directory",
    async () => {
      const result = await runDivineCore(
        executable,
        "list-package",
        { source: "unused" },
        { command: command("process.stdout.write(process.cwd())") },
      );
      expect(result.stdout).toBe(root);
    },
  );

  it("keeps paths, JSON, quotes, empty values and shell characters as literal argv", async () => {
    const options = {
      source: path.join(root, "日本語 '$()' `quoted` &;.pak"),
      destination: path.join(root, "extract & destination"),
      expression: '*.lsx; $(literal) "quoted"',
    };
    const args = buildDivineArgs("extract-package", options);
    expect(args).toContain(options.source);
    expect(args).toContain(options.destination);
    const output = await runDivineCore(executable, "extract-package", options, {
      command: command(
        "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
        args.concat(""),
      ),
    });
    expect(JSON.parse(output.stdout)).toEqual(args.concat(""));
  });

  it("captures nonzero exit codes and both output streams", async () => {
    await expect(
      runDivineCore(
        executable,
        "list-package",
        { source: "unused" },
        {
          command: command(
            "process.stdout.write('output');process.stderr.write('diagnostic');process.exit(37)",
          ),
        },
      ),
    ).rejects.toThrow(/exitCode=37; stderr=diagnostic; stdout=output/);
  });

  it("recognizes a missing Windows .NET runtime reported on stderr", async () => {
    await expect(
      runDivineCore(
        executable,
        "list-package",
        { source: "unused" },
        {
          command: command(
            "process.stderr.write('You must install or update .NET to run this application.');process.exit(150)",
          ),
        },
      ),
    ).rejects.toBeInstanceOf(DivineMissingDotNet);
  });

  it("classifies an unsupported Windows runtime tool path as a configuration failure", async () => {
    await expect(
      runDivineCore(
        executable,
        "list-package",
        { source: "unused" },
        {
          command: command(
            "process.stderr.write('VORTEX_BG3_UNSUPPORTED_TOOL_PATH');process.exit(87)",
          ),
        },
      ),
    ).rejects.toBeInstanceOf(DivineUnsupportedToolPath);
  });

  it.each([
    "Failed to create CoreCLR, HRESULT: 0x80070057",
    "Vortex BG3 launcher: Find output hook failed (Windows error 2)",
  ])("classifies runtime and launcher startup failures before PAK parsing: %s", async (diagnostic) => {
    await expect(
      runDivineCore(
        executable,
        "list-package",
        { source: "unused" },
        {
          command: command(
            "process.stderr.write(process.argv[1]);process.exit(137)",
            [diagnostic],
          ),
        },
      ),
    ).rejects.toBeInstanceOf(DivineLaunchFailed);
  });

  it("rejects bracketed PAK failures even on exit zero", async () => {
    await expect(
      runDivineCore(
        executable,
        "list-package",
        { source: "unused" },
        {
          command: command("process.stdout.write('[FATAL] Not a package')"),
        },
      ),
    ).rejects.toBeInstanceOf(DivinePakInvalid);
  });

  it.skipIf(process.platform !== "linux")(
    "accepts Proton setup and Wine synchronization messages on successful launches",
    async () => {
      const result = await runDivineCore(
        executable,
        "list-package",
        { source: "unused" },
        {
          command: command(
            "process.stderr.write('Proton: Prefix is ready\\nfsync: up and running.\\n');" +
              "process.stdout.write('meta.lsx\\n')",
          ),
        },
      );
      expect(result.stdout).toBe("meta.lsx\n");
    },
  );

  it("surfaces unrecognized stderr even when the CLI exits zero", async () => {
    await expect(
      runDivineCore(
        executable,
        "list-package",
        { source: "unused" },
        {
          command: command("process.stderr.write('Unexpected diagnostic')"),
        },
      ),
    ).rejects.toThrow("Unexpected diagnostic");
  });

  it("cancels before filesystem checks and process creation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runDivineCore(
        path.join(root, "missing.exe"),
        "list-package",
        { source: "unused" },
        { signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(DivineAborted);
  });

  it("terminates a running CLI at its deadline", async () => {
    await expect(
      runDivineCore(
        executable,
        "list-package",
        { source: "unused" },
        {
          command: command("setInterval(() => {}, 10000)"),
          timeoutMs: 200,
        },
      ),
    ).rejects.toBeInstanceOf(DivineTimedOut);
  });

  it.skipIf(process.platform !== "linux")(
    "removes inherited Linux .NET roots while accepting explicit command overrides",
    async () => {
      vi.stubEnv("DOTNET_ROOT", "/host/linux/dotnet");
      vi.stubEnv("DOTNET_ROOT_X64", "/host/linux/x64");
      const launch = command(
        "process.stdout.write(JSON.stringify({root:process.env.DOTNET_ROOT,x64:process.env.DOTNET_ROOT_X64}))",
      );
      launch.env = { DOTNET_ROOT_X64: "C:\\dotnet" };
      const result = await runDivineCore(
        executable,
        "list-package",
        { source: "unused" },
        { command: launch },
      );
      expect(JSON.parse(result.stdout)).toEqual({ x64: "C:\\dotnet" });
    },
  );

  it("bounds captured output", async () => {
    await expect(
      executeDivine(process.execPath, ["-e", "process.stdout.write('x'.repeat(2*1024*1024))"], {
        timeoutMs: 5000,
      }),
    ).rejects.toHaveProperty("code", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
  });

  it.skipIf(process.platform !== "linux")(
    "kills a descendant that ignores SIGTERM when cancellation occurs",
    async () => {
      const ready = path.join(root, "ready");
      const heartbeat = path.join(root, "heartbeat");
      const childScript = `const fs=require('node:fs');process.on('SIGTERM',()=>{});
      fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));
      setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),20);`;
      const parentScript = `const cp=require('node:child_process');process.on('SIGTERM',()=>{});
      cp.spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'inherit'});
      setInterval(()=>{},10000);`;
      const controller = new AbortController();
      const operation = executeDivine(process.execPath, ["-e", parentScript], {
        signal: controller.signal,
        timeoutMs: 5000,
      });
      let pid: number | undefined;
      for (let attempt = 0; attempt < 200 && pid === undefined; attempt++) {
        try {
          pid = Number(await readFile(ready, "utf8"));
        } catch {
          await delay(10);
        }
      }
      controller.abort();
      await expect(operation).rejects.toHaveProperty("signal", "SIGTERM");
      expect(pid).toBeGreaterThan(0);
      const content = await readFile(heartbeat, "utf8").catch(() => "");
      await delay(150);
      expect(await readFile(heartbeat, "utf8").catch(() => "")).toBe(content);
    },
  );
});

describe("Divine executable identity", () => {
  it("finds the release's capitalized filename on a case-sensitive filesystem", async () => {
    expect(await resolveDivineExecutable(root)).toBe(executable);
  });
  it.skipIf(process.platform === "win32")(
    "rejects competing case variants rather than choosing arbitrarily",
    async () => {
      await writeFile(path.join(root, "divine.exe"), "other version");
      await expect(resolveDivineExecutable(root)).rejects.toBeInstanceOf(DivineExecMissing);
    },
  );
  it("rejects missing tools and a directory posing as the executable", async () => {
    await expect(resolveDivineExecutable(path.join(root, "missing"))).rejects.toBeInstanceOf(
      DivineExecMissing,
    );
    await rm(executable);
    await mkdir(executable);
    await expect(
      runDivineCore(executable, "list-package", { source: "unused" }),
    ).rejects.toBeInstanceOf(DivineExecMissing);
  });
});
