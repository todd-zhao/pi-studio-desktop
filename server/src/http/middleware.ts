import { timingSafeEqual } from "node:crypto";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { ALLOWED_ORIGINS, APP_ORIGIN, AUTH_TOKEN } from "../config.ts";
import type { ServerContext } from "../context.ts";

export function safeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function requestToken(req: { headers: Record<string, unknown>; url?: string }): string {
  const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  if (authorization.startsWith("Bearer ")) return authorization.slice(7);
  try {
    return new URL(req.url ?? "/", APP_ORIGIN).searchParams.get("token") ?? "";
  } catch {
    return "";
  }
}

export function previewCookieToken(cookieHeader: string | undefined): string {
  if (!cookieHeader) return "";
  const match = cookieHeader.match(/(?:^|;\s*)pi_preview_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

export function allowedOrigin(origin: string | undefined): boolean {
  return !origin || ALLOWED_ORIGINS.has(origin);
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' http://127.0.0.1:* http://localhost:* https: ws://127.0.0.1:* ws://localhost:* wss:; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  next();
}

export const corsMiddleware = cors({
  origin(origin, callback) {
    const ok = allowedOrigin(origin);
    callback(ok ? null : new Error("不允许的请求来源"), ok);
  },
});

export const jsonBody = express.json({ limit: "12mb" });

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 64 * 1024 * 1024 },
});

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  if (!allowedOrigin(origin)) {
    res.status(403).json({ error: "不允许的请求来源" });
    return;
  }
  const cookieToken = req.originalUrl.startsWith("/api/workspace/preview/") ? previewCookieToken(req.headers.cookie) : "";
  const authorized = safeEqual(requestToken(req), AUTH_TOKEN) ||
    (cookieToken !== "" && safeEqual(cookieToken, AUTH_TOKEN));
  if (AUTH_TOKEN && !authorized) {
    res.status(401).json({ error: "未授权" });
    return;
  }
  next();
}

export function createBridgeReadyGate(ctx: ServerContext) {
  return async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await ctx.bridgeReady;
      next();
    } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
    }
  };
}