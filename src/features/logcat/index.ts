/**
 * Logcat tool window: what an Android device prints, via `adb logcat`, with the
 * level and text filters of IDEA's Android plugin.
 */
import { registerActions } from "@/platform/actions";
import { registerToolWindow, toolWindowService } from "@/workbench/contributions";
import { LogcatView } from "./LogcatView";
import { detachRunLog, followRunLog, resetLogcat, useLogcat, watchDevice } from "./store";

export function activate(): () => void {
  const dispose = registerToolWindow({
    id: "logcat",
    title: "Logcat",
    icon: "toolwindow-logcat",
    anchor: "bottom",
    // Listed under the stripe's "…" until first opened: most projects are not Android ones.
    stripe: "onUse",
    order: 26,
    component: LogcatView,
    // A device can be watched without a project open.
    requiresProject: false,
  });
  const actions = registerActions([
    {
      id: "logcat.detachAndroidRun",
      title: "Detach Android application logs",
      category: "Run",
      hidden: true,
      run: detachRunLog,
    },
    {
      id: "logcat.followAndroidRun",
      title: "Show Android application logs",
      category: "Run",
      hidden: true,
      run: ({ arg }) => {
        if (!arg || typeof arg !== "object") return;
        const t = arg as Record<string, unknown>;
        if (
          typeof t.serial !== "string" ||
          !t.serial ||
          typeof t.applicationId !== "string" ||
          !t.applicationId ||
          typeof t.pid !== "number" ||
          !Number.isSafeInteger(t.pid) ||
          t.pid <= 0 ||
          typeof t.logSince !== "string" ||
          !t.logSince
        )
          return;
        followRunLog(t.serial, { applicationId: t.applicationId, pid: t.pid, logSince: t.logSince });
        toolWindowService().show("logcat");
      },
    },
    {
      id: "logcat.watchDevice",
      title: "Show all processes",
      category: "Run",
      hidden: true,
      run: ({ arg }) => {
        watchDevice(typeof arg === "string" ? arg : useLogcat.getState().serial);
      },
    },
  ]);
  return () => {
    actions();
    dispose();
    resetLogcat();
  };
}
