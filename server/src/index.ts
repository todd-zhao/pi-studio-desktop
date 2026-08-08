import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync, readdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { timingSafeEqual } from "node:crypto";
import express from "express";
import cors from "cors";
import multer from "multer";
import { WebSocketServer, WebSocket } from "ws";
import type { PiBridge } from "./bridge.ts";
import type { ParsedDoc } from "./parsers.ts";
import { Scheduler, type ScheduledTask } from "./scheduler.ts";
import type {
  AppState,
  ClientWsMessage,
  McpStatusSnapshot,
  ServerWsMessage,
  SessionMeta,
  WechatLogEntry,
  WechatQr,
  WechatStatus,
  WorkspaceInfo,
} from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const WORKSPACE = process.env.PI_STUDIO_WORKSPACE ? resolve(process.env.PI_STUDIO_WORKSPACE) : join(ROOT, "workspace");
const CLIENT_DIST = join(ROOT, "client", "dist");
const PORT = Number(process.env.PI_STUDIO_PORT ?? 8787);
const AUTH_TOKEN = process.env.PI_STUDIO_AUTH_TOKEN ?? "";
const APP_ORIGIN = `http://127.0.0.1:${PORT}`;
const ALLOWED_ORIGINS = new Set([
  APP_ORIGIN,
  `http://localhost:${PORT}`,
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  ...(process.env.PI_STUDIO_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
]);
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR
  ? resolve(process.env.PI_CODING_AGENT_DIR)
  : join(ROOT, "data", "pi-agent");
process.env.PI_CODING_AGENT_DIR ??= AGENT_DIR;

// Keep a fresh app independent from provider credentials configured on the host.
// Users can still add keys through the Models panel, which writes app-local auth.json.
const PROVIDER_ENV_KEYS = [
  "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
  "OPENCODE_API_KEY", "DEEPSEEK_API_KEY", "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY",
  "GEMINI_API_KEY", "GOOGLE_CLOUD_API_KEY", "OPENROUTER_API_KEY", "GROQ_API_KEY",
  "MISTRAL_API_KEY", "XAI_API_KEY", "ZAI_API_KEY", "QWEN_TOKEN_PLAN_API_KEY",
  "QWEN_TOKEN_PLAN_CN_API_KEY", "COPILOT_GITHUB_TOKEN", "HF_TOKEN", "KIMI_API_KEY",
];
if (process.env.PI_STUDIO_INHERIT_PROVIDER_ENV !== "1") {
  for (const key of PROVIDER_ENV_KEYS) delete process.env[key];
}

function mcpConfigFile(): string {
  return join(AGENT_DIR, "mcp.json");
}

mkdirSync(join(WORKSPACE, "uploads"), { recursive: true });

// ------------------------------------------------------------------ bridge

const startupStartedAt = Date.now();
function startupLog(phase: string, details = ""): void {
  const suffix = details ? ` ${details}` : "";
  console.log(`[startup +${Date.now() - startupStartedAt}ms] ${phase}${suffix}`);
}

let bridge!: PiBridge;
let scheduler!: Scheduler;
let PiBridgeClass!: typeof import("./bridge.ts").PiBridge;
let resolveBridgeReady!: (value: PiBridge) => void;
let rejectBridgeReady!: (reason: unknown) => void;
let bridgeReady!: Promise<PiBridge>;
let bridgeStarting = false;
let bootState: "booting" | "ready" | "error" = "booting";
let bootError = "";
let initialSessions: SessionMeta[] = [];
let initialWorkspaces: WorkspaceInfo[] = [];

function resetBridgeReady(): void {
  bridgeReady = new Promise<PiBridge>((resolveReady, rejectReady) => {
    resolveBridgeReady = resolveReady;
    rejectBridgeReady = rejectReady;
  });
}

resetBridgeReady();

// Workspace for uploads is tied to the *current* bridge cwd; recompute per request.
function uploadRoot(): string {
  return join(bridge.cwdPath, "uploads");
}

// -------------------------------------------------------------------- http

const app = express();
function safeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requestToken(req: { headers: Record<string, unknown>; url?: string }): string {
  const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  if (authorization.startsWith("Bearer ")) return authorization.slice(7);
  try {
    return new URL(req.url ?? "/", APP_ORIGIN).searchParams.get("token") ?? "";
  } catch {
    return "";
  }
}

function allowedOrigin(origin: string | undefined): boolean {
  return !origin || ALLOWED_ORIGINS.has(origin);
}

app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' http://127.0.0.1:* http://localhost:* https: ws://127.0.0.1:* ws://localhost:* wss:; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  next();
});
app.use(cors({
  origin(origin, callback) {
    callback(allowedOrigin(origin) ? null : new Error("不允许的请求来源"), allowedOrigin(origin));
  },
}));
app.use(express.json({ limit: "12mb" }));
app.use("/api", (req, res, next) => {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  if (!allowedOrigin(origin)) {
    res.status(403).json({ error: "不允许的请求来源" });
    return;
  }
  if (AUTH_TOKEN && !safeEqual(requestToken(req), AUTH_TOKEN)) {
    res.status(401).json({ error: "未授权" });
    return;
  }
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ready: bootState === "ready", booting: bootState === "booting", error: bootError || undefined });
});

