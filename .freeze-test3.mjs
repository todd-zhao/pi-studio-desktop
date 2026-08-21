import WebSocket from "ws";

const ws = new WebSocket("ws://127.0.0.1:8801/ws");
const t0 = Date.now();
let ready = false;

setInterval(() => {
  if (!ready) return;
  fetch("http://127.0.0.1:8801/api/health").then(r => r.json()).then(h => {
    console.log(`[health ${Date.now() - t0}ms] ok=${h.ok} ready=${h.ready} booting=${h.booting} error=${h.error ?? "-"}`);
  }).catch(e => console.log(`[health ${Date.now() - t0}ms] ❌ SERVER DEAD:`, e.message));
}, 5000);

setTimeout(() => { console.log("=== done ==="); process.exit(0); }, 40000);

ws.on("open", () => console.log("[ws] connected"));
ws.on("close", () => console.log(`[ws] ❌ CLOSED at ${Date.now() - t0}ms`));
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === "ready" && !ready) {
    ready = true;
    console.log("[ws] ready — 清除 opencode-go（OAuth 类型）...");
    fetch("http://127.0.0.1:8801/api/models/api-key?provider=opencode-go", { method: "DELETE" })
      .then(async r => {
        console.log(`[http] delete 返回: ${r.status} (${Date.now() - t0}ms)`);
        const t1 = Date.now();
        const cat = await fetch("http://127.0.0.1:8801/api/models").then(r => r.json()).catch(() => null);
        console.log(`GET /api/models (${Date.now() - t1}ms):`, cat ? "ok" : "FAILED");
      });
  } else if (msg.type === "state") {
    console.log(`[ws] state (${Date.now() - t0}ms) model=${msg.state.model?.displayName ?? "null"} avail=${msg.state.availableModels?.length} fallback=${msg.state.modelFallbackMessage ? "yes" : "no"}`);
  } else if (msg.type === "error") {
    console.log(`[ws] ERROR (${Date.now() - t0}ms):`, msg.message.slice(0, 120));
  } else {
    console.log(`[ws] ${msg.type} (${Date.now() - t0}ms)`);
  }
});
