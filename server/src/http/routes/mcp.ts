import { Router } from "express";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ServerContext } from "../../context.ts";
import { mcpConfigFile } from "../../config.ts";

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

export function createMcpRouter(ctx: ServerContext): Router {
  const router = Router();

  router.get("/mcp/config", (_req, res) => {
    res.json(readMcpConfig());
  });

  router.post("/mcp/servers", async (req, res) => {
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
      await ctx.bridge.reload();
      res.json({ ok: true, name });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.delete("/mcp/servers/:name", async (req, res) => {
    try {
      const cfg = readMcpConfig();
      const name = decodeURIComponent(req.params.name);
      if (cfg.mcpServers?.[name]) {
        delete cfg.mcpServers[name];
        writeMcpConfig(cfg);
      }
      await ctx.bridge.reload();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Batch upsert multiple MCP servers at once (JSON import), then reload once.
  router.post("/mcp/servers/batch", async (req, res) => {
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
      await ctx.bridge.reload();
      res.json({ ok: true, count: names.length });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Browse arbitrary absolute directories for the workspace folder picker.
  router.get("/dirs", (req, res) => {
    try {
      const path = String(req.query.path ?? "");
      res.json({ entries: ctx.bridge.listDirs(path) });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  return router;
}