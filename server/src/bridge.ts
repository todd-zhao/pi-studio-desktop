import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, statSync, createReadStream, unlinkSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createEventBus,
  getAgentDir,
  loadSkillsFromDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createMcpAdapter, MCP_STATUS_EVENT } from "pi-mcp-adapter";
import { Type } from "typebox";
import type { McpConfig } from "pi-mcp-adapter/types";
import type { McpStatusSnapshot } from "./types.ts";
import type { WechatCommandAction } from "./types.ts";
import { wechatExtension } from "./extensions/wechat.ts";
import { AppCredentialStore } from "./credential-store.ts";
import { decodeTextBuffer, repairUploadedFilename } from "./textEncoding.ts";
import type {
  AppState,
  AgentProfile,
  AttachmentInfo,
  ClientMessage,
  CommandInfo,
  FileEntry,
  ModelCatalogEntry,
  ModelInfo,
  SessionMeta,
  WorkspaceFileContent,
  WorkspaceInfo,
  Project,
  ProjectSummary,
  ProjectMemory,
  ProjectDocument,
  ProjectMemoryType,
  ProjectSearchResult,
  LongTask,
} from "./types.ts";

const appRequire = createRequire(import.meta.url);

const startupStartedAt = Date.now();
function startupLog(phase: string, details = ""): void {
  const suffix = details ? ` ${details}` : "";
  console.log(`[startup +${Date.now() - startupStartedAt}ms] bridge:${phase}${suffix}`);
}

function resolvePiExtensionEntry(packageName: string): string {
  const pkgJsonPath = appRequire.resolve(`${packageName}/package.json`);
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
    pi?: { extensions?: string[] };
  };
  const entry = pkg.pi?.extensions?.[0];
  if (!entry) return appRequire.resolve(packageName);
  return resolve(dirname(pkgJsonPath), entry);
}
const MEMORY_SECRET_PATTERNS = [
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/i,
  /(?:sk|rk|pk)_[A-Za-z0-9_-]{20,}/,
  /(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s]{12,}/i,
];

