// Shared HTTP helpers for the Pi Studio browser client.
//
// The main Pi Studio server API (api.ts) and the team server API (team-api.ts)
// previously each carried their own fetch wrapper. This module centralises the
// common parts: authorization headers, JSON error extraction, request timeouts
// and automatic Content-Type detection.

export interface HttpRequestOptions {
  /** Prefix for relative paths, e.g. the team server origin. */
  baseUrl?: string;
  /** Bearer token to attach to the Authorization header. */
  token?: string;
  /** Attach the Authorization header. Defaults to true. */
  authenticated?: boolean;
  /** Timeout in milliseconds; 0 disables the timeout. Defaults to 30s. */
  timeoutMs?: number;
  /** Send cookies for same-origin requests. Defaults to false. */
  sameOriginCredentials?: boolean;
}

export async function httpFetch(url: string, init: RequestInit = {}, options: HttpRequestOptions = {}): Promise<Response> {
  const { baseUrl = "", token = "", authenticated = true, timeoutMs = 30_000, sameOriginCredentials = false } = options;
  const headers = new Headers(init.headers);
  if (init.body != null && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (authenticated && token) headers.set("Authorization", `Bearer ${token}`);
  const target = baseUrl ? `${baseUrl.replace(/\/+$/, "")}${url.startsWith("/") ? url : `/${url}`}` : url;
  const requestInit: RequestInit = { ...init, headers };
  if (sameOriginCredentials) requestInit.credentials = "same-origin";
  if (timeoutMs <= 0) return fetch(target, requestInit);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  requestInit.signal = controller.signal;
  try {
    return await fetch(target, requestInit);
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error("请求超时，请重试");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function httpJson<T>(url: string, init?: RequestInit, options: HttpRequestOptions = {}): Promise<T> {
  const response = await httpFetch(url, init, options);
  if (!response.ok) {
    let detail = "";
    try {
      detail = ((await response.json()) as { error?: string }).error ?? "";
    } catch {
      // Response body was not JSON.
    }
    throw new Error(detail || `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}