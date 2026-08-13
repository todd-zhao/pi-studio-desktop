import { join } from "node:path";
import type { PiBridge } from "./bridge.ts";
import type { Scheduler } from "./scheduler.ts";
import type { ServerWsMessage, SessionMeta, WorkspaceInfo } from "@pi-studio/shared";

export type BootState = "booting" | "ready" | "error";

/**
 * Shared mutable server state. Created once at startup and passed to every
 * router / WebSocket handler / startup routine so modules stay decoupled.
 */
export interface ServerContext {
  bridge: PiBridge;
  scheduler: Scheduler;
  PiBridgeClass: typeof import("./bridge.ts").PiBridge;
  bridgeReady: Promise<PiBridge>;
  resolveBridgeReady: (value: PiBridge) => void;
  rejectBridgeReady: (reason: unknown) => void;
  bridgeStarting: boolean;
  bootState: BootState;
  bootError: string;
  initialSessions: SessionMeta[];
  initialWorkspaces: WorkspaceInfo[];
  /** Push a message to every connected WebSocket client. No-op until the WS server is created. */
  broadcast: (msg: ServerWsMessage) => void;
  uploadRoot(): string;
  startupLog(phase: string, details?: string): void;
  resetBridgeReady(): void;
}

export function createServerContext(): ServerContext {
  const startupStartedAt = Date.now();

  const ctx: ServerContext = {
    bridge: undefined as unknown as PiBridge,
    scheduler: undefined as unknown as Scheduler,
    PiBridgeClass: undefined as unknown as typeof import("./bridge.ts").PiBridge,
    bridgeReady: undefined as unknown as Promise<PiBridge>,
    resolveBridgeReady: () => undefined,
    rejectBridgeReady: () => undefined,
    bridgeStarting: false,
    bootState: "booting",
    bootError: "",
    initialSessions: [],
    initialWorkspaces: [],
    broadcast: () => undefined,
    uploadRoot: () => join(ctx.bridge.cwdPath, "uploads"),
    startupLog: (phase, details = "") => {
      const suffix = details ? ` ${details}` : "";
      console.log(`[startup +${Date.now() - startupStartedAt}ms] ${phase}${suffix}`);
    },
    resetBridgeReady: () => {
      ctx.bridgeReady = new Promise<PiBridge>((resolveReady, rejectReady) => {
        ctx.resolveBridgeReady = resolveReady;
        ctx.rejectBridgeReady = rejectReady;
      });
    },
  };

  ctx.resetBridgeReady();
  return ctx;
}
