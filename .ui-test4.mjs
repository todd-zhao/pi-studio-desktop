import WebSocket from "ws";

const list = await fetch("http://127.0.0.1:9223/json").then(r => r.json());
const page = list.find(t => t.type === "page");
const ui = new WebSocket(page.webSocketDebuggerUrl);   // CDP：控制渲染进程
let id = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve) => { const m = ++id; pending.set(m, resolve); ui.send(JSON.stringify({ id: m, method, params })); });
}
function evaluate(expr) { return send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); }
ui.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    console.log("  ❌ [RENDERER EXCEPTION]", d.text, d.exception?.description?.slice(0, 400) ?? "");
  }
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 检查渲染进程是否存活/响应
async function ping(label) {
  const t0 = Date.now();
  const r = await Promise.race([
    evaluate("1+1"),
    sleep(5000).then(() => null),
  ]);
  console.log(`[${label}] 渲染进程响应: ${r ? "OK (" + (Date.now()-t0) + "ms)" : "❌ 无响应(>5s)"}`);
}

ui.on("open", async () => {
  await send("Runtime.enable");
  for (let i = 0; i < 40; i++) {
    const r = await evaluate("document.querySelector('.composer textarea') ? 'ready' : 'wait'");
    if (r.result?.result?.value === "ready") break;
    await sleep(1000);
  }
  await ping("启动后");
  const token = (await evaluate("sessionStorage.getItem('pi-studio-auth-token') ?? ''")).result?.result?.value;
  const H = JSON.stringify({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

  // 与 UI 相同的 WS 连接逻辑（模拟用户操作前状态）
  const wsUrl = `ws://127.0.0.1:8805/ws?token=${token}`;
  const app = new WebSocket(wsUrl);
  let appReady = false;
  app.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "ready") {
      appReady = true;
      console.log("[app-ws] ready | 当前模型:", m.state.model?.displayName ?? "null", "| 可用:", m.state.availableModels?.length);
    } else if (m.type === "state") {
      console.log("[app-ws] state | model:", m.state.model?.displayName ?? "null", "| avail:", m.state.availableModels?.length, "| streaming:", m.state.isStreaming);
    } else if (m.type === "error") {
      console.log("[app-ws] error:", m.message.slice(0, 100));
    }
  });
  await new Promise(r => app.on("open", r));
  for (let i = 0; i < 20 && !appReady; i++) await sleep(500);

  console.log("\n=== 用户场景：清除当前激活模型(opencode-go)的凭据 ===");
  const t0 = Date.now();
  const res = await fetch("http://127.0.0.1:8805/api/models/api-key?provider=opencode-go", { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  console.log(`DELETE 返回: ${res.status} (${Date.now() - t0}ms)`);

  await sleep(3000);
  await ping("清除Key后");

  console.log("\n=== 尝试选择模型（用户报告卡死的操作）===");
  app.send(JSON.stringify({ type: "set_model", provider: "opencode-go", id: "deepseek-v4-flash" }));
  await sleep(3000);
  await ping("选模型后");

  console.log("\n=== 尝试输入+发送 ===");
  app.send(JSON.stringify({ type: "prompt", text: "hi" }));
  await sleep(3000);
  await ping("发送后");

  console.log("\n=== 最终 UI 状态 ===");
  let r = await evaluate("document.body.innerText.slice(0, 200).replace(/\n/g,' | ')");
  console.log(r.result?.result?.value);
  process.exit(0);
});
