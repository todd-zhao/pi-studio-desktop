import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

export const DATA_DIR = process.env.PI_STUDIO_DATA_DIR ? resolve(process.env.PI_STUDIO_DATA_DIR) : join(ROOT, "data");
export const DEFAULT_WORKSPACE = process.env.PI_STUDIO_WORKSPACE ? resolve(process.env.PI_STUDIO_WORKSPACE) : join(ROOT, "workspace");

function resolveInitialWorkspace(): string {
  try {
    const workspacesFile = process.env.PI_STUDIO_WORKSPACES_FILE ? resolve(process.env.PI_STUDIO_WORKSPACES_FILE) : join(DATA_DIR, "workspaces.json");
    const data = JSON.parse(readFileSync(workspacesFile, "utf8")) as { active?: string };
    if (typeof data.active === "string" && data.active) {
      const abs = resolve(data.active);
      if (existsSync(abs) && statSync(abs).isDirectory()) return abs;
    }
  } catch {
    /* first launch or missing workspace file */
  }
  return DEFAULT_WORKSPACE;
}

export const WORKSPACE = resolveInitialWorkspace();
export const CLIENT_DIST = join(ROOT, "client", "dist");
export const PORT = Number(process.env.PI_STUDIO_PORT ?? 8787);
export const AUTH_TOKEN = process.env.PI_STUDIO_AUTH_TOKEN ?? "";
export const APP_ORIGIN = `http://127.0.0.1:${PORT}`;
export const ALLOWED_ORIGINS = new Set([
  APP_ORIGIN,
  `http://localhost:${PORT}`,
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  ...(process.env.PI_STUDIO_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
]);
export const AGENT_DIR = process.env.PI_CODING_AGENT_DIR
  ? resolve(process.env.PI_CODING_AGENT_DIR)
  : join(DATA_DIR, "pi-agent");
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

export function mcpConfigFile(): string {
  return join(AGENT_DIR, "mcp.json");
}

mkdirSync(join(DEFAULT_WORKSPACE, "uploads"), { recursive: true });