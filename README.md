# Pi Studio

基于 **Pi SDK**（`@earendil-works/pi-coding-agent`）构建的 **Codex 风格 Web 前端**。启动后由后端进程调用 Pi，支持：

- 💬 流式对话：文本/思考过程/工具调用实时渲染，Markdown 与代码块；**中间过程自动收缩**（思考、工具调用默认折叠成摘要行，点击展开详情）
- 🎨 **明/暗主题**：侧栏顶部一键切换（🌙/☀️），持久化到浏览器，默认跟随系统
- 📂 **多工作区**：侧栏可添加/切换工作区（agent 的 cwd），每个工作区独立的会话历史；MCP 配置统一保存在应用自己的 `data/pi-agent/mcp.json`。点击「＋」弹出**目录选择对话框**（可浏览磁盘、手动输入路径），无需手敲完整地址
- ⌨️ **自动补全**：输入 `/` 弹出斜杠命令补全（`/model`、`/new`、`/mcp reconnect …` 等），输入 `@` 弹出工作区文件/目录补全（选中的路径会作为引用随消息发送）
- 📎 文件上传：图片直接以视觉内容送入模型，其他文件保存到工作区供 agent 读取
- 🔌 **MCP 连接**：集成 [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter)（MCP World 收录的「Pi MCP 服务拓展」，全部服务通过手动添加）——
  - MCP 配置与应用数据隔离：只读取应用自己的 `data/pi-agent/mcp.json`，不会自动读取宿主机、工作区或其他客户端的 MCP 配置
  - 单个 `mcp` 代理工具（约 200 tokens）替代上百个工具定义，惰性连接、按需启动
  - 支持 stdio / HTTP (StreamableHTTP) / Unix socket、OAuth、`directTools`、工具审批、MCP UI
  - 支持从 Cursor / Claude Code / Codex 等宿主配置导入
- 🧠 模型切换 / 思考强度（thinking level）/ 会话历史（持久化，可切换）

---

## 架构

```
浏览器 (React/Vite)  ──WebSocket──▶  server (Node + Express + ws)
                                       │  PiBridge ─ createAgentSessionRuntime(createAgentSessionServices)
                                       │     ├─ ModelRuntime（复用 ~/.pi/agent 的凭据与模型配置）
                                       │     ├─ pi-mcp-adapter 扩展（MCP 文件发现 + 代理工具）
                                       │     └─ 事件流 → WS → 前端
                                       │  REST：上传 / MCP 配置管理 / 工作区
                                       └─ 托管 client/dist
```

- 工作区：`workspace/`（agent 的 cwd，上传文件落在这里）
- 会话：持久化在 `~/.pi/agent/sessions/`，可通过侧栏切换
- 模型/认证：直接复用你的 Pi 全局配置（`~/.pi/agent/auth.json`、`models.json`、`settings.json`，含 `httpProxy` 等）

## 快速开始

```bash
# 1. 安装依赖（server 的 postinstall 会自动给 pi-mcp-adapter 打一个兼容补丁）
npm run setup

# 2. 启动（后端 + 托管前端）
npm start
# 打开 http://localhost:8787

# 开发模式（前后端热更新）
npm run dev:server   # 终端 1
npm run dev:client   # 终端 2 → http://localhost:5173
```

### 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `PI_STUDIO_PORT` | 服务端口 | `8787` |
| `PI_STUDIO_WORKSPACE` | 工作区目录 | `<项目>/workspace` |
| `PI_STUDIO_LOAD_GLOBAL_EXTENSIONS` | 是否同时加载全局 pi 扩展（`~/.pi/agent/extensions/` 等） | `0`（应用自包含，避免重复注册） |
| `PI_STUDIO_INHERIT_PROVIDER_ENV` | 是否继承宿主机的模型 API Key 环境变量 | `0`（首次打开保持干净） |

