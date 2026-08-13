import { createServer } from "node:http";
import { createServerContext } from "./context.ts";
import { createApp, startBridge } from "./server.ts";
import { createWsServer } from "./ws.ts";
import { PORT, WORKSPACE, mcpConfigFile } from "./config.ts";

const ctx = createServerContext();
const app = createApp(ctx);
const server = createServer(app);
createWsServer(server, ctx);

async function main(): Promise<void> {
  ctx.startupLog("process-start");
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error("");
      console.error(`  端口 ${PORT} 已被占用 —— Pi Studio 可能已经在运行。`);
      console.error(`  直接打开 http://localhost:${PORT} 即可，无需重复启动。`);
      console.error(`  如需重启，请先关闭旧进程（占用端口的 node 进程）后重试。`);
      console.error("");
      process.exit(1);
    }
    throw err;
  });
  server.listen(PORT, "127.0.0.1", () => {
    ctx.startupLog("http-listening", `port=${PORT}`);
    console.log("");
    console.log("  Pi Studio 已启动");
    console.log(`  前端:  http://localhost:${PORT}`);
    console.log(`  工作区: ${WORKSPACE}`);
    console.log(`  MCP 配置: ${mcpConfigFile()}`);
    console.log("");
    void startBridge(ctx);
  });
}

main().catch((e) => {
  console.error("启动失败:", e);
  process.exit(1);
});
