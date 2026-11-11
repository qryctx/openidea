import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useSettingsPages } from "@/workbench/contributions";
import { commands } from "@/platform/ipc";
import { settingsSearchEntries } from "../searchIndex";
import { unloadBuiltinPages } from "../dialog/LazySettingsDialog";
import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { CommitOptionsBody } from "@/features/vcs/CommitOptions";

beforeAll(() => vi.stubEnv("VITE_OPENIDEA_PROFILE", "v0"));
afterAll(() => {
  unloadBuiltinPages();
  vi.unstubAllEnvs();
});

describe("v0 built-in settings", () => {
  it("keeps Git hooks and TODO checks without offering unavailable semantic checks", () => {
    render(createElement(CommitOptionsBody));
    expect(screen.getByRole("checkbox", { name: "Run Git hooks" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Check TODO" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Analyze code" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Reformat code" })).not.toBeInTheDocument();
    expect(screen.queryByText("Advanced Commit Checks")).not.toBeInTheDocument();
  });

  it("indexes only registered pages and avoids excluded language/update effects", async () => {
    const buildInfo = vi.spyOn(commands, "appBuildInfo");
    const languages = vi.spyOn(commands, "languages");
    const entries = await settingsSearchEntries();
    expect(entries.some((e) => e.pageId === "appearance")).toBe(true);
    expect(entries.some((e) => e.pageId === "tools.terminal")).toBe(true);
    expect(
      entries.some((e) => /^(agents|languages|plugins|tools\.ssh|build\.deployment|build\.runTargets)/.test(e.pageId)),
    ).toBe(false);
    expect(useSettingsPages.getState().pages.has("projectStructure")).toBe(false);
    expect(entries.some((e) => e.title === "Use non-modal commit interface")).toBe(false);
    expect(entries.some((e) => e.pageId === "vcs.commit" && e.title === "Analyze code")).toBe(false);
    expect(buildInfo).not.toHaveBeenCalled();
    expect(languages).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
