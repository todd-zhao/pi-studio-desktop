import { Router } from "express";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, sep } from "node:path";
import type { ServerContext } from "../../context.ts";
import { upload } from "../middleware.ts";

function safeUploadPath(input: string): string {
  const normalized = input.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/");
  if (!normalized || parts.some((part) => !part || part === "." || part === "..") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error("skill 压缩包包含不安全的文件路径");
  }
  return parts.join("/");
}

function copyDirectory(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
  }
}

function findSkillDirectories(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) return [root];
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .flatMap((entry) => findSkillDirectories(join(root, entry.name)));
}

async function materializeSkillUpload(files: Express.Multer.File[], stage: string): Promise<void> {
  const isZip = files.length === 1 && (extname(files[0].originalname).toLowerCase() === ".zip" || files[0].mimetype === "application/zip");
  if (isZip) {
    const { default: JSZip } = await import("jszip");
    const archive = await JSZip.loadAsync(files[0].buffer);
    for (const [name, entry] of Object.entries(archive.files)) {
      if (entry.dir) continue;
      const relativePath = safeUploadPath(name);
      const target = join(stage, ...relativePath.split("/"));
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, await entry.async("nodebuffer"));
    }
    return;
  }

  for (const file of files) {
    const relativePath = safeUploadPath(file.originalname);
    const target = join(stage, ...relativePath.split("/"));
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, file.buffer);
  }
}

export function createSkillsRouter(ctx: ServerContext): Router {
  const router = Router();

  router.get("/skills", (_req, res) => {
    res.json({ directory: ctx.bridge.getSkillsDirectory(), skills: ctx.bridge.listSkills() });
  });

  router.post("/skills", async (req, res) => {
    try {
      const name = String(req.body?.name ?? "").trim();
      const description = String(req.body?.description ?? "").trim();
      const instructions = String(req.body?.instructions ?? "").trim();
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
        throw new Error("skill 名称只能使用小写字母、数字和单个连字符");
      }
      if (!description || description.length > 1024) throw new Error("请填写 1-1024 个字符的描述");
      if (!instructions) throw new Error("请填写 skill 指令内容");

      const dir = join(ctx.bridge.getSkillsDirectory(), name);
      mkdirSync(dir, { recursive: true });
      const quotedDescription = JSON.stringify(description);
      writeFileSync(
        join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${quotedDescription}\n---\n\n${instructions}\n`,
        "utf8",
      );
      await ctx.bridge.reload();
      res.json({ ok: true, skills: ctx.bridge.listSkills() });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.post("/skills/import", upload.array("files", 1000), async (req, res) => {
    const stage = mkdtempSync(join(tmpdir(), "pi-studio-skill-import-"));
    try {
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (files.length === 0) throw new Error("请选择 skill 的 ZIP 文件或文件夹");

      await materializeSkillUpload(files, stage);
      const candidateRoot = join(stage, "candidates");
      mkdirSync(candidateRoot, { recursive: true });
      const candidates = findSkillDirectories(stage).filter((dir) => dir !== candidateRoot && !dir.startsWith(`${candidateRoot}${sep}`));
      if (candidates.length === 0) throw new Error("上传内容中没有找到 SKILL.md");

      for (const [index, candidate] of candidates.entries()) {
        copyDirectory(candidate, join(candidateRoot, `skill-${index}`));
      }
      const { loadSkillsFromDir } = await import("@earendil-works/pi-coding-agent");
      const loaded = loadSkillsFromDir({ dir: candidateRoot, source: "app" });
      if (loaded.skills.length === 0) throw new Error("没有找到有效的 skill；请检查 SKILL.md 的 name、description 和正文");

      const names = new Set<string>();
      for (const skill of loaded.skills) {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) || skill.name.length > 64) {
          throw new Error(`skill 名称无效：${skill.name}`);
        }
        if (names.has(skill.name)) throw new Error(`上传内容中存在重复的 skill：${skill.name}`);
        names.add(skill.name);
      }

      for (const skill of loaded.skills) {
        const destination = join(ctx.bridge.getSkillsDirectory(), skill.name);
        if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
        copyDirectory(skill.baseDir, destination);
      }
      await ctx.bridge.reload();
      res.json({ ok: true, imported: [...names], skills: ctx.bridge.listSkills() });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });

  router.delete("/skills/:name", async (req, res) => {
    try {
      const name = decodeURIComponent(req.params.name);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("无效的 skill 名称");
      const dir = join(ctx.bridge.getSkillsDirectory(), name);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      await ctx.bridge.reload();
      res.json({ ok: true, skills: ctx.bridge.listSkills() });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  return router;
}