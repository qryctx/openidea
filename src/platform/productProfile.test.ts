import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAction, registerAction } from "./actions";
import { useProject } from "./project";
import { connectRemote } from "./remote";
import { runTargets } from "./pluginRunTargets";
import { validateWorkflow, workflowSettings } from "./workflowSettings";
import { loadSession, storeSession, type EditorSession } from "@/editor/core/model/session";
import { profileMenuNodes } from "@/workbench/MainMenu";
import { disabledMenuActions } from "@/features/app/menuBridge";
import { openSettings, selectPage, useSettingsDialog } from "@/features/settings/model/staging";
import { registerSettingsPage, registerToolWindow, useSettingsPages } from "@/workbench/contributions";
import { installToolWindowActions } from "@/workbench/toolwindows/actions";
import {
  applyToolWindowLayout,
  defaultLayoutSnapshot,
  loadToolWindowLayout,
  resetToolWindowLayout,
  showToolWindow,
  toolWindowLayoutSnapshot,
  useToolWindowLayout,
} from "@/workbench/toolwindows/store";
import { _reloadLayouts, layoutNames, saveLayout } from "@/workbench/toolwindows/layouts";
import { startWithRemedies } from "@/features/run/remote";
import { openRecent } from "@/features/welcome/recent";
import { openProjectInWindow, openProjectWithPolicy } from "@/features/app/windows";
import type { MenuNode } from "./ipc";
import * as ipc from "./ipc";

const Empty = () => null;
let disposers: (() => void)[] = [];

beforeEach(() => {
  vi.stubEnv("VITE_OPENIDEA_PROFILE", "v0");
  localStorage.clear();
  resetToolWindowLayout();
});
afterEach(() => {
  disposers.reverse().forEach((d) => d());
  disposers = [];
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetToolWindowLayout();
  useProject.setState({ settings: null });
});

