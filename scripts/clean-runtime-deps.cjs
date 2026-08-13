#!/usr/bin/env node
/**
 * Post-prune cleanup for the packaged runtime `node_modules`.
 *
 * Removes files that are inert at runtime on Windows x64 so the released app
 * carries far fewer small files and no foreign-platform binaries:
 *   - non-win32-x64 native prebuilds (darwin / linux / win32-arm64 / ... .node)
 *   - source maps and type declarations (*.map / *.d.ts / *.d.mts / *.d.cts)
 *   - README / CHANGELOG markdown (keeping LICENSE / COPYING / NOTICE files)
 *   - test / benchmark / docs / example / .github / .cache directories
 *
 * Deliberately KEPT (never touched):
 *   - *.ts / *.tsx / *.mts / *.cts source — pi extension packages
 *     (pi-subagents, pi-hermes-memory, pi-goal-list-loop-audit) are loaded
 *     directly from TypeScript source at runtime, so their .ts files are load
 *     bearing.
 *   - *.js / *.cjs / *.mjs / *.json and every LICENSE / COPYING / NOTICE file.
 *
 * Usage: node scripts/clean-runtime-deps.cjs <path-to-node_modules>
 * Exit codes: 0 ok, 2 missing target.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const target = path.resolve(process.argv[2] || path.join(process.cwd(), "node_modules"));
if (!fs.existsSync(target)) {
  console.error(`[clean-runtime-deps] node_modules not found: ${target}`);
  process.exit(2);
}

// Extensions that are safe to strip. NOTE: do NOT add .ts/.tsx/.mts/.cts here —
// pi extension packages are loaded from TypeScript source (see header comment).
const REMOVE_EXT = new Set([".map", ".d.ts", ".d.mts", ".d.cts", ".md"]);

const REMOVE_DIRS = new Set([
  "test", "tests", "benchmark", "benchmarks", "doc", "docs",
  "example", "examples", ".github", ".cache",
]);

const FOREIGN_TOKENS = [
  "darwin", "linux", "android", "freebsd", "openbsd", "sunos", "aix",
  "win32-arm64", "win32-ia32", "win32-arm",
];

let removedFiles = 0;
let removedDirs = 0;
let removedBytes = 0;

function isLicense(name) {
  return /license|copying|notice/i.test(name);
}

function isForeign(p) {
  const n = p.replace(/\\/g, "/").toLowerCase();
  return FOREIGN_TOKENS.some((tok) => n.includes(tok));
}

function removeDir(dir) {
  let bytes = 0;
  const sum = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) sum(fp);
      else {
        try { bytes += fs.statSync(fp).size; } catch { /* ignore */ }
      }
    }
  };
  sum(dir);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  removedDirs++;
  removedBytes += bytes;
}

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const lower = e.name.toLowerCase();
    if (e.isDirectory() || e.isSymbolicLink()) {
      if (isForeign(e.name) || REMOVE_DIRS.has(lower)) {
        removeDir(full);
      } else if (e.isDirectory()) {
        walk(full);
      }
    } else if (e.isFile()) {
      let remove = false;
      if (lower.endsWith(".node")) {
        remove = isForeign(full);
      } else if (!isLicense(e.name)) {
        for (const ext of REMOVE_EXT) {
          if (lower.endsWith(ext)) { remove = true; break; }
        }
      }
      if (remove) {
        try {
          removedBytes += fs.statSync(full).size;
          fs.rmSync(full, { force: true });
          removedFiles++;
        } catch { /* ignore */ }
      }
    }
  }
}

walk(target);

console.log(
  `[clean-runtime-deps] removed ${removedFiles} files / ${removedDirs} dirs / ` +
  `${(removedBytes / 1048576).toFixed(1)} MB from ${target}`,
);
