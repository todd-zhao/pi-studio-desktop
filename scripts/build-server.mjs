import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const serverPkg = JSON.parse(
  readFileSync(new URL("../server/package.json", import.meta.url), "utf8"),
);
const piVersion = String(serverPkg.dependencies?.["@earendil-works/pi-coding-agent"] ?? "");

await build({
  absWorkingDir: root,
  entryPoints: ["server/src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  alias: { "pi-mcp-adapter": "./node_modules/pi-mcp-adapter/index.ts" },
  outfile: "server/dist/index.mjs",
  external: ["@earendil-works/pi-tui", "silk-wasm"],
  sourcemap: "linked",
  sourcesContent: true,
  banner: {
    js: "import { createRequire as __piCreateRequire } from 'module'; const require = __piCreateRequire(import.meta.url);",
  },
  define: { __PI_VERSION__: JSON.stringify(piVersion) },
});
