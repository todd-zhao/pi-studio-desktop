import { Router } from "express";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname } from "node:path";
import { AUTH_TOKEN } from "../../config.ts";
import type { ServerContext } from "../../context.ts";
import type { ParsedDoc } from "../../parsers.ts";
import { requestToken } from "../middleware.ts";

export function createWorkspacesRouter(ctx: ServerContext): Router {
  const router = Router();

  router.get("/env", (_req, res) => {
    res.json({ home: homedir(), username: process.env.USERNAME ?? "" });
  });

  router.get("/workspaces", (_req, res) => {
    res.json(ctx.bridge.listWorkspaces());
  });

  router.post("/workspaces/add", (req, res) => {
    try {
      const path = String(req.body?.path ?? "");
      if (!path) {
        res.status(400).json({ error: "缺少 path" });
        return;
      }
      res.json(ctx.bridge.addWorkspace(path));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.post("/workspaces/switch", async (req, res) => {
    try {
      const path = String(req.body?.path ?? "");
      if (!path) {
        res.status(400).json({ error: "缺少 path" });
        return;
      }
      await ctx.bridge.switchWorkspace(path);
      res.json(ctx.bridge.listWorkspaces());
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.get("/workspace/files", (req, res) => {
    try {
      const path = String(req.query.path ?? "");
      const root = String(req.query.root ?? "");
      res.json({ entries: ctx.bridge.listWorkspaceFiles(path, root || undefined) });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.post("/workspace/files/move", (req, res) => {
    try {
      const source = String(req.body?.source ?? "");
      const destination = String(req.body?.destination ?? "");
      const root = String(req.body?.root ?? "");
      if (!source || !destination) throw new Error("缺少源文件或目标文件夹");
      ctx.bridge.moveWorkspaceFile(source, destination, root || undefined);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.get("/workspace/file", async (req, res) => {
    try {
      const path = String(req.query.path ?? "");
      const root = String(req.query.root ?? "");
      if (!path) throw new Error("缺少 path");
      res.json(await ctx.bridge.readWorkspaceFile(path, root || undefined));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Path-based HTML preview so relative CSS/JS/images inside the document resolve
  // to sibling files under the current workspace.
  router.get("/workspace/preview/*", (req, res) => {
    try {
      const rel = String((req.params as Record<string, string>)["0"] ?? "");
      const root = String(req.query.root ?? "");
      if (!rel) throw new Error("缺少 path");
      const abs = ctx.bridge.resolveWorkspacePath(rel.split("/").map((segment) => decodeURIComponent(segment)).join("/"), root || undefined);
      if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`文件不存在: ${rel}`);
      const token = requestToken(req);
      if (AUTH_TOKEN && token) {
        res.cookie("pi_preview_token", token, {
          httpOnly: true,
          sameSite: "strict",
          path: "/api/workspace/preview",
          maxAge: 60 * 60 * 1000,
        });
      }
      res.sendFile(abs, { headers: { "Content-Disposition": "inline" } });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Raw file stream (full content, proper mime) — used by the browser-native PDF
  // viewer and oversized images. Express handles Range requests for large files.
  router.get("/workspace/file/raw", (req, res) => {
    try {
      const path = String(req.query.path ?? "");
      const root = String(req.query.root ?? "");
      if (!path) throw new Error("缺少 path");
      const abs = ctx.bridge.resolveWorkspacePath(path, root || undefined);
      if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`文件不存在: ${path}`);
      res.sendFile(abs, { headers: { "Content-Disposition": "inline" } });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Parse Office documents (docx / xlsx / xls / pptx) into HTML / tables for preview.
  router.post("/workspace/file/parse", async (req, res) => {
    try {
      const { parseDocx, parseXlsx, parsePptx } = await import("../../parsers.ts");
      const path = String(req.body?.path ?? "");
      const root = String(req.body?.root ?? "");
      if (!path) throw new Error("缺少 path");
      const abs = ctx.bridge.resolveWorkspacePath(path, root || undefined);
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

  router.get("/commands", (_req, res) => {
    res.json({ commands: ctx.PiBridgeClass.commandList() });
  });

  return router;
}