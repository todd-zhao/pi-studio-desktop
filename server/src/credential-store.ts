import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/**
 * App-owned credential store backed by auth.json.
 *
 * The SDK's default AuthStorage keeps an in-memory snapshot loaded once at
 * construction time; its `read`/`list` never re-read the file afterwards, so
 * external writes to auth.json leave the runtime snapshot stale — clearing a
 * key would keep the provider reported as "configured" until the app
 * restarts. This store owns the file and keeps memory and disk in sync on
 * every write, which the Models panel relies on for immediate status
 * feedback.
 *
 * Single-process assumption: the bridge is the only writer, so no file
 * locking is needed.
 */
export class AppCredentialStore implements CredentialStore {
  private data: Record<string, Credential> = {};
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.reload();
  }

  get filePath(): string {
    return this.path;
  }

  /** Re-read auth.json into memory (used at startup). */
  reload(): void {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      this.data = raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, Credential>)
        : {};
    } catch {
      this.data = {};
    }
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const credential = this.data[providerId];
    if (!credential || credential.type !== "api_key" || credential.key === undefined) return credential;
    return { ...credential, key: resolveAuthTemplate(credential.key, credential.env) };
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.data).map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const next = await fn(this.data[providerId]);
    if (next === undefined) return this.data[providerId];
    this.data[providerId] = next;
    this.writeFile();
    return next;
  }

  async delete(providerId: string): Promise<void> {
    if (!Object.prototype.hasOwnProperty.call(this.data, providerId)) return;
    delete this.data[providerId];
    this.writeFile();
  }

  private writeFile(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    chmodSync(this.path, 0o600);
  }
}

/**
 * Lightweight `${NAME}` / `$NAME` environment substitution for stored keys.
 * The SDK's own resolver additionally supports `!command` execution and a
 * richer template grammar; the Models panel saves plain literal keys, so
 * anything unrecognized is returned verbatim.
 */
function resolveAuthTemplate(key: string, env?: Record<string, string>): string {
  return key.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (whole, braced: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare;
      if (name === undefined) return whole;
      const value = env?.[name] ?? process.env[name];
      return value !== undefined ? value : whole;
    },
  );
}
