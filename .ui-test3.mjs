import WebSocket from "ws";

const list = await fetch("http://127.0.0.1:9223/json").then(r => r.json());
const page = list.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve) => { const m = ++id; pending.set(m, resolve); ws.send(JSON.stringify({ id: m, method, params })); });
}
function evaluate(expr) { return send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); }
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    console.log("  ❌ [RENDERER EXCEPTION]", d.text, d.exception?.description?.slice(0, 500) ?? "");
  }
  if (msg.method === "Runtime.consoleAPICalled" && ["error","warning"].includes(msg.params.type)) {
    console.log(`  [console.${msg.params.type}]`, (msg.params.args ?? []).map(a => a.description ?? a.value ?? "").join(" ").slice(0, 250));
  }
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

ws.on("open", async () => {
  await send("Runtime.enable");
  console.log("=== 等待 UI 就绪 ===");
  for (let i = 0; i < 40; i++) {
    const r = await evaluate("document.querySelector('.composer textarea') ? 'ready' : 'wait'");
    if (r.result?.result?.value === "ready") break;
    await sleep(1000);
  }
  let r = await evaluate("document.body.innerText.slice(0, 150).replace(/\n/g,' | ')");
  console.log("UI:", r.result?.result?.value);

  // 打开 Models 面板（右侧功能按钮）
  r = await evaluate(`
    (() => {
      // 找到打开模型面板的按钮：通常在 composer 的模型名上
      const btns = [...document.querySelectorAll('button')];
      return JSON.stringify(btns.map(b => b.textContent.trim().slice(0,25)).filter(t => t));
    })()
  `);
  console.log("可用按钮:", r.result?.result?.value);

  process.exit(0);
});
