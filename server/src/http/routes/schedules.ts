import { Router } from "express";
import type { ServerContext } from "../../context.ts";
import type { ScheduledTask } from "../../scheduler.ts";

export function createSchedulesRouter(ctx: ServerContext): Router {
  const router = Router();

  router.get("/subagents", (_req, res) => res.json({ enabled: ctx.bridge.isSubagentsEnabled() }));
  router.post("/subagents", async (req, res) => {
    try {
      await ctx.bridge.setSubagentsEnabled(!!req.body.enabled);
      res.json({ enabled: ctx.bridge.isSubagentsEnabled() });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.get("/goals", (_req, res) => res.json(ctx.bridge.getGoalSettings()));
  router.post("/goals", async (req, res) => {
    try {
      await ctx.bridge.setGoalsEnabled(!!req.body.enabled, String(req.body.goal ?? ""));
      res.json(ctx.bridge.getGoalSettings());
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.get("/schedules", (_req, res) => res.json(ctx.scheduler.list()));
  router.post("/schedules", (req, res) => {
    try {
      res.json(ctx.scheduler.saveTask(req.body as Omit<ScheduledTask, "id" | "nextRunAt" | "lastRunAt" | "lastStatus" | "lastResult"> & { id?: string }));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });
  router.post("/schedules/:id/run", async (req, res) => {
    try {
      await ctx.scheduler.trigger(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });
  router.post("/schedules/:id/enabled", (req, res) => {
    try {
      res.json(ctx.scheduler.setEnabled(req.params.id, !!req.body.enabled));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });
  router.delete("/schedules/:id", (req, res) => {
    ctx.scheduler.remove(req.params.id);
    res.json({ ok: true });
  });

  return router;
}
