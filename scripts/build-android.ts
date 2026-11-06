/** Produce matching diagnostics without embedding them in the Android edition. */
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = join(root, "target", "android-frontend");
const web = join(output, "web");
const diagnostics = join(output, "sourcemaps");
await build({ root, mode: "android", build: { outDir: web, emptyOutDir: true, sourcemap: "hidden" } });
await rm(diagnostics, { recursive: true, force: true });
const assets = await readdir(web, { recursive: true, withFileTypes: true });
let count = 0;
for (const asset of assets) {
  if (!asset.isFile() || !asset.name.endsWith(".map")) continue;
  const source = join(asset.parentPath, asset.name);
  const dest = join(diagnostics, relative(web, source));
  await mkdir(dirname(dest), { recursive: true });
  await rename(source, dest);
  count++;
}
if (!count) throw new Error("Android build did not generate diagnostic source maps");
console.log(`Archived ${count} source maps outside frontendDist in ${relative(root, diagnostics)}`);