function containsSensitiveMemory(content: string): boolean {
  return MEMORY_SECRET_PATTERNS.some((pattern) => pattern.test(content));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}（超过 ${ms / 1000} 秒）`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export interface BridgeOptions {
  cwd: string;
  /** The app-level default workspace shown as 临时对话. */
  defaultWorkspacePath?: string;
  mcpConfigPath?: string;
  /** Global pi config dir (defaults to ~/.pi/agent). */
  agentDir?: string;
  /** Enable loading of global/project pi extensions (default: false for a self-contained app). */
  loadGlobalExtensions?: boolean;
}

export interface SkillSummary {
  name: string;
  description: string;
  filePath: string;
  directory: string;
  disableModelInvocation: boolean;
}

// Pi SDK version, resolved by walking up from this file to node_modules
// (the package restricts subpath exports, so package.json can't be required directly).
const PI_VERSION: string = (() => {
  const read = (pkgPath: string): string => {
    try {
      return (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version ?? "";
    } catch {
      return "";
    }
  };
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const v = read(join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"));
    if (v) return v;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
})();

interface RuntimeEntry {
  id: string;
  runtime: AgentSessionRuntime;
  disposeFns: Array<() => void>;
}

interface ArchivedSession {
  file: string;
  name?: string;
  createdAt?: number;
  messageCount: number;
  firstMessage?: string;
  projectId?: string;
  projectName?: string;
  archivedAt: number;
}

interface BridgeEvents {
  state: [AppState];
  event: [unknown];
  mcp_status: [McpStatusSnapshot];
  sessions: [SessionMeta[]];
  workspaces: [WorkspaceInfo[]];
  log: [level: "info" | "warn" | "error", message: string];
  error: [message: string];
  ask_user: [question: import("./types.ts").AskUserQuestion];
  wechat_status: [status: import("./types.ts").WechatStatus];
  wechat_qr: [qr: import("./types.ts").WechatQr];
  wechat_log: [entry: import("./types.ts").WechatLogEntry];
}

export class PiBridge extends EventEmitter<BridgeEvents> {
  private cwd: string;
  private readonly defaultWorkspacePath: string;
  private readonly agentDir: string;
  private readonly loadGlobalExtensions: boolean;
  private readonly skillsDir: string;
  private readonly mcpConfigPath?: string;

  private modelRuntime!: ModelRuntime;
  private settingsManager!: SettingsManager;
  private appCredentials!: AppCredentialStore;
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private readonly promptQueues = new Map<string, Promise<void>>();
  private readonly longTasks = new Map<string, LongTask[]>();
  private activeRuntimeId = "";
  private eventBus!: ReturnType<typeof createEventBus>;
  private availableModels: ModelInfo[] = [];
  private lastMcpStatus: McpStatusSnapshot | null = null;
  private started = false;
  private workspacesFile: string;
  private projectsFile: string;
  private projectIndexFile: string;
  private archivedFile: string;
  private readonly archivedSessions = new Map<string, ArchivedSession>();
  private projectIndex: Record<string, { text: string; indexedAt: number }> = {};
  private projects: Project[] = [];
  private customWorkspaces: string[] = [];
  private lastWorkspacePath = "";
  private readonly agentsFile: string;
  private readonly hermesMemoryExtensionPath: string;
  private readonly subagentsExtensionPath: string;
  private readonly goalsExtensionPath: string;
  private goalsEnabled = false;
  private goalText = "";
  private subagentsEnabled = false;
  private agents: AgentProfile[] = [];
  private activeAgentId = "default";
  private pendingQuestions = new Map<string, { resolve: (answer: string) => void; timer: NodeJS.Timeout }>();

  constructor(options: BridgeOptions) {
    super();
    this.cwd = options.cwd;
    this.defaultWorkspacePath = options.defaultWorkspacePath ? resolve(options.defaultWorkspacePath) : resolve(this.cwd);
    this.mcpConfigPath = options.mcpConfigPath;
    this.agentDir = options.agentDir ?? getAgentDir();
    this.loadGlobalExtensions = options.loadGlobalExtensions ?? false;
    this.skillsDir = join(this.agentDir, "skills");
    this.subagentsExtensionPath = appRequire.resolve("pi-subagents");
    this.goalsExtensionPath = resolvePiExtensionEntry("pi-goal-list-loop-audit");
    try { this.subagentsEnabled = !!JSON.parse(readFileSync(join(this.agentDir, "subagents.json"), "utf8")).enabled; } catch { /* default off */ }
    try {
      const stored = JSON.parse(readFileSync(join(this.agentDir, "goals.json"), "utf8")) as { enabled?: boolean; goal?: string };
      this.goalsEnabled = !!stored.enabled;
      this.goalText = typeof stored.goal === "string" ? stored.goal : "";
    } catch { /* default off */ }
    mkdirSync(this.skillsDir, { recursive: true });
    this.agentsFile = join(this.agentDir, "agents.json");
    this.hermesMemoryExtensionPath = appRequire.resolve("pi-hermes-memory");
    this.loadAgents();
    this.workspacesFile = process.env.PI_STUDIO_WORKSPACES_FILE ?? this.defaultDataFile("workspaces.json");
    this.projectsFile = process.env.PI_STUDIO_PROJECTS_FILE ?? this.defaultDataFile("projects.json");
    this.projectIndexFile = process.env.PI_STUDIO_PROJECT_INDEX_FILE ?? this.defaultDataFile("project-index.json");
    this.archivedFile = process.env.PI_STUDIO_ARCHIVED_FILE ?? this.defaultDataFile("archived-sessions.json");
    this.loadWorkspaces();
    this.loadProjects();
    this.loadArchivedSessions();
  }

  private defaultDataFile(name: string): string {
    return process.env.PI_STUDIO_DATA_DIR
      ? resolve(process.env.PI_STUDIO_DATA_DIR, name)
      : resolve(this.cwd, "..", "data", name);
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    startupLog("model-runtime-create-start");
    // Keep model catalog and credentials tied to the app-local agent directory.
    // Credentials live in an app-owned store (memory + auth.json kept in sync)
    // so save/clear take effect immediately and survive restarts; runtime API
    // key overrides stay process-local on top of that store.
    this.appCredentials = new AppCredentialStore(join(this.agentDir, "auth.json"));
    this.modelRuntime = await ModelRuntime.create({
      credentials: this.appCredentials,
      modelsPath: join(this.agentDir, "models.json"),
    });
    startupLog("model-runtime-create-done");
    this.settingsManager = SettingsManager.create(this.cwd, this.agentDir);
    this.eventBus = createEventBus();

    this.eventBus.on("wechat:status", (status) => this.emit("wechat_status", status as import("./types.ts").WechatStatus));
    this.eventBus.on("wechat:qr", (qr) => this.emit("wechat_qr", qr as import("./types.ts").WechatQr));
    this.eventBus.on("wechat:log", (entry) => this.emit("wechat_log", entry as import("./types.ts").WechatLogEntry));

    // pi-mcp-adapter publishes a status snapshot on a shared event-bus channel.
    this.eventBus.on(MCP_STATUS_EVENT, (snapshot) => {
      this.lastMcpStatus = snapshot as McpStatusSnapshot;
      this.emit("mcp_status", this.lastMcpStatus);
    });

    // Let session restoration and the configured current model complete before
    // refreshing the full provider availability snapshot for the model picker.
    startupLog("create-runtime-start");
    await this.createRuntime();
    startupLog("create-runtime-done");
    this.updateAvailableModels();
    this.started = true;
    this.emit("log", "info", `Pi runtime ready (cwd: ${this.cwd})`);
    this.pushState();
    // Keep first paint independent from the full model-directory refresh.
    void this.refreshModels().catch((error) => this.emit("log", "warn", `Model catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  private makeFactory(): CreateAgentSessionRuntimeFactory {
    const appMcpAdapter = (pi: Parameters<ReturnType<typeof createMcpAdapter>>[0]) => {
      createMcpAdapter({ config: this.readMcpConfig() })(pi);
    };
    const askUserExtension = (pi: any) => pi.registerTool({
      name: "ask_user", label: "Ask user",
      description: "Ask a focused clarification question when the goal, scope, preference, or an irreversible choice is unclear. Prefer 2-5 concise options and allow freeform input.",
      parameters: Type.Object({ question: Type.String(), options: Type.Optional(Type.Array(Type.Object({ label: Type.String(), description: Type.Optional(Type.String()) }))), allowFreeform: Type.Optional(Type.Boolean()) }),
      execute: async (_id: string, params: { question: string; options?: Array<{ label: string; description?: string }>; allowFreeform?: boolean }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) => {
        const sessionManager = ctx?.sessionManager;
        const answer = await this.askUser(
          params.question,
          params.options ?? [],
          params.allowFreeform !== false,
          sessionManager?.getSessionId(),
          sessionManager?.getSessionName(),
        );
        return { content: [{ type: "text", text: answer }] };
      },
    });
    return async ({ cwd, sessionManager, sessionStartEvent }) => {
      startupLog("create-agent-session-services-start");
      const services = await createAgentSessionServices({
        cwd,
        agentDir: this.agentDir,
        modelRuntime: this.modelRuntime,
        settingsManager: this.settingsManager,
        resourceLoaderOptions: {
          eventBus: this.eventBus,
          noExtensions: !this.loadGlobalExtensions,
          // Skills are app-owned; do not inherit host-global or workspace skills.
          noSkills: true,
          additionalSkillPaths: [this.skillsDir],
          additionalExtensionPaths: [this.hermesMemoryExtensionPath, ...(this.subagentsEnabled ? [this.subagentsExtensionPath] : []), ...(this.goalsEnabled ? [this.goalsExtensionPath] : [])],
          appendSystemPromptOverride: (base) => {
            const agent = this.getActiveAgent();
            const additions: string[] = [];
            if (agent.prompt.trim()) additions.push(`## Active Agent: ${agent.name}\n${agent.prompt.trim()}`);
            if (agent.memory?.trim()) additions.push(`## Agent long-term memory\n<agent-memory>\nThe following is user-managed durable context for this agent. Treat it as reference material, not as new user input; current user requests and verified workspace evidence take priority.\n\n${agent.memory.trim()}\n</agent-memory>`);
            if (this.goalsEnabled && this.goalText.trim()) additions.push(`## Active long-running goal and audit policy\n<active-goal>\n${this.goalText.trim()}\n</active-goal>\nTreat this as the durable objective for the current work. Break it into verifiable milestones, keep checking completed work against the objective and actual evidence, and do not report the goal complete until its acceptance criteria are demonstrably satisfied. When a key requirement or tradeoff is unclear, use the ask_user tool to obtain confirmation before committing to an assumption. Use the installed goal/audit capabilities when useful for sustained work.`);
            additions.push(...this.projectSystemPrompt(sessionManager.getSessionFile()));
            return additions.length ? [...base, ...additions] : base;
          },
          // Passing config programmatically bypasses pi-mcp-adapter host discovery.
          // The wrapper rereads the app file on every resource reload.
          extensionFactories: [appMcpAdapter, askUserExtension, wechatExtension],
        },
      });
      startupLog("create-agent-session-services-done");
      startupLog("create-agent-session-from-services-start");
      const runtime = await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "ask_user"],
      });
      startupLog("create-agent-session-from-services-done");
      return {
        ...runtime,
        services,
        diagnostics: services.diagnostics,
      };
    };
  }

  private activeEntry(): RuntimeEntry {
    const entry = this.runtimes.get(this.activeRuntimeId);
    if (!entry) throw new Error("Active session runtime is not ready");
    return entry;
  }

  private async createRuntimeForManager(sessionManager: SessionManager): Promise<RuntimeEntry> {
    startupLog("create-agent-session-runtime-start");
    const runtime = await createAgentSessionRuntime(this.makeFactory(), {
      cwd: sessionManager.getCwd() || this.cwd,
      agentDir: this.agentDir,
      sessionManager,
    });
    startupLog("create-agent-session-runtime-done");

    const entry: RuntimeEntry = {
      id: runtime.session.sessionId,
      runtime,
      disposeFns: [],
    };
    for (const d of runtime.diagnostics ?? []) {
      this.emit("log", d.type === "error" ? "error" : d.type === "warning" ? "warn" : "info", d.message);
    }
    startupLog("bind-session-start", entry.id);
    await this.bindRuntime(entry);
    startupLog("bind-session-done", entry.id);
    return entry;
  }

  private async createRuntime(): Promise<void> {
    startupLog("session-manager-create-start");
    const sessionManager = SessionManager.create(this.cwd);
    startupLog("session-manager-create-done");
    const entry = await this.createRuntimeForManager(sessionManager);
    this.runtimes.set(entry.id, entry);
    this.activeRuntimeId = entry.id;
  }

  private async bindRuntime(entry: RuntimeEntry): Promise<void> {
    const session = entry.runtime.session;
    // Provide a binding so session.reload() re-initializes extensions.
    await session.bindExtensions({ shutdownHandler: () => {} });
    for (const fn of entry.disposeFns) fn();
    entry.disposeFns = [];
    entry.disposeFns.push(
      session.subscribe((event) => {
        const sessionId = entry.runtime.session.sessionId;
        const sessionFile = entry.runtime.session.sessionFile;
        const routedEvent = event && typeof event === "object"
          ? { ...(event as Record<string, unknown>), sessionId, sessionFile }
          : { type: "runtime_event", value: event, sessionId, sessionFile };
        this.emit("event", routedEvent);
        switch ((event as { type?: string }).type) {
          case "agent_start":
          case "queue_update":
          case "agent_end":
          case "agent_settled":
          case "message_end":
          case "compaction_end":
          case "auto_retry_end":
          case "summarization_retry_finished":
            if (entry.id === this.activeRuntimeId) this.pushState();
            break;
        }
      }),
    );
  }

  private findRuntimeByFile(file: string): RuntimeEntry | undefined {
    const target = resolve(file);
    return [...this.runtimes.values()].find((entry) => {
      const sessionFile = entry.runtime.session.sessionFile;
      return !!sessionFile && resolve(sessionFile) === target;
    });
  }

  async dispose(): Promise<void> {
    const entries = [...this.runtimes.values()];
    this.runtimes.clear();
    this.activeRuntimeId = "";
    await Promise.all(entries.map(async (entry) => {
      for (const fn of entry.disposeFns) fn();
      entry.disposeFns = [];
      try {
        await entry.runtime.dispose();
      } catch {
        /* ignore */
      }
    }));
  }

  // ------------------------------------------------------------------ actions

  private updateLongTask(entry: RuntimeEntry, task: LongTask, patch: Partial<LongTask>): void {
    Object.assign(task, patch);
    if (entry.id === this.activeRuntimeId) this.pushState();
  }

  private buildPromptText(text: string, attachments?: AttachmentInfo[], refs?: string[], longGoal?: string): { promptText: string; images: Array<{ type: "image"; data: string; mimeType: string }> } {
    const images = (attachments ?? [])
      .filter((a) => a.data)
      .map((a) => ({ type: "image" as const, data: a.data!, mimeType: a.mediaType }));
    let promptText = text;
    if (longGoal?.trim()) {
      promptText = "## Active long-running goal and audit policy\n<active-goal>\n" + longGoal.trim() + "\n</active-goal>\nTreat this as the durable objective for the current work. Break it into verifiable milestones, keep checking completed work against the objective and actual evidence, and do not report the goal complete until its acceptance criteria are demonstrably satisfied.\n\n## User request\n" + promptText;
    }
    if (refs && refs.length > 0) {
      promptText += "\n\n[Referenced workspace paths]\n" + refs.map((r) => {
        const isDir = r.endsWith("/") || r.endsWith("\\");
        return `- ${r}${isDir ? " (directory, list and read relevant files)" : ""}`;
      }).join("\n");
    }
    const files = attachments ?? [];
    if (files.length > 0) {
      const notes = files.map((a) => {
        const size = a.size > 1024 * 1024 ? (a.size / 1024 / 1024).toFixed(1) + " MB" : Math.max(1, Math.round(a.size / 1024)) + " KB";
        return "- " + a.name + " (" + size + ", path: " + a.path + ")";
      }).join("\n");
      promptText += "\n\n[User uploaded " + files.length + " attachment(s)]\n" + notes + "\n\nAttachments are saved in the workspace and can be read with the available tools; image attachments are also provided as image content.";
    }
    return { promptText, images };
  }

  private async runPrompt(entry: RuntimeEntry, text: string, attachments?: AttachmentInfo[], refs?: string[], longGoal?: string): Promise<void> {
    const { promptText, images } = this.buildPromptText(text, attachments, refs, longGoal);
    const session = entry.runtime.session;
    if (session.isStreaming) {
      await session.followUp(promptText, images.length ? images : undefined);
    } else {
      await session.prompt(promptText, images.length ? { images } : undefined);
    }
  }

  private async withPromptLock<T>(entry: RuntimeEntry, action: () => Promise<T>): Promise<T> {
    const previous = (this.promptQueues.get(entry.id) ?? Promise.resolve()).catch(() => undefined);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.promptQueues.set(entry.id, queued);

    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.promptQueues.get(entry.id) === queued) this.promptQueues.delete(entry.id);
    }
  }

  async prompt(text: string, attachments?: AttachmentInfo[], refs?: string[]): Promise<void> {
    const entry = this.activeEntry();
    // A prompt submitted while the agent is running is a follow-up message.
    // Send it directly so it can enter the SDK queue immediately instead of
    // waiting behind the outer prompt lock until the current run completes.
    if (entry.runtime.session.isStreaming) {
      await this.runPrompt(entry, text, attachments, refs);
      return;
    }
    await this.withPromptLock(entry, () => this.runPrompt(entry, text, attachments, refs));
  }

  async enqueueLongTask(text: string, goal: string, attachments?: AttachmentInfo[], refs?: string[]): Promise<LongTask> {
    const entry = this.activeEntry();
    const task: LongTask = { id: randomUUID(), text, goal, status: "queued", createdAt: Date.now() };
    const tasks = this.longTasks.get(entry.id) ?? [];
    tasks.push(task);
    this.longTasks.set(entry.id, tasks);
    this.pushState();

    await this.withPromptLock(entry, async () => {
      if (task.status === "cancelled") return;
      this.updateLongTask(entry, task, { status: "running", startedAt: Date.now() });
      try {
        await this.runPrompt(entry, text, attachments, refs, goal);
        this.updateLongTask(entry, task, { status: "completed", finishedAt: Date.now() });
      } catch (error) {
        this.updateLongTask(entry, task, { status: "failed", finishedAt: Date.now(), error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    });
    return task;
  }

  cancelLongTask(id: string): void {
    for (const [runtimeId, tasks] of this.longTasks) {
      const task = tasks.find((item) => item.id === id);
      if (!task || task.status !== "queued") continue;
      task.status = "cancelled";
      task.finishedAt = Date.now();
      if (runtimeId === this.activeRuntimeId) this.pushState();
      return;
    }
  }

  clearLongTasks(): void {
    const tasks = this.longTasks.get(this.activeRuntimeId);
    if (!tasks) return;
    const remaining = tasks.filter((task) => task.status === "queued" || task.status === "running");
    if (remaining.length === tasks.length) return;
    this.longTasks.set(this.activeRuntimeId, remaining);
    this.pushState();
  }
  async steer(text: string): Promise<void> {
    await this.activeEntry().runtime.session.steer(text);
  }

  async followUp(text: string): Promise<void> {
    await this.activeEntry().runtime.session.followUp(text);
  }

  async cancelQueueItem(kind: "steer" | "followUp", text: string): Promise<void> {
    const session = this.activeEntry().runtime.session;
    const { steering, followUp } = session.clearQueue();
    const keep = (items: readonly string[]) => items.filter((item) => item !== text);
    for (const item of keep(steering)) await session.steer(item);
    for (const item of keep(followUp)) await session.followUp(item);
  }

  async editQueueItem(kind: "steer" | "followUp", oldText: string, newText: string): Promise<void> {
    const text = newText.trim();
    if (!text) throw new Error("修改后的消息不能为空");
    const session = this.activeEntry().runtime.session;
    const { steering, followUp } = session.clearQueue();
    let replaced = false;
    const replaceFirst = (items: readonly string[]) => items.map((item) => {
      if (!replaced && item === oldText) {
        replaced = true;
        return text;
      }
      return item;
    });
    const nextSteering = kind === "steer" ? replaceFirst(steering) : steering.filter((item) => item !== oldText);
    const nextFollowUp = kind === "followUp" ? replaceFirst(followUp) : followUp.filter((item) => item !== oldText);
    for (const item of nextSteering) await session.steer(item);
    for (const item of nextFollowUp) await session.followUp(item);
  }

  async abort(): Promise<void> {
    await this.activeEntry().runtime.session.abort();
  }

  async newSession(projectId?: string): Promise<void> {
    // A brand-new conversation without an explicit project belongs to the
    // default "临时对话" workspace, so it stays reachable after switching.
    if (!projectId && resolve(this.cwd) !== resolve(this.defaultWorkspacePath)) {
      await this.dispose();
      this.cwd = resolve(this.defaultWorkspacePath);
      this.settingsManager = SettingsManager.create(this.cwd, this.agentDir);
      this.lastMcpStatus = null;
      await this.createRuntime();
      this.emit("log", "info", `工作区已切换: ${this.cwd}`);
      this.pushState();
      await this.emitSessions();
      this.emit("workspaces", this.listWorkspaces());
      return;
    }
    const active = this.activeEntry();
    const inheritedProject = projectId
      ? this.requireProject(projectId)
      : this.projectForSessionFile(active.runtime.session.sessionFile);
    const sessionDir = active.runtime.session.sessionManager.getSessionDir();
    const entry = await this.createRuntimeForManager(SessionManager.create(this.cwd, sessionDir));
    this.runtimes.set(entry.id, entry);
    this.activeRuntimeId = entry.id;
    if (inheritedProject && entry.runtime.session.sessionFile) await this.assignSessionToProject(entry.runtime.session.sessionFile, inheritedProject.id);
    this.pushState();
    await this.emitSessions();
  }

  async switchSession(file: string): Promise<void> {
    const existing = this.findRuntimeByFile(file);
    if (existing) {
      this.activeRuntimeId = existing.id;
    } else {
      const sessionManager = SessionManager.open(resolve(file), undefined, this.cwd);
      const entry = await this.createRuntimeForManager(sessionManager);
      this.runtimes.set(entry.id, entry);
      this.activeRuntimeId = entry.id;
    }
    this.pushState();
    await this.emitSessions();
  }

  async deleteSession(file: string): Promise<{ activeFile?: string }> {
    const target = resolve(file);
    const infos = await SessionManager.list(this.cwd);
    const info = infos.find((item) => resolve(item.path) === target);
    if (!info || extname(target).toLowerCase() !== ".jsonl") throw new Error("Session file not found");
    const runtime = this.findRuntimeByFile(target);
    const currentProject = this.projectForSessionFile(target);
    let replacement: RuntimeEntry | undefined;
    if (runtime?.id === this.activeRuntimeId) {
      if (this.runtimes.size > 1) {
        replacement = [...this.runtimes.values()].find((entry) => entry.id !== runtime.id);
      } else {
        const sessionDir = runtime.runtime.session.sessionManager.getSessionDir();
        replacement = await this.createRuntimeForManager(SessionManager.create(this.cwd, sessionDir));
        this.runtimes.set(replacement.id, replacement);
      }
      if (!replacement) throw new Error("Unable to select a replacement session");
      this.activeRuntimeId = replacement.id;
    }
    for (const project of this.projects) {
      const before = project.sessionFiles.length;
      project.sessionFiles = project.sessionFiles.filter((item) => resolve(item) !== target);
      if (project.sessionFiles.length !== before) project.updatedAt = Date.now();
    }
    this.saveProjects();
    if (runtime) {
      this.runtimes.delete(runtime.id);
      this.promptQueues.delete(runtime.id);
      this.longTasks.delete(runtime.id);
      for (const fn of runtime.disposeFns) fn();
      runtime.disposeFns = [];
      try { await runtime.runtime.dispose(); } catch { /* ignore */ }
    }
    try { unlinkSync(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (currentProject) await this.reloadProjectRuntimes(currentProject.id);
    this.pushState();
    await this.emitSessions();
    return { activeFile: this.activeEntry().runtime.session.sessionFile };
  }

  async archiveSession(file: string): Promise<{ activeFile?: string }> {
    const target = resolve(file);
    const infos = await SessionManager.list(this.cwd);
    const info = infos.find((item) => resolve(item.path) === target);
    if (!info || extname(target).toLowerCase() !== ".jsonl") throw new Error("Session file not found");
    if (this.archivedSessions.has(target)) throw new Error("对话已归档");

    const project = this.projectForSessionFile(target);
    this.archivedSessions.set(target, {
      file: target,
      name: info.name,
      createdAt: info.created.getTime(),
      messageCount: info.messageCount,
      firstMessage: info.firstMessage,
      projectId: project?.id,
      projectName: project?.name,
      archivedAt: Date.now(),
    });
    this.saveArchivedSessions();

    if (project) {
      project.sessionFiles = project.sessionFiles.filter((item) => resolve(item) !== target);
      project.updatedAt = Date.now();
      this.saveProjects();
    }

    const runtime = this.findRuntimeByFile(target);
    let replacement: RuntimeEntry | undefined;
    if (runtime?.id === this.activeRuntimeId) {
      if (this.runtimes.size > 1) {
        replacement = [...this.runtimes.values()].find((entry) => entry.id !== runtime.id);
      } else {
        const sessionDir = runtime.runtime.session.sessionManager.getSessionDir();
        replacement = await this.createRuntimeForManager(SessionManager.create(this.cwd, sessionDir));
        this.runtimes.set(replacement.id, replacement);
      }
      if (!replacement) throw new Error("Unable to select a replacement session");
      this.activeRuntimeId = replacement.id;
    }

    if (runtime) {
      this.runtimes.delete(runtime.id);
      this.promptQueues.delete(runtime.id);
      this.longTasks.delete(runtime.id);
      for (const fn of runtime.disposeFns) fn();
      runtime.disposeFns = [];
      try { await runtime.runtime.dispose(); } catch { /* ignore */ }
    }

    if (project) await this.reloadProjectRuntimes(project.id);
    this.pushState();
    await this.emitSessions();
    return { activeFile: this.activeEntry().runtime.session.sessionFile };
  }

  async restoreSession(file: string): Promise<void> {
    const target = resolve(file);
    const archived = this.archivedSessions.get(target);
    if (!archived) throw new Error("对话不在归档中");
    this.archivedSessions.delete(target);
    this.saveArchivedSessions();

    const project = this.projects.find((item) => item.id === archived.projectId);
    if (project && !project.sessionFiles.some((item) => resolve(item) === target)) {
      project.sessionFiles.push(target);
      project.updatedAt = Date.now();
      this.saveProjects();
      await this.reloadProjectRuntimes(project.id);
    }
    this.pushState();
    await this.emitSessions();
  }

  async deleteArchivedSession(file: string): Promise<{ activeFile?: string }> {
    const target = resolve(file);
    if (!this.archivedSessions.has(target)) throw new Error("对话不在归档中");
    const result = await this.deleteSession(target);
    this.archivedSessions.delete(target);
    this.saveArchivedSessions();
    return result;
  }

  listArchivedSessions(): ArchivedSession[] {
    return [...this.archivedSessions.values()]
      .filter((session) => existsSync(session.file))
      .sort((a, b) => b.archivedAt - a.archivedAt)
      .map((session) => ({ ...session }));
  }

  async listSessions(): Promise<SessionMeta[]> {
    const infos = await SessionManager.list(this.cwd);
    return infos
      .filter((info) => !this.archivedSessions.has(resolve(info.path)))
      .map((i) => ({
        id: i.id,
        file: i.path,
        name: i.name,
        createdAt: i.created.getTime(),
        messageCount: i.messageCount,
        firstMessage: i.firstMessage,
        ...(this.projectForSessionFile(i.path)
          ? {
              projectId: this.projectForSessionFile(i.path)?.id,
              projectName: this.projectForSessionFile(i.path)?.name,
            }
          : {}),
      }));
  }

  private loadArchivedSessions(): void {
    try {
      const data = JSON.parse(readFileSync(this.archivedFile, "utf8")) as { sessions?: ArchivedSession[] };
      for (const session of data.sessions ?? []) {
        if (session?.file) this.archivedSessions.set(resolve(session.file), session);
      }
    } catch {
      /* start empty when the archive file does not exist yet */
    }
  }

  private saveArchivedSessions(): void {
    mkdirSync(dirname(this.archivedFile), { recursive: true });
    writeFileSync(
      this.archivedFile,
      JSON.stringify({ sessions: [...this.archivedSessions.values()] }, null, 2),
      "utf8",
    );
  }

  private async emitSessions(): Promise<void> {
    try {
      this.emit("sessions", await this.listSessions());
    } catch (e) {
      this.emit("log", "warn", `Failed to list sessions: ${(e as Error).message}`);
    }
  }

  async setModel(provider: string, id: string): Promise<void> {
    const model = this.modelRuntime.getModel(provider, id);
    if (!model) throw new Error(`Model not found: ${provider}/${id}`);
    await this.activeEntry().runtime.session.setModel(model);
    this.pushState();
  }

  async setThinking(level: string): Promise<void> {
    this.activeEntry().runtime.session.setThinkingLevel(level as ThinkingLevel);
    this.pushState();
  }

  /** Run an extension command such as /mcp reconnect <server>. */
  async runMcpCommand(command: string): Promise<void> {
    await this.activeEntry().runtime.session.prompt(command);
  }

  /** Reload extensions/skills/prompts/settings — used after MCP config changes. */
  async reload(): Promise<void> {
    await this.activeEntry().runtime.session.reload();
    this.pushState();
  }

  getSkillsDirectory(): string {
    return this.skillsDir;
  }

  isSubagentsEnabled(): boolean { return this.subagentsEnabled; }
  async setSubagentsEnabled(enabled: boolean): Promise<void> {
    if (enabled === this.subagentsEnabled) return;
    this.subagentsEnabled = enabled;
    writeFileSync(join(this.agentDir, "subagents.json"), JSON.stringify({ enabled }, null, 2));
    await this.activeEntry().runtime.session.reload();
    await this.bindRuntime(this.activeEntry());
    this.pushState();
  }
  getGoalSettings(): { enabled: boolean; goal: string } { return { enabled: this.goalsEnabled, goal: this.goalText }; }
  async setGoalsEnabled(enabled: boolean, goal?: string): Promise<void> {
    const nextGoal = goal ?? this.goalText;
    if (enabled === this.goalsEnabled && nextGoal === this.goalText) return;
    this.goalsEnabled = enabled;
    this.goalText = nextGoal;
    writeFileSync(join(this.agentDir, "goals.json"), JSON.stringify({ enabled, goal: this.goalText }, null, 2));
    await this.activeEntry().runtime.session.reload();
    await this.bindRuntime(this.activeEntry());
    this.pushState();
  }

  private normalizeAskUserQuestion(
    question: string,
    options: Array<{ label: string; description?: string }>,
  ): { question: string; options: Array<{ label: string; description?: string }> } {
    if (options.length > 0) return { question, options: options.slice(0, 5) };

    const lines = question.split("\n");
    const kept: string[] = [];
    const parsed: Array<{ label: string; description?: string }> = [];
    for (const rawLine of lines) {
      const match = rawLine.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/);
      if (!match) {
        kept.push(rawLine);
        continue;
      }
      const item = match[1].trim();
      const bold = item.match(/^\*\*(.+?)\*\*\s*(?::|：|[-—–]|\s+-\s+)?\s*(.*)$/);
      let label = item;
      let description: string | undefined;
      if (bold && bold[1]) {
        label = bold[1].trim();
        description = bold[2]?.trim() || undefined;
      } else {
        const separated = item.match(/^([^:：—–-]{1,80}?)\s*(?::|：|—|–)\s+(.+)$/);
        if (separated) {
          label = separated[1].trim();
          description = separated[2].trim();
        } else if (item.includes(" - ")) {
          const pieces = item.split(" - ");
          label = pieces[0].trim();
          description = pieces.slice(1).join(" - ").trim() || undefined;
        }
      }
      if (label) parsed.push(description ? { label, description } : { label });
    }

    if (parsed.length === 0) return { question, options };
    const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    return { question: text || "请选择：", options: parsed.slice(0, 5) };
  }

  private askUser(
    question: string,
    options: Array<{ label: string; description?: string }>,
    allowFreeform: boolean,
    sessionId?: string,
    sessionName?: string,
  ): Promise<string> {
    const id = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const normalized = this.normalizeAskUserQuestion(question, options);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pendingQuestions.delete(id); resolve("No answer received; ask again or use a safe explicit assumption."); }, 10 * 60_000);
      this.pendingQuestions.set(id, { resolve, timer });
      this.emit("ask_user", { id, sessionId, sessionName, question: normalized.question.slice(0, 1200), options: normalized.options, allowFreeform });
    });
  }

  answerUserQuestion(id: string, answer: string): void {
    const pending = this.pendingQuestions.get(id);
    if (!pending) throw new Error("澄清问题已过期");
    clearTimeout(pending.timer); this.pendingQuestions.delete(id); pending.resolve(`User clarification: ${answer.trim().slice(0, 4000)}`);
  }

  // ---------------------------------------------------------------- agents

  private defaultAgent(): AgentProfile {
    return { id: "default", name: "默认助手", description: "不附加额外提示词", prompt: "", memory: "", builtIn: true };
  }

  private loadAgents(): void {
    try {
      if (existsSync(this.agentsFile)) {
        const parsed = JSON.parse(readFileSync(this.agentsFile, "utf8")) as { agents?: AgentProfile[]; activeAgentId?: string };
        this.agents = (parsed.agents ?? []).filter((agent) => agent && typeof agent.id === "string" && typeof agent.name === "string" && typeof agent.prompt === "string")
          .map((agent) => ({ ...agent, memory: typeof agent.memory === "string" ? agent.memory : "" }));
        this.activeAgentId = parsed.activeAgentId ?? "default";
      }
    } catch {
      this.agents = [];
      this.activeAgentId = "default";
    }
    if (!this.agents.some((agent) => agent.id === "default")) this.agents.unshift(this.defaultAgent());
    if (!this.agents.some((agent) => agent.id === this.activeAgentId)) this.activeAgentId = "default";
    this.writeAgents();
  }

  private writeAgents(): void {
    writeFileSync(this.agentsFile, JSON.stringify({ agents: this.agents, activeAgentId: this.activeAgentId }, null, 2) + "\n", "utf8");
  }

  listAgents(): AgentProfile[] {
    return this.agents.map((agent) => ({ ...agent }));
  }

  getActiveAgent(): AgentProfile {
    return this.agents.find((agent) => agent.id === this.activeAgentId) ?? this.defaultAgent();
  }

  async saveAgent(agent: Omit<AgentProfile, "builtIn">): Promise<AgentProfile> {
    const name = agent.name.trim();
    if (!name) throw new Error("Agent 名称不能为空");
    const id = agent.id.trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error("Agent ID 只能包含字母、数字、下划线和连字符");
    const memory = (agent.memory ?? "").trim();
    if (memory.length > 16_000) throw new Error("Agent 长期记忆最多 16,000 个字符");
    if (containsSensitiveMemory(memory)) throw new Error("长期记忆疑似包含密钥、令牌或密码，已拒绝保存");
    if (id === "default") {
      const index = this.agents.findIndex((item) => item.id === "default");
      this.agents[index] = { ...this.defaultAgent(), memory };
      this.writeAgents();
      if (this.started) await this.activeEntry().runtime.session.reload();
      this.pushState();
      return { ...this.agents[index] };
    }
    const next: AgentProfile = { id, name, description: agent.description.trim(), prompt: agent.prompt.trim(), memory };
    const index = this.agents.findIndex((item) => item.id === id);
    if (index >= 0) this.agents[index] = { ...this.agents[index], ...next };
    else this.agents.push(next);
    this.writeAgents();
    if (id === this.activeAgentId && this.started) await this.activeEntry().runtime.session.reload();
    this.pushState();
    return { ...(this.agents.find((item) => item.id === id) as AgentProfile) };
  }

  async removeAgent(id: string): Promise<void> {
    if (id === "default") throw new Error("默认助手不能删除");
    const before = this.agents.length;
    this.agents = this.agents.filter((agent) => agent.id !== id);
    if (this.agents.length === before) throw new Error("Agent 不存在");
    if (this.activeAgentId === id) this.activeAgentId = "default";
    this.writeAgents();
    if (this.started) await this.activeEntry().runtime.session.reload();
    this.pushState();
  }

  async setActiveAgent(id: string): Promise<void> {
    if (!this.agents.some((agent) => agent.id === id)) throw new Error("Agent 不存在");
    this.activeAgentId = id;
    this.writeAgents();
    if (this.started) await this.activeEntry().runtime.session.reload();
    this.pushState();
  }

  private readMcpConfig(): McpConfig {
    if (!this.mcpConfigPath) return { mcpServers: {} };
    try {
      if (existsSync(this.mcpConfigPath)) {
        const parsed = JSON.parse(readFileSync(this.mcpConfigPath, "utf8")) as Partial<McpConfig>;
        return { mcpServers: parsed.mcpServers ?? {}, settings: parsed.settings };
      }
    } catch {
      /* ignore invalid app config; the UI can replace it */
    }
    return { mcpServers: {} };
  }

  listSkills(): SkillSummary[] {
    const result = loadSkillsFromDir({ dir: this.skillsDir, source: "app" });
    return result.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      directory: skill.baseDir,
      disableModelInvocation: skill.disableModelInvocation,
    }));
  }

  // --------------------------------------------------------------- projects

  private loadProjects(): void {
    try {
      if (!existsSync(this.projectsFile)) return;
      const parsed = JSON.parse(readFileSync(this.projectsFile, "utf8")) as { projects?: Project[] };
      this.projects = Array.isArray(parsed.projects) ? parsed.projects.map((project) => ({
        ...project,
        workspacePaths: this.normalizeWorkspacePaths((project as { workspacePaths?: unknown; workspacePath?: unknown }).workspacePaths ?? (project as { workspacePath?: unknown }).workspacePath),
        sessionFiles: Array.isArray(project.sessionFiles) ? project.sessionFiles.map((file) => resolve(file)) : [],
        memories: Array.isArray(project.memories) ? project.memories : [],
        documents: Array.isArray(project.documents)
          ? project.documents.map((document) => ({ ...document, name: repairUploadedFilename(document.name) }))
          : [],
      })) : [];
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
      const abs = resolve(this.cwd, item.trim());
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push(abs);
    }
    return out;
  }

  private saveProjects(): void {
    mkdirSync(dirname(this.projectsFile), { recursive: true });
    writeFileSync(this.projectsFile, JSON.stringify({ projects: this.projects }, null, 2), "utf8");
  }

  private loadProjectIndex(): void {
    try {
      if (!existsSync(this.projectIndexFile)) return;
      const parsed = JSON.parse(readFileSync(this.projectIndexFile, "utf8")) as Record<string, { text?: string; indexedAt?: number }>;
      this.projectIndex = Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value?.text === "string").map(([key, value]) => [key, { text: value.text ?? "", indexedAt: value.indexedAt ?? 0 }]));
    } catch {
      this.projectIndex = {};
    }
  }

  private saveProjectIndex(): void {
    mkdirSync(dirname(this.projectIndexFile), { recursive: true });
    writeFileSync(this.projectIndexFile, JSON.stringify(this.projectIndex, null, 2), "utf8");
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
    const parsers = await import("./parsers.ts");
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
    const sessions = await this.listSessions();
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

  private projectSummary(project: Project): ProjectSummary {
    return {
      id: project.id,
      name: project.name,
      description: project.description,
      workspacePaths: project.workspacePaths ?? [],
      sessionCount: project.sessionFiles.length,
      memoryCount: project.memories.length,
      documentCount: project.documents.length,
      updatedAt: project.updatedAt,
    };
  }

  private projectForSessionFile(file?: string): Project | null {
    if (!file) return null;
    const target = resolve(file);
    return this.projects.find((project) => project.sessionFiles.some((item) => resolve(item) === target)) ?? null;
  }

  private requireProject(id: string): Project {
    const project = this.projects.find((item) => item.id === id);
    if (!project) throw new Error("Project not found");
    return project;
  }

  listProjects(): ProjectSummary[] {
    return this.projects.map((project) => this.projectSummary(project));
  }

  getProject(id: string): Project {
    return structuredClone(this.requireProject(id));
  }

  createProject(input: { name: string; description?: string; workspacePaths?: string[] | string | null; workspacePath?: string; instructions?: string }): Project {
    const name = input.name.trim();
    if (!name) throw new Error("Project name is required");
    if (name.length > 120) throw new Error("Project name is too long");
    const now = Date.now();
    const project: Project = {
      id: randomUUID(),
      name,
      description: (input.description ?? "").trim(),
      workspacePaths: this.normalizeWorkspacePaths(input.workspacePaths ?? input.workspacePath),
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

  async updateProject(id: string, patch: { name?: string; description?: string; workspacePaths?: string[] | string | null; workspacePath?: string | null; instructions?: string }): Promise<Project> {
    const project = this.requireProject(id);
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new Error("Project name is required");
      project.name = name;
    }
    if (patch.description !== undefined) project.description = patch.description.trim();
    if (patch.workspacePaths !== undefined || patch.workspacePath !== undefined) project.workspacePaths = this.normalizeWorkspacePaths(patch.workspacePaths ?? patch.workspacePath);
    if (patch.instructions !== undefined) project.instructions = patch.instructions.trim();
    project.updatedAt = Date.now();
    this.saveProjects();
    await this.reloadProjectRuntimes(project.id);
    this.pushState();
    return structuredClone(project);
  }

  async removeProject(id: string): Promise<void> {
    const project = this.requireProject(id);
    const sessionFiles = new Set(project.sessionFiles.map((file) => resolve(file)));
    this.projects = this.projects.filter((item) => item.id !== id);
    this.saveProjects();
    await Promise.all([...this.runtimes.values()]
      .filter((entry) => {
        const sessionFile = entry.runtime.session.sessionFile;
        return !!sessionFile && sessionFiles.has(resolve(sessionFile));
      })
      .map((entry) => entry.runtime.session.reload()));
    this.pushState();
    await this.emitSessions();
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
    const runtime = this.findRuntimeByFile(target);
    if (runtime) await runtime.runtime.session.reload();
    this.pushState();
    await this.emitSessions();
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
    await this.reloadProjectRuntimes(projectId);
    this.pushState();
    return structuredClone(memory);
  }

  async removeProjectMemory(projectId: string, memoryId: string): Promise<void> {
    const project = this.requireProject(projectId);
    project.memories = project.memories.filter((memory) => memory.id !== memoryId);
    project.updatedAt = Date.now();
    this.saveProjects();
    await this.reloadProjectRuntimes(projectId);
    this.pushState();
  }

  async addProjectDocument(projectId: string, input: { path: string; name?: string; summary?: string }): Promise<ProjectDocument> {
    const project = this.requireProject(projectId);
    const absolute = resolve(this.cwd, input.path);
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
    await this.reloadProjectRuntimes(projectId);
    this.pushState();
    return structuredClone(document);
  }

  async removeProjectDocument(projectId: string, documentId: string): Promise<void> {
    const project = this.requireProject(projectId);
    const removed = project.documents.find((document) => document.id === documentId);
    project.documents = project.documents.filter((document) => document.id !== documentId);
    if (removed) this.removeProjectDocumentIndex(removed.id);
    project.updatedAt = Date.now();
    this.saveProjects();
    await this.reloadProjectRuntimes(projectId);
    this.pushState();
  }

  private async reloadProjectRuntimes(projectId: string): Promise<void> {
    await Promise.all([...this.runtimes.values()]
      .filter((entry) => this.projectForSessionFile(entry.runtime.session.sessionFile)?.id === projectId)
      .map((entry) => entry.runtime.session.reload()));
  }

  private projectSystemPrompt(sessionFile?: string): string[] {
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

  // ------------------------------------------------------------- workspaces

  private loadWorkspaces(): void {
    try {
      if (existsSync(this.workspacesFile)) {
        const data = JSON.parse(readFileSync(this.workspacesFile, "utf8")) as { paths?: string[]; active?: string };
        this.customWorkspaces = Array.isArray(data.paths) ? data.paths : [];
        this.lastWorkspacePath = typeof data.active === "string" ? data.active : "";
      }
    } catch {
      this.customWorkspaces = [];
    }
  }

  private saveWorkspaces(): void {
    try {
      mkdirSync(resolve(this.workspacesFile, ".."), { recursive: true });
      writeFileSync(
        this.workspacesFile,
        JSON.stringify({ paths: this.customWorkspaces, active: this.lastWorkspacePath || this.cwd }, null, 2),
        "utf8",
      );
    } catch {
      /* ignore */
    }
  }

  listWorkspaces(): WorkspaceInfo[] {
    const seen = new Set<string>();
    const out: WorkspaceInfo[] = [];
    const push = (p: string) => {
      const abs = resolve(p);
      if (seen.has(abs)) return;
      seen.add(abs);
      out.push({
        path: abs,
        name: abs === resolve(this.defaultWorkspacePath) ? "临时对话" : basename(abs) || abs,
        current: abs === resolve(this.cwd),
      });
    };
    push(this.defaultWorkspacePath);
    push(this.cwd);
    for (const p of this.customWorkspaces) push(p);
    return out;
  }

  addWorkspace(path: string): WorkspaceInfo[] {
    const abs = resolve(path);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      throw new Error(`目录不存在: ${abs}`);
    }
    if (!this.customWorkspaces.includes(abs)) this.customWorkspaces.push(abs);
    this.saveWorkspaces();
    this.emit("workspaces", this.listWorkspaces());
    return this.listWorkspaces();
  }

  async switchWorkspace(path: string): Promise<void> {
    const abs = resolve(path);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      throw new Error(`目录不存在: ${abs}`);
    }
    if (abs === resolve(this.cwd)) {
      this.emit("workspaces", this.listWorkspaces());
      return;
    }

    await this.dispose();

    this.cwd = abs;
    if (!this.customWorkspaces.includes(abs)) this.customWorkspaces.push(abs);
    this.lastWorkspacePath = abs;
    this.saveWorkspaces();

    this.settingsManager = SettingsManager.create(this.cwd, this.agentDir);
    this.lastMcpStatus = null;
    await this.createRuntime();
    this.emit("log", "info", `工作区已切换: ${this.cwd}`);
    this.pushState();
    await this.emitSessions();
    this.emit("workspaces", this.listWorkspaces());
  }

  listWorkspaceFiles(relPath: string, root?: string): FileEntry[] {
    const absRoot = resolve(root ? root : this.cwd);
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
  resolveWorkspacePath(relPath: string, root?: string): string {
    const absRoot = resolve(root ? root : this.cwd);
    const abs = resolve(absRoot, relPath);
    if (abs !== absRoot && !abs.startsWith(absRoot + sep)) throw new Error("路径越界，拒绝读取");
    return abs;
  }

  /** Read a workspace file for preview: text head (≤1MB) or full image (≤8MB). */
  moveWorkspaceFile(sourceRelPath: string, destinationDir: string, root?: string): void {
    const absRoot = resolve(root ? root : this.cwd);
    const sourceAbs = this.resolveWorkspacePath(sourceRelPath, root);
    const destAbs = resolve(destinationDir);
    if (destAbs !== absRoot && !destAbs.startsWith(absRoot + sep)) throw new Error("目标文件夹不在当前工作区");
    if (!existsSync(destAbs) || !statSync(destAbs).isDirectory()) throw new Error("目标文件夹不存在");
    if (!existsSync(sourceAbs)) throw new Error("源文件不存在");
    if (resolve(dirname(sourceAbs)) === destAbs) return;

    const movedAbs = join(destAbs, basename(sourceAbs));
    if (existsSync(movedAbs)) throw new Error("目标位置已存在同名文件或文件夹");
    renameSync(sourceAbs, movedAbs);

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

  async readWorkspaceFile(relPath: string, root?: string): Promise<WorkspaceFileContent> {
    const abs = this.resolveWorkspacePath(relPath, root);
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

  /** Browse an arbitrary absolute directory (used by the workspace folder picker). */
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
      return drives.map((d) => ({ name: d.replace(/\\$/, ""), path: d, isDir: true }));
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

  // -------------------------------------------------------------- commands

  async runCommand(command: string): Promise<string> {
    const parts = command.trim().split(/\s+/);
    const name = parts[0] ?? "";
    const arg = parts.slice(1).join(" ");

    switch (name) {
      case "/new":
      case "/new-session":
        await this.newSession();
        return "已新建会话";
      case "/reload":
        await this.reload();
        return "已重新加载扩展/配置";
      case "/model": {
        const [pid, level] = arg.split(":");
        const idx = pid.lastIndexOf("/");
        if (idx <= 0 || idx === pid.length - 1) throw new Error(`用法: /model <provider>/<model>[:thinking]`);
        const provider = pid.slice(0, idx);
        const id = pid.slice(idx + 1);
        await this.setModel(provider, id);
        if (level) await this.setThinking(level);
        return `已切换到 ${provider}/${id}${level ? ` (思考: ${level})` : ""}`;
      }
      case "/compact":
        await this.activeEntry().runtime.session.compact();
        return "已压缩上下文";
      case "/mcp":
      case "/mcp-auth": {
        await this.activeEntry().runtime.session.prompt(command);
        return `已执行 ${command}`;
      }
      default: {
        if (name.startsWith("/")) {
          // pass through as an extension command
          await this.activeEntry().runtime.session.prompt(command);
          return `已执行 ${command}`;
        }
        throw new Error(`未知命令: ${name}`);
      }
    }
  }

  async runWechatCommand(action: WechatCommandAction): Promise<void> {
    const command = action === "reconnect" ? "/wechat reconnect"
      : action === "disconnect" ? "/wechat disconnect" : "/wechat";
    await this.activeEntry().runtime.session.prompt(command);
  }

  static commandList(): CommandInfo[] {
    return [
      { name: "/new", description: "新建会话", group: "session" },
      { name: "/reload", description: "重新加载扩展、技能、提示词与配置", group: "system" },
      { name: "/model", description: "切换模型，如 /model anthropic/claude-opus-4-5:high", args: "<provider>/<model>[:thinking]", group: "model" },
      { name: "/compact", description: "手动压缩会话上下文", group: "session" },
      { name: "/mcp", description: "MCP 面板/状态（reconnect <server>、status、setup 等）", args: "[setup|status|reconnect <server>]", group: "mcp" },
      { name: "/mcp reconnect", description: "重连所有 MCP 服务", args: "[<server>]", group: "mcp" },
      { name: "/mcp-auth", description: "MCP OAuth 认证", args: "[<server>]", group: "mcp" },
      { name: "/mcp disable", description: "禁用某个 MCP 服务", args: "<server>", group: "mcp" },
      { name: "/mcp enable", description: "启用某个 MCP 服务", args: "<server>", group: "mcp" },
      { name: "/mcp logout", description: "清除某个服务的 OAuth 凭据", args: "<server>", group: "mcp" },
      { name: "/wechat", description: "连接微信对话", args: "[connect|reconnect|disconnect|status]", group: "system" },
      { name: "/weixin", description: "连接微信对话（别名）", args: "[connect|reconnect|disconnect|status]", group: "system" },
    ];
  }

  // ------------------------------------------------------------- model mgmt

  private modelsJsonPath(): string {
    return join(this.agentDir, "models.json");
  }

  readModelsJson(): Record<string, unknown> {
    try {
      const f = this.modelsJsonPath();
      if (existsSync(f)) {
        const data = JSON.parse(readFileSync(f, "utf8")) as unknown;
        if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
      }
    } catch {
      /* ignore */
    }
    return {};
  }

  private writeModelsJson(data: Record<string, unknown>): void {
    mkdirSync(this.agentDir, { recursive: true });
    writeFileSync(this.modelsJsonPath(), JSON.stringify(data, null, 2) + "\n", "utf8");
  }

  /** Register a custom provider in models.json, then reload the runtime. */
  registerProviderConfig(name: string, config: Record<string, unknown>): void {
    if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error("提供方名称只能包含字母、数字、._-");
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("config 必须是对象");
    const data = this.readModelsJson();
    const providers = (data.providers ?? {}) as Record<string, unknown>;
    providers[name] = config;
    data.providers = providers;
    this.writeModelsJson(data);
  }

  /** Remove a custom provider from models.json, then reload the runtime. */
  unregisterProviderConfig(name: string): void {
    const data = this.readModelsJson();
    const providers = (data.providers ?? {}) as Record<string, unknown>;
    if (!(name in providers)) throw new Error(`未注册的提供方: ${name}`);
    delete providers[name];
    data.providers = providers;
    this.writeModelsJson(data);
  }

  /** Reload models.json + refresh availability, then push the new state to clients. */
  async refreshModels(): Promise<{ errors: string[] }> {
    let result: { errors?: ReadonlyMap<string, Error> } | undefined;
    try {
      result = await withTimeout(
        this.modelRuntime.refresh({ allowNetwork: false }),
        15_000,
        "模型刷新超时",
      );
    } catch (error) {
      result = { errors: new Map([[this.agentDir, new Error((error as Error).message)]]) };
    }
    this.updateAvailableModels();
    this.pushState();
    const errors: string[] = [];
    for (const [provider, error] of result?.errors ?? new Map()) {
      errors.push(`${provider}: ${error}`);
    }
    return { errors };
  }

  /** Full provider × model catalog with auth/custom flags (for the Models panel). */
  listModels(): ModelCatalogEntry[] {
    const providers = this.modelRuntime.getProviders();
    const customNames = new Set(
      Object.keys((this.readModelsJson() as { providers?: Record<string, unknown> }).providers ?? {}),
    );
    const availableSet = new Set(this.modelRuntime.getAvailableSnapshot().map((m) => `${m.provider}/${m.id}`));
    return providers.map((p) => {
      const models = this.modelRuntime.getModels(p.id).map((m) => {
        const meta = m as unknown as { name?: string; reasoning?: boolean; input?: string[]; contextWindow?: number };
        return {
          id: m.id,
          name: meta.name,
          reasoning: meta.reasoning,
          input: meta.input,
          contextWindow: meta.contextWindow,
          available: availableSet.has(`${p.id}/${m.id}`),
        };
      });
      const auth = this.modelRuntime.getProviderAuthStatus(p.id);
      return {
        provider: p.id,
        displayName: (p as { displayName?: string }).displayName ?? p.id,
        isCustom: customNames.has(p.id),
        authConfigured: !!auth?.configured,
        authSource: auth?.source,
        models,
      };
    });
  }

  async setProviderApiKey(provider: string, apiKey: string): Promise<void> {
    const providerId = provider.trim();
    const key = apiKey.trim();
    if (!providerId || !key) throw new Error("需要 provider 和 apiKey");
    // Persist through the app-owned store first so the key survives even if
    // the in-process refresh below fails, then activate it in the runtime
    // (process-local overlay) and refresh the provider snapshot.
    await this.appCredentials.modify(providerId, async () => ({ type: "api_key", key }));
    await withTimeout(
      this.modelRuntime.setRuntimeApiKey(providerId, key),
      15_000,
      "保存 API Key 超时",
    );
    this.pushState();
  }

  async removeProviderApiKey(provider: string): Promise<void> {
    const providerId = provider.trim();
    // Clear the process-local runtime overlay first. Its internal refresh is
    // network-bound (allowNetwork defaults to true), so a slow or failed
    // availability check must not block the authoritative cleanup below.
    try {
      await withTimeout(
        this.modelRuntime.removeRuntimeApiKey(providerId),
        15_000,
        "清除 API Key 超时",
      );
    } catch (error) {
      this.emit("log", "warn", `清除 API Key 时刷新失败（继续清理）: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Remove from the app-owned store (memory + auth.json), then force a
    // network-free refresh so storedProviders immediately matches the file.
    // Without it, the Models panel keeps reporting the provider as
    // configured until the app restarts.
    await this.appCredentials.delete(providerId);
    try {
      await withTimeout(
        this.modelRuntime.refresh({ allowNetwork: false }),
        15_000,
        "清除后刷新模型状态超时",
      );
    } catch (error) {
      this.emit("log", "warn", `清除 API Key 后刷新模型状态失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.updateAvailableModels();
    this.pushState();
  }

  private updateAvailableModels(): void {
    const available = this.modelRuntime?.getAvailableSnapshot() ?? [];
    this.availableModels = available.map((m) => {
      const meta = m as unknown as { displayName?: string; thinkingLevels?: string[]; kind?: string; contextWindow?: number };
      return {
        provider: m.provider,
        id: m.id,
        displayName: meta.displayName ?? `${m.provider}/${m.id}`,
        thinking: meta.thinkingLevels ?? [],
        kind: meta.kind,
        contextWindow: meta.contextWindow,
      };
    });
  }
  private availableModelInfos(): ModelInfo[] {
    const snap = this.modelRuntime?.getAvailableSnapshot() ?? [];
    if (snap.length === 0 && this.availableModels.length > 0) return this.availableModels;
    return snap.map((m) => {
      const meta = m as unknown as { displayName?: string; kind?: string; contextWindow?: number };
      return {
        provider: m.provider,
        id: m.id,
        displayName: meta.displayName ?? `${m.provider}/${m.id}`,
        thinking: (m as { thinkingLevels?: string[] }).thinkingLevels ?? [],
        kind: meta.kind,
        contextWindow: meta.contextWindow,
      };
    });
  }

  // ------------------------------------------------------------------ state

  getState(): AppState {
    const session = this.runtimes.get(this.activeRuntimeId)?.runtime.session;
    const model = session?.model;
    return {
      messages: serializeMessages(session?.messages ?? []),
      piVersion: PI_VERSION || undefined,
      model: model
        ? {
            provider: model.provider,
            id: model.id,
            displayName: (model as { displayName?: string }).displayName ?? `${model.provider}/${model.id}`,
            thinking: (model as { thinkingLevels?: string[] }).thinkingLevels ?? [],
          }
        : null,
      thinkingLevel: session?.thinkingLevel ?? "off",
      isStreaming: session?.isStreaming ?? false,
      cwd: this.cwd,
      availableModels: this.availableModelInfos(),
      activeAgent: this.getActiveAgent(),
      mcp: this.lastMcpStatus as unknown as AppState["mcp"],
      sessionFile: session?.sessionFile,
      sessionId: session?.sessionId,
      longTasks: [...(this.longTasks.get(this.activeRuntimeId) ?? [])],
      project: this.projectForSessionFile(session?.sessionFile)
        ? this.projectSummary(this.projectForSessionFile(session?.sessionFile) as Project)
        : null,
    };
  }

  pushState(): void {
    if (!this.started) return;
    this.emit("state", this.getState());
  }

  get cwdPath(): string {
    return this.cwd;
  }
}

// ------------------------------------------------------------------ serialize

const TEXT_PREVIEW_LIMIT = 1024 * 1024; // bytes of text content returned to the client
const IMAGE_PREVIEW_LIMIT = 8 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".ts": "text/typescript", ".tsx": "text/typescript", ".js": "text/javascript", ".jsx": "text/javascript",
  ".mjs": "text/javascript", ".cjs": "text/javascript", ".json": "application/json", ".md": "text/markdown",
  ".css": "text/css", ".scss": "text/scss", ".html": "text/html", ".htm": "text/html",
  ".py": "text/x-python", ".go": "text/x-go", ".rs": "text/x-rust", ".java": "text/x-java",
  ".c": "text/x-c", ".h": "text/x-c", ".cpp": "text/x-c++", ".hpp": "text/x-c++",
  ".rb": "text/x-ruby", ".sh": "text/x-sh", ".bat": "text/x-bat", ".ps1": "text/x-powershell",
  ".yaml": "text/yaml", ".yml": "text/yaml", ".toml": "text/toml", ".xml": "text/xml", ".sql": "text/sql",
  ".txt": "text/plain", ".csv": "text/csv", ".log": "text/plain",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".ico": "image/x-icon",
  ".pdf": "application/pdf", ".zip": "application/zip", ".gz": "application/gzip", ".tar": "application/x-tar",
};

function textOf(content: unknown[]): string {
  return content
    .filter((c) => (c as { type?: string }).type === "text")
    .map((c) => (c as { text: string }).text)
    .join("");
}

export function serializeMessages(messages: AgentMessage[]): ClientMessage[] {
  const out: ClientMessage[] = [];
  for (const m of messages) {
    const ts = (m as { timestamp?: number }).timestamp ?? 0;
    if (m.role === "user") {
      const content = m.content;
      const text =
        typeof content === "string"
          ? content
          : content.filter((c) => (c as { type?: string }).type === "text").map((c) => (c as { text: string }).text).join("\n");
      out.push({ id: `u-${ts}-${out.length}`, role: "user", text, timestamp: ts });
    } else if (m.role === "assistant") {
      const content = m.content as Array<{
        type: string;
        text?: string;
        thinking?: string;
        id?: string;
        name?: string;
        arguments?: Record<string, unknown>;
      }>;
      const text = textOf(content as unknown[]);
      const thinking = content
        .filter((c) => c.type === "thinking")
        .map((c) => c.thinking ?? "")
        .join("\n");
      const toolCalls = content
        .filter((c) => c.type === "toolCall")
        .map((c) => ({ id: c.id ?? "", name: c.name ?? "", arguments: c.arguments ?? {} }));
      out.push({
        id: `a-${ts}-${out.length}`,
        role: "assistant",
        text,
        thinking: thinking || undefined,
        toolCalls,
        stopReason: m.stopReason,
        errorMessage: m.errorMessage,
        isError: m.stopReason === "error" || !!m.errorMessage,
        timestamp: ts,
      });
    } else if (m.role === "toolResult") {
      const text = textOf((m.content as unknown[]) ?? []);
      out.push({
        id: `t-${m.toolCallId}`,
        role: "toolResult",
        toolCallId: m.toolCallId,
        toolName: m.toolName,
        text,
        isError: m.isError,
        timestamp: ts,
      });
    }
  }
  return out;
}
