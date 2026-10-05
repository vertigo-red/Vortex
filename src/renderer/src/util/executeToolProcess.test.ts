import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { executeToolProcess } from "./executeToolProcess";

const run = (source: string, options = {}) =>
  executeToolProcess(process.execPath, ["-e", source], options);

describe("CLI process lifecycle", () => {
  it("keeps literal argv, cwd and environment without shell expansion", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "vortex-cli-"));
    const args = ["a b", "", "日本語", "%literal%", "x & ; $()", 'embedded"quote', "tail\\"];
    try {
      const result = await executeToolProcess(
        process.execPath,
        [
          "-e",
          "console.log(JSON.stringify({args: process.argv.slice(1), cwd: process.cwd(), env: process.env.CLI_VALUE}))",
          "--",
          ...args,
        ],
        { cwd: directory, env: { ...process.env, CLI_VALUE: "chosen" } },
      );
      expect(JSON.parse(result.stdout)).toEqual({ args, cwd: directory, env: "chosen" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("decodes UTF-8 split across stream chunks", async () => {
    const result = await run(
      "const b=Buffer.from('日本語'); process.stdout.write(b.subarray(0,2)); setTimeout(()=>process.stdout.end(b.subarray(2)),20)",
    );
    expect(result.stdout).toBe("日本語");
  });
  it("propagates spawn failure", async () => {
    await expect(
      executeToolProcess(path.join(tmpdir(), "vortex-missing-command"), []),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects nonzero exit with complete stdout and stderr", async () => {
    await expect(
      run("console.log('output'); console.error('diagnostic'); process.exitCode=8"),
    ).rejects.toMatchObject({ code: 8, stdout: "output\n", stderr: "diagnostic\n" });
  });
  it("enforces output bounds", async () => {
    await expect(
      run("process.stdout.write('x'.repeat(4096)); setInterval(()=>{},1000)", {
        maxOutputBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
  });
  it("stops an idle process and clears keepalive timers", async () => {
    await expect(
      run("process.stdin.resume(); setInterval(()=>{},1000)", {
        idleTimeoutMs: 80,
        keepAliveMs: 20,
      }),
    ).rejects.toMatchObject({ code: "ETIMEDOUT" });
  });
  it("sends keepalive input while the process continues producing output", async () => {
    const result = await run(
      "process.stdin.on('data',()=>{ console.log('received'); process.exit(0); })",
      { idleTimeoutMs: 1000, keepAliveMs: 40 },
    );
    expect(result.stdout).toBe("received\n");
  });
  it("escalates a timeout when the child ignores SIGTERM", async () => {
    await expect(
      run("process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)", {
        timeoutMs: 200,
      }),
    ).rejects.toMatchObject({ code: "ETIMEDOUT", stdout: "ready\n" });
  });
  it("handles pre-start and running cancellation", async () => {
    const before = new AbortController();
    before.abort();
    await expect(
      run("throw Error('must not start')", { signal: before.signal }),
    ).rejects.toMatchObject({ code: "ABORT_ERR" });
    const active = new AbortController();
    const operation = run("setInterval(()=>{},1000)", { signal: active.signal });
    active.abort();
    await expect(operation).rejects.toMatchObject({ code: "ABORT_ERR" });
  });
});
