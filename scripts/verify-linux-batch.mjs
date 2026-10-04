import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), "vortex-wine-batch-"));
const tools = path.join(root, "Tools '日本語' %VORTEX_EXPAND_ME%");
const working = path.join(root, "Working directory");
const script = path.join(tools, "Capture Args.cmd");
const capture = path.join(tools, "capture.js");
const wine = process.env.VORTEX_TEST_WINE ?? "/usr/lib/wine/wine64";
const server = process.env.VORTEX_TEST_WINESERVER ?? "/usr/lib/wine/wineserver64";
const environment = {
  ...process.env,
  WINEPREFIX: path.join(root, "pfx"),
  WINEARCH: "win64",
  WINEDEBUG: "-all",
  VORTEX_EXPAND_ME: "expanded",
  VORTEX_CAPTURE_JS: capture,
};

async function run(executable, args, env = environment) {
  try {
    const output = await execute(executable, args, {
      cwd: working,
      env,
      timeout: 45000,
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, ...output };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

function quoteArgument(value) {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

async function readCapture() {
  for (const directory of [working, tools]) {
    try {
      const text = (await readFile(path.join(directory, "capture.txt")))
        .toString("utf16le")
        .replace(/^\uFEFF/, "");
      const lines = text.split(/\r?\n/);
      return { directory, args: lines.slice(1, Number(lines[0]) + 1) };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return undefined;
}

try {
  await Promise.all([tools, working].map((directory) => mkdir(directory, { recursive: true })));
  await writeFile(
    capture,
    [
      'var fs = new ActiveXObject("Scripting.FileSystemObject");',
      'var out = fs.CreateTextFile("capture.txt", true, true);',
      "out.WriteLine(WScript.Arguments.length);",
      "for (var i = 0; i < WScript.Arguments.length; i++) out.WriteLine(WScript.Arguments.Item(i));",
      "out.Close();",
    ].join("\r\n"),
  );
  await writeFile(
    script,
    '@echo off\r\ncscript.exe //nologo "%VORTEX_CAPTURE_JS%" %*\r\nexit /b 37\r\n',
  );
  const version = await run(wine, ["cmd.exe", "/c", "ver"]);
  assert.equal(version.code, 0, version.stderr);
  console.log(`Real Wine runtime ready: ${version.stdout.trim()}`);

  const inputs = [
    ["hello world", ""],
    ['{"key":"value with space"}', "tail\\"],
    ["percent%VORTEX_EXPAND_ME%", "bang!literal", "Unicode 日本語"],
    ["amp&echo injected>sentinel.txt", "literal|pipe", "(parentheses)"],
    ['{"key":"a & echo injected>sentinel.txt"}', 'a"b'],
  ];
  for (const [index, args] of inputs.entries()) {
    const command = `${quoteArgument(script)} ${args.map(quoteArgument).join(" ")}`;
    const cases = {
      direct: { args: ["cmd.exe", "/c", script, ...args] },
      call: { args: ["cmd.exe", "/d", "/v:off", "/c", "call", script, ...args] },
      start: { args: ["start.exe", "/b", "/wait", "/unix", script, ...args] },
      environment: {
        args: ["cmd.exe", "/d", "/v:off", "/c", "%VORTEX_PROTON_BATCH_COMMAND%"],
        env: { ...environment, VORTEX_PROTON_BATCH_COMMAND: command },
      },
    };
    for (const [name, plan] of Object.entries(cases)) {
      await Promise.all(
        [working, tools].map((directory) =>
          rm(path.join(directory, "capture.txt"), { force: true }),
        ),
      );
      const output = await run(wine, plan.args, plan.env);
      console.log(
        JSON.stringify({
          case: name,
          index,
          input: args,
          code: output.code,
          capture: await readCapture(),
          stdout: output.stdout.slice(-700),
          stderr: output.stderr.slice(-700),
        }),
      );
    }
  }
} finally {
  await run(server, ["-k"]).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
