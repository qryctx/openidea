import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import { executeAction } from "@/platform/actions";
import { androidRunTarget, useAndroidVariants } from "@/platform/androidVariants";
import { tx } from "@/platform/i18n";
import {
  call,
  commands,
  nextRequestId,
  type AndroidDevice,
  type AndroidRunResult,
  type AndroidRunStage,
} from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { maybeEditorService, notifications } from "@/workbench/contributions";
import { ANDROID_VARIANT, loadConfigs, useRun } from "./store";

type Phase = "idle" | AndroidRunStage | "launched" | "failed";
interface State {
  devices: AndroidDevice[];
  serial: string | null;
  devicesError: string | null;
  phase: Phase;
  error: string | null;
  result: AndroidRunResult | null;
}
const initial: State = { devices: [], serial: null, devicesError: null, phase: "idle", error: null, result: null };
export const useAndroidRun = create<State>(() => initial);
let deviceRevision = 0;
let request: ReturnType<typeof nextRequestId> | null = null;

export function cancelAndroidRun() {
  if (request !== null) void commands.cancelRequest(request).catch(() => {});
  request = null;
  if (useAndroidRun.getState().result) void executeAction("logcat.detachAndroidRun");
  useAndroidRun.setState({ phase: "idle", error: null, result: null });
}

export async function refreshAndroidDevices() {
  const rev = ++deviceRevision;
  try {
    const devices = (await call(commands.androidDevices())).filter((d) => !d.serial.startsWith("emulator-"));
    if (rev !== deviceRevision) return;
    const online = devices.filter((d) => d.state === "device");
    const current = useAndroidRun.getState().serial;
    useAndroidRun.setState({
      devices,
      devicesError: null,
      serial: current ?? (online.length === 1 ? online[0]!.serial : null),
    });
  } catch (e) {
    if (rev === deviceRevision)
      useAndroidRun.setState({ devices: [], devicesError: e instanceof Error ? e.message : String(e) });
  }
}
export function selectAndroidDevice(arg: unknown) {
  if (
    typeof arg !== "string" ||
    !useAndroidRun.getState().devices.some((d) => d.serial === arg && d.state === "device")
  )
    return;
  if (useAndroidRun.getState().serial !== arg) cancelAndroidRun();
  useAndroidRun.setState({ serial: arg });
}

/** Selection in the Android picker makes the toolbar and its normal Run shortcut follow that variant. */
export function installAndroidRun() {
  const switchTarget = (
    current: ReturnType<typeof androidRunTarget>,
    previous: ReturnType<typeof androidRunTarget>,
  ) => {
    if (
      current?.root === previous?.root &&
      current?.module === previous?.module &&
      current?.variant === previous?.variant
    )
      return;
    cancelAndroidRun();
    if (!current || current.root !== previous?.root) {
      ++deviceRevision;
      useAndroidRun.setState(initial);
    }
    if (current) {
      useRun.setState({ selectedId: ANDROID_VARIANT });
      void refreshAndroidDevices();
    } else if (useRun.getState().selectedId === ANDROID_VARIANT) {
      useRun.setState({ selectedId: null });
      void loadConfigs();
    }
  };
  switchTarget(androidRunTarget(useAndroidVariants.getState()), null);
  const off = useAndroidVariants.subscribe((s, prev) => switchTarget(androidRunTarget(s), androidRunTarget(prev)));
  return () => {
    off();
    ++deviceRevision;
    cancelAndroidRun();
    useAndroidRun.setState(initial);
  };
}

export async function runAndroidVariant() {
  if (request !== null) return;
  const target = androidRunTarget(useAndroidVariants.getState());
  const project = useProject.getState().project;
  if (!target || !project?.trusted || project.root !== target.root) return;
  cancelAndroidRun();
  const { serial, devices } = useAndroidRun.getState();
  if (!serial || !devices.some((d) => d.serial === serial && d.state === "device")) {
    useAndroidRun.setState({ phase: "failed", error: tx("Select an online Android device") });
    void refreshAndroidDevices();
    return;
  }
  const id = nextRequestId();
  request = id;
  useAndroidRun.setState({ phase: "building", error: null, result: null });
  try {
    await maybeEditorService()?.saveAll();
    if (request !== id) return;
    const stages = new Channel<AndroidRunStage>();
    stages.onmessage = (phase) => {
      if (request === id) useAndroidRun.setState({ phase });
    };
    const result = await call(
      commands.androidRunVariant(id, target.root, target.module, target.variant, serial, stages),
    );
    if (request !== id) return;
    if (
      result.serial !== serial ||
      result.module !== target.module ||
      result.variant !== target.variant ||
      result.pid <= 0
    )
      throw new Error(tx("Android Run returned a different target"));
    useAndroidRun.setState({ phase: "launched", result });
    await executeAction("logcat.followAndroidRun", result);
  } catch (error) {
    if (request !== id) return;
    const message = error instanceof Error ? error.message : String(error);
    useAndroidRun.setState({ phase: "failed", error: message, result: null });
    notifications().notify({
      group: "run",
      level: "error",
      title: "Android Run failed",
      body: message,
      key: "android-run-failed",
    });
  } finally {
    if (request === id) request = null;
  }
}

export function androidBusy(phase: Phase) {
  return phase === "building" || phase === "installing" || phase === "launching";
}
