import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type {
  Project,
  ProjectDocument,
  ProjectMemory,
  ProjectMemoryType,
  ProjectSearchResult,
  ProjectSummary,
  SessionMeta,
} from "@pi-studio/shared";
import { decodeTextBuffer, repairUploadedFilename } from "../textEncoding.ts";
import { containsSensitiveMemory, MIME_BY_EXT } from "./shared.ts";

export interface ProjectStoreDeps {
  projectsFile: string;
  projectIndexFile: string;
  getCwd: () => string;
  pushState: () => void;
  listSessions: () => Promise<SessionMeta[]>;
  reloadProjectRuntimes: (projectId: string) => Promise<void>;
  reloadSessionFile: (file: string) => Promise<void>;
  reloadSessionsForFiles: (files: Set<string>) => Promise<void>;
  emitSessions: () => Promise<void>;
}

/**
 * Projects: session-file membership, memories, documents, full-text search
 * index and project-context prompts, persisted to projects.json +
 * project-index.json under the app-local data directory.
 */
export class ProjectStore {
  private projects: Project[] = [];
  private projectIndex: Record<string, { text: string; indexedAt: number }> = {};

  constructor(private readonly deps: ProjectStoreDeps) {}

loadProjects(): void {
    try {
      if (!existsSync(this.deps.projectsFile)) return;
      const parsed = JSON.parse(readFileSync(this.deps.projectsFile, "utf8")) as { projects?: Project[] };
      this.projects = Array.isArray(parsed.projects) ? parsed.projects.map((project) => {
        const workspacePaths = this.normalizeWorkspacePaths(
          (project as { workspacePaths?: unknown; workspacePath?: unknown }).workspacePaths ??
          (project as { workspacePath?: unknown }).workspacePath,
        );
        return {
          ...project,
          workspacePaths,
          mainWorkspacePath: this.normalizeMainWorkspacePath(
            (project as { mainWorkspacePath?: unknown }).mainWorkspacePath,
            workspacePaths,
          ),
          sessionFiles: Array.isArray(project.sessionFiles) ? project.sessionFiles.map((file) => resolve(file)) : [],
          memories: Array.isArray(project.memories) ? project.memories : [],
          documents: Array.isArray(project.documents)
            ? project.documents.map((document) => ({ ...document, name: repairUploadedFilename(document.name) }))
            : [],
        };
      }) : [];
    } catch {
      this.projects = [];
    }
  }

private normalizeWorkspacePaths(value: unknown): string[] {
    const raw = Array.isArray(value) ? value : value ? [value] : [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of raw) {
      if (typeof item !== "string" || !item.trim()) continue;
      const abs = resolve(this.deps.getCwd(), item.trim());
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push(abs);
    }
    return out;
  }

  /** Primary workspace: explicit value wins, otherwise the first mounted folder. */
  private normalizeMainWorkspacePath(value: unknown, workspacePaths: string[]): string | null {
    if (typeof value === "string" && value.trim()) {
      return resolve(this.deps.getCwd(), value.trim());
    }
    return workspacePaths[0] ?? null;
  }

private saveProjects(): void {
    mkdirSync(dirname(this.deps.projectsFile), { recursive: true });
    writeFileSync(this.deps.projectsFile, JSON.stringify({ projects: this.projects }, null, 2), "utf8");
  }

private loadProjectIndex(): void {
    try {
      if (!existsSync(this.deps.projectIndexFile)) return;
      const parsed = JSON.parse(readFileSync(this.deps.projectIndexFile, "utf8")) as Record<string, { text?: string; indexedAt?: number }>;
      this.projectIndex = Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value?.text === "string").map(([key, value]) => [key, { text: value.text ?? "", indexedAt: value.indexedAt ?? 0 }]));
    } catch {
      this.projectIndex = {};
    }
  }

private saveProjectIndex(): void {
    mkdirSync(dirname(this.deps.projectIndexFile), { recursive: true });
    writeFileSync(this.deps.projectIndexFile, JSON.stringify(this.projectIndex, null, 2), "utf8");
  }

