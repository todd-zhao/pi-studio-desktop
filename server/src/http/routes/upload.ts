import { Router } from "express";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import type { ServerContext } from "../../context.ts";
import { repairUploadedFilename } from "../../textEncoding.ts";
import { upload } from "../middleware.ts";

function sanitize(name: string): string {
  const base = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return base || `file-${Date.now()}`;
}

// POST /api/upload  ->  { files: AttachmentInfo[] }
export function createUploadRouter(ctx: ServerContext): Router {
  const router = Router();

  router.post("/upload", upload.array("files", 12), (req, res) => {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dir = join(ctx.uploadRoot(), stamp);
      mkdirSync(dir, { recursive: true });

      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      const result = files.map((f) => {
        const name = sanitize(repairUploadedFilename(f.originalname));
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

  return router;
}