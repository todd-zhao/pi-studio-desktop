// Post-install patch: pi-mcp-adapter imports `complete` from the main
// `@earendil-works/pi-ai` entry, but pi-ai 0.83.0 only exports it from the
// `/compat` subpath. Rewrite the import so the adapter works with the pinned
// pi-ai version.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// npm workspaces may hoist pi-mcp-adapter to the repo root node_modules.
const candidates = [
  join(here, "..", "node_modules", "pi-mcp-adapter", "sampling-handler.ts"),
  join(here, "..", "..", "node_modules", "pi-mcp-adapter", "sampling-handler.ts"),
];
const target = candidates.find((p) => existsSync(p));

if (!existsSync(target)) {
  console.log("[patch] pi-mcp-adapter sampling-handler.ts not found, skipping");
  process.exit(0);
}

let src = readFileSync(target, "utf8");
const from = 'from "@earendil-works/pi-ai"';
const to = 'from "@earendil-works/pi-ai/compat"';

if (src.includes(from) && !src.includes(to)) {
  src = src.split(from).join(to);
  writeFileSync(target, src, "utf8");
  console.log("[patch] rewrote pi-ai import -> /compat in pi-mcp-adapter/sampling-handler.ts");
} else {
  console.log("[patch] pi-mcp-adapter import already patched or unchanged");
}