describe("v0 workbench boundaries", () => {
  it("starts in Commit, retains Project and filters restored windows and their actions", () => {
    for (const id of ["project", "commit", "notifications", "agents", "database"]) {
      disposers.push(registerToolWindow({ id, title: id, icon: "folder", anchor: "left", component: Empty }));
    }
    disposers.push(installToolWindowActions());
    loadToolWindowLayout("/p");
    expect(useToolWindowLayout.getState().visible.left).toBe("commit");
    expect(getAction("toolwindow.project")).toBeDefined();
    expect(getAction("toolwindow.notifications")).toBeDefined();
    expect(getAction("toolwindow.agents")).toBeUndefined();
    expect(getAction("toolwindow.database")).toBeUndefined();
    const snapshot = defaultLayoutSnapshot();
    snapshot.visible.right = "agents";
    snapshot.placements.agents = { anchor: "right" };
    snapshot.stripeButtons.database = true;
    applyToolWindowLayout(snapshot);
    expect(useToolWindowLayout.getState().visible.right).toBeNull();
    expect(useToolWindowLayout.getState().mounted.has("agents")).toBe(false);
    expect(toolWindowLayoutSnapshot().placements).not.toHaveProperty("agents");
    expect(toolWindowLayoutSnapshot().stripeButtons).not.toHaveProperty("database");
    showToolWindow("project");
    expect(useToolWindowLayout.getState().visible.left).toBe("project");
  });

  it("isolates both project and named layouts without changing the default profile's data", () => {
    const baseline = JSON.stringify({ visible: { left: "project", right: "agents" } });
    localStorage.setItem("openidea.layout.v1:/p", baseline);
    localStorage.setItem(
      "openidea.toolWindowLayouts.v1",
      JSON.stringify({
        layouts: [{ name: "Original", layout: defaultLayoutSnapshot() }],
        active: "Original",
      }),
    );
    const namedBaseline = localStorage.getItem("openidea.toolWindowLayouts.v1");
    _reloadLayouts();
    expect(layoutNames()).toEqual([]);
    loadToolWindowLayout("/p");
    expect(useToolWindowLayout.getState().visible.left).toBe("commit");
    saveLayout("Changes");
    applyToolWindowLayout(defaultLayoutSnapshot());
    expect(localStorage.getItem("openidea.layout.v1:/p")).toBe(baseline);
    expect(localStorage.getItem("openidea.toolWindowLayouts.v1")).toBe(namedBaseline);
    vi.stubEnv("VITE_OPENIDEA_PROFILE", "default");
    loadToolWindowLayout("/p");
    _reloadLayouts();
    expect(useToolWindowLayout.getState().visible).toMatchObject({ left: "project", right: "agents" });
    expect(layoutNames()).toEqual(["Original"]);
  });

  it("preserves default editor documents even when v0 closes its own session", () => {
    const original: EditorSession = {
      version: 1,
      activePane: 0,
      files: {},
      layout: {
        kind: "pane",
        active: 0,
        tabs: [{ path: "/p/Main.kt" }, { input: { kind: "notebook", key: "notebook:/p/notes.ipynb" } }],
      },
    };
    vi.stubEnv("VITE_OPENIDEA_PROFILE", "default");
    storeSession("/p", original);
    vi.stubEnv("VITE_OPENIDEA_PROFILE", "v0");
    expect(loadSession("/p")).toBeNull();
    storeSession("/p", { ...original, layout: { kind: "pane", active: 0, tabs: [{ path: "/p/Edit.kt" }] } });
    storeSession("/p", null);
    vi.stubEnv("VITE_OPENIDEA_PROFILE", "default");
    expect(loadSession("/p")).toEqual(original);
  });

  it("filters Settings registrations and routes excluded deep links to Appearance", () => {
    disposers.push(registerSettingsPage({ id: "agents.chat", title: "Chat" }));
    disposers.push(registerSettingsPage({ id: "tools.terminal", title: "Terminal" }));
    expect(useSettingsPages.getState().pages.has("agents.chat")).toBe(false);
    expect(useSettingsPages.getState().pages.has("tools.terminal")).toBe(true);
    openSettings("agents.chat#input");
    expect(useSettingsDialog.getState()).toMatchObject({ pageId: "appearance", focus: null });
    selectPage("tools.sshConfigurations");
    expect(useSettingsDialog.getState().pageId).toBe("appearance");
    selectPage("tools.terminal");
    expect(useSettingsDialog.getState().pageId).toBe("tools.terminal");
  });

  it("enforces non-modal Commit without overwriting the stored preference", () => {
    const raw = { vcs: { commit: { nonModal: false, analyzeCode: true, reformat: true } } };
    useProject.setState({ settings: raw as NonNullable<ReturnType<typeof useProject.getState>["settings"]> });
    expect(workflowSettings().vcs.commit.nonModal).toBe(true);
    expect(workflowSettings().vcs.commit.analyzeCode).toBe(false);
    expect(workflowSettings().vcs.commit.reformat).toBe(false);
    expect(raw.vcs.commit.nonModal).toBe(false);
    vi.stubEnv("VITE_OPENIDEA_PROFILE", "default");
    expect(validateWorkflow(raw).vcs.commit.nonModal).toBe(false);
    expect(validateWorkflow(raw).vcs.commit.analyzeCode).toBe(true);
    expect(validateWorkflow(raw).vcs.commit.reformat).toBe(true);
  });

  it("removes absent frontend menu entries, empty submenus and orphan separators", () => {
    disposers.push(registerAction({ id: "file.settings", title: "Settings", run: () => {} }));
    disposers.push(registerAction({ id: "file.openRecentProject", title: "Open Recent", run: () => {} }));
    const action = (id: string): MenuNode => ({ kind: "action", id, label: id, hint: null, arg: null, checked: null });
    const nodes: MenuNode[] = [
      { kind: "submenu", id: "tools", label: "Tools", children: [action("agents.open")] },
      {
        kind: "submenu",
        id: "file",
        label: "File",
        children: [
          { kind: "separator" },
          action("file.settings"),
          { kind: "separator" },
          action("deployment.sync"),
          {
            kind: "action",
            id: "file.openRecentProject",
            label: "remote",
            hint: null,
            checked: null,
            arg: "ssh://box/p",
          },
          { kind: "placeholder", id: "todo", label: "TODO" },
        ],
      },
    ];
    expect(profileMenuNodes(nodes)).toEqual([
      { kind: "submenu", id: "file", label: "File", children: [action("file.settings")] },
    ]);
    expect(disabledMenuActions(["deployment.sync"])).toEqual(["deployment.sync"]);
    vi.stubEnv("VITE_OPENIDEA_PROFILE", "default");
    expect(profileMenuNodes(nodes)).toBe(nodes);
    expect(disabledMenuActions(["deployment.sync"])).toEqual([]);
  });

  it("blocks restored remote entrypoints before connection or launch and retains local execution", async () => {
    vi.spyOn(ipc, "isTauri").mockReturnValue(true);
    const openWindow = vi.spyOn(ipc.commands, "windowOpenProject");
    const connect = vi.spyOn(ipc.commands, "remoteConnect");
    expect(runTargets()).toEqual([]);
    await expect(connectRemote({ kind: "ssh", config: "box" }, "/p")).rejects.toMatchObject({ kind: "unavailable" });
    const start = vi.fn(async () => "started");
    await expect(startWithRemedies({ target: "box" }, start)).rejects.toMatchObject({ kind: "unavailable" });
    expect(start).not.toHaveBeenCalled();
    await expect(startWithRemedies({ target: "" }, start)).resolves.toBe("started");
    await expect(openRecent({ path: "ssh://box/p", name: "remote" })).resolves.toBe(false);
    await expect(openProjectInWindow("ssh://box/p", true)).resolves.toBeUndefined();
    await expect(openProjectWithPolicy("ssh://box/p")).resolves.toBeUndefined();
    expect(openWindow).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
});
