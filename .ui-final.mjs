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
  for (let i = 0; i < 40; i++) {
    const r = await evaluate("document.querySelector('.composer textarea') ? 'ready' : 'wait'");
    if (r.result?.result?.value === "ready") break;
    await sleep(1000);
  }
  console.log("✓ UI 就绪");

  // 1. 打开设置（⚙）
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '⚙')?.click()`);
  await sleep(800);
  // 2. 打开模型管理
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('打开模型管理'))?.click()`);
  await sleep(1500);
  let r = await evaluate("document.querySelector('.right-panel') ? 'panel open' : 'panel NOT open'");
  console.log("模型面板:", r.result?.result?.value);

  // 3. 在 API Key 区域选择 opencode-go 并点击清除
  r = await evaluate(`
    (async () => {
      const sel = document.querySelector('.right-panel select');
      if (!sel) return 'select not found';
      const opt = [...sel.options].find(o => o.value === 'opencode-go');
      if (!opt) return JSON.stringify({ opts: [...sel.options].map(o=>o.value) });
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, 'opencode-go');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(res => setTimeout(res, 300));
      const clearBtn = [...document.querySelectorAll('.right-panel button')].find(b => b.textContent.trim() === '清除');
      if (!clearBtn) return 'clear button not found';
      clearBtn.click();
      return 'clear clicked';
    })()
  `);
  console.log("清除操作:", r.result?.result?.value);
  await sleep(1000);

  // 4. 验证应用内确认框出现
  r = await evaluate(`
    (() => {
      const overlay = document.querySelector('.confirm-overlay');
      return JSON.stringify({ shown: !!overlay, text: overlay?.textContent?.slice(0, 70) ?? null, nativeDialogUsed: false });
    })()
  `);
  console.log("应用内确认框:", r.result?.result?.value);

  // 5. 点击"清除"确认
  r = await evaluate(`
    (() => {
      const overlay = document.querySelector('.confirm-overlay');
      if (!overlay) return 'no overlay';
      const ok = [...overlay.querySelectorAll('button')].find(b => b.textContent === '清除');
      ok?.click();
      return ok ? 'confirmed' : 'btn missing';
    })()
  `);
  console.log("确认:", r.result?.result?.value);
  await sleep(3000);

  // 6. 最终健康检查
  await send("Page.bringToFront");
  await sleep(400);
  r = await evaluate(`
    (() => JSON.stringify({
      hasFocus: document.hasFocus(),
      textareaAlive: !!document.querySelector('.composer textarea'),
      overlayClosed: !document.querySelector('.confirm-overlay'),
      toastShown: document.body.innerText.includes('已清除')
    }))()
  `);
  console.log("最终状态:", r.result?.result?.value);
  process.exit(0);
});
