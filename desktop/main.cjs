const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const DEFAULT_PORT = Number(process.env.PI_STUDIO_PORT || 8787);
const smokeMode = process.env.PI_STUDIO_SMOKE === "1";
let port = DEFAULT_PORT;
const authToken = randomBytes(32).toString("hex");
const startupStartedAt = Date.now();

function startupLog(phase, details = "") {
  const suffix = details ? ` ${details}` : "";
  console.log(`[startup +${Date.now() - startupStartedAt}ms] ${phase}${suffix}`);
}

startupLog("process-start");
const isPackaged = app.isPackaged;
const projectRoot = path.join(__dirname, "..");
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
const baseDir = isPackaged
  ? portableDir || path.dirname(process.execPath)
  : projectRoot;

const dataDir = path.join(baseDir, "data");
const workspaceDir = path.join(baseDir, "workspace");

let mainWindow = null;
let serverProcess = null;
let serverRunning = false;

function logServer(channel, chunk) {
  const text = String(chunk).replace(/\s+$/, "");
  if (text) console.log(`[pi-server:${channel}] ${text}`);
}

function serverEntry() {
  const root = isPackaged ? process.resourcesPath : projectRoot;
  return path.join(root, "server", "dist", "index.mjs");
}

function serverCwd() {
  return isPackaged ? process.resourcesPath : projectRoot;
}

function serverRuntime() {
  return isPackaged ? path.join(process.resourcesPath, "runtime", "node.exe") : (process.env.npm_node_execpath || process.execPath);
}

function findAvailablePort(preferredPort) {
  return new Promise((resolve) => {
    const tryPort = (candidate, fallback) => {
      const probe = net.createServer();
      probe.once("error", () => {
        if (fallback) {
          tryPort(0, false);
        } else {
          resolve(null);
        }
      });
      probe.once("listening", () => {
        const address = probe.address();
        const availablePort = typeof address === "object" && address ? address.port : null;
        probe.close(() => resolve(availablePort));
      });
      probe.listen(candidate, "127.0.0.1");
    };
    tryPort(preferredPort, true);
  });
}

