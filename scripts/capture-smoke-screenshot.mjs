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
await Promise.race([
  new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  }),
  timeout(15000),
]);

let msgId = 0;
const pending = new Map();
const once = (type) =>
  new Promise((resolve, reject) => {
    ws.addEventListener("message", function handler(event) {
      const msg = JSON.parse(String(event.data));
      if (msg.id === type && msg.id != null) {
        ws.removeEventListener("message", handler);
        resolve(msg);
      }
    });
    ws.addEventListener("error", reject, { once: true });
  });

// Step 1: Page.enable
const enableP = once(1);
ws.send(JSON.stringify({ id: 1, method: "Page.enable" }));
await Promise.race([enableP, timeout(15000)]);

// Step 2: wait for a moment for first paint, then captureScreenshot.
const capP = once(2);
await new Promise((r) => setTimeout(r, 1500));
ws.send(JSON.stringify({
  id: 2,
  method: "Page.captureScreenshot",
  params: { format: "png", captureBeyondViewport: true },
}));
const cap = await Promise.race([capP, timeout(30000)]);

ws.close();

if (cap?.result?.data == null) {
  console.error("no screenshot data");
  process.exit(3);
}

const { writeFileSync } = await import("node:fs");
writeFileSync(out, Buffer.from(cap.result.data, "base64"));
console.log(`screenshot saved: ${out}`);