private extractSearchText(value: unknown): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map((item) => this.extractSearchText(item)).filter(Boolean).join("\n");
    if (!value || typeof value !== "object") return "";
    const record = value as Record<string, unknown>;
    return [record.text, record.thinking, record.content, record.output, record.arguments].map((item) => this.extractSearchText(item)).filter(Boolean).join("\n");
  }

private async extractDocumentText(document: ProjectDocument): Promise<string> {
    const absolute = resolve(document.path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) return "";
    const size = statSync(absolute).size;
    if (size > 8 * 1024 * 1024) return "";
    const ext = extname(absolute).toLowerCase();
    if ([".txt", ".md", ".markdown", ".json", ".csv", ".ts", ".tsx", ".js", ".jsx", ".css", ".html", ".htm", ".xml", ".yaml", ".yml", ".log"].includes(ext)) {
      return decodeTextBuffer(readFileSync(absolute)).slice(0, 1_000_000);
    }
    const buffer = readFileSync(absolute);
    const parsers = await import("../parsers.ts");
    if (ext === ".docx") return this.extractSearchText((await parsers.parseDocx(buffer)).replace(/<[^>]+>/g, " "));
    if (ext === ".pptx") return this.extractSearchText((await parsers.parsePptx(buffer)).replace(/<[^>]+>/g, " "));
    if (ext === ".xlsx" || ext === ".xls") {
      return parsers.parseXlsx(buffer).map((sheet) => `## ${sheet.name}\n${sheet.rows.map((row) => row.join("\t")).join("\n")}`).join("\n\n");
    }
    return "";
  }

private async indexProjectDocument(document: ProjectDocument): Promise<void> {
    const text = await this.extractDocumentText(document);
    this.projectIndex[document.id] = { text, indexedAt: Date.now() };
    document.indexedAt = this.projectIndex[document.id].indexedAt;
    this.saveProjectIndex();
    this.saveProjects();
  }

private removeProjectDocumentIndex(documentId: string): void {
    delete this.projectIndex[documentId];
    this.saveProjectIndex();
  }

private makeSnippet(text: string, query: string): { snippet: string; matches: number } {
    const normalized = text.toLocaleLowerCase();
    const needle = query.toLocaleLowerCase();
    let matches = 0;
    let from = 0;
    let first = -1;
    while (needle && (from = normalized.indexOf(needle, from)) >= 0) {
      if (first < 0) first = from;
      matches++;
      from += needle.length;
    }
    if (first < 0) return { snippet: text.slice(0, 180).replace(/\s+/g, " "), matches: 0 };
    const start = Math.max(0, first - 100);
    const end = Math.min(text.length, first + query.length + 140);
    return { snippet: `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`, matches };
  }

async searchProject(projectId: string, query: string): Promise<ProjectSearchResult[]> {
    const project = this.requireProject(projectId);
    const needle = query.trim();
    if (!needle) return [];
    const results: ProjectSearchResult[] = [];
    const sessions = await this.deps.listSessions();
    for (const file of project.sessionFiles) {
      if (!existsSync(file)) continue;
      let text = "";
      try {
        const lines = decodeTextBuffer(readFileSync(file)).split(/\r?\n/);
        text = lines.map((line) => { try { return this.extractSearchText(JSON.parse(line)); } catch { return ""; } }).filter(Boolean).join("\n");
      } catch { continue; }
      const hit = this.makeSnippet(text, needle);
      if (hit.matches > 0) {
        const session = sessions.find((item) => resolve(item.file) === resolve(file));
        results.push({ kind: "session", id: session?.id ?? file, title: session?.name || session?.firstMessage || basename(file), file, snippet: hit.snippet, matches: hit.matches });
      }
    }
    for (const document of project.documents) {
      const indexed = this.projectIndex[document.id];
      if (!indexed) {
        try { await this.indexProjectDocument(document); } catch { /* keep metadata searchable */ }
      }
      const text = this.projectIndex[document.id]?.text ?? "";
      const hit = this.makeSnippet(text, needle);
      if (hit.matches > 0) results.push({ kind: "document", id: document.id, documentId: document.id, title: document.name, file: document.path, snippet: hit.snippet, matches: hit.matches });
    }
    return results.sort((a, b) => b.matches - a.matches).slice(0, 50);
  }

