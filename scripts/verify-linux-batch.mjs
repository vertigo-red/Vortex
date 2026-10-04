import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), "vortex-wine-batch-"));
const tools = path.join(root, "Tools '日本語'");
const working = path.join(root, "Working directory");
const script = path.join(tools, "Capture Args.cmd");
const capture = path.join(tools, "capture.exe");
const captureFile = path.join(root, "capture.txt");
const wine = process.env.VORTEX_TEST_WINE ?? "/usr/lib/wine/wine64";
const server = process.env.VORTEX_TEST_WINESERVER ?? "/usr/lib/wine/wineserver64";
const environment = {
  ...process.env,
  WINEPREFIX: path.join(root, "pfx"),
  WINEARCH: "win64",
  WINEDEBUG: "-all",
  VORTEX_EXPAND_ME: "expanded",
  VORTEX_CAPTURE_EXE: capture,
  VORTEX_CAPTURE_FILE: `Z:${captureFile.replaceAll("/", "\\")}`,
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
  try {
    const text = (await readFile(captureFile)).toString("utf16le").replace(/^\uFEFF/, "");
    const lines = text.split(/\r?\n/);
    return { directory: lines[0], args: lines.slice(2, Number(lines[1]) + 2) };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return undefined;
}

const captureSource = `
#include <windows.h>
#include <wchar.h>
static HANDLE output;
static void line(const wchar_t *text) {
  DWORD written;
  WriteFile(output, text, (DWORD)(wcslen(text) * sizeof(wchar_t)), &written, NULL);
  WriteFile(output, L"\\r\\n", 4, &written, NULL);
}
int wmain(int count, wchar_t **args) {
  wchar_t filename[32768], directory[32768], number[32];
  DWORD written;
  if (!GetEnvironmentVariableW(L"VORTEX_CAPTURE_FILE", filename, 32768)) return 91;
  output = CreateFileW(filename, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
                       FILE_ATTRIBUTE_NORMAL, NULL);
  if (output == INVALID_HANDLE_VALUE) return 92;
  WriteFile(output, L"\\ufeff", 2, &written, NULL);
  GetCurrentDirectoryW(32768, directory);
  line(directory);
  _snwprintf(number, 32, L"%d", count - 1);
  line(number);
  for (int index = 1; index < count; index++) line(args[index]);
  CloseHandle(output);
  return 0;
}
`;

try {
  await Promise.all([tools, working].map((directory) => mkdir(directory, { recursive: true })));
  const source = path.join(root, "capture.c");
  await writeFile(source, captureSource);
  const compiler = await run("x86_64-w64-mingw32-gcc", [
    "-municode",
    "-mconsole",
    "-static",
    "-O2",
    "-s",
    source,
    "-o",
    capture,
  ]);
  assert.equal(compiler.code, 0, compiler.stderr);
  await writeFile(script, '@echo off\r\n"%VORTEX_CAPTURE_EXE%" %*\r\nexit /b 37\r\n');
  const version = await run(wine, ["cmd.exe", "/c", "ver"]);
  assert.equal(version.code, 0, version.stderr);
  console.log(`Real Wine runtime ready: ${version.stdout.trim()}`);
  const baseline = ["receiver 日本語", "", '{"key":"value with space"}', "tail\\"];
  const baselineOutput = await run(wine, [capture, ...baseline]);
  assert.equal(baselineOutput.code, 0, baselineOutput.stderr);
  const baselineCapture = await readCapture();
  assert.deepEqual(baselineCapture?.args, baseline);
  console.log(`Native Windows receiver ready: ${JSON.stringify(baselineCapture)}`);

  const inputs = [
    ["hello world", ""],
    ['{"key":"value with space"}', "tail\\"],
    ["percent%VORTEX_EXPAND_ME%", "bang!literal", "Unicode 日本語"],
    ["amp&echo injected>sentinel.txt", "literal|pipe", "(parentheses)"],
    ['{"key":"a & echo injected>sentinel.txt"}', 'a"b'],
  ];
  for (const [index, args] of inputs.entries()) {
    const command = `@ ${quoteArgument(script)} ${args.map(quoteArgument).join(" ")}`;
    const escaped = `@ ${quoteArgument(script)} ${args
      .map((arg) => quoteArgument(arg).replace(/[()%!^"<>&|]/g, "^$&"))
      .join(" ")}`;
    const cases = {
      direct: { args: ["cmd.exe", "/c", script, ...args] },
      quiet: { args: ["cmd.exe", "/d", "/v:off", "/c", "@", script, ...args] },
      start: { args: ["start.exe", "/b", "/wait", "/unix", script, ...args] },
      environment: {
        args: ["cmd.exe", "/d", "/v:off", "/c", "%VORTEX_PROTON_BATCH_COMMAND%"],
        env: { ...environment, VORTEX_PROTON_BATCH_COMMAND: command },
      },
      escaped: {
        args: ["cmd.exe", "/d", "/v:off", "/c", "%VORTEX_PROTON_BATCH_COMMAND%"],
        env: { ...environment, VORTEX_PROTON_BATCH_COMMAND: escaped },
      },
      delayed: {
        args: ["cmd.exe", "/d", "/v:on", "/c", "!VORTEX_PROTON_BATCH_COMMAND!"],
        env: { ...environment, VORTEX_PROTON_BATCH_COMMAND: command },
      },
    };
    for (const [name, plan] of Object.entries(cases)) {
      await rm(captureFile, { force: true });
      await Promise.all(
        [working, tools].map((directory) =>
          rm(path.join(directory, "sentinel.txt"), { force: true }),
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
          injected: await Promise.all(
            [working, tools].map(async (directory) =>
              readFile(path.join(directory, "sentinel.txt"), "utf8").catch(() => undefined),
            ),
          ),
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