> 注意：本应用默认不加载你全局安装的其他 pi 扩展，以保证行为可预测。如需启用，设置 `PI_STUDIO_LOAD_GLOBAL_EXTENSIONS=1`。

应用内添加的 skill 保存在应用目录的 `data/pi-agent/skills/<skill-name>/SKILL.md`。应用只读取这个目录；不会自动读取宿主机的 `~/.pi/agent/skills` 或工作区 `.pi/skills`。

在「Skills」面板中可直接上传 skill 的 `.zip` 文件，或选择包含一个/多个 skill 文件夹的目录导入；每个 skill 文件夹必须包含标准的 `SKILL.md`。

## 绿色便携版（Windows）

项目支持打成“解压即用”的 Windows 便携目录，内置 Node 24.12 运行时、完整依赖和已构建前端，目标电脑无需安装 Node.js、npm 或 Pi。

```bash
# 生成 dist/portable/Pi Studio/（可直接分发整个文件夹）
npm run build:portable

# 额外生成 Pi Studio-portable-win-x64.zip（约 120-180MB）
npm run build:portable:zip
```

- 双击 `启动 Pi Studio.bat` 即可启动，服务就绪后自动打开浏览器（`http://localhost:8787`）。
- Pi 的模型配置、密钥、会话和工作区列表全部保存在应用内 `data/` 目录，不会写入用户目录；复制/删除整个文件夹即可迁移或清理。
- 打包过程只需联网一次（下载官方 Node 与依赖）；最终用户运行不需要任何网络或安装操作。
- 若端口 8787 已被占用，说明已有实例在运行，启动器会直接提示打开已有页面。

### 桌面版（单文件 exe）

项目同时提供 Electron 桌面版，无需安装 Node.js、npm 或 Pi。桌面版有两种分发形态：

```bash
# 生成 dist/electron/win-unpacked/ 与两个 zip
npm run build:electron
```

- **免解压文件夹版（推荐）**：`dist/electron/Pi Studio-desktop-win-x64.zip`，解压后双击 `Pi Studio.exe`，启动只需几秒；数据保存在 exe 同级 `data/` 目录。
- **单文件 exe（可选）**：`dist/electron/Pi Studio 便携版.exe`（对应 `Pi Studio-single-exe-win-x64.zip`）。单文件每次启动都要把内置内容解压到临时目录，首次和之后每次启动都较慢（约 1-3 分钟），适合只需要分发单个文件的场景。
- 模型配置、密钥、会话和工作区列表保存在 exe 同级的 `data/` 目录，整个文件夹一起复制即可迁移。
- 打包产物不包含任何 `data/` 内容，所以不会带出本机的模型配置或 API Key；便携版默认离线运行（`PI_OFFLINE=1`），避免启动/注册供应商时联网卡住。
- 开发调试可运行 `npm run dev:electron`；默认端口同样是 8787。

## 使用 MCP

1. **应用配置**：MCP 保存在应用数据目录的 `data/pi-agent/mcp.json`（便携版即为 `Pi Studio\\data\\pi-agent\\mcp.json`）。应用不会读取 `~/.config/mcp`、`~/.agents`、工作区 `.mcp.json` / `.pi/mcp.json` 或其他客户端配置。右侧「MCP 管理」可查看状态、重连、移除。
2. **手动添加**：「MCP 管理 → ＋ 手动添加」支持**表单模式**（名称 + 命令 + 参数）与 **JSON 模式**（粘贴完整配置批量导入）。
3. **对话中使用**：直接让 agent 调用即可，例如：

   ```
   用 mcp 搜索 github 仓库 xxx 的最新 issues
   ```

   agent 会通过 `mcp` 代理工具按需连接、搜索并调用目标服务器。

## 中间过程折叠

agent 运行过程中的产物（thinking、工具调用）**默认自动收缩**，不占用屏幕：

