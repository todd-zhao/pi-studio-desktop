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
  await send("Page.enable");
  // 把窗口带到前台
  await send("Page.bringToFront");
  await sleep(1000);
  let r = await evaluate("document.hasFocus()");
  console.log("对话框前 hasFocus:", r.result?.result?.value);

  evaluate(`setTimeout(() => { window.confirm("焦点测试"); }, 50); 'ok'`);
  await sleep(1500);
  send("Page.handleJavaScriptDialog", { accept: true });
  await sleep(1500);
  r = await evaluate("document.hasFocus()");
  console.log("对话框后 hasFocus:", r.result?.result?.value);
  process.exit(0);
});
