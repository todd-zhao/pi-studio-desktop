// App-adapted WeChat bridge based on @wechatbot/pi-agent.
// The npm package targets @mariozechner/pi-coding-agent and terminal UI, so this
// local extension uses @earendil-works/pi-coding-agent events to drive the web
// panel (QR, status, logs) while keeping the same SDK flow.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  WeChatBot,
  stripMarkdown,
  type IncomingMessage,
} from "@wechatbot/wechatbot";
import { toDataURL } from "qrcode";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { tmpdir } from "node:os";
import type { WechatLogEntry, WechatStatusPhase } from "../types.ts";

type PiContent =
  | string
  | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;

export function wechatExtension(pi: ExtensionAPI): void {
  let bot: WeChatBot | null = null;
  let connected = false;
  let connecting = false;
  let activeUserId: string | null = null;
  let pendingReply: IncomingMessage | null = null;
  let assistantText = "";
  let isStreaming = false;
  let connectEpoch = 0;
  let logSeq = 0;

  const emitStatus = (phase: WechatStatusPhase, message?: string, account?: string): void => {
    pi.events.emit("wechat:status", { phase, message, account, timestamp: Date.now() });
  };

  const emitLog = (direction: WechatLogEntry["direction"], text: string): void => {
    logSeq += 1;
    pi.events.emit("wechat:log", {
      id: `wc-${Date.now()}-${logSeq}`,
      direction,
      text: text.slice(0, 4000),
      timestamp: Date.now(),
    });
  };

  const stopBot = (): void => {
    connectEpoch += 1;
    connecting = false;
    connected = false;
    activeUserId = null;
    pendingReply = null;
    assistantText = "";
    isStreaming = false;
    if (bot) {
      try {
        bot.stop();
      } catch {
        /* ignore */
      }
    }
    bot = null;
  };

  const connectWechat = async (force: boolean): Promise<void> => {
    if (connecting) {
      emitStatus("connecting", "WeChat login already in progress");
      return;
    }

    const epoch = ++connectEpoch;
    connecting = true;
    emitStatus("connecting", "Connecting to WeChat");
    emitLog("system", "正在连接微信...");

    const nextBot = new WeChatBot({ storage: "file", logLevel: "warn" });
    bot = nextBot;

    try {
      const creds = await nextBot.login({
        force,
        callbacks: {
          onQrUrl: (url) => {
            if (epoch !== connectEpoch) return;
            void (async () => {
              try {
                const data = await toDataURL(url, { margin: 1, width: 280, errorCorrectionLevel: "M" });
                if (epoch !== connectEpoch) return;
                pi.events.emit("wechat:qr", { url, data, timestamp: Date.now() });
                emitStatus("qr", "Scan the QR code in WeChat");
                emitLog("system", "请用微信扫描二维码");
              } catch {
                if (epoch === connectEpoch) emitStatus("qr", "QR ready, preview unavailable");
              }
            })();
          },
          onScanned: () => {
            if (epoch === connectEpoch) emitStatus("scanned", "Scanned, confirm on your phone");
          },
          onExpired: () => {
            if (epoch === connectEpoch) emitStatus("expired", "QR expired, new QR incoming");
          },
        },
      });

      if (epoch !== connectEpoch) {
        try {
          nextBot.stop();
        } catch {
          /* ignore */
        }
        return;
      }

      connecting = false;
      connected = true;
      emitStatus("connected", "Connected to WeChat", creds.accountId);
      emitLog("system", `已连接微信: ${creds.accountId}`);

      nextBot.onMessage(async (msg) => {
        activeUserId = msg.userId;
        pendingReply = msg;
        isStreaming = true;
        assistantText = "";

        try {
          await nextBot.sendTyping(msg.userId);
        } catch {
          /* ignore */
        }

        const piContent = await buildPiContent(msg, nextBot);
        const preview = typeof piContent === "string"
          ? piContent
          : (piContent.find((block) => block.type === "text") as { text?: string } | undefined)?.text ?? "[media]";
        emitStatus("connected", preview.slice(0, 60), creds.accountId);
        emitLog("in", preview);
        pi.sendUserMessage(piContent, { deliverAs: "followUp" });
      });

      nextBot.on("error", (err) => {
        if (epoch !== connectEpoch) return;
        emitStatus("error", err instanceof Error ? err.message : String(err), creds.accountId);
        emitLog("system", `微信错误: ${err instanceof Error ? err.message : String(err)}`);
      });
      nextBot.on("session:expired", () => {
        if (epoch !== connectEpoch) return;
        emitStatus("expired", "Session expired, re-login needed", creds.accountId);
        emitLog("system", "微信会话已过期，需要重新登录");
      });
      nextBot.on("session:restored", (c) => {
        if (epoch !== connectEpoch) return;
        emitStatus("connected", "Reconnected to WeChat", c.accountId);
        emitLog("system", `微信会话已恢复: ${c.accountId}`);
      });
      nextBot.on("poll:start", () => {
        if (epoch === connectEpoch) emitStatus("connected", "Polling started", creds.accountId);
      });
      nextBot.on("poll:stop", () => {
        if (epoch === connectEpoch && connected) {
          emitStatus("error", "WeChat polling stopped", creds.accountId);
        }
      });
      nextBot.on("close", () => {
        if (epoch !== connectEpoch) return;
        if (connected) {
          connected = false;
          emitStatus("idle", "WeChat disconnected");
          emitLog("system", "微信连接已断开");
        }
      });

      nextBot.start().catch((e) => {
        if (epoch !== connectEpoch) return;
        connected = false;
        emitStatus("error", `Poll error: ${e instanceof Error ? e.message : e}`, creds.accountId);
        emitLog("system", `微信轮询错误: ${e instanceof Error ? e.message : e}`);
      });
    } catch (e) {
      if (epoch !== connectEpoch) return;
      connecting = false;
      connected = false;
      if (bot === nextBot) bot = null;
      emitStatus("error", `Login failed: ${e instanceof Error ? e.message : e}`);
      emitLog("system", `微信登录失败: ${e instanceof Error ? e.message : e}`);
    }
  };

  const startWechat = async (args: string): Promise<void> => {
    const arg = (args ?? "").trim().toLowerCase();

    if (arg === "status") {
      const creds = bot?.getCredentials();
      emitStatus(
        connected ? "connected" : "idle",
        connected ? "Connected to WeChat" : "Not connected",
        creds?.accountId,
      );
      return;
    }

    if (arg === "disconnect") {
      if (bot || connected || connecting) {
        stopBot();
        emitStatus("idle", "WeChat disconnected");
        emitLog("system", "已断开微信连接");
      } else {
        emitStatus("idle", "Not connected");
      }
      return;
    }

    if (arg === "reconnect") {
      stopBot();
      emitLog("system", "正在重新连接微信...");
      await connectWechat(true);
      return;
    }

    if (arg && arg !== "connect") {
      emitStatus("error", `Unknown argument: ${arg}`);
      return;
    }

    if (connected) {
      const creds = bot?.getCredentials();
      emitStatus("connected", "Already connected", creds?.accountId);
      return;
    }

    await connectWechat(false);
  };

  pi.on("before_agent_start", async (event) => {
    if (!connected || !bot || !pendingReply) return;
    return {
      systemPrompt: event.systemPrompt + `

## WeChat Bridge (Active)

You are currently bridged to WeChat via the wechatbot extension.
A real WeChat user is chatting with you - your response will be sent back to them.

Key behaviors:
- No markdown: WeChat doesn't render markdown. Write plain text. Use line breaks for structure.
- Send files: To send a file (image, video, document) back to WeChat, mention its absolute path in your response (e.g. C:/tmp/photo.png). The bridge auto-detects paths ending in media extensions and sends them as attachments.
- Concise replies: WeChat is a mobile chat app. Keep responses short and conversational.
- Media received: Images arrive as vision input. Videos/voice/files are described with metadata.
`,
    };
  });

  pi.on("agent_end", async (event) => {
    if (!bot || !connected || !pendingReply) return;

    const reply = pendingReply;
    pendingReply = null;
    isStreaming = false;

    const messages = event.messages ?? [];
    let finalText = "";
    for (const msg of messages) {
      if (msg.role === "assistant") {
        for (const block of msg.content) {
          if (block.type === "text") finalText += block.text;
        }
      }
    }
    if (!finalText.trim()) finalText = assistantText || "[No response]";

    const cleanText = stripMarkdown(finalText);

    try {
      await bot.stopTyping(reply.userId);

      const mediaFiles = extractMediaPaths(finalText);
      if (mediaFiles.length > 0) {
        const textWithoutPaths = removeMediaPaths(cleanText, mediaFiles);
        if (textWithoutPaths.trim()) {
          await bot.reply(reply, textWithoutPaths);
          emitLog("out", textWithoutPaths);
        }
        for (const filePath of mediaFiles) {
          try {
            const data = await readFile(filePath);
            const fileName = basename(filePath);
            await bot.reply(reply, { file: data, fileName });
            emitLog("out", `[文件] ${fileName}`);
          } catch {
            const fallback = `[Failed to send file: ${basename(filePath)}]`;
            await bot.reply(reply, fallback);
            emitLog("out", fallback);
          }
        }
      } else {
        await bot.reply(reply, cleanText);
        emitLog("out", cleanText);
      }

      const creds = bot.getCredentials();
      emitStatus("connected", "Replied to WeChat", creds?.accountId);
    } catch (e) {
      const creds = bot.getCredentials();
      emitStatus("error", `Reply failed: ${e instanceof Error ? e.message : e}`, creds?.accountId);
      emitLog("system", `回复失败: ${e instanceof Error ? e.message : e}`);
    }

    assistantText = "";
  });

  pi.on("message_update", (event) => {
    if (!isStreaming) return;
    if (event.message.role === "assistant") {
      let text = "";
      for (const block of event.message.content) {
        if (block.type === "text") text += block.text;
      }
      assistantText = text;
    }
  });

  pi.on("session_start", () => {
    if (connected && bot) {
      const creds = bot.getCredentials();
      emitStatus("connected", "Connected to WeChat", creds?.accountId);
    }
  });

  pi.on("session_shutdown", () => {
    stopBot();
  });

  pi.registerCommand("wechat", {
    description: "Connect WeChat and chat with Pi from your phone",
    handler: startWechat,
  });

  pi.registerCommand("weixin", {
    description: "Connect WeChat and chat with Pi from your phone",
    handler: startWechat,
  });
}

