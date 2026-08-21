import { useCallback, useEffect, useState } from "react";
import {
  getModelsConfig,
  listModels,
  refreshModels,
  registerModelProvider,
  removeProviderApiKey,
  setProviderApiKey,
  unregisterModelProvider,
} from "../api";
import type { ModelCatalogEntry } from "../types";
import { PanelShell } from "./PanelShell";
import { usePanel } from "../hooks/usePanel";

interface Props {
  current: { provider: string; id: string } | null;
  onSelect: (provider: string, id: string) => void;
  onClose: () => void;
  onToast: (level: "info" | "warn" | "error" | "ok", message: string) => void;
}

const APIS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];

export function ModelsPanel({ current, onSelect, onClose, onToast }: Props) {
  const [catalog, setCatalog] = useState<ModelCatalogEntry[] | null>(null);
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const { busy, run } = usePanel(onToast);

  // register form
  const [regMode, setRegMode] = useState<"form" | "json">("form");
  const [name, setName] = useState("");
  const [api, setApi] = useState("openai-completions");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelsText, setModelsText] = useState("");
  const [jsonText, setJsonText] = useState("");

  // api key form
  const [keyProvider, setKeyProvider] = useState("");
  const [keyValue, setKeyValue] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [cat, cfg] = await Promise.all([listModels(), getModelsConfig()]);
      setCatalog(cat);
      setConfig(cfg);
      if (!keyProvider && cat.length > 0) setKeyProvider(cat[0].provider);
    } catch (e) {
      onToast("error", (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [keyProvider, onToast]);

  // Full reload: ask the server to refresh the model catalog (including the
  // remote pi.dev overlay when online), then re-read the snapshot.
  const reloadCatalog = useCallback(async () => {
    setLoading(true);
    try {
      const result = await refreshModels();
      if (result.errors.length > 0) {
        onToast("warn", `部分供应商刷新失败：${result.errors.join("；")}`);
      }
      const [cat, cfg] = await Promise.all([listModels(), getModelsConfig()]);
      setCatalog(cat);
      setConfig(cfg);
      onToast("ok", "模型目录已刷新");
    } catch (e) {
      onToast("error", (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [onToast]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const customProviders = Object.entries((config.providers ?? {}) as Record<string, unknown>);

  const currentKey = current ? `${current.provider}/${current.id}` : "";

  const selectModel = (provider: string, id: string) => {
    onSelect(provider, id);
    onToast("ok", `已切换模型: ${provider}/${id}`);
  };

  const buildConfigFromForm = (): { name: string; config: Record<string, unknown> } => {
    const models = modelsText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(",").map((s) => s.trim());
        const [id, label, reasoning, contextWindow] = parts;
        if (!id) throw new Error("模型列表每行至少需要一个 id");
        const m: Record<string, unknown> = { id };
        if (label) m.name = label;
        if (reasoning) m.reasoning = reasoning === "true" || reasoning === "1" || reasoning === "yes";
        if (contextWindow) m.contextWindow = Number(contextWindow);
        return m;
      });
    if (models.length === 0) throw new Error("请至少填写一个模型 id");
    const config: Record<string, unknown> = {
      api,
      models,
    };
    if (baseUrl.trim()) config.baseUrl = baseUrl.trim();
    if (apiKey.trim()) config.apiKey = apiKey.trim();
    return { name: name.trim(), config };
  };

  const parseJson = (): { name: string; config: Record<string, unknown> } => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      throw new Error(`JSON 解析失败: ${(e as Error).message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON 必须是对象");
    const obj = parsed as Record<string, unknown>;
    // 支持 { "providers": { name: config } } 包装，取第一个；也支持单个 provider 配置 { name: config }
    const providers = obj.providers && typeof obj.providers === "object" ? (obj.providers as Record<string, unknown>) : obj;
    const entries = Object.entries(providers);
    if (entries.length === 0) throw new Error("没有可注册的提供方");
    const [n, c] = entries[0];
    if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error(`提供方 ${n} 的配置无效（应为对象）`);
    return { name: n, config: c as Record<string, unknown> };
  };

  const register = () => {
    run(async () => {
      const { name: n, config: c } = regMode === "form" ? buildConfigFromForm() : parseJson();
      if (!n) throw new Error("请填写提供方名称");
      const res = await registerModelProvider(n, c);
      if (res.errors?.length) onToast("warn", `已注册，但加载有告警: ${res.errors.join("；")}`);
      else onToast("ok", `已注册提供方: ${n}`);
      setName("");
      setModelsText("");
      setJsonText("");
      setApiKey("");
      await refresh();
    });
  };

  const unregister = (n: string) => {
    if (!window.confirm(`确定注销提供方「${n}」？此操作会从 models.json 中删除该配置。`)) return;
    run(async () => {
      const res = await unregisterModelProvider(n);
      if (res.errors?.length) onToast("warn", `已注销，但刷新有告警: ${res.errors.join("；")}`);
      else onToast("ok", `已注销提供方: ${n}`);
      await refresh();
    });
  };

  const saveApiKey = () => {
    if (!keyProvider) return;
    if (!keyValue.trim()) {
      onToast("warn", "请输入 API Key");
      return;
    }
    run(async () => {
      await setProviderApiKey(keyProvider, keyValue.trim());
      onToast("ok", `已为 ${keyProvider} 保存 API Key`);
      setKeyValue("");
      await refresh();
    });
  };

  const clearApiKey = () => {
    if (!keyProvider) return;
    if (!window.confirm(`清除 ${keyProvider} 的运行时 API Key？`)) return;
    run(async () => {
      await removeProviderApiKey(keyProvider);
      onToast("ok", `已清除 ${keyProvider} 的 API Key`);
      await refresh();
    });
  };

  return (
    <PanelShell
      variant="tabs"
      title="模型管理"
      subtitle="注册 / 注销 / 切换"
      actions={
        <button className="mini-btn" onClick={() => void reloadCatalog()} title="重新加载模型目录（联网检查更新）">
          ↻ 刷新
        </button>
      }
      onClose={onClose}
    >
      {false && <>
      {/* ------------------------------------------------- available models */}
      <div className="panel-title">可用模型</div>
      <div className="panel-sub">点击切换当前会话模型</div>
      {loading && <div className="ft-hint">加载中…</div>}
      {!loading && catalog?.length === 0 && <div className="ft-hint">暂无可用模型</div>}
      {catalog?.map((p) => (
        <details
          key={p.provider}
          className="model-provider"
          open={p.models.some((m) => `${p.provider}/${m.id}` === currentKey) || p.isCustom}
        >
          <summary>
            <span className="mp-name">{p.displayName ?? p.provider}</span>
            {p.isCustom && <span className="tag">自定义</span>}
            {p.authConfigured ? (
              <span className="mp-auth ok">已认证</span>
            ) : (
              <span className="mp-auth no">未认证</span>
            )}
            <span className="mp-count">{p.models.length}</span>
          </summary>
          <div className="mp-models">
            {p.models.length === 0 && <div className="ft-hint">（无模型）</div>}
            {p.models.map((m) => {
              const key = `${p.provider}/${m.id}`;
              const isCur = key === currentKey;
              return (
                <div
                  key={m.id}
                  className={`mp-model ${isCur ? "cur" : ""} ${m.available ? "" : "off"}`}
                  title={m.available ? `${m.id} · 点击切换` : `${m.id} · 未认证，先配置 API Key`}
                  onClick={() => m.available && selectModel(p.provider, m.id)}
                >
                  <span className="mp-model-id">{m.id}</span>
                  {m.name && m.name !== m.id && <span className="mp-model-name">{m.name}</span>}
                  <span className="mp-model-badges">
                    {m.reasoning && <span className="tag">思考</span>}
                    {m.input?.includes("image") && <span className="tag">视觉</span>}
                    {isCur && <span className="tag cur">当前</span>}
                    {!m.available && <span className="tag no">未认证</span>}
                  </span>
                </div>
              );
            })}
          </div>
        </details>
      ))}
      </>}

      {!loading && catalog && !catalog.some((p) => p.models.some((m) => m.available)) && (
        <div className="settings-warning" style={{ marginTop: "8px" }}>
          <span>未检测到可用模型，当前对话无法使用模型。</span>
          <span>请在下方「API Key」为提供方配置密钥，或在「注册自定义模型」中添加本地模型（如 Ollama）。</span>
        </div>
      )}

      {/* --------------------------------------------------- api key */}
      <div className="panel-title" style={{ marginTop: "12px" }}>
        API Key
      </div>
      <div className="panel-sub">保存运行时 API Key（写入 auth.json），立即生效</div>
      <div className="form-row">
        <select className="grow" value={keyProvider} onChange={(e) => setKeyProvider(e.target.value)}>
          {catalog?.map((p) => (
            <option key={p.provider} value={p.provider}>
              {p.displayName ?? p.provider}
            </option>
          ))}
        </select>
      </div>
      <div className="form-row" style={{ marginTop: "6px" }}>
        <input
          className="grow"
          type="password"
          placeholder="sk-…"
          value={keyValue}
          onChange={(e) => setKeyValue(e.target.value)}
        />
        <button className="btn primary" disabled={busy} onClick={() => void saveApiKey()}>
          保存
        </button>
        <button className="btn" disabled={busy} onClick={() => void clearApiKey()}>
          清除
        </button>
      </div>

      {/* -------------------------------------------------- custom providers */}
      <div className="panel-title" style={{ marginTop: "12px" }}>
        自定义提供方（models.json）
      </div>
      {customProviders.length === 0 && <div className="ft-hint">尚未注册任何自定义提供方</div>}
      {customProviders.map(([n, c]) => {
        const cfg = c as { models?: unknown[]; baseUrl?: string; api?: string };
        const modelCount = Array.isArray(cfg.models) ? cfg.models.length : 0;
        return (
          <div key={n} className="mcp-server">
            <div className="row1">
              <span className="sname">{n}</span>
              <span className="sstatus">{modelCount} 个模型</span>
              <span className="sact">
                <button className="mini-btn danger" disabled={busy} onClick={() => void unregister(n)}>
                  注销
                </button>
              </span>
            </div>
            <div className="row2">
              {cfg.api ?? "—"} · {cfg.baseUrl ?? "（无 baseUrl）"}
            </div>
          </div>
        );
      })}

      {/* ------------------------------------------------------ register */}
      <div className="panel-title" style={{ marginTop: "12px" }}>
        注册自定义模型
      </div>
      <div className="side-tabs" style={{ marginBottom: "8px" }}>
        <div className={`side-tab ${regMode === "form" ? "active" : ""}`} onClick={() => setRegMode("form")}>
          表单
        </div>
        <div className={`side-tab ${regMode === "json" ? "active" : ""}`} onClick={() => setRegMode("json")}>
          JSON
        </div>
      </div>
      {regMode === "form" ? (
        <div className="add-form">
          <input placeholder="提供方名称（如 my-ollama）" value={name} onChange={(e) => setName(e.target.value)} />
          <div className="form-row">
            <select className="grow" value={api} onChange={(e) => setApi(e.target.value)}>
              {APIS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>
          <input placeholder="baseUrl（如 http://localhost:11434/v1）" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          <input placeholder="apiKey（可选，如 $MY_KEY 或 sk-…）" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          <textarea
            placeholder={"模型列表：每行一个，格式 id, 显示名, 是否思考, 上下文\n例如：\nllama3.1:8b, Llama 3.1 8B\nqwen2.5-coder:7b, Qwen 2.5 Coder, true, 131072"}
            value={modelsText}
            onChange={(e) => setModelsText(e.target.value)}
          />
          <button className="btn primary" disabled={busy} onClick={() => void register()}>
            {busy ? "处理中…" : "注册"}
          </button>
        </div>
      ) : (
        <div className="add-form">
          <textarea
            placeholder={'粘贴 models.json 配置（支持包装或单个提供方）：\n{ "providers": { "my-ollama": { "baseUrl": "...", "api": "openai-completions", "apiKey": "$KEY", "models": [{ "id": "llama3.1:8b" }] } } }'}
            style={{ minHeight: "120px" }}
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
          />
          <button className="btn primary" disabled={busy} onClick={() => void register()}>
            {busy ? "处理中…" : "导入注册"}
          </button>
        </div>
      )}
    </PanelShell>
  );
}
