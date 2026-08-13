import { Router } from "express";
import type { ServerContext } from "../../context.ts";

export function createModelsRouter(ctx: ServerContext): Router {
  const router = Router();

  router.get("/models", (_req, res) => {
    try {
      res.json(ctx.bridge.listModels());
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.get("/models/config", (_req, res) => {
    res.json(ctx.bridge.readModelsJson());
  });

  router.post("/models/register", async (req, res) => {
    try {
      const name = String(req.body?.name ?? "");
      const config = req.body?.config as Record<string, unknown> | undefined;
      if (!config || typeof config !== "object" || Array.isArray(config)) {
        res.status(400).json({ error: "需要 config 对象" });
        return;
      }
      ctx.bridge.registerProviderConfig(name, config);
      const { errors } = await ctx.bridge.refreshModels();
      res.json({ ok: true, name, errors });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.post("/models/unregister", async (req, res) => {
    try {
      const name = String(req.body?.name ?? "");
      ctx.bridge.unregisterProviderConfig(name);
      const { errors } = await ctx.bridge.refreshModels();
      res.json({ ok: true, name, errors });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.post("/models/api-key", async (req, res) => {
    try {
      const provider = String(req.body?.provider ?? "");
      const apiKey = String(req.body?.apiKey ?? "");
      if (!provider || !apiKey) {
        res.status(400).json({ error: "需要 provider 和 apiKey" });
        return;
      }
      await ctx.bridge.setProviderApiKey(provider, apiKey);
      res.json({ ok: true, provider });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.delete("/models/api-key", async (req, res) => {
    try {
      const provider = String(req.query.provider ?? "");
      if (!provider) {
        res.status(400).json({ error: "缺少 provider" });
        return;
      }
      await ctx.bridge.removeProviderApiKey(provider);
      res.json({ ok: true, provider });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  return router;
}