projectSummary(project: Project): ProjectSummary {
    return {
      id: project.id,
      name: project.name,
      description: project.description,
      workspacePaths: project.workspacePaths ?? [],
      mainWorkspacePath: project.mainWorkspacePath ?? null,
      archived: project.archived === true,
      archivedAt: project.archivedAt,
      sessionCount: project.sessionFiles.length,
      memoryCount: project.memories.length,
      documentCount: project.documents.length,
      updatedAt: project.updatedAt,
    };
  }

projectForSessionFile(file?: string): Project | null {
    if (!file) return null;
    const target = resolve(file);
    return this.projects.find((project) => project.sessionFiles.some((item) => resolve(item) === target)) ?? null;
  }

requireProject(id: string): Project {
    const project = this.projects.find((item) => item.id === id);
    if (!project) throw new Error("Project not found");
    return project;
  }

listProjects(): ProjectSummary[] {
    return this.projects
      .filter((project) => project.archived !== true)
      .map((project) => this.projectSummary(project));
  }

listArchivedProjects(): ProjectSummary[] {
    return this.projects
      .filter((project) => project.archived === true)
      .map((project) => this.projectSummary(project));
  }

getProject(id: string): Project {
    return structuredClone(this.requireProject(id));
  }

createProject(input: { name: string; description?: string; workspacePaths?: string[] | string | null; workspacePath?: string; mainWorkspacePath?: string | null; instructions?: string }): Project {
    const name = input.name.trim();
    if (!name) throw new Error("Project name is required");
    if (name.length > 120) throw new Error("Project name is too long");
    const now = Date.now();
    const workspacePaths = this.normalizeWorkspacePaths(input.workspacePaths ?? input.workspacePath);
    const project: Project = {
      id: randomUUID(),
      name,
      description: (input.description ?? "").trim(),
      workspacePaths,
      mainWorkspacePath: this.normalizeMainWorkspacePath(input.mainWorkspacePath, workspacePaths),
      instructions: (input.instructions ?? "").trim(),
      sessionFiles: [],
      memories: [],
      documents: [],
      createdAt: now,
      updatedAt: now,
    };
    this.projects.push(project);
    this.saveProjects();
    return structuredClone(project);
  }

async updateProject(id: string, patch: { name?: string; description?: string; workspacePaths?: string[] | string | null; workspacePath?: string | null; mainWorkspacePath?: string | null; instructions?: string }): Promise<Project> {
    const project = this.requireProject(id);
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new Error("Project name is required");
      project.name = name;
    }
    if (patch.description !== undefined) project.description = patch.description.trim();
    if (patch.workspacePaths !== undefined || patch.workspacePath !== undefined) {
      project.workspacePaths = this.normalizeWorkspacePaths(patch.workspacePaths ?? patch.workspacePath);
      if (patch.mainWorkspacePath === undefined) {
        project.mainWorkspacePath = this.normalizeMainWorkspacePath(null, project.workspacePaths);
      }
    }
    if (patch.mainWorkspacePath !== undefined) {
      project.mainWorkspacePath = patch.mainWorkspacePath
        ? resolve(this.deps.getCwd(), patch.mainWorkspacePath)
        : null;
    }
    if (patch.instructions !== undefined) project.instructions = patch.instructions.trim();
    project.updatedAt = Date.now();
    this.saveProjects();
    await this.deps.reloadProjectRuntimes(project.id);
    this.deps.pushState();
    return structuredClone(project);
  }

async removeProject(id: string): Promise<void> {
    const project = this.requireProject(id);
    const sessionFiles = new Set(project.sessionFiles.map((file) => resolve(file)));
    this.projects = this.projects.filter((item) => item.id !== id);
    this.saveProjects();
    await this.deps.reloadSessionsForFiles(sessionFiles);
    this.deps.pushState();
    await this.deps.emitSessions();
  }

