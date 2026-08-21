import WebSocket from "ws";

const ws = new WebSocket("ws://127.0.0.1:8801/ws");
const t0 = Date.now();
let ready = false;

setTimeout(() => {
  console.log("\n=== 45秒结论 ===");
  console.log(ready ? "delete 已返回" : "❌ delete 一直没返回");
  process.exit(0);
}, 45000);

ws.on("open", () => console.log("[ws] connected"));
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === "ready" && !ready) {
    ready = true;
    console.log("[ws] ready — 开始清除 deepseek API Key...");
    fetch("http://127.0.0.1:8801/api/models/api-key?provider=deepseek", { method: "DELETE" })
      .then(async r => {
        console.log(`[http] delete 返回: ${r.status} (${Date.now() - t0}ms)`);
        // 随后尝试 set_model —— 看是否被死队列卡住
        const t1 = Date.now();
        ws.send(JSON.stringify({ type: "set_model", provider: "minimax-cn", id: "MiniMax-M3" }));
      });
  } else if (msg.type === "state") {
    console.log(`[ws] state (${Date.now() - t0}ms) model=${msg.state.model?.displayName ?? "null"} avail=${msg.state.availableModels?.length}`);
  } else if (msg.type === "error") {
    console.log(`[ws] ERROR (${Date.now() - t0}ms):`, msg.message.slice(0, 100));
  }
});
