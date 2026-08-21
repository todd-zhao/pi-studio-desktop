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
  if (msg.method === "Page.javascriptDialogOpening") {
    console.log("  ⚠️ 原生对话框弹出:", msg.params.message.slice(0, 60));
    // 先检查对话框出现时的状态，再接受它
    console.log("  >>> 接受对话框（相当于用户点确定）");
    send("Page.handleJavaScriptDialog", { accept: true });
  }
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

ui.on("open", async () => {
  await send("Runtime.enable");
  await send("Page.enable");
  for (let i = 0; i < 40; i++) {
    const r = await evaluate("document.querySelector('.composer textarea') ? 'ready' : 'wait'");
    if (r.result?.result?.value === "ready") break;
    await sleep(1000);
  }

  // 恢复 opencode-go 的凭据以便有东西可清除：直接写 auth 不可行，改用设置 api-key 到一个自定义 provider？
  // 简化：直接测 window.confirm 本身对焦点的影响 —— 这就是怀疑的根因
  console.log("=== 测试 1：触发一次真实的 window.confirm ===");
  evaluate(`
    setTimeout(() => { window.__confirmResult = window.confirm("清除 API Key？（UI焦点测试）"); }, 100);
    'triggered'
  `);
  await sleep(2500);

  console.log("=== 测试 2：对话框关闭后检查窗口焦点与输入能力 ===");
  let r = await evaluate(`
    (() => JSON.stringify({
      hasFocus: document.hasFocus(),
      visibility: document.visibilityState,
      activeElement: document.activeElement?.tagName ?? "none",
      confirmResult: window.__confirmResult
    }))()
  `);
  console.log("页面状态:", r.result?.result?.value);

  // 用真实 DOM 事件模拟键盘输入（不是直接改 value）
  r = await evaluate(`
    (async () => {
      const ta = document.querySelector('.composer textarea');
      if (!ta) return 'no textarea';
      ta.focus();
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
      // 检查 focus 是否真的落在 textarea 上
      await new Promise(r=>setTimeout(r,300));
      return JSON.stringify({ activeAfterClick: document.activeElement?.className?.slice(0,30), isFocused: document.activeElement === ta });
    })()
  `);
  console.log("textarea 聚焦测试:", r.result?.result?.value);

  // 模拟真实鼠标点击 textarea
  r = await evaluate(`
    (async () => {
      const ta = document.querySelector('.composer textarea');
      const rect = ta.getBoundingClientRect();
      const opts = { bubbles: true, clientX: rect.x + 50, clientY: rect.y + 10 };
      ta.dispatchEvent(new MouseEvent('mousedown', opts));
      ta.dispatchEvent(new MouseEvent('mouseup', opts));
      ta.dispatchEvent(new MouseEvent('click', opts));
      await new Promise(r=>setTimeout(r,500));
      return JSON.stringify({
        afterClickFocus: document.activeElement === ta,
        docHasFocus: document.hasFocus()
      });
    })()
  `);
  console.log("鼠标点击后:", r.result?.result?.value);

  process.exit(0);
});
