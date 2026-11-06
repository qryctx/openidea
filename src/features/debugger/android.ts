import { tx } from "@/platform/i18n";
import type { AndroidDebugTarget } from "@/platform/ipc";
import { KOTLIN_ADAPTER } from "./java";
import { isLive, startSession, stopSession, useDebug } from "./state";

export async function attachAndroid(
  root: string,
  { run, port }: AndroidDebugTarget,
  signal: AbortSignal,
  onAttached: () => void,
) {
  signal.throwIfAborted();
  const id = await startSession(
    {
      name: `${run.module} · ${run.variant}`,
      adapter: KOTLIN_ADAPTER,
      request: "attach",
      program: null,
      args: [],
      cwd: root,
      env: {},
      extraJson: JSON.stringify({
        projectRoot: root,
        hostName: "127.0.0.1",
        port,
        timeout: 30_000,
        openAndroidTarget: { module: run.module, variant: run.variant },
      }),
    },
    { rerunnable: false, attachSignal: signal },
  );
  if (id === null) {
    signal.throwIfAborted();
    throw new Error(tx("Could not attach the Android debugger"));
  }
  // A breakpoint can already be hit when debugStart returns. Keep the same session and execution point.
  if (!isLive(useDebug.getState().sessions[id])) return;
  onAttached();
  await new Promise<void>((resolve) => {
    const off = useDebug.subscribe((state) => {
      if (!isLive(state.sessions[id])) finish();
    });
    function finish() {
      off();
      signal.removeEventListener("abort", abort);
      resolve();
    }
    const abort = () => {
      void stopSession(id).finally(finish);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