async archiveProject(id: string): Promise<void> {
    const project = this.requireProject(id);
    project.archived = true;
    project.archivedAt = Date.now();
    project.updatedAt = Date.now();
    this.saveProjects();
    this.deps.pushState();
    await this.deps.emitSessions();
  }

async restoreProject(id: string): Promise<void> {
    const project = this.requireProject(id);
    project.archived = false;
    project.archivedAt = undefined;
    project.updatedAt = Date.now();
    this.saveProjects();
    this.deps.pushState();
    await this.deps.emitSessions();
  }

async assignSessionToProject(file: string, projectId: string | null): Promise<ProjectSummary | null> {
    const target = resolve(file);
    const assigned = projectId ? this.requireProject(projectId) : null;
    const changedProjects = this.projects.filter((project) => project.sessionFiles.some((item) => resolve(item) === target));
    for (const project of this.projects) {
      project.sessionFiles = project.sessionFiles.filter((item) => resolve(item) !== target);
    }
    if (assigned) {
      assigned.sessionFiles.push(target);
    }
    const now = Date.now();
    for (const project of changedProjects) project.updatedAt = now;
    if (assigned && !changedProjects.includes(assigned)) assigned.updatedAt = now;
    this.saveProjects();
    await this.deps.reloadSessionFile(target);
    this.deps.pushState();
    await this.deps.emitSessions();
    return assigned ? this.projectSummary(assigned) : null;
  }

async saveProjectMemory(projectId: string, input: { id?: string; content: string; type?: ProjectMemoryType; pinned?: boolean; sourceSessionId?: string }): Promise<ProjectMemory> {
    const project = this.requireProject(projectId);
    const content = input.content.trim();
    if (!content) throw new Error("Memory content is required");
    if (content.length > 16000) throw new Error("Memory is limited to 16,000 characters");
    if (containsSensitiveMemory(content)) throw new Error("Memory appears to contain a secret or token");
    const now = Date.now();
    const existing = input.id ? project.memories.find((memory) => memory.id === input.id) : undefined;
    const memory: ProjectMemory = existing ?? {
      id: randomUUID(), projectId, content: "", type: "fact", pinned: false, createdAt: now, updatedAt: now,
    };
    memory.content = content;
    memory.type = input.type ?? memory.type;
    memory.pinned = input.pinned ?? memory.pinned;
    memory.sourceSessionId = input.sourceSessionId ?? memory.sourceSessionId;
    memory.updatedAt = now;
    if (!existing) project.memories.push(memory);
    project.updatedAt = now;
    this.saveProjects();
    await this.deps.reloadProjectRuntimes(projectId);
    this.deps.pushState();
    return structuredClone(memory);
  }

async removeProjectMemory(projectId: string, memoryId: string): Promise<void> {
    const project = this.requireProject(projectId);
    project.memories = project.memories.filter((memory) => memory.id !== memoryId);
    project.updatedAt = Date.now();
    this.saveProjects();
    await this.deps.reloadProjectRuntimes(projectId);
    this.deps.pushState();
  }

