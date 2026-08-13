import { Router } from "express";
import type { ServerContext } from "../../context.ts";

export function createSessionsRouter(ctx: ServerContext): Router {
  const router = Router();

  router.get("/state", (_req, res) => {
    res.json(ctx.bridge.getState());
  });

  router.get("/sessions", async (_req, res) => {
    res.json(await ctx.bridge.listSessions());
  });

  router.delete("/sessions", async (req, res) => {
    try {
      const file = String(req.body?.file ?? "");
      if (!file) throw new Error("Missing session file");
      res.json({ ok: true, ...(await ctx.bridge.deleteSession(file)) });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.get("/archived-sessions", async (_req, res) => {
    res.json(await ctx.bridge.listArchivedSessions());
  });

  router.post("/sessions/archive", async (req, res) => {
    try {
      const file = String(req.body?.file ?? "");
      if (!file) throw new Error("Missing session file");
      res.json({ ok: true, ...(await ctx.bridge.archiveSession(file)) });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.post("/sessions/restore", async (req, res) => {
    try {
      const file = String(req.body?.file ?? "");
      if (!file) throw new Error("Missing session file");
      await ctx.bridge.restoreSession(file);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.delete("/archived-sessions", async (req, res) => {
    try {
      const file = String(req.body?.file ?? "");
      if (!file) throw new Error("Missing session file");
      res.json({ ok: true, ...(await ctx.bridge.deleteArchivedSession(file)) });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  return router;
}
