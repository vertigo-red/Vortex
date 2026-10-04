import { spawn } from "node:child_process";

interface IDivineProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
}

const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Capture a CLI without a shell and stop its own Linux process group on cancellation. */
export function executeDivine(
  executable: string,
  args: string[],
  options: IDivineProcessOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("Divine operation was aborted"));
      return;
    }
    const grouped = process.platform === "linux";
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      detached: grouped,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = { stdout: "", stderr: "" };
    const bytes = { stdout: 0, stderr: 0 };
    let failure: Error | undefined;
    let stopped = false;
    let hardStop: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (grouped && child.pid !== undefined) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
          failure ??= err as Error;
        }
      }
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      kill("SIGTERM");
      // A Proton launcher or its children may ignore SIGTERM; never leave them writing PAKs.
      hardStop = setTimeout(() => kill("SIGKILL"), 1000);
    };
    const timeout = options.timeoutMs > 0 ? setTimeout(stop, options.timeoutMs) : undefined;
    const capture = (stream: "stdout" | "stderr", chunk: string) => {
      bytes[stream] += Buffer.byteLength(chunk);
      if (bytes[stream] > MAX_OUTPUT_BYTES) {
        failure ??= Object.assign(new Error(`Divine ${stream} exceeded the output limit`), {
          code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        });
        stop();
      } else {
        output[stream] += chunk;
      }
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => capture("stdout", chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => capture("stderr", chunk));
    child.on("error", (err) => {
      failure ??= err;
    });
    options.signal?.addEventListener("abort", stop, { once: true });
    child.on("close", (code, signal) => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (hardStop !== undefined) clearTimeout(hardStop);
      options.signal?.removeEventListener("abort", stop);
      if (stopped) kill("SIGKILL");
      if (failure || stopped || code !== 0) {
        reject(
          Object.assign(failure ?? new Error(`Divine exited with code ${code}`), {
            code: (failure as NodeJS.ErrnoException)?.code ?? code,
            signal: stopped ? "SIGTERM" : signal,
            ...output,
          }),
        );
      } else {
        resolve(output);
      }
    });
    // Cover cancellation between the initial check and listener registration.
    if (options.signal?.aborted) stop();
  });
}
