// Best-effort DevTools screenshot of a running packaged Vortex (used by the
// Linux boot smoke). Node 22+ global fetch/WebSocket only; no deps.
// Usage: node capture-smoke-screenshot.mjs <host> <port> <out.png>
// Exits 2 when no page target is present, 3 on protocol failure/crash.

const [, , host, port, out] = process.argv;

if (host == null || port == null || out == null) {
  console.error("usage: capture-smoke-screenshot.mjs <host> <port> <out.png>");
  process.exit(1);
}

const timeout = (ms) =>
  new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));

const pages = await fetch(`http://${host}:${port}/json`).then((res) => res.json());
const page = pages.find((target) => target.type === "page");
if (page == null) {
  console.error("no page target");
  process.exit(2);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await Promise.race([new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", rej, { once: true });
}), timeout(15000)]);

const result = await Promise.race([
  new Promise((resolve, reject) => {
    let resolved = false;
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id === 2 && !resolved) {
        resolved = true;
        resolve(msg.result);
      }
    });
    ws.addEventListener("error", reject, { once: true });
    ws.send(JSON.stringify({ id: 1, method: "Page.enable" }));
    ws.send(JSON.stringify({
      id: 2,
      method: "Page.captureScreenshot",
      params: { format: "png", captureBeyondViewport: true },
    }));
  }),
  timeout(30000),
]);

ws.close();

if (result?.data == null) {
  console.error("no screenshot data");
  process.exit(3);
}

const { writeFileSync } = await import("node:fs");
writeFileSync(out, Buffer.from(result.data, "base64"));
console.log(`screenshot saved: ${out}`);