// This route intentionally sits before the bridge-ready gate so the renderer
// can recover from an initialization failure without restarting Electron.
app.post("/api/runtime/retry", async (_req, res) => {
  if (bootState === "booting") {
    res.status(202).json({ ok: true, state: bootState });
    return;
  }
  await startBridge();
  res.status(bootState === "ready" ? 200 : 503).json({
    ok: bootState === "ready",
    state: bootState,
    error: bootError || undefined,
  });
});

// Serve the application shell immediately while the heavier Pi runtime starts.
app.use("/api", async (_req, res, next) => {
  try {
    await bridgeReady;
    next();
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 64 * 1024 * 1024 },
});

function sanitize(name: string): string {
  const base = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return base || `file-${Date.now()}`;
}

// POST /api/upload  ->  { files: AttachmentInfo[] }
app.post("/api/upload", upload.array("files", 12), (req, res) => {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = join(uploadRoot(), stamp);
    mkdirSync(dir, { recursive: true });

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const result = files.map((f) => {
      const name = sanitize(f.originalname);
      const saved = join(dir, name);
      writeFileSync(saved, f.buffer);
      const rel = `uploads/${stamp}/${name}`.split(sep).join("/");
      const isImage = f.mimetype.startsWith("image/");
      const small = isImage && f.buffer.length <= 4 * 1024 * 1024;
      return {
        name,
        path: rel,
        mediaType: f.mimetype || "application/octet-stream",
        size: f.buffer.length,
        data: small ? f.buffer.toString("base64") : undefined,
      };
    });
    res.json({ files: result });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ------------------------------------------------------------ MCP config mgmt

function readMcpConfig(): { mcpServers: Record<string, unknown> } {
  try {
    const f = mcpConfigFile();
    if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    /* ignore */
  }
  return { mcpServers: {} };
}

function writeMcpConfig(cfg: { mcpServers: Record<string, unknown> }): void {
  writeFileSync(mcpConfigFile(), JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

app.get("/api/mcp/config", (_req, res) => {
  res.json(readMcpConfig());
});

app.post("/api/mcp/servers", async (req, res) => {
  try {
    const { name, config } = req.body ?? {};
    if (!name || typeof name !== "string" || !config || typeof config !== "object") {
      res.status(400).json({ error: "需要 name 和 config" });
      return;
    }
    const cfg = readMcpConfig();
    cfg.mcpServers = cfg.mcpServers ?? {};
    cfg.mcpServers[name] = config;
    writeMcpConfig(cfg);
    await bridge.reload();
    res.json({ ok: true, name });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.delete("/api/mcp/servers/:name", async (req, res) => {
  try {
    const cfg = readMcpConfig();
    const name = decodeURIComponent(req.params.name);
    if (cfg.mcpServers?.[name]) {
      delete cfg.mcpServers[name];
      writeMcpConfig(cfg);
    }
    await bridge.reload();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Batch upsert multiple MCP servers at once (JSON import), then reload once.
app.post("/api/mcp/servers/batch", async (req, res) => {
  try {
    const servers = req.body?.servers as Record<string, unknown> | undefined;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      res.status(400).json({ error: "需要 servers 对象：{ name: { command, args, ... } }" });
      return;
    }
    const names = Object.keys(servers);
    if (names.length === 0) {
      res.json({ ok: true, count: 0 });
      return;
    }
    for (const [name, config] of Object.entries(servers)) {
      if (!name || typeof name !== "string" || !config || typeof config !== "object") {
        res.status(400).json({ error: `无效的服务项: ${name}` });
        return;
      }
    }
    const cfg = readMcpConfig();
    cfg.mcpServers = { ...(cfg.mcpServers ?? {}), ...servers };
    writeMcpConfig(cfg);
    await bridge.reload();
    res.json({ ok: true, count: names.length });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Browse arbitrary absolute directories for the workspace folder picker.
app.get("/api/dirs", (req, res) => {
  try {
    const path = String(req.query.path ?? "");
    res.json({ entries: bridge.listDirs(path) });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ------------------------------------------------------------- workspaces

app.get("/api/env", (_req, res) => {
  res.json({ home: homedir(), username: process.env.USERNAME ?? "" });
});

app.get("/api/workspaces", (_req, res) => {
  res.json(bridge.listWorkspaces());
});

app.post("/api/workspaces/add", (req, res) => {
  try {
    const path = String(req.body?.path ?? "");
    if (!path) {
      res.status(400).json({ error: "缺少 path" });
      return;
    }
    res.json(bridge.addWorkspace(path));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/workspaces/switch", async (req, res) => {
  try {
    const path = String(req.body?.path ?? "");
    if (!path) {
      res.status(400).json({ error: "缺少 path" });
      return;
    }
    await bridge.switchWorkspace(path);
    res.json(bridge.listWorkspaces());
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.get("/api/workspace/files", (req, res) => {
  try {
    const path = String(req.query.path ?? "");
    res.json({ entries: bridge.listWorkspaceFiles(path) });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.get("/api/workspace/file", async (req, res) => {
  try {
    const path = String(req.query.path ?? "");
    if (!path) throw new Error("缺少 path");
    res.json(await bridge.readWorkspaceFile(path));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// Raw file stream (full content, proper mime) — used by the browser-native PDF
// viewer and oversized images. Express handles Range requests for large files.
app.get("/api/workspace/file/raw", (req, res) => {
  try {
    const path = String(req.query.path ?? "");
    if (!path) throw new Error("缺少 path");
    const abs = bridge.resolveWorkspacePath(path);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`文件不存在: ${path}`);
    res.sendFile(abs, { headers: { "Content-Disposition": "inline" } });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// Parse Office documents (docx / xlsx / xls / pptx) into HTML / tables for preview.
app.post("/api/workspace/file/parse", async (req, res) => {
  try {
    const { parseDocx, parseXlsx, parsePptx } = await import("./parsers.ts");
    const path = String(req.body?.path ?? "");
    if (!path) throw new Error("缺少 path");
    const abs = bridge.resolveWorkspacePath(path);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`文件不存在: ${path}`);
    if (statSync(abs).size > 20 * 1024 * 1024) throw new Error("文件过大（>20MB），无法解析");

    const ext = extname(abs).toLowerCase();
    const buf = readFileSync(abs);
    let parsed: ParsedDoc;
    if (ext === ".docx") parsed = { kind: "docx", html: await parseDocx(buf) };
    else if (ext === ".xlsx" || ext === ".xls") parsed = { kind: "xlsx", sheets: parseXlsx(buf) };
    else if (ext === ".pptx") parsed = { kind: "pptx", html: await parsePptx(buf) };
    else throw new Error(`暂不支持解析该格式: ${ext}`);
    res.json(parsed);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.get("/api/commands", (_req, res) => {
  res.json({ commands: PiBridgeClass.commandList() });
});

// --------------------------------------------------------------- skills

function safeUploadPath(input: string): string {
  const normalized = input.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/");
  if (!normalized || parts.some((part) => !part || part === "." || part === "..") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error("skill 压缩包包含不安全的文件路径");
  }
  return parts.join("/");
}

function copyDirectory(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
  }
}

function findSkillDirectories(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) return [root];
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .flatMap((entry) => findSkillDirectories(join(root, entry.name)));
}

async function materializeSkillUpload(files: Express.Multer.File[], stage: string): Promise<void> {
  const isZip = files.length === 1 && (extname(files[0].originalname).toLowerCase() === ".zip" || files[0].mimetype === "application/zip");
  if (isZip) {
    const { default: JSZip } = await import("jszip");
    const archive = await JSZip.loadAsync(files[0].buffer);
    for (const [name, entry] of Object.entries(archive.files)) {
      if (entry.dir) continue;
      const relativePath = safeUploadPath(name);
      const target = join(stage, ...relativePath.split("/"));
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, await entry.async("nodebuffer"));
    }
    return;
  }

  for (const file of files) {
    const relativePath = safeUploadPath(file.originalname);
    const target = join(stage, ...relativePath.split("/"));
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, file.buffer);
  }
}

app.get("/api/skills", (_req, res) => {
  res.json({ directory: bridge.getSkillsDirectory(), skills: bridge.listSkills() });
});

app.post("/api/skills", async (req, res) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    const description = String(req.body?.description ?? "").trim();
    const instructions = String(req.body?.instructions ?? "").trim();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
      throw new Error("skill 名称只能使用小写字母、数字和单个连字符");
    }
    if (!description || description.length > 1024) throw new Error("请填写 1-1024 个字符的描述");
    if (!instructions) throw new Error("请填写 skill 指令内容");

    const dir = join(bridge.getSkillsDirectory(), name);
    mkdirSync(dir, { recursive: true });
    const quotedDescription = JSON.stringify(description);
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${quotedDescription}\n---\n\n${instructions}\n`,
      "utf8",
    );
    await bridge.reload();
    res.json({ ok: true, skills: bridge.listSkills() });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/skills/import", upload.array("files", 1000), async (req, res) => {
  const stage = mkdtempSync(join(tmpdir(), "pi-studio-skill-import-"));
  try {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) throw new Error("请选择 skill 的 ZIP 文件或文件夹");

    await materializeSkillUpload(files, stage);
    const candidateRoot = join(stage, "candidates");
    mkdirSync(candidateRoot, { recursive: true });
    const candidates = findSkillDirectories(stage).filter((dir) => dir !== candidateRoot && !dir.startsWith(`${candidateRoot}${sep}`));
    if (candidates.length === 0) throw new Error("上传内容中没有找到 SKILL.md");

    for (const [index, candidate] of candidates.entries()) {
      copyDirectory(candidate, join(candidateRoot, `skill-${index}`));
    }
    const { loadSkillsFromDir } = await import("@earendil-works/pi-coding-agent");
    const loaded = loadSkillsFromDir({ dir: candidateRoot, source: "app" });
    if (loaded.skills.length === 0) throw new Error("没有找到有效的 skill；请检查 SKILL.md 的 name、description 和正文");

    const names = new Set<string>();
    for (const skill of loaded.skills) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) || skill.name.length > 64) {
        throw new Error(`skill 名称无效：${skill.name}`);
      }
      if (names.has(skill.name)) throw new Error(`上传内容中存在重复的 skill：${skill.name}`);
      names.add(skill.name);
    }

    for (const skill of loaded.skills) {
      const destination = join(bridge.getSkillsDirectory(), skill.name);
      if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
      copyDirectory(skill.baseDir, destination);
    }
    await bridge.reload();
    res.json({ ok: true, imported: [...names], skills: bridge.listSkills() });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

app.delete("/api/skills/:name", async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("无效的 skill 名称");
    const dir = join(bridge.getSkillsDirectory(), name);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    await bridge.reload();
    res.json({ ok: true, skills: bridge.listSkills() });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ------------------------------------------------------------ model mgmt

app.get("/api/models", (_req, res) => {
  try {
    res.json(bridge.listModels());
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.get("/api/models/config", (_req, res) => {
  res.json(bridge.readModelsJson());
});

app.post("/api/models/register", async (req, res) => {
  try {
    const name = String(req.body?.name ?? "");
    const config = req.body?.config as Record<string, unknown> | undefined;
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      res.status(400).json({ error: "需要 config 对象" });
      return;
    }
    bridge.registerProviderConfig(name, config);
    const { errors } = await bridge.refreshModels();
    res.json({ ok: true, name, errors });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/models/unregister", async (req, res) => {
  try {
    const name = String(req.body?.name ?? "");
    bridge.unregisterProviderConfig(name);
    const { errors } = await bridge.refreshModels();
    res.json({ ok: true, name, errors });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/models/api-key", async (req, res) => {
  try {
    const provider = String(req.body?.provider ?? "");
    const apiKey = String(req.body?.apiKey ?? "");
    if (!provider || !apiKey) {
      res.status(400).json({ error: "需要 provider 和 apiKey" });
      return;
    }
    await bridge.setProviderApiKey(provider, apiKey);
    res.json({ ok: true, provider });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.delete("/api/models/api-key", async (req, res) => {
  try {
    const provider = String(req.query.provider ?? "");
    if (!provider) {
      res.status(400).json({ error: "缺少 provider" });
      return;
    }
    await bridge.removeProviderApiKey(provider);
    res.json({ ok: true, provider });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ---------------------------------------------------------------- agents

app.get("/api/agents", (_req, res) => {
  res.json({ agents: bridge.listAgents(), activeAgentId: bridge.getActiveAgent().id });
});

app.post("/api/agents", async (req, res) => {
  try {
    const agent = await bridge.saveAgent({
      id: String(req.body?.id ?? ""),
      name: String(req.body?.name ?? ""),
      description: String(req.body?.description ?? ""),
      prompt: String(req.body?.prompt ?? ""),
      memory: String(req.body?.memory ?? ""),
    });
    res.json({ ok: true, agent });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.delete("/api/agents/:id", async (req, res) => {
  try {
    await bridge.removeAgent(decodeURIComponent(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/agents/active", async (req, res) => {
  try {
    await bridge.setActiveAgent(String(req.body?.id ?? ""));
    res.json({ ok: true, activeAgent: bridge.getActiveAgent() });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ---------------------------------------------------------------- projects

app.get("/api/projects", (_req, res) => {
  res.json(bridge.listProjects());
});

app.post("/api/projects", (req, res) => {
  try {
    const project = bridge.createProject({
      name: String(req.body?.name ?? ""),
      description: req.body?.description === undefined ? undefined : String(req.body.description),
      workspacePath: req.body?.workspacePath ? String(req.body.workspacePath) : undefined,
      instructions: req.body?.instructions === undefined ? undefined : String(req.body.instructions),
    });
    res.json(project);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.get("/api/projects/:id", (req, res) => {
  try {
    res.json(bridge.getProject(decodeURIComponent(req.params.id)));
  } catch (e) {
    res.status(404).json({ error: (e as Error).message });
  }
});

app.patch("/api/projects/:id", async (req, res) => {
  try {
    const project = await bridge.updateProject(decodeURIComponent(req.params.id), {
      name: req.body?.name === undefined ? undefined : String(req.body.name),
      description: req.body?.description === undefined ? undefined : String(req.body.description),
      workspacePath: req.body?.workspacePath === undefined ? undefined : (req.body.workspacePath ? String(req.body.workspacePath) : null),
      instructions: req.body?.instructions === undefined ? undefined : String(req.body.instructions),
    });
    res.json(project);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.delete("/api/projects/:id", async (req, res) => {
  try {
    await bridge.removeProject(decodeURIComponent(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/projects/:id/sessions", async (req, res) => {
  try {
    const file = String(req.body?.file ?? "");
    if (!file) throw new Error("Missing session file");
    res.json(await bridge.assignSessionToProject(file, decodeURIComponent(req.params.id)));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.delete("/api/projects/:id/sessions", async (req, res) => {
  try {
    const file = String(req.body?.file ?? "");
    if (!file) throw new Error("Missing session file");
    await bridge.assignSessionToProject(file, null);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/projects/:id/memories", async (req, res) => {
  try {
    const memory = await bridge.saveProjectMemory(decodeURIComponent(req.params.id), {
      id: req.body?.id ? String(req.body.id) : undefined,
      content: String(req.body?.content ?? ""),
      type: req.body?.type,
      pinned: req.body?.pinned === undefined ? undefined : !!req.body.pinned,
      sourceSessionId: req.body?.sourceSessionId ? String(req.body.sourceSessionId) : undefined,
    });
    res.json(memory);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.delete("/api/projects/:id/memories/:memoryId", async (req, res) => {
  try {
    await bridge.removeProjectMemory(decodeURIComponent(req.params.id), decodeURIComponent(req.params.memoryId));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.get("/api/projects/:id/search", async (req, res) => {
  try {
    const query = String(req.query.q ?? "");
    res.json(await bridge.searchProject(decodeURIComponent(req.params.id), query));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/projects/:id/documents", async (req, res) => {
  try {
    const document = await bridge.addProjectDocument(decodeURIComponent(req.params.id), {
      path: String(req.body?.path ?? ""),
      name: req.body?.name ? String(req.body.name) : undefined,
      summary: req.body?.summary ? String(req.body.summary) : undefined,
    });
    res.json(document);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.delete("/api/projects/:id/documents/:documentId", async (req, res) => {
  try {
    await bridge.removeProjectDocument(decodeURIComponent(req.params.id), decodeURIComponent(req.params.documentId));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ------------------------------------------------------------------ misc API

app.get("/api/state", (_req, res) => {
  res.json(bridge.getState());
});

app.get("/api/sessions", async (_req, res) => {
  res.json(await bridge.listSessions());
});

app.delete("/api/sessions", async (req, res) => {
  try {
    const file = String(req.body?.file ?? "");
    if (!file) throw new Error("Missing session file");
    res.json({ ok: true, ...(await bridge.deleteSession(file)) });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ------------------------------------------------------------ static client

const indexHtml = join(CLIENT_DIST, "index.html");
if (existsSync(indexHtml)) {
  app.use(express.static(CLIENT_DIST));
  app.get(/^\/(?!api\/|ws).*/, (_req, res) => {
    res.sendFile(indexHtml);
  });
}

// -------------------------------------------------------------------- WS

const server = createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/ws",
  verifyClient(info, done) {
    const origin = info.origin || undefined;
    const authorized = !AUTH_TOKEN || safeEqual(requestToken(info.req), AUTH_TOKEN);
    if (!allowedOrigin(origin)) {
      done(false, 403, "Forbidden origin");
      return;
    }
    if (!authorized) {
      done(false, 401, "Unauthorized");
      return;
    }
    done(true);
  },
});
app.get("/api/subagents", (_req, res) => res.json({ enabled: bridge.isSubagentsEnabled() }));
app.post("/api/subagents", async (req, res) => { try { await bridge.setSubagentsEnabled(!!req.body.enabled); res.json({ enabled: bridge.isSubagentsEnabled() }); } catch(e) { res.status(400).json({ error:(e as Error).message }); } });
app.get("/api/goals", (_req,res)=>res.json(bridge.getGoalSettings()));
app.post("/api/goals", async (req,res)=>{try{await bridge.setGoalsEnabled(!!req.body.enabled,String(req.body.goal??""));res.json(bridge.getGoalSettings());}catch(e){res.status(400).json({error:(e as Error).message})}});

app.get("/api/schedules", (_req, res) => res.json(scheduler.list()));
app.post("/api/schedules", (req, res) => {
  try { res.json(scheduler.saveTask(req.body as Omit<ScheduledTask, "id" | "nextRunAt" | "lastRunAt" | "lastStatus" | "lastResult"> & { id?: string })); }
  catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
app.post("/api/schedules/:id/run", async (req, res) => { try { await scheduler.trigger(req.params.id); res.json({ ok: true }); } catch(e) { res.status(400).json({error:(e as Error).message}); } });
app.post("/api/schedules/:id/enabled", (req, res) => { try { res.json(scheduler.setEnabled(req.params.id, !!req.body.enabled)); } catch(e) { res.status(400).json({error:(e as Error).message}); } });
app.delete("/api/schedules/:id", (req,res) => { scheduler.remove(req.params.id); res.json({ok:true}); });

function send(ws: WebSocket, msg: ServerWsMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg: ServerWsMessage): void {
  for (const client of wss.clients) send(client, msg);
}

async function attachWebSocket(ws: WebSocket): Promise<void> {
  const waitingForBoot = bootState === "booting";
  if (waitingForBoot) {
    send(ws, { type: "booting", phase: "starting", message: "AI engine initializing" });
  }
  try {
    await bridgeReady;
  } catch (error) {
    send(ws, { type: "boot_error", message: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (!waitingForBoot) {
    send(ws, {
      type: "ready",
      state: bridge.getState(),
      sessions: initialSessions,
      workspaces: initialWorkspaces,
    });
  }

  const onState = (state: AppState) => send(ws, { type: "state", state });
  const onEvent = (event: unknown) => send(ws, { type: "event", event });
  const onMcp = (snapshot: McpStatusSnapshot) => send(ws, { type: "mcp_status", snapshot });
  const onSessions = (sessions: SessionMeta[]) => send(ws, { type: "sessions", sessions });
  const onWorkspaces = (workspaces: WorkspaceInfo[]) => send(ws, { type: "workspaces", workspaces });
  const onLog = (level: "info" | "warn" | "error", message: string) => send(ws, { type: "log", level, message });
  const onError = (message: string) => send(ws, { type: "error", message });
  const onAskUser = (question: import("./types.ts").AskUserQuestion) => send(ws, { type: "ask_user", question });
  const onWechatStatus = (status: WechatStatus) => send(ws, { type: "wechat_status", status });
  const onWechatQr = (qr: WechatQr) => send(ws, { type: "wechat_qr", qr });
  const onWechatLog = (entry: WechatLogEntry) => send(ws, { type: "wechat_log", entry });

  bridge.on("state", onState);
  bridge.on("event", onEvent);
  bridge.on("mcp_status", onMcp);
  bridge.on("sessions", onSessions);
  bridge.on("workspaces", onWorkspaces);
  bridge.on("log", onLog);
  bridge.on("error", onError);
  bridge.on("ask_user", onAskUser);
  bridge.on("wechat_status", onWechatStatus);
  bridge.on("wechat_qr", onWechatQr);
  bridge.on("wechat_log", onWechatLog);

  ws.on("close", () => {
    bridge.off("state", onState);
    bridge.off("event", onEvent);
    bridge.off("mcp_status", onMcp);
    bridge.off("sessions", onSessions);
    bridge.off("workspaces", onWorkspaces);
    bridge.off("log", onLog);
    bridge.off("error", onError);
    bridge.off("ask_user", onAskUser);
    bridge.off("wechat_status", onWechatStatus);
    bridge.off("wechat_qr", onWechatQr);
    bridge.off("wechat_log", onWechatLog);
  });

  let promptQueue: Promise<void> = Promise.resolve();
  ws.on("message", (raw) => {
    let msg: ClientWsMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientWsMessage;
    } catch {
      return;
    }

    // Prompt calls must be processed in arrival order. The SDK keeps the
    // streaming state on the session, so starting two prompt handlers at the
    // same time can make both of them observe `isStreaming === false` and
    // launch duplicate agent runs. Keep steering, follow-up, and abort
    // commands immediate so they can still control a running task.
    if (msg.type === "prompt") {
      const previous = promptQueue.catch(() => undefined);
      promptQueue = previous.then(() => handleClientMessage(ws, msg));
      return;
    }
    void handleClientMessage(ws, msg);
  });
}

wss.on("connection", (ws) => {
  void attachWebSocket(ws).catch((error) => {
    send(ws, { type: "error", message: error instanceof Error ? error.message : String(error) });
  });
});

async function handleClientMessage(ws: WebSocket, msg: ClientWsMessage): Promise<void> {
  try {
    switch (msg.type) {
      case "prompt": {
        send(ws, { type: "log", level: "info", message: "已发送" });
        await bridge.prompt(msg.text, msg.attachments, msg.refs);
        break;
      }
      case "steer":
        await bridge.steer(msg.text);
        break;
      case "followUp":
        await bridge.followUp(msg.text);
        break;
      case "abort":
        await bridge.abort();
        break;
      case "new_session":
        await bridge.newSession();
        break;
      case "list_sessions": {
        const sessions = await bridge.listSessions();
        send(ws, { type: "sessions", sessions });
        break;
      }
      case "switch_session":
        await bridge.switchSession(msg.file);
        break;
      case "set_model":
        await bridge.setModel(msg.provider, msg.id);
        break;
      case "set_thinking":
        await bridge.setThinking(msg.level);
        break;
      case "mcp_command":
        await bridge.runMcpCommand(msg.command);
        break;
      case "command": {
        const result = await bridge.runCommand(msg.command);
        send(ws, { type: "log", level: "info", message: result });
        break;
      }
      case "switch_workspace":
        await bridge.switchWorkspace(msg.path);
        break;
      case "add_workspace":
        bridge.addWorkspace(msg.path);
        break;
      case "ask_user_answer":
        bridge.answerUserQuestion(msg.id, msg.answer);
        break;
      case "wechat_command":
        await bridge.runWechatCommand(msg.action);
        break;
    }
  } catch (e) {
    send(ws, { type: "error", message: (e as Error).message });
  }
}

// -------------------------------------------------------------------- start

async function startBridge(): Promise<void> {
  if (bridgeStarting) {
    await bridgeReady.catch(() => undefined);
    return;
  }
  bridgeStarting = true;
  bootState = "booting";
  bootError = "";
  initialSessions = [];
  initialWorkspaces = [];
  resetBridgeReady();
  broadcast({ type: "booting", phase: "starting", message: "AI engine initializing" });
  startupLog("bridge-start");

  let nextBridge: PiBridge | undefined;
  try {
    startupLog("import-bridge-start");
    ({ PiBridge: PiBridgeClass } = await import("./bridge.ts"));
    startupLog("import-bridge-done");
    nextBridge = new PiBridgeClass({
      cwd: WORKSPACE,
      agentDir: AGENT_DIR,
      mcpConfigPath: mcpConfigFile(),
      loadGlobalExtensions: process.env.PI_STUDIO_LOAD_GLOBAL_EXTENSIONS === "1",
    });
    broadcast({ type: "booting", phase: "runtime", message: "Loading current model and session" });
    await nextBridge.start();
    startupLog("bridge-started");
    bridge = nextBridge;
    scheduler = new Scheduler(join(AGENT_DIR, "schedules.json"), async (task) => {
      const previous = bridge.getActiveAgent().id;
      if (task.agentId && task.agentId !== previous) await bridge.setActiveAgent(task.agentId);
      await bridge.prompt(`[Scheduled task: ${task.name}]\n${task.prompt}\n\nThis is a scheduled task. Return a concise result summary when complete.`);
      if (task.agentId && task.agentId !== previous) await bridge.setActiveAgent(previous);
    });
    startupLog("scheduler-created");
    bootState = "ready";
    resolveBridgeReady(bridge);
    startupLog("bridge-ready");
    broadcast({ type: "ready", state: bridge.getState() });

    // Session and workspace listings no longer gate the ready broadcast.
    void (async () => {
      try {
        const [sessions, workspaces] = await Promise.all([
          nextBridge.listSessions().catch((error) => {
            startupLog("sessions-load-failed", error instanceof Error ? error.message : String(error));
            return [] as SessionMeta[];
          }),
          Promise.resolve(nextBridge.listWorkspaces()),
        ]);
        initialSessions = sessions;
        initialWorkspaces = workspaces;
        startupLog("initial-state-loaded", `sessions=${sessions.length} workspaces=${workspaces.length}`);
        broadcast({ type: "initial_state", sessions, workspaces });
      } catch (error) {
        startupLog("initial-state-failed", error instanceof Error ? error.message : String(error));
      }
    })();
  } catch (error) {
    if (nextBridge) await nextBridge.dispose();
    bridge = undefined as unknown as PiBridge;
    scheduler = undefined as unknown as Scheduler;
    bootState = "error";
    bootError = error instanceof Error ? error.message : String(error);
    startupLog("bridge-failed", bootError);
    rejectBridgeReady(error);
    broadcast({ type: "boot_error", message: bootError });
  } finally {
    bridgeStarting = false;
  }
}

async function main(): Promise<void> {
  startupLog("process-start");
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
    startupLog("http-listening", `port=${PORT}`);
    console.log("");
    console.log("  Pi Studio 已启动");
    console.log(`  前端:  http://localhost:${PORT}`);
    console.log(`  工作区: ${WORKSPACE}`);
    console.log(`  MCP 配置: ${mcpConfigFile()}`);
    console.log("");
    void startBridge();
  });
}

main().catch((e) => {
  console.error("启动失败:", e);
  process.exit(1);
});
