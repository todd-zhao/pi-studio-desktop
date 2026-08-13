import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelCatalogEntry, ModelInfo } from "@pi-studio/shared";
import type { AppCredentialStore } from "../credential-store.ts";
import { withTimeout } from "./shared.ts";

export interface ModelManagerDeps {
  /** App-local pi agent directory (models.json / auth.json live here). */
  agentDir: string;
  pushState: () => void;
  emitLog: (level: "info" | "warn" | "error", message: string) => void;
  /** Fired after the user configures a model channel (API key / provider). */
  onModelsConfigured?: () => void;
}

/**
 * Model catalog, provider configs and API-key credentials.
 *
 * `modelRuntime` / `appCredentials` are wired by the owning facade after the
 * runtime finishes booting (they mirror the original PiBridge lifecycle).
 */
export class ModelManager {
  modelRuntime!: ModelRuntime;
  appCredentials!: AppCredentialStore;
  private availableModels: ModelInfo[] = [];

  constructor(private readonly deps: ModelManagerDeps) {}

  private modelsJsonPath(): string {
    return join(this.deps.agentDir, "models.json");
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
    mkdirSync(this.deps.agentDir, { recursive: true });
    writeFileSync(this.modelsJsonPath(), JSON.stringify(data, null, 2) + "\n", "utf8");
  }

  registerProviderConfig(name: string, config: Record<string, unknown>): void {
    if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error("提供方名称只能包含字母、数字、._-");
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("config 必须是对象");
    const data = this.readModelsJson();
    const providers = (data.providers ?? {}) as Record<string, unknown>;
    providers[name] = config;
    data.providers = providers;
    this.writeModelsJson(data);
    this.deps.onModelsConfigured?.();
  }

  unregisterProviderConfig(name: string): void {
    const data = this.readModelsJson();
    const providers = (data.providers ?? {}) as Record<string, unknown>;
    if (!(name in providers)) throw new Error(`未注册的提供方: ${name}`);
    delete providers[name];
    data.providers = providers;
    this.writeModelsJson(data);
  }

  async refreshModels(): Promise<{ errors: string[] }> {
    let result: { errors?: ReadonlyMap<string, Error> } | undefined;
    try {
      result = await withTimeout(
        this.modelRuntime.refresh({ allowNetwork: false }),
        15_000,
        "模型刷新超时",
      );
    } catch (error) {
      result = { errors: new Map([[this.deps.agentDir, new Error((error as Error).message)]]) };
    }
    this.updateAvailableModels();
    this.deps.pushState();
    const errors: string[] = [];
    for (const [provider, error] of result?.errors ?? new Map()) {
      errors.push(`${provider}: ${error}`);
    }
    return { errors };
  }

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
    this.deps.onModelsConfigured?.();
    this.deps.pushState();
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
      this.deps.emitLog("warn", `清除 API Key 时刷新失败（继续清理）: ${error instanceof Error ? error.message : String(error)}`);
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
      this.deps.emitLog("warn", `清除 API Key 后刷新模型状态失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.updateAvailableModels();
    this.deps.pushState();
  }

  updateAvailableModels(): void {
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

  availableModelInfos(): ModelInfo[] {
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
}
