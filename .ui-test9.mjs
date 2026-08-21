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

  // 点击"选择模型"按钮（title 属性定位）
  let r = await evaluate(`document.querySelector('button[title="选择模型"]').click(); 'clicked'`);
  console.log("点击选择模型:", r.result?.result?.value);
  await sleep(1000);

  // 查看弹出的菜单内容
  r = await evaluate(`
    (() => {
      const menus = document.querySelector('.picker-wrap')?.parentElement?.innerHTML ?? '';
      const m = document.body.innerText;
      // 找菜单项
      const items = [...document.querySelectorAll('.composer button')].map(b => (b.title || b.textContent.trim()).slice(0,20)).filter(x=>x);
      return JSON.stringify({ buttons: items });
    })()
  `);
  console.log("菜单:", r.result?.result?.value);
  process.exit(0);
});
