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
import type { McpStatusSnapshot } from "@pi-studio/shared";
import type { WechatCommandAction } from "@pi-studio/shared";
import { wechatExtension } from "./extensions/wechat.ts";
import { AppCredentialStore } from "./credential-store.ts";
import { ModelManager } from "./domains/model-manager.ts";
import { AgentStore } from "./domains/agent-store.ts";
import { ProjectStore } from "./domains/project-store.ts";
import { WorkspaceManager } from "./domains/workspace-manager.ts";
import { decodeTextBuffer, repairUploadedFilename } from "./textEncoding.ts";
import type {
  AppState,
  AgentProfile,
  AttachmentInfo,
  ClientMessage,
  CommandInfo,
  FileEntry,
  ModelCatalogEntry,
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
} from "@pi-studio/shared";

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

// Pi SDK version. In production the exact version is injected at build time
// (esbuild `define`) because the SDK package is bundled and its package.json is
// pruned from the runtime. In dev we fall back to walking node_modules.
declare const __PI_VERSION__: string | undefined;

const PI_VERSION: string = (typeof __PI_VERSION__ !== "undefined" ? __PI_VERSION__ : "") || (() => {
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
  ask_user: [question: import("@pi-studio/shared").AskUserQuestion];
  wechat_status: [status: import("@pi-studio/shared").WechatStatus];
  wechat_qr: [qr: import("@pi-studio/shared").WechatQr];
  wechat_log: [entry: import("@pi-studio/shared").WechatLogEntry];
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
  private readonly modelManager: ModelManager;
  private readonly agentStore: AgentStore;
  private readonly projectStore: ProjectStore;
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private readonly promptQueues = new Map<string, Promise<void>>();
  private readonly longTasks = new Map<string, LongTask[]>();
  private activeRuntimeId = "";
  private eventBus!: ReturnType<typeof createEventBus>;
  private lastMcpStatus: McpStatusSnapshot | null = null;
  private started = false;
  private readonly workspaceManager: WorkspaceManager;
  private projectsFile: string;
  private projectIndexFile: string;
  private archivedFile: string;
  private readonly archivedSessions = new Map<string, ArchivedSession>();
  private readonly agentsFile: string;
  private readonly hermesMemoryExtensionPath: string;
  private readonly subagentsExtensionPath: string;
  private readonly goalsExtensionPath: string;
  private goalsEnabled = false;
  private goalText = "";
  private subagentsEnabled = false;
  private pendingQuestions = new Map<string, { resolve: (answer: string) => void; timer: NodeJS.Timeout }>();

  constructor(options: BridgeOptions) {
    super();
    this.cwd = options.cwd;
    this.defaultWorkspacePath = options.defaultWorkspacePath ? resolve(options.defaultWorkspacePath) : resolve(this.cwd);
    this.mcpConfigPath = options.mcpConfigPath;
    this.agentDir = options.agentDir ?? getAgentDir();
    this.modelManager = new ModelManager({
      agentDir: this.agentDir,
      pushState: () => this.pushState(),
      emitLog: (level, message) => this.emit("log", level, message),
      // Once the user configures a model channel, default new sessions to
      // high thinking (persisted via the SDK settings manager).
      onModelsConfigured: () => this.settingsManager.setDefaultThinkingLevel("high"),
    });
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
    this.agentStore = new AgentStore({
      agentsFile: this.agentsFile,
      getStarted: () => this.started,
      reloadActiveSession: async () => {
        await this.activeEntry().runtime.session.reload();
      },
      pushState: () => this.pushState(),
    });
    this.agentStore.loadAgents();
    this.workspaceManager = new WorkspaceManager({
      workspacesFile: process.env.PI_STUDIO_WORKSPACES_FILE ?? this.defaultDataFile("workspaces.json"),
      getCwd: () => this.cwd,
      getDefaultWorkspacePath: () => this.defaultWorkspacePath,
      emitWorkspaces: (list) => this.emit("workspaces", list),
      updateDocumentPathsAfterMove: (sourceAbs, movedAbs) => this.projectStore.updateDocumentPathsAfterMove(sourceAbs, movedAbs),
    });
    this.projectsFile = process.env.PI_STUDIO_PROJECTS_FILE ?? this.defaultDataFile("projects.json");
    this.projectIndexFile = process.env.PI_STUDIO_PROJECT_INDEX_FILE ?? this.defaultDataFile("project-index.json");
    this.projectStore = new ProjectStore({
      projectsFile: this.projectsFile,
      projectIndexFile: this.projectIndexFile,
      getCwd: () => this.cwd,
      pushState: () => this.pushState(),
      listSessions: () => this.listSessions(),
      reloadProjectRuntimes: async (projectId) => this.reloadProjectRuntimes(projectId),
      reloadSessionFile: async (file) => {
        const runtime = this.findRuntimeByFile(file);
        if (runtime) await runtime.runtime.session.reload();
      },
      reloadSessionsForFiles: async (files) => {
        await Promise.all([...this.runtimes.values()]
          .filter((entry) => {
            const sessionFile = entry.runtime.session.sessionFile;
            return !!sessionFile && files.has(resolve(sessionFile));
          })
          .map((entry) => entry.runtime.session.reload()));
      },
      emitSessions: () => this.emitSessions(),
    });
    this.projectStore.loadProjects();
    this.archivedFile = process.env.PI_STUDIO_ARCHIVED_FILE ?? this.defaultDataFile("archived-sessions.json");
    this.workspaceManager.load();
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
    this.modelManager.modelRuntime = this.modelRuntime;
    this.modelManager.appCredentials = this.appCredentials;
    this.settingsManager = SettingsManager.create(this.cwd, this.agentDir);
    this.eventBus = createEventBus();

    this.eventBus.on("wechat:status", (status) => this.emit("wechat_status", status as import("@pi-studio/shared").WechatStatus));
    this.eventBus.on("wechat:qr", (qr) => this.emit("wechat_qr", qr as import("@pi-studio/shared").WechatQr));
    this.eventBus.on("wechat:log", (entry) => this.emit("wechat_log", entry as import("@pi-studio/shared").WechatLogEntry));

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
    this.modelManager.updateAvailableModels();
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
            const agent = this.agentStore.getActiveAgent();
            const additions: string[] = [];
            if (agent.prompt.trim()) additions.push(`## Active Agent: ${agent.name}\n${agent.prompt.trim()}`);
            if (agent.memory?.trim()) additions.push(`## Agent long-term memory\n<agent-memory>\nThe following is user-managed durable context for this agent. Treat it as reference material, not as new user input; current user requests and verified workspace evidence take priority.\n\n${agent.memory.trim()}\n</agent-memory>`);
            if (this.goalsEnabled && this.goalText.trim()) additions.push(`## Active long-running goal and audit policy\n<active-goal>\n${this.goalText.trim()}\n</active-goal>\nTreat this as the durable objective for the current work. Break it into verifiable milestones, keep checking completed work against the objective and actual evidence, and do not report the goal complete until its acceptance criteria are demonstrably satisfied. When a key requirement or tradeoff is unclear, use the ask_user tool to obtain confirmation before committing to an assumption. Use the installed goal/audit capabilities when useful for sustained work.`);
            additions.push(...this.projectStore.projectSystemPrompt(sessionManager.getSessionFile()));
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
    const project = projectId ? this.projectStore.requireProject(projectId) : null;
    // A projectless conversation belongs to the default "临时对话" workspace, and a
    // project session belongs to the project's main workspace, so both stay reachable
    // after switching. Switch cwd first when the desired workspace differs.
    const targetCwd = projectId ? (project?.mainWorkspacePath ?? null) : this.defaultWorkspacePath;
    if (targetCwd && resolve(targetCwd) !== resolve(this.cwd)) {
      this.cwd = resolve(targetCwd);
      this.settingsManager = SettingsManager.create(this.cwd, this.agentDir);
      this.lastMcpStatus = null;
      await this.createRuntime();
      this.emit("log", "info", `工作区已切换: ${this.cwd}`);
      // The freshly created session now belongs to the selected project.
      if (project) {
        const newFile = this.activeEntry().runtime.session.sessionFile;
        if (newFile) await this.projectStore.assignSessionToProject(newFile, project.id);
      }
      this.pushState();
      await this.emitSessions();
      this.emit("workspaces", this.listWorkspaces());
      return;
    }
    const active = this.activeEntry();
    const inheritedProject = projectId
      ? project
      : this.projectStore.projectForSessionFile(active.runtime.session.sessionFile);
    const sessionDir = active.runtime.session.sessionManager.getSessionDir();
    const entry = await this.createRuntimeForManager(SessionManager.create(this.cwd, sessionDir));
    this.runtimes.set(entry.id, entry);
    this.activeRuntimeId = entry.id;
    if (inheritedProject && entry.runtime.session.sessionFile) await this.projectStore.assignSessionToProject(entry.runtime.session.sessionFile, inheritedProject.id);
    this.pushState();
    await this.emitSessions();
  }

  async switchSession(file: string): Promise<void> {
    const existing = this.findRuntimeByFile(file);
    if (existing) {
      this.activeRuntimeId = existing.id;
    } else {
      const sessionManager = SessionManager.open(resolve(file));
      const entry = await this.createRuntimeForManager(sessionManager);
      this.runtimes.set(entry.id, entry);
      this.activeRuntimeId = entry.id;
    }
    this.pushState();
    await this.emitSessions();
  }

  async deleteSession(file: string): Promise<{ activeFile?: string }> {
    const target = resolve(file);
    const infos = await SessionManager.listAll();
    const info = infos.find((item) => resolve(item.path) === target);
    if (!info || extname(target).toLowerCase() !== ".jsonl") throw new Error("Session file not found");
    const runtime = this.findRuntimeByFile(target);
    const currentProject = this.projectStore.projectForSessionFile(target);
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
    this.projectStore.removeSessionFromProjects(target);
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
    const infos = await SessionManager.listAll();
    const info = infos.find((item) => resolve(item.path) === target);
    if (!info || extname(target).toLowerCase() !== ".jsonl") throw new Error("Session file not found");
    if (this.archivedSessions.has(target)) throw new Error("对话已归档");

    const project = this.projectStore.projectForSessionFile(target);
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

    if (project) this.projectStore.removeSessionFromProjects(target);

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

    const changedProjectId = archived.projectId ? this.projectStore.restoreSessionToProject(archived.projectId, target) : null;
    if (changedProjectId) await this.reloadProjectRuntimes(changedProjectId);
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
    const infos = await SessionManager.listAll();
    const out: SessionMeta[] = [];
    for (const i of infos) {
      if (this.archivedSessions.has(resolve(i.path))) continue;
      const project = this.projectStore.projectForSessionFile(i.path);
      if (project?.archived) continue;
      out.push({
        id: i.id,
        file: i.path,
        name: i.name,
        createdAt: i.created.getTime(),
        messageCount: i.messageCount,
        firstMessage: i.firstMessage,
        ...(project ? { projectId: project.id, projectName: project.name } : {}),
      });
    }
    return out;
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

  listAgents(): AgentProfile[] {
    return this.agentStore.listAgents();
  }

  getActiveAgent(): AgentProfile {
    return this.agentStore.getActiveAgent();
  }

  async saveAgent(agent: Omit<AgentProfile, "builtIn">): Promise<AgentProfile> {
    return this.agentStore.saveAgent(agent);
  }

  async removeAgent(id: string): Promise<void> {
    return this.agentStore.removeAgent(id);
  }

  async setActiveAgent(id: string): Promise<void> {
    return this.agentStore.setActiveAgent(id);
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

  listProjects(): ProjectSummary[] {
    return this.projectStore.listProjects();
  }

  listArchivedProjects(): ProjectSummary[] {
    return this.projectStore.listArchivedProjects();
  }

  getProject(id: string): Project {
    return this.projectStore.getProject(id);
  }

  createProject(input: { name: string; description?: string; workspacePaths?: string[] | string | null; workspacePath?: string; mainWorkspacePath?: string | null; instructions?: string }): Project {
    return this.projectStore.createProject(input);
  }

  async updateProject(id: string, patch: { name?: string; description?: string; workspacePaths?: string[] | string | null; workspacePath?: string | null; mainWorkspacePath?: string | null; instructions?: string }): Promise<Project> {
    return this.projectStore.updateProject(id, patch);
  }

  async removeProject(id: string): Promise<void> {
    return this.projectStore.removeProject(id);
  }

  async archiveProject(id: string): Promise<void> {
    return this.projectStore.archiveProject(id);
  }

  async restoreProject(id: string): Promise<void> {
    return this.projectStore.restoreProject(id);
  }

  async assignSessionToProject(file: string, projectId: string | null): Promise<ProjectSummary | null> {
    return this.projectStore.assignSessionToProject(file, projectId);
  }

  async searchProject(projectId: string, query: string): Promise<ProjectSearchResult[]> {
    return this.projectStore.searchProject(projectId, query);
  }

  async saveProjectMemory(projectId: string, input: { id?: string; content: string; type?: ProjectMemoryType; pinned?: boolean; sourceSessionId?: string }): Promise<ProjectMemory> {
    return this.projectStore.saveProjectMemory(projectId, input);
  }

  async removeProjectMemory(projectId: string, memoryId: string): Promise<void> {
    return this.projectStore.removeProjectMemory(projectId, memoryId);
  }

  async addProjectDocument(projectId: string, input: { path: string; name?: string; summary?: string }): Promise<ProjectDocument> {
    return this.projectStore.addProjectDocument(projectId, input);
  }

  async removeProjectDocument(projectId: string, documentId: string): Promise<void> {
    return this.projectStore.removeProjectDocument(projectId, documentId);
  }

  private async reloadProjectRuntimes(projectId: string): Promise<void> {
    await Promise.all([...this.runtimes.values()]
      .filter((entry) => this.projectStore.projectForSessionFile(entry.runtime.session.sessionFile)?.id === projectId)
      .map((entry) => entry.runtime.session.reload()));
  }

  // ------------------------------------------------------------- workspaces

  listWorkspaces(): WorkspaceInfo[] {
    return this.workspaceManager.list();
  }

  addWorkspace(path: string): WorkspaceInfo[] {
    return this.workspaceManager.add(path);
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

    this.cwd = abs;
    this.workspaceManager.registerActive(abs);

    this.settingsManager = SettingsManager.create(this.cwd, this.agentDir);
    this.lastMcpStatus = null;
    await this.createRuntime();
    this.emit("log", "info", `工作区已切换: ${this.cwd}`);
    this.pushState();
    await this.emitSessions();
    this.emit("workspaces", this.listWorkspaces());
  }

  listWorkspaceFiles(relPath: string, root?: string): FileEntry[] {
    return this.workspaceManager.listFiles(relPath, root);
  }

  /** Resolve a workspace-relative path, rejecting traversal outside the given root. */
  resolveWorkspacePath(relPath: string, root?: string): string {
    return this.workspaceManager.resolvePath(relPath, root);
  }

  moveWorkspaceFile(sourceRelPath: string, destinationDir: string, root?: string): void {
    return this.workspaceManager.moveFile(sourceRelPath, destinationDir, root);
  }

  async readWorkspaceFile(relPath: string, root?: string): Promise<WorkspaceFileContent> {
    return this.workspaceManager.readFile(relPath, root);
  }

  listDirs(absPath: string): FileEntry[] {
    return this.workspaceManager.listDirs(absPath);
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

  

    readModelsJson(): Record<string, unknown> {
    return this.modelManager.readModelsJson();
  }

  

  /** Register a custom provider in models.json, then reload the runtime. */
    registerProviderConfig(name: string, config: Record<string, unknown>): void {
    this.modelManager.registerProviderConfig(name, config);
  }

  /** Remove a custom provider from models.json, then reload the runtime. */
    unregisterProviderConfig(name: string): void {
    this.modelManager.unregisterProviderConfig(name);
  }

  /** Reload models.json + refresh availability, then push the new state to clients. */
  async refreshModels(options?: { force?: boolean }): Promise<{ errors: string[] }> {
    return this.modelManager.refreshModels(options);
  }

  /** Full provider × model catalog with auth/custom flags (for the Models panel). */
    listModels(): ModelCatalogEntry[] {
    return this.modelManager.listModels();
  }

    async setProviderApiKey(provider: string, apiKey: string): Promise<void> {
    return this.modelManager.setProviderApiKey(provider, apiKey);
  }

    async removeProviderApiKey(provider: string): Promise<void> {
    return this.modelManager.removeProviderApiKey(provider);
  }

  
  

  // ------------------------------------------------------------------ state

  getState(): AppState {
    const entry = this.runtimes.get(this.activeRuntimeId);
    const session = entry?.runtime.session;
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
      modelFallbackMessage: entry?.runtime.modelFallbackMessage,
      thinkingLevel: session?.thinkingLevel ?? "off",
      isStreaming: session?.isStreaming ?? false,
      cwd: this.cwd,
      availableModels: this.modelManager.availableModelInfos(),
      activeAgent: this.agentStore.getActiveAgent(),
      mcp: this.lastMcpStatus as unknown as AppState["mcp"],
      sessionFile: session?.sessionFile,
      sessionId: session?.sessionId,
      longTasks: [...(this.longTasks.get(this.activeRuntimeId) ?? [])],
      project: this.projectStore.projectForSessionFile(session?.sessionFile)
        ? this.projectStore.projectSummary(this.projectStore.projectForSessionFile(session?.sessionFile) as Project)
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