- 💭 **思考过程**：折叠成一行「💭 思考过程（N 字）」，点击展开全文
- 🔧 **工具调用**：折叠成一行摘要（工具名 + 输出首行预览 + 状态），点击展开参数 JSON 与完整输出
- 流式运行中同样只显示紧凑行（工具名 + 转圈），不刷屏
- 最终回答的正文始终完整显示

支持深链 `?session=<会话文件路径>` 直接打开某个历史会话。

## 工作区与命令补全

- **切换工作区**：侧栏顶部选择器切换，或点「＋」打开目录浏览对话框（支持逐级进入、上级目录、用户主目录快捷入口，也可直接输入路径）。切换后 agent 的 cwd 与会话列表会跟随新工作区；MCP 配置仍保持应用级隔离。工作区列表保存在 `data/workspaces.json`。
- **命令补全**：输入 `/` 查看并选择命令（方向键选择，Enter/Tab 确认，Esc 关闭）：
  - `/model <provider>/<model>[:thinking]` 切换模型
  - `/new` 新建会话、`/compact` 压缩上下文、`/reload` 重新加载配置
  - `/mcp [status|reconnect <server>|disable|enable|logout]`、`/mcp-auth [<server>]`
- **添加 MCP 服务**：「MCP 管理 → ＋ 手动添加」支持两种模式：
  - **表单模式**：填写名称 + 命令 + 参数
  - **JSON 模式**：直接粘贴完整配置批量导入（支持 `{ "mcpServers": { … } }` 包装或 `{ 服务名: 配置 }` 两种格式），一次写入并 reload
- **文件引用**：输入 `@` 浏览工作区文件/目录；选中的相对路径会作为引用附在消息里（后端会提示 agent 读取这些文件）。

## 常见问题

- **模型 403 / 网络错误**：确认 `~/.pi/agent/settings.json` 中的 `httpProxy` 等配置正确（应用会读取并应用）。
- **添加 MCP 服务后状态未更新**：添加接口会自动执行运行时 reload；若手工修改应用数据目录的 `data/pi-agent/mcp.json`，在「MCP 管理」面板点 **↻ 重新加载配置**（`/reload`），再点重连。
- **MCP 服务连接失败（failed）**：最常见原因是配置里的可执行路径带 Windows 长路径前缀 `\\?\`（例如 `\\?\D:\xxx\server\index.js`），node 无法解析该路径，去掉前缀即可。其他原因：`npx` 首次拉包慢（请稍后重试）、网络代理不可达。
- **首次调用 MCP 工具较慢**：惰性连接 + `npx` 首次拉包是正常的；此后有元数据缓存。
- **`NODE_ENV=production` 影响安装**：若你的环境设置了 `NODE_ENV=production`，npm 会跳过 devDependencies，请用 `NODE_ENV=development npm install`。

## 兼容性说明

`pi-mcp-adapter` 以 TypeScript 源码发布（需 `tsx` 加载），并且它从 `@earendil-works/pi-ai` 主入口导入 `complete`，而该导出位于 `/compat` 子路径。`server/scripts/patch-mcp-adapter.mjs`（postinstall 自动运行）会把这一行导入改写为 `/compat`，使其与 pi 0.83.0 兼容。

## 目录结构

```
├── server/                 # Node 后端
│   └── src/
│       ├── index.ts        # Express + WebSocket + REST
│       ├── bridge.ts       # Pi SDK 会话桥接（事件流 → WS）
│       └── types.ts        # 前后端共享协议类型
├── client/                 # React 前端（Vite）
│   └── src/components/     # Sidebar / Chat / Message / Composer / McpPanel / McpMarket
└── workspace/              # agent 工作区（上传文件）
```

## 技术栈

- 后端：Node 24 · TypeScript · Express · ws · multer · `@earendil-works/pi-coding-agent@0.83.0` · `pi-mcp-adapter@2.18.0` · tsx
- 前端：React 18 · TypeScript · Vite 6（无 UI 框架依赖，手写暗色主题 CSS）
