import WebSocket from "ws";

// 重新发现页面（可能已刷新）
const list = await fetch("http://127.0.0.1:9222/json").then(r => r.json());
const page = list.find(t => t.type === "page");
console.log("page:", page.title, page.url.slice(0, 50));

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();

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
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    console.log("  ❌ [EXCEPTION]", d.text, d.exception?.description?.slice(0, 400) ?? "");
  }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    console.log("  [console.error]", (msg.params.args ?? []).map(a => a.description ?? a.value ?? "").join(" ").slice(0, 300));
  }
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

ws.on("open", async () => {
  await send("Runtime.enable");
  // 从 sessionStorage 拿 token
  let r = await evaluate("sessionStorage.getItem('pi-studio-auth-token') ?? ''");
  const token = r.result?.result?.value;
  console.log("token:", token ? token.slice(0, 8) + "..." : "(none)");
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  console.log("\n=== 1. 给 minimax-cn 设置测试 Key ===");
  r = await evaluate(`fetch('/api/models/api-key', { method:'POST', headers:${JSON.stringify(H)}, body: JSON.stringify({provider:'minimax-cn', apiKey:'sk-ui-test'}) }).then(r=>r.json())`);
  console.log("set:", JSON.stringify(r.result?.result?.value));
  await sleep(1500);

  console.log("\n=== 2. 清除 minimax-cn Key（与 UI 按钮相同调用）===");
  r = await evaluate(`fetch('/api/models/api-key?provider=minimax-cn', { method:'DELETE', headers:${JSON.stringify(H)} }).then(r=>r.json())`);
  console.log("clear:", JSON.stringify(r.result?.result?.value));
  await sleep(2500);

  console.log("\n=== 3. UI 响应能力检查 ===");
  r = await evaluate(`
    (async () => {
      const ta = document.querySelector('.composer textarea');
      if (!ta) return JSON.stringify({ err: 'textarea NOT FOUND — UI 可能已崩溃' });
      ta.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '测试输入');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r=>setTimeout(r,200));
      return JSON.stringify({ typed: ta.value });
    })()
  `);
  console.log("输入测试:", r.result?.result?.value);

  // 检查 React 根是否还挂着
  r = await evaluate(`
    (() => {
      const root = document.getElementById('root') || document.querySelector('#app, body > div');
      return JSON.stringify({
        hasRoot: !!root,
        childCount: root ? root.children.length : -1,
        textLen: (document.body.innerText || '').length,
        bodySnippet: (document.body.innerText || '').slice(0, 100)
      });
    })()
  `);
  console.log("DOM 状态:", r.result?.result?.value);
  process.exit(0);
});
