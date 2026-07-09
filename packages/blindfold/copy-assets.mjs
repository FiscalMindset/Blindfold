// Copies the assets that a few commands need (skill's SKILL.md, publish's WASM)
// into packages/blindfold/assets/ so they ship inside the npm package and those
// commands work from a standalone/global install — no repo, no SSD required.
// Runs from the build/prepare step; missing sources are skipped (dev is fine
// falling back to the repo copies at runtime).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/blindfold
const assets = path.join(here, "assets");
fs.mkdirSync(assets, { recursive: true });

const copies = [
  [path.join(here, "..", "..", ".claude", "skills", "blindfold", "SKILL.md"), path.join(assets, "SKILL.md")],
  [path.join(here, "..", "..", "contract", "target", "wasm32-wasip2", "release", "blindfold_proxy.wasm"), path.join(assets, "blindfold_proxy.wasm")],
];

for (const [src, dst] of copies) {
  try {
    if (fs.existsSync(src)) { fs.copyFileSync(src, dst); console.log("bundled asset:", path.basename(dst)); }
    else console.warn("asset source missing (skipped):", src);
  } catch (e) { console.warn("asset copy failed:", dst, e.message); }
}