async addProjectDocument(projectId: string, input: { path: string; name?: string; summary?: string }): Promise<ProjectDocument> {
    const project = this.requireProject(projectId);
    const absolute = resolve(this.deps.getCwd(), input.path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new Error("Document file not found");
    const existing = project.documents.find((document) => resolve(document.path) === absolute);
    if (existing) return structuredClone(existing);
    const document: ProjectDocument = {
      id: randomUUID(), projectId, name: (input.name ?? basename(absolute)).trim() || basename(absolute), path: absolute,
      mime: MIME_BY_EXT[extname(absolute).toLowerCase()] ?? "application/octet-stream", size: statSync(absolute).size,
      summary: (input.summary ?? "").trim(), addedAt: Date.now(),
    };
    project.documents.push(document);
    project.updatedAt = Date.now();
    await this.indexProjectDocument(document);
    await this.deps.reloadProjectRuntimes(projectId);
    this.deps.pushState();
    return structuredClone(document);
  }

async removeProjectDocument(projectId: string, documentId: string): Promise<void> {
    const project = this.requireProject(projectId);
    const removed = project.documents.find((document) => document.id === documentId);
    project.documents = project.documents.filter((document) => document.id !== documentId);
    if (removed) this.removeProjectDocumentIndex(removed.id);
    project.updatedAt = Date.now();
    this.saveProjects();
    await this.deps.reloadProjectRuntimes(projectId);
    this.deps.pushState();
  }

projectSystemPrompt(sessionFile?: string): string[] {
    const project = this.projectForSessionFile(sessionFile);
    if (!project) return [];
    const additions: string[] = [];
    const workspaces = project.workspacePaths ?? [];
    if (project.description || workspaces.length) additions.push("## Project context\n<project-context>\nThis conversation belongs to the project \"" + project.name + "\".\n" + (project.description ? project.description + "\n" : "") + (workspaces.length ? "Project workspaces:\n" + workspaces.map((workspace) => "- " + workspace).join("\n") + "\n" : "") + "</project-context>\nTreat this as shared context across the project's conversations.");
    if (project.instructions) additions.push("## Project instructions\n<project-instructions>\n" + project.instructions + "\n</project-instructions>");
    const memories = [...project.memories].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt).slice(0, 20);
    if (memories.length) additions.push("## Project memory\n<project-memory>\n" + memories.map((memory) => "- [" + memory.type + (memory.pinned ? ", pinned" : "") + "] " + memory.content).join("\n") + "\n</project-memory>");
    if (project.documents.length) {
      const references = project.documents.map((document) => "- " + document.name + ": " + document.path + (document.summary ? " (" + document.summary + ")" : ""));
      const excerpts: string[] = [];
      let budget = 30000;
      for (const document of project.documents) {
        if (budget <= 0 || !document.mime?.startsWith("text/") || (document.size ?? 0) > 200000) continue;
        try {
          const text = decodeTextBuffer(readFileSync(document.path)).slice(0, Math.min(8000, budget));
          if (text.trim()) { excerpts.push("### " + document.name + "\n" + text); budget -= text.length; }
        } catch { /* document may have moved; keep its reference */ }
      }
      additions.push("## Project documents\n<project-documents>\n" + references.join("\n") + (excerpts.length ? "\n\nSelected text excerpts:\n" + excerpts.join("\n\n") : "") + "\n</project-documents>\nUse the listed paths and workspace tools to inspect the source documents when needed.");
    }
    return additions;
  }

  /** Detach a session file from every project (used when a session is deleted or archived). */
  removeSessionFromProjects(file: string): void {
    const target = resolve(file);
    for (const project of this.projects) {
      const before = project.sessionFiles.length;
      project.sessionFiles = project.sessionFiles.filter((item) => resolve(item) !== target);
      if (project.sessionFiles.length !== before) project.updatedAt = Date.now();
    }
    this.saveProjects();
  }

  /** Reattach an archived session to its project; returns the project id when it changed. */
  restoreSessionToProject(projectId: string, file: string): string | null {
    const project = this.projects.find((item) => item.id === projectId);
    if (!project) return null;
    const target = resolve(file);
    if (!project.sessionFiles.some((item) => resolve(item) === target)) {
      project.sessionFiles.push(target);
      project.updatedAt = Date.now();
      this.saveProjects();
      return project.id;
    }
    return null;
  }

  /** Update project document paths after a file/dir was moved within a workspace. */
  updateDocumentPathsAfterMove(sourceAbs: string, movedAbs: string): void {
    let changed = false;
    for (const project of this.projects) {
      let projectChanged = false;
      for (const document of project.documents) {
        const docAbs = resolve(document.path);
        if (docAbs === sourceAbs) {
          document.path = movedAbs;
          projectChanged = true;
        } else if (docAbs.startsWith(sourceAbs + sep)) {
          document.path = join(movedAbs, relative(sourceAbs, docAbs));
          projectChanged = true;
        }
      }
      if (projectChanged) {
        project.updatedAt = Date.now();
        changed = true;
      }
    }
    if (changed) this.saveProjects();
  }
}
