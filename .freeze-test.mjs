import WebSocket from "ws";

const ws = new WebSocket("ws://127.0.0.1:8801/ws");
const counts = {};
let phase = "boot";
const t0 = Date.now();

setTimeout(() => {
  console.log("\n=== 20秒消息统计 ===", counts);
  console.log("phase:", phase);
  process.exit(0);
}, 20000);

ws.on("open", async () => console.log("[ws] connected"));
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  counts[msg.type] = (counts[msg.type] ?? 0) + 1;
  if (msg.type === "ready") {
    console.log("[ws] ready, model:", msg.state.model?.displayName, "| available:", msg.state.availableModels?.length);
    phase = "clearing-key";
    // 清除 deepseek 的 API Key（复现 bug）
    fetch("http://127.0.0.1:8801/api/models/api-key?provider=deepseek", { method: "DELETE" })
      .then(r => r.json())
      .then(r => {
        console.log("[http] delete result:", JSON.stringify(r), `(${Date.now() - t0}ms)`);
        phase = "cleared";
        // 然后尝试发 prompt 和选模型
        setTimeout(() => {
          console.log("[ws] >>> sending prompt");
          ws.send(JSON.stringify({ type: "prompt", text: "回复OK" }));
          setTimeout(() => {
            console.log("[ws] >>> set_model");
            ws.send(JSON.stringify({ type: "set_model", provider: "deepseek", id: "deepseek-v4-pro" }));
            phase = "after-ops";
          }, 3000);
        }, 1000);
      });
  } else if (msg.type === "state") {
    if (counts.state <= 3 || counts.state % 50 === 0) {
      console.log(`[ws] state #${counts.state} streaming=${msg.state.isStreaming} model=${msg.state.model?.displayName ?? "null"} avail=${msg.state.availableModels?.length}`);
    }
  } else if (msg.type === "error") {
    console.log("[ws] ERROR:", msg.message);
  } else if (counts[msg.type] <= 2) {
    console.log("[ws]", msg.type, JSON.stringify(msg).slice(0, 120));
  }
});
ws.on("close", () => console.log("[ws] CLOSED"));
ws.on("error", (e) => console.log("[ws] ERROR-EVENT:", e.message));
