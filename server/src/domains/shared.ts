// Shared helpers extracted from bridge.ts so domain modules stay independent.

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
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

const MEMORY_SECRET_PATTERNS = [
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/i,
  /(?:sk|rk|pk)_[A-Za-z0-9_-]{20,}/,
  /(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s]{12,}/i,
];

/** True when the content looks like it embeds credentials/keys that must not be persisted as memory. */
export function containsSensitiveMemory(content: string): boolean {
  return MEMORY_SECRET_PATTERNS.some((pattern) => pattern.test(content));
}

export const TEXT_PREVIEW_LIMIT = 1024 * 1024; // bytes of text content returned to the client
export const IMAGE_PREVIEW_LIMIT = 8 * 1024 * 1024;

export const MIME_BY_EXT: Record<string, string> = {
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
