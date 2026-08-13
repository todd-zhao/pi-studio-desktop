import { Router } from "express";
import type { ServerContext } from "../../context.ts";

export function createProjectsRouter(ctx: ServerContext): Router {
  const router = Router();

  router.get("/projects", (_req, res) => {
    res.json(ctx.bridge.listProjects());
  });

  router.get("/projects/archived", (_req, res) => {
    res.json(ctx.bridge.listArchivedProjects());
  });

  router.post("/projects", (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const workspacePaths = Array.isArray(body.workspacePaths)
        ? body.workspacePaths.map((item) => String(item))
        : undefined;
      const project = ctx.bridge.createProject({
        name: String(body.name ?? ""),
        description: body.description === undefined ? undefined : String(body.description),
        workspacePaths,
        workspacePath: workspacePaths === undefined && body.workspacePath ? String(body.workspacePath) : undefined,
        mainWorkspacePath: body.mainWorkspacePath === undefined ? undefined : (body.mainWorkspacePath ? String(body.mainWorkspacePath) : null),
        instructions: body.instructions === undefined ? undefined : String(body.instructions),
      });
      res.json(project);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.get("/projects/:id", (req, res) => {
    try {
      res.json(ctx.bridge.getProject(decodeURIComponent(req.params.id)));
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });

  router.patch("/projects/:id", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const workspacePaths = Array.isArray(body.workspacePaths)
        ? body.workspacePaths.map((item) => String(item))
        : undefined;
      const project = await ctx.bridge.updateProject(decodeURIComponent(req.params.id), {
        name: body.name === undefined ? undefined : String(body.name),
        description: body.description === undefined ? undefined : String(body.description),
        workspacePaths,
        workspacePath: workspacePaths === undefined && body.workspacePath !== undefined ? (body.workspacePath ? String(body.workspacePath) : null) : undefined,
        mainWorkspacePath: body.mainWorkspacePath === undefined ? undefined : (body.mainWorkspacePath ? String(body.mainWorkspacePath) : null),
        instructions: body.instructions === undefined ? undefined : String(body.instructions),
      });
      res.json(project);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.delete("/projects/:id", async (req, res) => {
    try {
      await ctx.bridge.removeProject(decodeURIComponent(req.params.id));
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.post("/projects/:id/archive", async (req, res) => {
    try {
      await ctx.bridge.archiveProject(decodeURIComponent(req.params.id));
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.post("/projects/:id/restore", async (req, res) => {
    try {
      await ctx.bridge.restoreProject(decodeURIComponent(req.params.id));
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.post("/projects/:id/sessions", async (req, res) => {
    try {
      const file = String(req.body?.file ?? "");
      if (!file) throw new Error("Missing session file");
      res.json(await ctx.bridge.assignSessionToProject(file, decodeURIComponent(req.params.id)));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.delete("/projects/:id/sessions", async (req, res) => {
    try {
      const file = String(req.body?.file ?? "");
      if (!file) throw new Error("Missing session file");
      await ctx.bridge.assignSessionToProject(file, null);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.post("/projects/:id/memories", async (req, res) => {
    try {
      const memory = await ctx.bridge.saveProjectMemory(decodeURIComponent(req.params.id), {
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

  router.delete("/projects/:id/memories/:memoryId", async (req, res) => {
    try {
      await ctx.bridge.removeProjectMemory(decodeURIComponent(req.params.id), decodeURIComponent(req.params.memoryId));
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.get("/projects/:id/search", async (req, res) => {
    try {
      const query = String(req.query.q ?? "");
      res.json(await ctx.bridge.searchProject(decodeURIComponent(req.params.id), query));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.post("/projects/:id/documents", async (req, res) => {
    try {
      const document = await ctx.bridge.addProjectDocument(decodeURIComponent(req.params.id), {
        path: String(req.body?.path ?? ""),
        name: req.body?.name ? String(req.body.name) : undefined,
        summary: req.body?.summary ? String(req.body.summary) : undefined,
      });
      res.json(document);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.delete("/projects/:id/documents/:documentId", async (req, res) => {
    try {
      await ctx.bridge.removeProjectDocument(decodeURIComponent(req.params.id), decodeURIComponent(req.params.documentId));
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  return router;
}
