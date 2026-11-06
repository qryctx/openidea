import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import { executeAction } from "@/platform/actions";
import { androidRunTarget, useAndroidVariants } from "@/platform/androidVariants";
import { tx } from "@/platform/i18n";
import {
  call,
  commands,
  nextRequestId,
  isCancelled,
  type AndroidDebugTarget,
  type AndroidDevice,
  type AndroidRunResult,
  type AndroidRunStage,
} from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { maybeEditorService, notifications, useDebugRunSessions } from "@/workbench/contributions";
import { ANDROID_VARIANT, loadConfigs, useRun } from "./store";

type Phase = "idle" | AndroidRunStage | "launched" | "attaching" | "debugging" | "failed";
interface State {
  devices: AndroidDevice[];
  serial: string | null;
  devicesError: string | null;
  phase: Phase;
  mode: "run" | "debug";
  error: string | null;
  result: AndroidRunResult | null;
}
const initial: State = {
  devices: [],
  serial: null,
  devicesError: null,
  phase: "idle",
  mode: "run",
  error: null,
  result: null,
};
export const useAndroidRun = create<State>(() => initial);
let deviceRevision = 0;
let request: ReturnType<typeof nextRequestId> | null = null;
let debugAbort: AbortController | null = null;
let previousDebug: Promise<void> | null = null;

export function cancelAndroidRun() {
  debugAbort?.abort();
  debugAbort = null;
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

type Target = NonNullable<ReturnType<typeof androidRunTarget>>;

function checkResult(run: AndroidRunResult, target: Target, serial: string) {
  if (run.serial !== serial || run.module !== target.module || run.variant !== target.variant || run.pid <= 0)
    throw new Error(tx("Android Run returned a different target"));
}

// Saving an edited source can invalidate an index that was ready when the user clicked Debug.
async function waitForIndex(signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const off = useAndroidVariants.subscribe(check);
    function finish(error?: Error) {
      off();
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    }
    function abort() {
      finish(new Error(tx("Android project changed")));
    }
    function check() {
      const { phase, error } = useAndroidVariants.getState();
      if (phase === "ready") finish();
      else if (phase === "failed" || phase === "idle") finish(new Error(error ?? tx("Android project sync failed")));
    }
    signal.addEventListener("abort", abort, { once: true });
    check();
  });
}

async function debugOnDevice(
  id: ReturnType<typeof nextRequestId>,
  target: Target,
  serial: string,
  stages: Channel<AndroidRunStage>,
  abort: AbortController,
) {
  const attach = useDebugRunSessions.getState().attachAndroid;
  if (!attach) throw new Error(tx("Debugger is not available"));
  await waitForIndex(abort.signal);
  abort.signal.throwIfAborted();

  const next = new Channel<AndroidDebugTarget>();
  let attachment: Promise<void> | undefined;
  let attachError: unknown;
  next.onmessage = (ready) => {
    if (request !== id || attachment || abort.signal.aborted) return;
    attachment = (async () => {
      checkResult(ready.run, target, serial);
      useAndroidRun.setState({ phase: "attaching", result: ready.run });
      await executeAction("logcat.followAndroidRun", ready.run);
      await attach(target.root, ready, abort.signal, () => {
        if (request === id) useAndroidRun.setState({ phase: "debugging" });
      });
    })()
      .catch((error: unknown) => {
        attachError = error;
      })
      .finally(() => {
        if (!abort.signal.aborted) void commands.cancelRequest(id).catch(() => {});
      });
  };
  let nativeError: unknown;
  try {
    // The native request owns the forwarding rule for the lifetime of the DAP session.
    await call(commands.androidDebugVariant(id, target.root, target.module, target.variant, serial, stages, next));
  } catch (error) {
    nativeError = error;
  }
  abort.abort();
  await attachment;
  if (nativeError && !isCancelled(nativeError)) throw nativeError;
  if (attachError) throw attachError;
  if (!attachment) throw new Error(tx("Could not attach the Android debugger"));
}

export async function runAndroidVariant(mode: "run" | "debug" = "run") {
  if (request !== null) return;
  const target = androidRunTarget(useAndroidVariants.getState());
  const project = useProject.getState().project;
  if (!target || !project?.trusted || project.root !== target.root) return;
  cancelAndroidRun();
  const { serial, devices } = useAndroidRun.getState();
  if (!serial || !devices.some((d) => d.serial === serial && d.state === "device")) {
    useAndroidRun.setState({ mode, phase: "failed", error: tx("Select an online Android device") });
    void refreshAndroidDevices();
    return;
  }
  const id = nextRequestId();
  request = id;
  useAndroidRun.setState({ mode, phase: "building", error: null, result: null });
  try {
    await previousDebug;
    if (request !== id) return;
    await maybeEditorService()?.saveAll();
    if (request !== id) return;
    const stages = new Channel<AndroidRunStage>();
    stages.onmessage = (phase) => {
      if (request === id) useAndroidRun.setState({ phase });
    };
    if (mode === "debug") {
      debugAbort = new AbortController();
      const work = debugOnDevice(id, target, serial, stages, debugAbort);
      previousDebug = work.catch(() => {});
      await work;
      if (request === id) {
        request = null;
        cancelAndroidRun();
      }
    } else {
      const result = await call(
        commands.androidRunVariant(id, target.root, target.module, target.variant, serial, stages),
      );
      if (request !== id) return;
      checkResult(result, target, serial);
      useAndroidRun.setState({ phase: "launched", result });
      await executeAction("logcat.followAndroidRun", result);
    }
  } catch (error) {
    if (request !== id) return;
    const message = error instanceof Error ? error.message : String(error);
    if (useAndroidRun.getState().result) void executeAction("logcat.detachAndroidRun");
    useAndroidRun.setState({ phase: "failed", error: message, result: null });
    notifications().notify({
      group: "run",
      level: "error",
      title: mode === "debug" ? "Android Debug failed" : "Android Run failed",
      body: message,
      key: "android-run-failed",
    });
  } finally {
    if (request === id) {
      request = null;
      debugAbort = null;
    }
  }
}

export function androidBusy(phase: Phase) {
  return (
    phase === "building" ||
    phase === "installing" ||
    phase === "launching" ||
    phase === "attaching" ||
    phase === "debugging"
  );
}
