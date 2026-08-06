const fs = require("node:fs");
const path = require("node:path");

const nodeModules = path.resolve(process.argv[2] || path.join(__dirname, "..", "node_modules"));
const bundledRoot = path.join(nodeModules, "@earendil-works", "pi-coding-agent", "node_modules");
const replacements = new Map([
  ["brace-expansion", "5.0.9"],
  ["undici", "8.9.0"],
]);

for (const [name, expectedVersion] of replacements) {
  const source = path.join(nodeModules, name);
  const target = path.join(bundledRoot, name);
  const sourceManifest = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
  if (sourceManifest.version !== expectedVersion) {
    throw new Error(`Expected ${name}@${expectedVersion}, found ${sourceManifest.version}`);
  }
  if (!fs.existsSync(target)) continue;
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true });
  console.log(`Patched Pi bundled dependency: ${name}@${expectedVersion}`);
}
