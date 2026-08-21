import WebSocket from "ws";
const list = await fetch("http://127.0.0.1:9223/json").then(r => r.json());
const page = list.find(t => t.type === "page");
const ui = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve) => { const m = ++id; pending.set(m, resolve); ui.send(JSON.stringify({ id: m, method, params })); });
}
function evaluate(expr) { return send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); }
ui.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
ui.on("open", async () => {
  await send("Runtime.enable");
  for (let i = 0; i < 30; i++) {
    const r = await evaluate("document.querySelector('.composer textarea') ? 'ready' : 'wait'");
    if (r.result?.result?.value === "ready") break;
    await sleep(1000);
  }
  // 点击模型区域
  let r = await evaluate(`
    (() => {
      const el = document.querySelector('.composer-model, .model-selector, [class*=model]');
      if (!el) return JSON.stringify({ err: 'no model element', composerHTML: document.querySelector('.composer')?.innerHTML?.slice(0, 500) });
      return JSON.stringify({ cls: el.className, text: el.textContent.slice(0,40) });
    })()
  `);
  console.log("模型元素:", r.result?.result?.value);
  process.exit(0);
});
