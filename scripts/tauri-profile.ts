import { loadEnv } from "vite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type ProductProfile = "default" | "v0";

export function productProfile(value: string | undefined): ProductProfile {
  if (!value || value === "default") return "default";
  if (value === "v0") return "v0";
  throw new Error(`Unknown OpenIDEA product profile: ${value}`);
}

export function buildProfile(command: string | undefined, root: string): ProductProfile {
  const mode = command === "dev" ? "development" : "production";
  return productProfile(loadEnv(mode, root, "VITE_OPENIDEA_PROFILE").VITE_OPENIDEA_PROFILE);
}

export function profileTargetDirectory(
  profile: ProductProfile,
  root: string,
  current: string | undefined,
): string | undefined {
  return profile === "v0" ? resolve(root, current ?? "target", "v0") : current;
}

export function withProfileConfig(args: string[], profile: ProductProfile): string[] {
  if (profile === "v0" && args[0] === "bundle") {
    throw new Error("Use pnpm tauri build for v0 bundles so Cargo recompiles the matching backend profile.");
  }
  if (profile !== "v0" || !["dev", "build"].includes(args[0] ?? "")) return args;
  const overlay = readFileSync(new URL("../src-tauri/tauri.v0.conf.json", import.meta.url), "utf8");
  const separator = args.indexOf("--");
  const index = separator < 0 ? args.length : separator;
  return [...args.slice(0, index), "--config", overlay, ...args.slice(index)];
}
