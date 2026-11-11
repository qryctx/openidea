// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProfile, productProfile, profileTargetDirectory, withProfileConfig } from "./tauri-profile.ts";
import { withDevConfig } from "./dev-session.ts";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("Tauri product profile", () => {
  it("separates v0 binaries without changing default Cargo output, independently of launch cwd", () => {
    const root = join(tmpdir(), "worktree");
    expect(profileTargetDirectory("default", root, undefined)).toBeUndefined();
    expect(profileTargetDirectory("default", root, "custom-target")).toBe("custom-target");
    expect(profileTargetDirectory("v0", root, undefined)).toBe(join(root, "target", "v0"));
    expect(profileTargetDirectory("v0", root, "custom-target")).toBe(join(root, "custom-target", "v0"));
    expect(profileTargetDirectory("v0", root, join(root, "output"))).toBe(join(root, "output", "v0"));
  });

  it("uses the same explicit selection and errors as the frontend", () => {
    for (const value of [undefined, "", "default"]) expect(productProfile(value)).toBe("default");
    expect(productProfile("v0")).toBe("v0");
    expect(() => productProfile("unknown")).toThrow("Unknown OpenIDEA product profile");
  });

  it("resolves Vite mode files and environment precedence before launching Cargo", () => {
    const root = mkdtempSync(join(tmpdir(), "openidea-profile-"));
    roots.push(root);
    vi.stubEnv("VITE_OPENIDEA_PROFILE", undefined);
    writeFileSync(join(root, ".env.development"), "VITE_OPENIDEA_PROFILE=v0\n");
    writeFileSync(join(root, ".env.production"), "VITE_OPENIDEA_PROFILE=default\n");
    expect(buildProfile("dev", root)).toBe("v0");
    expect(buildProfile("build", root)).toBe("default");
    vi.stubEnv("VITE_OPENIDEA_PROFILE", "default");
    expect(buildProfile("dev", root)).toBe("default");
    vi.stubEnv("VITE_OPENIDEA_PROFILE", "v0");
    expect(buildProfile("build", root)).toBe("v0");
  });

  it.each(["dev", "build"])("applies v0 isolation last for %s without changing runtime args", (command) => {
    const input = [command, "--config", '{"plugins":{"updater":{"endpoints":["https://example.com"]}}}', "--", "arg"];
    const args = withProfileConfig(input, "v0");
    expect(args.slice(-2)).toEqual(["--", "arg"]);
    expect(JSON.parse(args.at(-3)!)).toEqual({
      identifier: "dev.qryctx.openidea.v0",
      bundle: { createUpdaterArtifacts: false },
      plugins: { updater: null },
    });
    expect(withProfileConfig(input, "default")).toBe(input);
    const devArgs = withDevConfig(args, "http://localhost:12345/");
    expect(JSON.parse(devArgs.at(-5)!)).toEqual(JSON.parse(args.at(-3)!));
    expect(JSON.parse(devArgs.at(-3)!)).toEqual({
      build: { beforeDevCommand: "", devUrl: "http://localhost:12345/" },
    });
  });

  it("does not package a previously compiled default backend as v0", () => {
    expect(() => withProfileConfig(["bundle"], "v0")).toThrow("Cargo recompiles");
    expect(withProfileConfig(["bundle"], "default")).toEqual(["bundle"]);
  });

  it("leaves the upstream base configuration unchanged", () => {
    const base = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
    expect(base.identifier).toBe("ai.l0ng.openidea");
    expect(base.bundle.createUpdaterArtifacts).toBe(true);
    expect(base.plugins.updater.endpoints).toEqual([
      "https://github.com/l0ng-ai/openidea/releases/latest/download/latest.json",
    ]);
    expect(base.plugins.updater.pubkey).toBeTruthy();
  });
});
