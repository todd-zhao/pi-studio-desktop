// 通过 CDP 驱动真实 UI 复现 bug
import WebSocket from "ws";

const ws = new WebSocket("ws://127.0.0.1:9222/devtools/page/50944B6C16FD826079229B3F1EDD0DB9");
let id = 0;
const pending = new Map();
const consoleLogs = [];

function send(method, params = {}) {
  return new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

function evaluate(expr) {
  return send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
}

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === "Runtime.consoleAPICalled") {
    const text = (msg.params.args ?? []).map(a => a.value ?? a.description ?? "").join(" ").slice(0, 200);
    consoleLogs.push(`[${msg.params.type}] ${text}`);
    console.log("  [console]", text.slice(0, 150));
  }
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    console.log("  ❌ [EXCEPTION]", d.text, d.exception?.description?.slice(0, 300) ?? "");
    consoleLogs.push(`[exception] ${d.text}`);
  }
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

ws.on("open", async () => {
  await send("Runtime.enable");
  await send("Page.enable");
  console.log("=== 等待应用就绪 ===");
  for (let i = 0; i < 30; i++) {
    const r = await evaluate("document.querySelector('.composer textarea') ? 'ready' : 'wait'");
    if (r.result?.result?.value === "ready") break;
    await sleep(1000);
  }
  console.log("✓ UI 就绪");

  // 打开 Models 面板
  console.log("\n=== 1. 记录当前状态，给 minimax-cn 设置一个测试 Key ===");
  let r = await evaluate(`
    (async () => {
      const token = localStorage.getItem('pi-studio-token') || document.cookie;
      return fetch('/api/models/api-key', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({provider:'minimax-cn', apiKey:'sk-ui-test'}) }).then(r=>r.json());
    })()
  `);
  console.log("set key:", JSON.stringify(r.result?.result?.value));
  await sleep(1000);

  console.log("\n=== 2. 通过 UI 清除 Key（模拟用户点击）===");
  // 直接调用与按钮相同的逻辑：window.confirm + DELETE
  // 先覆盖 confirm 自动确认
  await evaluate("window.__origConfirm = window.confirm; window.confirm = () => true;");
  r = await evaluate(`
    (async () => {
      const t0 = Date.now();
      try {
        await fetch('/api/models/api-key?provider=minimax-cn', { method: 'DELETE' });
        return 'delete ok in ' + (Date.now()-t0) + 'ms';
      } catch(e) { return 'fetch error: ' + e.message; }
    })()
  `);
  console.log("clear key:", r.result?.result?.value);

  console.log("\n=== 3. 检查 UI 是否还能响应（输入 + 点击模型选择器）===");
  await sleep(2000);
  r = await evaluate(`
    (async () => {
      const ta = document.querySelector('.composer textarea');
      if (!ta) return 'textarea NOT FOUND';
      ta.focus();
      ta.value = 'x';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return 'typed ok, value=' + ta.value;
    })()
  `);
  console.log("输入测试:", r.result?.result?.value);

  // 模拟点击侧栏模型名（打开模型菜单）
  r = await evaluate(`
    (async () => {
      const el = [...document.querySelectorAll('button, .model-name, [title]')].find(b => (b.textContent||'').includes('/') && b.closest('.sidebar, .composer'));
      if (!el) return 'model selector not found';
      el.click();
      await new Promise(r=>setTimeout(r,500));
      return 'clicked model selector: ' + el.textContent.slice(0,40);
    })()
  `);
  console.log("模型选择测试:", r.result?.result?.value);
  await sleep(3000);
  console.log("\n=== 完成。console 消息数:", consoleLogs.length, "===");
  process.exit(0);
});
