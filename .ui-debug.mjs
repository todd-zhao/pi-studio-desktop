import WebSocket from "ws";
const list = await fetch("http://127.0.0.1:9223/json").then(r => r.json()).catch(() => []);
console.log("pages:", list.filter(t=>t.type==="page").map(p => p.url.slice(0,50)));
if (!list.length) process.exit(1);
