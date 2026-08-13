import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import type { FileEntry, WorkspaceFileContent, WorkspaceInfo } from "@pi-studio/shared";
import { decodeTextBuffer } from "../textEncoding.ts";
import { IMAGE_PREVIEW_LIMIT, MIME_BY_EXT, TEXT_PREVIEW_LIMIT } from "./shared.ts";

export interface WorkspaceManagerDeps {
  workspacesFile: string;
  getCwd: () => string;
  getDefaultWorkspacePath: () => string;
  emitWorkspaces: (list: WorkspaceInfo[]) => void;
  updateDocumentPathsAfterMove: (sourceAbs: string, movedAbs: string) => void;
}

/**
 * Workspaces: the user-editable workspace list (workspaces.json), path
 * resolution/preview for the file browser, and safe in-workspace moves.
 */
export class WorkspaceManager {
  private customWorkspaces: string[] = [];
  private lastWorkspacePath = "";

  constructor(private readonly deps: WorkspaceManagerDeps) {}

  load(): void {
    try {
      if (existsSync(this.deps.workspacesFile)) {
        const data = JSON.parse(readFileSync(this.deps.workspacesFile, "utf8")) as { paths?: string[]; active?: string };
        this.customWorkspaces = Array.isArray(data.paths) ? data.paths : [];
        this.lastWorkspacePath = typeof data.active === "string" ? data.active : "";
      }
    } catch {
      this.customWorkspaces = [];
    }
  }

  save(): void {
    try {
      mkdirSync(resolve(this.deps.workspacesFile, ".."), { recursive: true });
      writeFileSync(
        this.deps.workspacesFile,
        JSON.stringify({ paths: this.customWorkspaces, active: this.lastWorkspacePath || this.deps.getCwd() }, null, 2),
        "utf8",
      );
    } catch {
      /* ignore */
    }
  }

  list(): WorkspaceInfo[] {
    const seen = new Set<string>();
    const out: WorkspaceInfo[] = [];
    const push = (p: string) => {
      const abs = resolve(p);
      if (seen.has(abs)) return;
      seen.add(abs);
      out.push({
        path: abs,
        name: abs === resolve(this.deps.getDefaultWorkspacePath()) ? "临时对话" : basename(abs) || abs,
        current: abs === resolve(this.deps.getCwd()),
      });
    };
    push(this.deps.getDefaultWorkspacePath());
    push(this.deps.getCwd());
    for (const p of this.customWorkspaces) push(p);
    return out;
  }

