#!/usr/bin/env node
/**
 * Prunes the runtime-stage `node_modules` down to the packages that MUST stay
 * on disk next to the bundle. Everything else is inlined into
 * `server/dist/index.mjs` by esbuild (see package.json "build:server").
 *
 * Why these packages must stay external:
 *   - Native addons (.node / WASM) cannot be inlined by esbuild.
 *   - Extension packages are resolved at runtime via appRequire.resolve()
 *     (server/src/bridge.ts), so they must exist as real directories.
 *   - A few libraries are loaded through runtime-generated require() calls
 *     that esbuild leaves as external requires (recheck, keyring, clipboard).
 *
 * Maintenance: keep REQUIRED_ROOTS in sync with docs/runtime-deps.md. When you
 * add a new native / lazily-loaded dependency, add it to REQUIRED_ROOTS, or
 * this script will delete it and the runtime will fail with a confusing
 * "Cannot find module" error at startup.
 *
 * Usage: node scripts/keep-runtime-deps.cjs <path-to-node_modules>
 * Exit codes: 0 ok, 2 validation failure (build must stop).
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const nodeModules = path.resolve(process.argv[2] || path.join(process.cwd(), "node_modules"));
if (!fs.existsSync(nodeModules)) {
  console.error(`[keep-runtime-deps] node_modules not found: ${nodeModules}`);
  console.error("Run the build from the repository root after npm ci, or pass the stage node_modules path.");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Required external roots (see docs/runtime-deps.md for the full rationale).
// ---------------------------------------------------------------------------
const REQUIRED_ROOTS = [
  // Extension packages resolved at runtime via appRequire.resolve() (bridge.ts).
  "pi-hermes-memory", // Hermes memory extension (pulls in better-sqlite3 native addon)
  "pi-subagents", // subagent extension
  "pi-goal-list-loop-audit", // goal list / loop audit extension
  // Loaded by the MCP adapter through runtime-generated require()/import() calls.
  "typebox",
  "ajv",
  "ajv-formats",
  "iconv-lite",
  "google-auth-library",
  // Native credential store (keyringRequire("@napi-rs/keyring")).
  "@napi-rs/keyring",
  "@napi-rs/keyring-win32-x64-msvc",
  // Native clipboard (keyringRequire style runtime require).
  "@mariozechner/clipboard",
  "@mariozechner/clipboard-win32-x64-msvc",
  // Regex safety validation (require("recheck")).
  "recheck",
  "recheck-windows-x64",
  "recheck-jar",
  // TUI: contains a native .node addon (win32-console-mode) loaded by a
  // relative path from import.meta.url, so it cannot be inlined.
  "@earendil-works/pi-tui",
];

// ---------------------------------------------------------------------------
// Helpers (mirror Node's real resolution, honoring nested node_modules).
// ---------------------------------------------------------------------------
function readPkg(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function resolvePkg(spec, fromDir) {
  const parts = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
  let dir = fromDir;
  for (;;) {
    const cand = path.join(dir, "node_modules", parts);
    if (fs.existsSync(cand)) return cand;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// ---------------------------------------------------------------------------
// 1) Resolve every required root; fail hard if any is missing.
// ---------------------------------------------------------------------------
const seen = new Map(); // absolute package dir -> spec
const queue = [];
const missing = [];
for (const r of REQUIRED_ROOTS) {
  const p = resolvePkg(r, nodeModules);
  if (!p) {
    missing.push(r);
    continue;
  }
  if (!seen.has(p)) {
    seen.set(p, r);
    queue.push(p);
  }
}
if (missing.length > 0) {
  console.error("[keep-runtime-deps] FATAL: required external packages are missing from node_modules:");
  for (const m of missing) console.error(`  - ${m}`);
  console.error("The runtime would fail to start. Aborting build (see docs/runtime-deps.md).");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 2) BFS over the runtime dependency closure.
// ---------------------------------------------------------------------------
while (queue.length > 0) {
  const pkgDir = queue.shift();
  const pkg = readPkg(pkgDir);
  if (!pkg) continue;
  // NOTE: intentionally only dependencies + optionalDependencies. Peer
  // dependencies would pull in huge optional provider SDK trees (openai,
  // @aws-sdk/*, ...) that the inlined bundle already carries; the verified
  // keep-set is ~90 packages. If a kept package later hard-requires a peer
  // dependency at runtime, add it to REQUIRED_ROOTS explicitly.
  const deps = {
    ...(pkg.dependencies || {}),
    ...(pkg.optionalDependencies || {}),
  };
  for (const spec of Object.keys(deps)) {
    const dep = resolvePkg(spec, pkgDir);
    if (dep && !seen.has(dep)) {
      seen.set(dep, spec);
      queue.push(dep);
    }
  }
}

// ---------------------------------------------------------------------------
// 3) Collect every directory that must survive (package dirs + full subtrees).
// ---------------------------------------------------------------------------
const keepDirs = new Set();
for (const d of seen.keys()) {
  keepDirs.add(d);
  const walk = (p) => {
    let entries;
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const fp = path.join(p, e.name);
      if (e.isDirectory()) {
        keepDirs.add(fp);
        walk(fp);
      }
    }
  };
  walk(d);
}

// ---------------------------------------------------------------------------
// 4) Guard rails: a sane closure is the whole point of this script.
// ---------------------------------------------------------------------------
const MIN_EXPECTED_PACKAGES = 40; // current closure is ~90; sanity floor only.
if (seen.size < MIN_EXPECTED_PACKAGES) {
  console.error(
    `[keep-runtime-deps] FATAL: closure unexpectedly small (${seen.size} packages < ${MIN_EXPECTED_PACKAGES}). ` +
      "Refusing to prune: the keep-set logic may be broken.",
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 5) Prune everything at the top level that is not inside the keep-set.
// ---------------------------------------------------------------------------
const removed = [];
function removeEntry(full, label) {
  fs.rmSync(full, { recursive: true, force: true });
  removed.push(label);
}

for (const e of fs.readdirSync(nodeModules, { withFileTypes: true })) {
  if (e.name === ".bin" || e.name === ".package-lock.json" || e.name === ".cache") {
    removeEntry(path.join(nodeModules, e.name), e.name);
    continue;
  }
  const full = path.join(nodeModules, e.name);
  if (e.isDirectory() && e.name.startsWith("@")) {
    // Scoped namespace: prune child packages individually, then the scope dir if empty.
    let children;
    try {
      children = fs.readdirSync(full, { withFileTypes: true });
    } catch {
      continue;
    }
    let remaining = 0;
    for (const c of children) {
      const cf = path.join(full, c.name);
      if (c.isDirectory()) {
        if (keepDirs.has(cf)) {
          remaining++;
        } else {
          removeEntry(cf, `${e.name}/${c.name}`);
        }
      } else {
        removeEntry(cf, `${e.name}/${c.name}`);
      }
    }
    if (remaining === 0) removeEntry(full, e.name);
  } else if (e.isDirectory() || e.isSymbolicLink()) {
    if (!keepDirs.has(full)) removeEntry(full, e.name);
  }
}

// ---------------------------------------------------------------------------
// 6) Report.
// ---------------------------------------------------------------------------
let files = 0;
let bytes = 0;
for (const d of keepDirs) {
  let entries;
  try {
    entries = fs.readdirSync(d, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const e of entries) {
    if (e.isFile()) {
      files++;
      bytes += fs.statSync(path.join(d, e.name)).size;
    }
  }
}
const keptNames = [...seen.values()].sort();
console.log(`[keep-runtime-deps] kept ${seen.size} packages / ${keepDirs.size} dirs / ${files} files / ${(bytes / 1048576).toFixed(1)} MB`);
console.log(`[keep-runtime-deps] removed ${removed.length} top-level entries`);
console.log("[keep-runtime-deps] kept packages:");
console.log(keptNames.map((n) => `  - ${n}`).join("\n"));