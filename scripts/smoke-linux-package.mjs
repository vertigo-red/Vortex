import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

const options = process.argv.slice(3);
if (
  process.platform !== "linux" ||
  process.argv[2] === undefined ||
  options.some((option) => option !== "--no-sandbox")
) {
  throw new Error(
    "Usage on Linux: node scripts/smoke-linux-package.mjs <packaged-vortex> [--no-sandbox]",
  );
}
const disableSandbox = options.includes("--no-sandbox");

const temporary = await mkdtemp(path.join(tmpdir(), "vortex-linux-startup-"));
const screenshot = path.resolve(
  "dist",
  disableSandbox ? "linux-startup.png" : "linux-installed-startup.png",
);
for (const directory of ["config", "data", "cache", "state"]) {
  await mkdir(path.join(temporary, directory), { recursive: true });
}
const env = {
  ...process.env,
  NODE_ENV: "production",
  LANG: "en_US.UTF-8",
  XDG_CONFIG_HOME: path.join(temporary, "config"),
  XDG_DATA_HOME: path.join(temporary, "data"),
  XDG_CACHE_HOME: path.join(temporary, "cache"),
  XDG_STATE_HOME: path.join(temporary, "state"),
  VORTEX_ENABLE_LOGGING: "1",
};
delete env.ELECTRON_RUN_AS_NODE;
const application = spawn(
  path.resolve(process.argv[2]),
  [...(disableSandbox ? ["--no-sandbox"] : []), "--disable-gpu", "--remote-debugging-port=0"],
  { env, stdio: ["ignore", "pipe", "pipe"] },
);
let output = "";
let port;
let socket;
const pending = new Map();
const exceptions = [];
let requestId = 0;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const deadline = Date.now() + 90_000;
function record(chunk) {
  output = (output + chunk.toString()).slice(-32_000);
  const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output);
  if (match !== null) port = match[1];
}
application.stdout.on("data", record);
application.stderr.on("data", record);
function checkRunning() {
  if (application.exitCode !== null || application.signalCode !== null) {
    throw new Error("Packaged Vortex exited: " + (application.exitCode ?? application.signalCode));
  }
  if (Date.now() > deadline) throw new Error("Packaged Vortex startup timed out");
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("CDP request timed out: " + method));
    }, 10_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

try {
  let page;
  while (page === undefined) {
    checkRunning();
    if (port !== undefined) {
      try {
        const response = await fetch("http://127.0.0.1:" + port + "/json/list");
        const pages = await response.json();
        page = pages.find((entry) => entry.type === "page" && entry.url.includes("index.html"));
      } catch {
        // The debugger can announce its port before the main window exists.
      }
    }
    if (page === undefined) await delay(250);
  }
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Debugger connection timed out")), 10_000);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("Debugger connection failed"));
      },
      { once: true },
    );
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (request !== undefined) {
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    } else if (message.method === "Runtime.exceptionThrown") {
      exceptions.push(message.params.exceptionDetails);
    }
  });
  socket.addEventListener("close", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Packaged renderer closed its debugger connection"));
    }
    pending.clear();
  });
  await send("Runtime.enable");
  let document;
  for (;;) {
    checkRunning();
    const result = await send("Runtime.evaluate", {
      expression: "JSON.stringify({ready:document.readyState,text:document.body?.innerText??''})",
      returnByValue: true,
    });
    document = JSON.parse(result.result.value);
    if (document.ready === "complete" && /\b(Dashboard|Games)\b/.test(document.text)) break;
    await delay(500);
  }
  await delay(1_000);
  checkRunning();
  if (exceptions.length > 0) {
    throw new Error("Packaged renderer raised an exception: " + JSON.stringify(exceptions));
  }
  const image = await send("Page.captureScreenshot", { format: "png" });
  await mkdir(path.dirname(screenshot), { recursive: true });
  await writeFile(screenshot, Buffer.from(image.data, "base64"));
  console.log(
    "Native Linux renderer started successfully (sandbox " +
      (disableSandbox ? "disabled" : "enabled") +
      "): " +
      document.text.slice(0, 500),
  );
  console.log("Saved " + screenshot);
} catch (error) {
  console.error(output);
  throw error;
} finally {
  socket?.close();
  if (application.exitCode === null && application.signalCode === null) {
    application.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => application.once("exit", resolve)), delay(3_000)]);
    if (application.exitCode === null && application.signalCode === null)
      application.kill("SIGKILL");
  }
  await rm(temporary, { recursive: true, force: true });
}