async function buildPiContent(msg: IncomingMessage, bot: WeChatBot): Promise<PiContent> {
  switch (msg.type) {
    case "text":
      return msg.text || "[empty message]";

    case "image": {
      const media = await bot.download(msg);
      if (!media) return "[Image received but could not be downloaded]";

      const content: PiContent = [];
      content.push({ type: "text", text: msg.text !== "[image]" ? msg.text : "User sent an image from WeChat:" });
      content.push({ type: "image", data: media.data.toString("base64"), mimeType: "image/jpeg" });
      return content;
    }

    case "voice": {
      const voice = msg.voices[0];
      if (voice?.text) return `[Voice message, transcribed]: ${voice.text}`;

      const media = await bot.download(msg);
      if (media) {
        return `[Voice message received (${media.format}, ${media.data.length} bytes). No transcription available - please ask the user to type their message.]`;
      }
      return "[Voice message received but could not be downloaded]";
    }

    case "file": {
      const file = msg.files[0];
      const fileName = file?.fileName ?? "unknown file";
      const fileSize = file?.size ? ` (${formatFileSize(file.size)})` : "";

      const textExts = new Set([".txt", ".md", ".csv", ".json", ".xml", ".html", ".yaml", ".yml", ".toml", ".log", ".py", ".js", ".ts", ".go", ".rs", ".java", ".c", ".cpp", ".h"]);
      if (textExts.has(extname(fileName).toLowerCase())) {
        try {
          const media = await bot.download(msg);
          if (media) {
            const text = media.data.toString("utf-8");
            const truncated = text.length > 10000 ? text.slice(0, 10000) + "\n... [truncated]" : text;
            return `[File: ${fileName}${fileSize}]\n\n\`\`\`\n${truncated}\n\`\`\``;
          }
        } catch {
          /* fall through */
        }
      }
      return `[File received: ${fileName}${fileSize}. To process this file, ask the user to share its content as text.]`;
    }

    case "video": {
      const video = msg.videos[0];
      const duration = video?.durationMs ? ` (${Math.round(video.durationMs / 1000)}s)` : "";
      try {
        const media = await bot.download(msg);
        if (media) {
          const tmpDir = await mkdtemp(join(tmpdir(), "wechat-video-"));
          const videoPath = join(tmpDir, "video.mp4");
          await writeFile(videoPath, media.data);
          return `[Video received${duration}, saved to: ${videoPath}. You can access this file for processing.]`;
        }
      } catch {
        /* fall through */
      }
      return `[Video received${duration} but could not be downloaded.]`;
    }

    default:
      return `[${msg.type} message received - not supported yet]`;
  }
}

function extractMediaPaths(text: string): string[] {
  const paths: string[] = [];
  const mediaExts = /\.(png|jpg|jpeg|gif|webp|bmp|svg|mp4|mov|webm|avi|pdf|doc|docx|xls|xlsx|ppt|pptx|zip|tar|gz)$/i;
  const pathRegex = /(?:^|\s)((?:\/[\w./-]+|\.\/[\w./-]+|[A-Za-z]:[\\/][\w.\\/-]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pathRegex.exec(text)) !== null) {
    const p = match[1].trim();
    if (mediaExts.test(p)) paths.push(p);
  }
  return [...new Set(paths)];
}

function removeMediaPaths(text: string, paths: string[]): string {
  let result = text;
  for (const p of paths) {
    result = result.replace(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "");
  }
  return result.replace(/\n{3,}/g, "\n\n").trim();
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
