import { afterEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const closed: string[] = [];
const modules = [
  "mcp",
  "project-trust",
  "welcome",
  "project-tree",
  "search",
  "dependencies",
  "code-insight",
  "vcs",
  "terminal",
  "run",
  "dotnet",
  "run-anything",
  "macros",
  "debugger",
  "coverage",
  "color-preview",
  "profiler",
  "logcat",
  "build-tools",
  "build",
  "templates",
  "todo",
  "settings",
  "app",
  "perf",
  "plugins",
  "tools",
  "scratch",
  "libraries",
  "viewers",
  "notebook",
  "web",
  "analysis",
  "services",
  "github",
  "http-client",
  "database",
  "graphql",
  "deployment",
  "agents",
  "vim",
  "ssh",
  "remote-dev",
];
const activate = (name: string) => () => {
  calls.push(name);
  return () => closed.push(name);
};
for (const name of modules) {
  vi.doMock(`@/features/${name}`, () => ({
    activate: activate(name),
    activateSettingsPages: activate(`${name}.pages`),
    activateLocale: activate("locale"),
    activateMenuBridge: activate("menu"),
    activateRuntimeSettings: activate("settings.runtime"),
    activateSettingsWindow: activate("settings.window"),
    activateComparisonWindow: activate("comparison"),
    activateDiffViewer: activate("diff"),
    activateDeploymentWindow: activate("deployment.window"),
    confirmLeave: vi.fn(),
    SettingsWindow: () => null,
    ComparisonWindow: () => null,
    DeploymentWindow: () => null,
  }));
}
vi.doMock("@/editor/core", () => ({ activate: activate("editor") }));
vi.doMock("@/editor/lsp", () => ({ activate: activate("editor-lsp") }));
const features = await import("./index");

afterEach(() => {
  vi.unstubAllEnvs();
  calls.length = 0;
  closed.length = 0;
});

describe("product feature activation", () => {
  it("retains default activation and reverse-order disposal", () => {
    vi.stubEnv("VITE_OPENIDEA_PROFILE", "default");
    const dispose = features.activateFeatures();
    expect(calls).toContain("agents");
    expect(calls).toContain("editor-lsp");
    expect(calls).toContain("remote-dev");
    const active = [...calls];
    dispose();
    expect(closed).toEqual(active.reverse());
  });

  it("activates only the bounded v0 slice, not feature-owned effects", () => {
    vi.stubEnv("VITE_OPENIDEA_PROFILE", "v0");
    const dispose = features.activateFeatures();
    expect(calls).toEqual([
      "project-trust",
      "editor",
      "app",
      "welcome",
      "project-tree",
      "search",
      "vcs",
      "terminal",
      "run",
      "debugger",
      "logcat",
      "build",
      "settings",
    ]);
    dispose();
    expect(closed).toEqual([...calls].reverse());
  });

  it("uses the same boundary in Settings and refuses deployment auxiliary activation", () => {
    vi.stubEnv("VITE_OPENIDEA_PROFILE", "v0");
    const dispose = features.activateSettingsWindowFeatures("main");
    expect(calls).toEqual(["project-trust", "locale", "settings.window", "vcs.pages"]);
    expect(() => features.activateDeploymentWindowFeatures("main")).toThrow("Deployment is unavailable");
    dispose();
  });

  it("keeps comparison editor and Git activation available in v0", () => {
    vi.stubEnv("VITE_OPENIDEA_PROFILE", "v0");
    const dispose = features.activateComparisonWindowFeatures("main");
    expect(calls).toEqual(["locale", "settings.runtime", "menu", "editor", "vcs", "comparison"]);
    dispose();
  });
});
