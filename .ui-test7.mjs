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
    console.log("  ❌ 原生对话框仍然被触发了！", msg.params.message.slice(0, 60));
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
  await send("Page.bringToFront");
  await sleep(500);

  // 打开 Models 面板：点击 composer 上的模型名按钮（▾）
  let r = await evaluate(`
    (() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('▾'));
      if (!btn) return 'not found';
      btn.click();
      return 'clicked';
    })()
  `);
  console.log("打开模型菜单:", r.result?.result?.value);
  await sleep(800);

  // 找到"模型管理"入口
  r = await evaluate(`
    (() => {
      const items = [...document.querySelectorAll('button, a, [role=menuitem], .menu-item')];
      const t = items.find(b => b.textContent.includes('模型管理') || b.textContent.includes('模型'));
      if (!t) return JSON.stringify({ found: false, options: items.map(i=>i.textContent.trim().slice(0,15)).filter(x=>x).slice(0,20) });
      t.click();
      return JSON.stringify({ found: true, clicked: t.textContent.trim().slice(0,20) });
    })()
  `);
  console.log("进入模型管理:", r.result?.result?.value);
  await sleep(1200);

  // 在面板中找到 opencode-go 的清除按钮并点击
  r = await evaluate(`
    (() => {
      const rows = [...document.querySelectorAll('*')].filter(el => el.children.length === 0 && /opencode-go/.test(el.textContent));
      if (!rows.length) return JSON.stringify({ err: 'opencode-go 行未找到', text: document.body.innerText.slice(0,300) });
      const row = rows[0].closest('div, li, section') ?? rows[0];
      const btns = [...(row.parentElement ?? row).querySelectorAll('button')];
      const clearBtn = btns.find(b => /清除|删除/.test(b.textContent));
      if (!clearBtn) return JSON.stringify({ err: '清除按钮未找到', buttons: btns.map(b=>b.textContent.trim()) });
      clearBtn.click();
      return '已点击清除按钮';
    })()
  `);
  console.log("点击清除:", r.result?.result?.value);
  await sleep(1200);

  // 检查新确认框是否出现
  r = await evaluate(`
    (() => {
      const overlay = document.querySelector('.confirm-overlay');
      return JSON.stringify({
        newModalShown: !!overlay,
        modalText: overlay ? overlay.textContent.slice(0, 80) : null
      });
    })()
  `);
  console.log("应用内确认框:", r.result?.result?.value);

  // 点击确认按钮
  r = await evaluate(`
    (() => {
      const overlay = document.querySelector('.confirm-overlay');
      if (!overlay) return 'overlay gone';
      const btns = [...overlay.querySelectorAll('button')];
      const ok = btns.find(b => b.textContent === '清除');
      if (!ok) return JSON.stringify({ buttons: btns.map(b=>b.textContent) });
      ok.click();
      return 'confirmed';
    })()
  `);
  console.log("确认操作:", r.result?.result?.value);
  await sleep(2500);

  // 验证焦点与 UI 存活
  await send("Page.bringToFront");
  await sleep(500);
  r = await evaluate(`
    (() => JSON.stringify({
      hasFocus: document.hasFocus(),
      textareaAlive: !!document.querySelector('.composer textarea'),
      confirmOverlayClosed: !document.querySelector('.confirm-overlay')
    }))()
  `);
  console.log("最终状态:", r.result?.result?.value);
  process.exit(0);
});
