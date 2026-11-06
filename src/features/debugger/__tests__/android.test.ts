import { beforeEach, expect, it, vi } from "vitest";
import type { AndroidDebugTarget, ProjectInfo } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import {
  provideNotificationService,
  provideToolWindowService,
  type ToolWindowService,
} from "@/workbench/contributions";
import { attachAndroid } from "../android";
import { handleDebugEvent, useDebug } from "../state";
import { useBreakpoints } from "../breakpoints/store";
const ipc = vi.hoisted(() => ({
  debugStart: vi.fn(async () => ({ status: "ok", data: 42 })),
  debugStop: vi.fn(async () => ({ status: "ok", data: null })),
  debugCapabilities: vi.fn(async () => ({ status: "ok", data: {} })),
  debugExceptionFilters: vi.fn(async () => ({ status: "ok", data: [] })),
}));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});
const target: AndroidDebugTarget = {
  run: {
    module: ":app",
    variant: "demoDebug",
    serial: "phone",
    applicationId: "dev.sample.demo",
    pid: 100,
    component: "dev.sample/.Main",
    apk: "app.apk",
    logSince: "123.000",
  },
  port: 51000,
};
beforeEach(() => {
  vi.clearAllMocks();
  useBreakpoints.setState({ root: "/p", byFile: {}, muted: false, status: {} });
  useProject.setState({ project: { root: "/p", trusted: true } as ProjectInfo });
  useDebug.setState({ sessions: {}, active: null, console: {} });
  provideToolWindowService({ show: vi.fn() } as unknown as ToolWindowService);
  provideNotificationService({ notify: vi.fn() });
});
it("targets the forwarded port and chosen variant until the debugger terminates", async () => {
  const attached = vi.fn();
  const work = attachAndroid("/p", target, new AbortController().signal, attached);
  await vi.waitFor(() => expect(attached).toHaveBeenCalledOnce());
  const session = useDebug.getState().sessions[42]!;
  expect(session.launch).toBeNull(); // A new Debug needs a fresh device forward.
  expect(ipc.debugStart).toHaveBeenCalledWith(
    expect.objectContaining({
      adapter: "kotlin-debug-adapter",
      request: "attach",
      extraJson: JSON.stringify({
        projectRoot: "/p",
        hostName: "127.0.0.1",
        port: 51000,
        timeout: 30000,
        openAndroidTarget: { module: ":app", variant: "demoDebug" },
      }),
    }),
  );
  handleDebugEvent(42, { kind: "terminated" });
  await work;
  expect(ipc.debugStop).not.toHaveBeenCalled();
});
it("stops a late debugger if the target changes before the adapter connects", async () => {
  const abort = new AbortController();
  const attached = vi.fn();
  let ready!: () => void;
  ipc.debugStart.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      ready = resolve;
    });
    return { status: "ok", data: 43 };
  });
  const work = attachAndroid("/p", target, abort.signal, attached);
  await vi.waitFor(() => expect(ipc.debugStart).toHaveBeenCalledOnce());
  abort.abort();
  ready();
  await expect(work).rejects.toThrow();
  expect(ipc.debugStop).toHaveBeenCalledWith(43);
  expect(attached).not.toHaveBeenCalled();
});
