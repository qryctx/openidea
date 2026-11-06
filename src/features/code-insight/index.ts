/**
 * Code insight: Problems tool window, Find / Show Usages, call and
 * type hierarchies, and language server status. Editor-side LSP features live
 * in `editor/lsp`; the two talk only through actions.
 */
import { onEditorEvent } from "@/editor/api";
import { onIdeEvent } from "@/platform/ipc";
import { registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { registerOverlay, registerStatusItem, registerToolWindow } from "@/workbench/contributions";
import { clearProblems, installProblemsEvents, useProblems } from "./problemsStore";
import { installProblemDecorations } from "./decorations";
import { ProblemsHeaderActions, ProblemsTabs, ProblemsView, useProblemsHeaderMenu } from "./ProblemsView";
import { UsagesTabs, UsagesView, useUsagesHeaderMenu } from "./UsagesView";
import { UsagesPopup } from "./UsagesPopup";
import { findUsages, rerunActiveUsages, resetUsages, showUsageResults, showUsagesPopup } from "./usages";
import { HierarchyTabs, HierarchyView } from "./HierarchyView";
import { resetHierarchy, showHierarchy } from "./hierarchy";
import { installServerEvents } from "./servers";
import { ServerStatus } from "./ServerStatus";
import { installWorkspaceEditUndo } from "./workspaceUndo";

import { AndroidVariantStatus } from "./AndroidVariantStatus";
import {
  androidFilesChanged,
  cancelAndroidSync,
  discoverAndroidVariants,
  selectAndroidVariant,
  useAndroidVariants,
} from "./androidVariants";

const EDITOR_WHEN = "textEditorActive && (editorFocus || popupOpen || !toolWindowFocus)";

function useErrorBadge(): number | null {
  return useProblems((s) => {
    let n = 0;
    for (const sources of s.map.values())
      for (const items of sources.values()) for (const d of items) if (d.severity === "error") n++;
    return n || null;
  });
}

export function activate(): () => void {
  let root = useProject.getState().project?.root ?? null;
  let trusted = useProject.getState().project?.trusted === true;
  void discoverAndroidVariants(root, trusted);
  const unsubVariant = useAndroidVariants.subscribe((s, prev) => {
    if (
      s.selected !== prev.selected ||
      s.application !== prev.application ||
      (s.selected && s.phase !== prev.phase && ["stale", "discovering"].includes(s.phase))
    )
      resetUsages();
  });
  const unsubProject = useProject.subscribe((s) => {
    const r = s.project?.root ?? null;
    const t = s.project?.trusted === true;
    if (r !== root || t !== trusted) {
      root = r;
      trusted = t;
      void discoverAndroidVariants(r, t);
      clearProblems();
      resetUsages();
      resetHierarchy();
    }
  });
  const disposers = [
    unsubProject,
    unsubVariant,
    () => {
      void discoverAndroidVariants(null, false);
    },
    onEditorEvent((e) => {
      if (e.type === "docSaved") androidFilesChanged([e.path]);
    }),
    onIdeEvent("fsChanged", (e) => androidFilesChanged([...e.created, ...e.modified, ...e.removed])),
    installProblemsEvents(),
    installProblemDecorations(),
    installServerEvents(),
    installWorkspaceEditUndo(),
    registerToolWindow({
      id: "problems",
      title: "Problems",
      icon: "toolwindow-problems",
      anchor: "bottom",
      order: 30,
      component: ProblemsView,
      headerContent: ProblemsTabs,
      headerActions: ProblemsHeaderActions,
      headerMenu: useProblemsHeaderMenu,
      useBadge: useErrorBadge,
    }),
    registerToolWindow({
      id: "usages",
      title: "Find Usages",
      icon: "toolwindow-usages",
      anchor: "bottom",
      stripe: "onUse",
      order: 35,
      component: UsagesView,
      headerContent: UsagesTabs,
      headerMenu: useUsagesHeaderMenu,
    }),
    registerToolWindow({
      id: "hierarchy",
      title: "Hierarchy",
      icon: "toolwindow-hierarchy",
      anchor: "right",
      stripe: "onUse",
      order: 40,
      component: HierarchyView,
      headerContent: HierarchyTabs,
    }),
    registerStatusItem({
      id: "code-insight.servers",
      align: "right",
      priority: 5,
      component: ServerStatus,
      title: "Language Services",
    }),
    registerStatusItem({
      id: "android.referenceVariant",
      align: "right",
      priority: 6,
      component: AndroidVariantStatus,
      title: "Android reference variant",
    }),
    registerOverlay({ id: "code-insight.usagesPopup", component: UsagesPopup }),
    registerActions([
      {
        id: "android.selectVariant",
        title: "Select Android reference variant",
        hidden: true,
        run: ({ arg }) => selectAndroidVariant(arg),
      },
      {
        id: "android.cancelSync",
        title: "Cancel Android sync",
        hidden: true,
        run: () => {
          cancelAndroidSync();
          resetUsages();
        },
      },
      {
        id: "android.refreshVariants",
        title: "Reload Android reference variants",
        when: "projectOpen",
        run: () => {
          resetUsages();
          return discoverAndroidVariants(root, trusted);
        },
      },
      { id: "find.usages", title: "Find Usages", category: "Find", when: EDITOR_WHEN, run: () => findUsages() },
      {
        id: "find.showUsages",
        title: "Show Usages",
        category: "Find",
        when: EDITOR_WHEN,
        run: () => showUsagesPopup(),
      },
      {
        // ⌘R in the Find Usages tool window, as in IDEA.
        id: "usages.rerun",
        title: "Rerun Find Usages",
        category: "Find",
        icon: "rerun",
        when: "projectOpen && activeToolWindow == 'usages'",
        run: rerunActiveUsages,
      },
      {
        id: "find.showUsageResults",
        title: "Show Usage Results",
        category: "Find",
        hidden: true,
        description:
          "Shows `{ symbol, locations }` (found elsewhere, e.g. by Safe Delete) in the Find Usages tool window.",
        run: ({ arg }) => showUsageResults(arg),
      },
      {
        id: "navigate.callHierarchy",
        title: "Call Hierarchy",
        category: "Navigate",
        when: EDITOR_WHEN,
        run: () => showHierarchy("call"),
      },
      {
        id: "navigate.typeHierarchy",
        title: "Type Hierarchy",
        category: "Navigate",
        when: EDITOR_WHEN,
        run: () => showHierarchy("type"),
      },
    ]),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
