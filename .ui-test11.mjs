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
  await evaluate(`document.querySelector('button[title="选择模型"]')?.click()`);
  await sleep(1000);
  const r = await evaluate(`document.body.innerText.replace(/\n+/g, ' | ')`);
  console.log("BODY:", r.result?.result?.value?.slice(0, 600));
  process.exit(0);
});
