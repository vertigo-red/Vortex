import { spawn } from "node:child_process";

export interface IToolProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  keepAliveMs?: number;
  maxOutputBytes?: number;
}

/** Run a CLI with literal argv, bounded UTF-8 output and cleanup on failure or cancellation. */
export function executeToolProcess(
  executable: string,
  args: string[],
  options: IToolProcessOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(Object.assign(new Error("Tool operation was aborted"), { code: "ABORT_ERR" }));
      return;
    }
    const grouped = process.platform === "linux";
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      detached: grouped,
      shell: false,
      stdio: [options.keepAliveMs ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const output = { stdout: "", stderr: "" };
    const bytes = { stdout: 0, stderr: 0 };
    const limit = options.maxOutputBytes ?? 16 * 1024 * 1024;
    let lastOutput = Date.now();
    let failure: Error | undefined;
    let hardStop: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (grouped && child.pid !== undefined) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") failure ??= err as Error;
      }
    };
    const stop = (error: Error) => {
      failure ??= error;
      if (hardStop !== undefined) return;
      kill("SIGTERM");
      hardStop = setTimeout(() => kill("SIGKILL"), 1000);
    };
    const abort = () =>
      stop(Object.assign(new Error("Tool operation was aborted"), { code: "ABORT_ERR" }));
    const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    const timeout =
      timeoutMs > 0
        ? setTimeout(
            () => stop(Object.assign(new Error("Tool operation timed out"), { code: "ETIMEDOUT" })),
            timeoutMs,
          )
        : undefined;
    const intervalMs = Math.min(options.idleTimeoutMs ?? Infinity, options.keepAliveMs ?? Infinity);
    const heartbeat =
      Number.isFinite(intervalMs) && intervalMs > 0
        ? setInterval(() => {
            if (options.idleTimeoutMs && Date.now() - lastOutput >= options.idleTimeoutMs) {
              stop(
                Object.assign(new Error("Tool stopped producing output"), { code: "ETIMEDOUT" }),
              );
            } else if (options.keepAliveMs && child.stdin?.writable) {
              child.stdin.write(" ", () => {});
            }
          }, intervalMs)
        : undefined;
    child.stdin?.on("error", () => {});
    const capture = (stream: "stdout" | "stderr", chunk: string) => {
      lastOutput = Date.now();
      bytes[stream] += Buffer.byteLength(chunk);
      if (bytes[stream] > limit) {
        stop(
          Object.assign(new Error(`Tool ${stream} exceeded the output limit`), {
            code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          }),
        );
      } else {
        output[stream] += chunk;
      }
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => capture("stdout", chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => capture("stderr", chunk));
    child.on("error", (err) => {
      failure ??= err;
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    child.on("close", (code, signal) => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (heartbeat !== undefined) clearInterval(heartbeat);
      if (hardStop !== undefined) {
        clearTimeout(hardStop);
        kill("SIGKILL");
      }
      options.signal?.removeEventListener("abort", abort);
      if (failure || code !== 0) {
        reject(
          Object.assign(failure ?? new Error(`Tool exited with code ${code}`), {
            code: (failure as NodeJS.ErrnoException)?.code ?? code,
            signal,
            ...output,
          }),
        );
      } else resolve(output);
    });
    if (options.signal?.aborted) abort();
  });
}