  add(path: string): WorkspaceInfo[] {
    const abs = resolve(path);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      throw new Error(`目录不存在: ${abs}`);
    }
    if (!this.customWorkspaces.includes(abs)) this.customWorkspaces.push(abs);
    this.save();
    this.deps.emitWorkspaces(this.list());
    return this.list();
  }

  /** Record an active workspace path (used when the facade switches cwd). */
  registerActive(abs: string): void {
    if (!this.customWorkspaces.includes(abs)) this.customWorkspaces.push(abs);
    this.lastWorkspacePath = abs;
    this.save();
  }

  listFiles(relPath: string, root?: string): FileEntry[] {
    const absRoot = resolve(root ? root : this.deps.getCwd());
    const base = relPath ? resolve(absRoot, relPath) : absRoot;
    if (base !== absRoot && !base.startsWith(absRoot + sep)) throw new Error("路径越界，拒绝读取");
    if (!existsSync(base) || !statSync(base).isDirectory()) throw new Error(`目录不存在: ${relPath || "/"}`);
    const entries = readdirSync(base, { withFileTypes: true })
      .filter((d) => !d.name.startsWith(".") && d.name !== "node_modules" && d.name !== "uploads")
      .map((d) => {
        const abs = join(base, d.name);
        const isDir = d.isDirectory();
        let size: number | undefined;
        if (!isDir) {
          try {
            size = statSync(abs).size;
          } catch {
            /* ignore */
          }
        }
        return {
          name: d.name,
          path: relPath ? `${relPath.split(sep).join("/")}/${d.name}` : d.name,
          isDir,
          size,
        };
      })
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    return entries;
  }

  /** Resolve a workspace-relative path, rejecting traversal outside the given root. */
  resolvePath(relPath: string, root?: string): string {
    const absRoot = resolve(root ? root : this.deps.getCwd());
    const abs = resolve(absRoot, relPath);
    if (abs !== absRoot && !abs.startsWith(absRoot + sep)) throw new Error("路径越界，拒绝读取");
    return abs;
  }

  moveFile(sourceRelPath: string, destinationDir: string, root?: string): void {
    const absRoot = resolve(root ? root : this.deps.getCwd());
    const sourceAbs = this.resolvePath(sourceRelPath, root);
    const destAbs = resolve(destinationDir);
    if (destAbs !== absRoot && !destAbs.startsWith(absRoot + sep)) throw new Error("目标文件夹不在当前工作区");
    if (!existsSync(destAbs) || !statSync(destAbs).isDirectory()) throw new Error("目标文件夹不存在");
    if (!existsSync(sourceAbs)) throw new Error("源文件不存在");
    if (resolve(dirname(sourceAbs)) === destAbs) return;

    const movedAbs = join(destAbs, basename(sourceAbs));
    if (existsSync(movedAbs)) throw new Error("目标位置已存在同名文件或文件夹");
    renameSync(sourceAbs, movedAbs);

    this.deps.updateDocumentPathsAfterMove(sourceAbs, movedAbs);
  }

  async readFile(relPath: string, root?: string): Promise<WorkspaceFileContent> {
    const abs = this.resolvePath(relPath, root);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`文件不存在: ${relPath}`);

    const st = statSync(abs);
    const size = st.size;
    const mime = MIME_BY_EXT[extname(abs).toLowerCase()] ?? "application/octet-stream";
    const name = basename(abs);
    const path = relPath.split(sep).join("/");

    if (mime.startsWith("image/")) {
      // Small images inline as data URL; oversized ones fall back to the raw stream endpoint.
      const data =
        size <= IMAGE_PREVIEW_LIMIT ? (await this.readHead(abs, IMAGE_PREVIEW_LIMIT)).toString("base64") : undefined;
      return { name, path, size, mime, isBinary: false, content: data ? `data:${mime};base64,${data}` : undefined };
    }

    // Read only the head of big text files so huge files stay previewable.
    const limit = Math.min(size, TEXT_PREVIEW_LIMIT);
    const chunk = await this.readHead(abs, limit);
    const isBinary = chunk.includes(0);
    if (isBinary) return { name, path, size, mime, isBinary: true };
    return {
      name,
      path,
      size,
      mime,
      isBinary: false,
      content: decodeTextBuffer(chunk),
      truncated: size > chunk.length,
    };
  }

  private readHead(abs: string, limit: number): Promise<Buffer> {
    return new Promise((resolvePromise, rejectPromise) => {
      const chunks: Buffer[] = [];
      const stream = createReadStream(abs, { start: 0, end: Math.max(0, limit - 1) });
      stream.on("data", (c) => chunks.push(c as Buffer));
      stream.on("end", () => resolvePromise(Buffer.concat(chunks)));
      stream.on("error", rejectPromise);
    });
  }

  listDirs(absPath: string): FileEntry[] {
    const drives: string[] = [];
    for (const ch of "CDEFGH") {
      try {
        if (existsSync(`${ch}:\\`)) drives.push(`${ch}:\\`);
      } catch {
        /* ignore */
      }
    }
    if (!absPath) {
      return drives.map((d) => ({ name: d.replace(/\\\\$/, ""), path: d, isDir: true }));
    }
    const target = resolve(absPath);
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      throw new Error(`目录不存在: ${absPath}`);
    }
    try {
      const entries = readdirSync(target, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => ({
          name: d.name,
          path: join(target, d.name),
          isDir: true,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return entries;
    } catch (e) {
      throw new Error(`无法读取目录: ${absPath} (${(e as Error).message})`);
    }
  }
}
