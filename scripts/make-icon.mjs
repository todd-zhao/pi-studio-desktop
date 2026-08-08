import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = path.join(ROOT, "desktop", "assets");
const PUBLIC = path.join(ROOT, "client", "public");
const SOURCE = path.join(ASSETS, "icon.png");
const png = readFileSync(SOURCE);
const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
if (!png.subarray(0, 8).equals(signature)) throw new Error("desktop/assets/icon.png is not a PNG");
if (png.readUInt32BE(16) !== 256 || png.readUInt32BE(20) !== 256) throw new Error("desktop/assets/icon.png must be 256x256");

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry.writeUInt16LE(1, 4);
entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(22, 12);
const ico = Buffer.concat([header, entry, png]);
writeFileSync(path.join(ASSETS, "icon.ico"), ico);
writeFileSync(path.join(ASSETS, "pi-studio-logo.ico"), ico);
for (const name of ["logo.png", "pi-studio-logo.png"]) copyFileSync(SOURCE, path.join(ASSETS, name));
copyFileSync(SOURCE, path.join(PUBLIC, "pi-studio-logo.png"));
console.log("Synchronized Pi Studio icon assets from desktop/assets/icon.png");
