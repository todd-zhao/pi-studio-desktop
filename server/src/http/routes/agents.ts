import { Router } from "express";
import type { ServerContext } from "../../context.ts";

export function createAgentsRouter(ctx: ServerContext): Router {
  const router = Router();

  router.get("/agents", (_req, res) => {
    res.json({ agents: ctx.bridge.listAgents(), activeAgentId: ctx.bridge.getActiveAgent().id });
  });

  router.post("/agents", async (req, res) => {
    try {
      const agent = await ctx.bridge.saveAgent({
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

  router.delete("/agents/:id", async (req, res) => {
    try {
      await ctx.bridge.removeAgent(decodeURIComponent(req.params.id));
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.post("/agents/active", async (req, res) => {
    try {
      await ctx.bridge.setActiveAgent(String(req.body?.id ?? ""));
      res.json({ ok: true, activeAgent: ctx.bridge.getActiveAgent() });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  return router;
}