function startServer() {
  fs.mkdirSync(path.join(dataDir, "pi-agent"), { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  const childEnv = {
    ...process.env,
    PI_CODING_AGENT_DIR: path.join(dataDir, "pi-agent"),
    PI_STUDIO_WORKSPACE: workspaceDir,
    PI_STUDIO_PORT: String(port),
    PI_STUDIO_AUTH_TOKEN: authToken,
    PI_STUDIO_LOAD_GLOBAL_EXTENSIONS: "0",
    PI_STUDIO_INHERIT_PROVIDER_ENV: "0",
    PI_OFFLINE: "1",
  };
  delete childEnv.NODE_OPTIONS;
  if (!isPackaged && serverRuntime() === process.execPath) childEnv.ELECTRON_RUN_AS_NODE = "1";
  else delete childEnv.ELECTRON_RUN_AS_NODE;

  // Use the bundled standalone Node runtime for the server. This keeps native
  // extensions (such as Hermes Memory's SQLite store) on the same ABI in the
  // portable and Electron editions, without exposing Node to the renderer.
  startupLog("server-spawn", `runtime=${serverRuntime()}`);
  const child = spawn(serverRuntime(), [serverEntry()], {
    cwd: serverCwd(),
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stdout?.on("data", (chunk) => logServer("out", chunk));
  child.stderr?.on("data", (chunk) => logServer("err", chunk));
  child.on("spawn", () => {
    serverRunning = true;
    startupLog("server-spawned", `pid=${child.pid ?? "unknown"}`);
  });
  child.on("exit", (code) => {
    serverRunning = false;
    console.log(`[pi-server] exited (code=${code})`);
    if (serverProcess === child) serverProcess = null;
  });
  child.on("error", (error) => {
    startupLog("server-error", error instanceof Error ? error.message : String(error));
    console.error("[pi-server] failed:", error);
  });
  return child;
}

function stopServer() {
  if (serverProcess && serverRunning) {
    try {
      serverProcess.kill();
    } catch {
      // Already gone.
    }
  }
  serverRunning = false;
  serverProcess = null;
}

function waitForServer(timeoutMs = 90_000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    let settled = false;
    let healthLogged = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const attempt = () => {
      const req = http.get({
        host: "127.0.0.1",
        port,
        path: "/api/health",
        headers: { Authorization: `Bearer ${authToken}` },
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          if (res.statusCode === 200) {
            let state = "unknown";
            try {
              const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              state = payload.ready ? "ready" : payload.booting ? "booting" : "not-ready";
            } catch {
              // The status code is still enough to load the renderer.
            }
            if (!healthLogged) {
              healthLogged = true;
              startupLog("first-health-response", `status=${res.statusCode} state=${state}`);
            }
            finish(true);
          } else if (Date.now() >= deadline) {
            startupLog("health-timeout", `status=${res.statusCode ?? "unknown"}`);
            finish(false);
          } else {
            setTimeout(attempt, 250);
          }
        });
      });
      req.setTimeout(1500, () => req.destroy());
      req.on("error", () => {
        if (Date.now() >= deadline) {
          startupLog("health-timeout", "request-error");
          finish(false);
        } else {
          setTimeout(attempt, 250);
        }
      });
    };
    attempt();
  });
}
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: "Pi Studio",
    icon: path.join(__dirname, "assets", "pi-studio-logo.png"),
    backgroundColor: "#171717",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  startupLog("window-created", `size=${mainWindow.getBounds().width}x${mainWindow.getBounds().height}`);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("data:text/html")) return;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" && Number(parsed.port) === port) return;
    } catch {
      // Invalid navigations are denied below.
    }
    event.preventDefault();
  });
  const clipboardWritePermissions = new Set(["clipboard-sanitized-write", "clipboard-write"]);
  const isTrustedRendererUrl = (url) => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" && Number(parsed.port) === port;
    } catch {
      return false;
    }
  };
  mainWindow.webContents.session.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => (
    clipboardWritePermissions.has(permission) && isTrustedRendererUrl(requestingOrigin)
  ));
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl = details?.requestingUrl || webContents.getURL();
    callback(clipboardWritePermissions.has(permission) && isTrustedRendererUrl(requestingUrl));
  });

  const svgPath = path.join(__dirname, "assets", "pi-studio-logo.svg");
  const pngPath = path.join(__dirname, "assets", "pi-studio-logo.png");
  const startupAsset = fs.existsSync(svgPath)
    ? { mime: "image/svg+xml", path: svgPath }
    : { mime: "image/png", path: pngPath };
  const startupIcon = `data:${startupAsset.mime};base64,${fs.readFileSync(startupAsset.path).toString("base64")}`;
  mainWindow.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
        * { box-sizing: border-box; }
        body { margin: 0; min-height: 100vh; background: #fff; color: #111; font-family: Inter, "Segoe UI", "Microsoft YaHei", sans-serif; }
        .shell { min-height: 100vh; display: flex; flex-direction: column; }
        .topbar { height: 52px; border-bottom: 1px solid #e5e5e5; display: flex; align-items: center; padding: 0 24px; font-size: 15px; font-weight: 650; letter-spacing: -0.2px; }
        .brand-mark { width: 22px; height: 22px; margin-right: 9px; display: grid; place-items: center; }
        .brand-mark img { width: 22px; height: 22px; display: block; }
        .content { flex: 1; display: grid; place-items: center; padding-bottom: 52px; }
        .card { width: min(360px, calc(100vw - 48px)); }
        h1 { margin: 0; font-size: 28px; line-height: 1.2; font-weight: 700; letter-spacing: -0.8px; }
        .status { margin: 8px 0 20px; color: #737373; font-size: 13px; }
        .progress { height: 4px; overflow: hidden; background: #e9e9e9; border-radius: 99px; }
        .progress::after { content: ""; display: block; width: 38%; height: 100%; background: #111; border-radius: inherit; animation: loading 1.35s ease-in-out infinite; }
        @keyframes loading { 0% { transform: translateX(-110%); } 100% { transform: translateX(370%); } }
      </style></head><body><div class="shell"><header class="topbar"><span class="brand-mark"><img src="${startupIcon}" alt="Pi Studio"></span>Pi Studio</header><main class="content"><section class="card"><h1>Pi Studio</h1><p class="status">正在启动</p><div class="progress" role="progressbar" aria-label="正在启动"></div></section></main></div></body></html>`)
  );
  mainWindow.on("closed", () => {
    mainWindow = null;
    app.quit();
  });
}

async function main() {
  startupLog("app-when-ready");
  if (!smokeMode) createWindow();
  const availablePort = await findAvailablePort(DEFAULT_PORT);
  if (!availablePort) {
    dialog.showErrorBox("Pi Studio", "无法分配本地服务端口，请稍后重试。");
    app.quit();
    return;
  }
  port = availablePort;
  startupLog("port-selected", `port=${port}`);
  serverProcess = startServer();
  const ready = await waitForServer();
  if (smokeMode) {
    stopServer();
    app.exit(ready ? 0 : 1);
    return;
  }
  if (!ready) {
    dialog.showErrorBox(
      "Pi Studio",
      `本地服务未就绪：127.0.0.1:${port}`
    );
    stopServer();
    app.quit();
    return;
  }
  if (mainWindow) {
    mainWindow.webContents.once("did-finish-load", () => startupLog("renderer-page-loaded"));
    startupLog("renderer-load-start", `url=http://127.0.0.1:${port}/`);
    await mainWindow.loadURL(`http://127.0.0.1:${port}/?token=${encodeURIComponent(authToken)}`);
  }
}

process.on("unhandledRejection", (error) => {
  console.error("[pi-studio] unhandled rejection:", error);
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.on("window-all-closed", () => {
    app.quit();
  });
  app.on("before-quit", () => {
    stopServer();
  });
  app.whenReady().then(main).catch((error) => {
    console.error("[pi-studio] startup failed:", error);
    dialog.showErrorBox("Pi Studio", `启动失败：${error instanceof Error ? error.message : String(error)}`);
    stopServer();
    app.quit();
  });
}
