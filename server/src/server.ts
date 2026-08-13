import { existsSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import type { PiBridge } from "./bridge.ts";
import { Scheduler } from "./scheduler.ts";
import { AGENT_DIR, CLIENT_DIST, DEFAULT_WORKSPACE, WORKSPACE, mcpConfigFile } from "./config.ts";
import type { ServerContext } from "./context.ts";
import {
  authMiddleware,
  corsMiddleware,
  createBridgeReadyGate,
  jsonBody,
  securityHeaders,
} from "./http/middleware.ts";
import { createAgentsRouter } from "./http/routes/agents.ts";
import { createMcpRouter } from "./http/routes/mcp.ts";
import { createModelsRouter } from "./http/routes/models.ts";
import { createProjectsRouter } from "./http/routes/projects.ts";
import { createSchedulesRouter } from "./http/routes/schedules.ts";
import { createSessionsRouter } from "./http/routes/sessions.ts";
import { createSkillsRouter } from "./http/routes/skills.ts";
import { createUploadRouter } from "./http/routes/upload.ts";
import { createWorkspacesRouter } from "./http/routes/workspaces.ts";
import type { SessionMeta } from "@pi-studio/shared";

export function createApp(ctx: ServerContext): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.use(corsMiddleware);
  app.use(jsonBody);
  // Protect only the API surface; static client assets are served without a
  // token (the renderer attaches tokens to API calls and preview URLs). The
  // preview cookie check in authMiddleware relies on req.originalUrl keeping
  // the /api prefix.
  app.use("/api", authMiddleware);

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, ready: ctx.bootState === "ready", booting: ctx.bootState === "booting", error: ctx.bootError || undefined });
  });

  // This route intentionally sits before the bridge-ready gate so the renderer
  // can recover from an initialization failure without restarting Electron.
  app.post("/api/runtime/retry", async (_req, res) => {
    if (ctx.bootState === "booting") {
      res.status(202).json({ ok: true, state: ctx.bootState });
      return;
    }
    await startBridge(ctx);
    res.status(ctx.bootState === "ready" ? 200 : 503).json({
      ok: ctx.bootState === "ready",
      state: ctx.bootState,
      error: ctx.bootError || undefined,
    });
  });

  // Serve the application shell immediately while the heavier Pi runtime starts.
  app.use("/api", createBridgeReadyGate(ctx));
  app.use("/api", createUploadRouter(ctx));
  app.use("/api", createMcpRouter(ctx));
  app.use("/api", createWorkspacesRouter(ctx));
  app.use("/api", createSkillsRouter(ctx));
  app.use("/api", createModelsRouter(ctx));
  app.use("/api", createAgentsRouter(ctx));
  app.use("/api", createProjectsRouter(ctx));
  app.use("/api", createSessionsRouter(ctx));
  app.use("/api", createSchedulesRouter(ctx));

  // ------------------------------------------------------------ static client
  const indexHtml = join(CLIENT_DIST, "index.html");
  if (existsSync(indexHtml)) {
    app.use(express.static(CLIENT_DIST));
    app.get(/^\/(?!api\/|ws).*/, (_req, res) => {
      res.sendFile(indexHtml);
    });
  }

  return app;
}

async function startBridge(ctx: ServerContext): Promise<void> {
  if (ctx.bridgeStarting) {
    await ctx.bridgeReady.catch(() => undefined);
    return;
  }
  ctx.bridgeStarting = true;
  ctx.bootState = "booting";
  ctx.bootError = "";
  ctx.initialSessions = [];
  ctx.initialWorkspaces = [];
  ctx.resetBridgeReady();
  ctx.broadcast({ type: "booting", phase: "starting", message: "AI engine initializing" });
  ctx.startupLog("bridge-start");

  let nextBridge: PiBridge | undefined;
  try {
    ctx.startupLog("import-bridge-start");
    ctx.PiBridgeClass = (await import("./bridge.ts")).PiBridge;
    ctx.startupLog("import-bridge-done");
    nextBridge = new ctx.PiBridgeClass({
      cwd: WORKSPACE,
      defaultWorkspacePath: DEFAULT_WORKSPACE,
      agentDir: AGENT_DIR,
      mcpConfigPath: mcpConfigFile(),
      loadGlobalExtensions: process.env.PI_STUDIO_LOAD_GLOBAL_EXTENSIONS === "1",
    });
    ctx.broadcast({ type: "booting", phase: "runtime", message: "Loading current model and session" });
    await nextBridge.start();
    ctx.startupLog("bridge-started");
    ctx.bridge = nextBridge;
    ctx.scheduler = new Scheduler(join(AGENT_DIR, "schedules.json"), async (task) => {
      const previous = ctx.bridge.getActiveAgent().id;
      if (task.agentId && task.agentId !== previous) await ctx.bridge.setActiveAgent(task.agentId);
      await ctx.bridge.prompt(`[Scheduled task: ${task.name}]\n${task.prompt}\n\nThis is a scheduled task. Return a concise result summary when complete.`);
      if (task.agentId && task.agentId !== previous) await ctx.bridge.setActiveAgent(previous);
    });
    ctx.startupLog("scheduler-created");
    ctx.bootState = "ready";
    ctx.resolveBridgeReady(ctx.bridge);
    ctx.startupLog("bridge-ready");
    ctx.broadcast({ type: "ready", state: ctx.bridge.getState() });

    // Session and workspace listings no longer gate the ready broadcast.
    void (async () => {
      try {
        const [sessions, workspaces] = await Promise.all([
          nextBridge!.listSessions().catch((error) => {
            ctx.startupLog("sessions-load-failed", error instanceof Error ? error.message : String(error));
            return [] as SessionMeta[];
          }),
          Promise.resolve(nextBridge!.listWorkspaces()),
        ]);
        ctx.initialSessions = sessions;
        ctx.initialWorkspaces = workspaces;
        ctx.startupLog("initial-state-loaded", `sessions=${sessions.length} workspaces=${workspaces.length}`);
        ctx.broadcast({ type: "initial_state", sessions, workspaces });
      } catch (error) {
        ctx.startupLog("initial-state-failed", error instanceof Error ? error.message : String(error));
      }
    })();
  } catch (error) {
    if (nextBridge) await nextBridge.dispose();
    ctx.bridge = undefined as unknown as PiBridge;
    ctx.scheduler = undefined as unknown as Scheduler;
    ctx.bootState = "error";
    ctx.bootError = error instanceof Error ? error.message : String(error);
    ctx.startupLog("bridge-failed", ctx.bootError);
    ctx.rejectBridgeReady(error);
    ctx.broadcast({ type: "boot_error", message: ctx.bootError });
  } finally {
    ctx.bridgeStarting = false;
  }
}

export { startBridge };
