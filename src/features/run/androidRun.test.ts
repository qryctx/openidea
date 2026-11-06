import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands, type AndroidDevice, type AndroidRunResult, type ProjectInfo } from "@/platform/ipc";
import { initialAndroidVariants, useAndroidVariants } from "@/platform/androidVariants";
import { registerAction } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { ANDROID_VARIANT, useRun } from "./store";
import {
  installAndroidRun,
  refreshAndroidDevices,
  runAndroidVariant,
  selectAndroidDevice,
  useAndroidRun,
} from "./androidRun";

vi.mock("@tauri-apps/api/core", async (orig) => ({
  ...(await orig<typeof import("@tauri-apps/api/core")>()),
  Channel: class {},
}));

const root = "/sample";
const variants = ["demoDebug", "fullDebug"].map((name) => ({ module: ":app", name }));
const device = (serial: string, state = "device"): AndroidDevice => ({
  serial,
  state,
  model: "Pixel",
  product: null,
  device: null,
  transportId: null,
});
const result = (variant: string): AndroidRunResult => ({
  module: ":app",
  variant,
  serial: "usb-A",
  applicationId: "example." + variant,
  pid: 20,
  component: "example/.Main",
  apk: "/sample/out.apk",
  logSince: "123.123",
});
let stop: () => void;
let stopLog: () => void;
let stopDetach: () => void;
const follow = vi.fn();
const detach = vi.fn();
beforeEach(() => {
  vi.restoreAllMocks();
  follow.mockClear();
  detach.mockClear();
  useAndroidVariants.setState(initialAndroidVariants);
  useProject.setState({ project: { root, trusted: true } as ProjectInfo });
  useRun.setState({ selectedId: "gradle", configs: [], loaded: true });
  vi.spyOn(commands, "androidDevices").mockResolvedValue({ status: "ok", data: [device("usb-A")] });
  vi.spyOn(commands, "cancelRequest").mockResolvedValue(undefined);
  stopLog = registerAction({
    id: "logcat.followAndroidRun",
    title: "Logcat",
    run: ({ arg }) => {
      follow(arg);
    },
  });
  stopDetach = registerAction({ id: "logcat.detachAndroidRun", title: "Detach", run: detach });
  stop = installAndroidRun();
});
afterEach(() => {
  stop();
  stopLog();
  stopDetach();
  useAndroidVariants.setState(initialAndroidVariants);
  useProject.setState({ project: null });
  vi.restoreAllMocks();
});
function select(variant: string) {
  useAndroidVariants.setState({
    root,
    trusted: true,
    variants,
    application: ":app",
    selected: variant,
    phase: "ready",
  });
}
it("keeps the physical device across variants and forwards each exact run result to Logcat", async () => {
  const invoke = vi
    .spyOn(commands, "androidRunVariant")
    .mockImplementation(async (_id, _root, _module, name, _serial, channel) => {
      channel.onmessage("installing");
      return { status: "ok", data: result(name) };
    });
  for (const { name } of variants) {
    select(name);
    await vi.waitFor(() => expect(useAndroidRun.getState().serial).toBe("usb-A"));
    expect(useRun.getState().selectedId).toBe(ANDROID_VARIANT);
    await runAndroidVariant();
    expect(invoke).toHaveBeenLastCalledWith(expect.any(Number), root, ":app", name, "usb-A", expect.anything());
    expect(useAndroidRun.getState().phase).toBe("launched");
    expect(follow).toHaveBeenLastCalledWith(result(name));
  }
});
it("requires a choice between devices and never redirects an offline selection", async () => {
  vi.mocked(commands.androidDevices).mockResolvedValue({
    status: "ok",
    data: [device("usb-A"), device("usb-B"), device("emulator-5554")],
  });
  select("demoDebug");
  const invoke = vi.spyOn(commands, "androidRunVariant");
  await refreshAndroidDevices();
  expect(useAndroidRun.getState().devices.map((d) => d.serial)).toEqual(["usb-A", "usb-B"]);
  expect(useAndroidRun.getState().serial).toBeNull();
  await runAndroidVariant();
  expect(invoke).not.toHaveBeenCalled();
  selectAndroidDevice("usb-A");
  vi.mocked(commands.androidDevices).mockResolvedValue({ status: "ok", data: [device("usb-B")] });
  await refreshAndroidDevices();
  expect(useAndroidRun.getState().serial).toBe("usb-A");
  await runAndroidVariant();
  expect(invoke).not.toHaveBeenCalled();
});
it("detaches the launched app on a variant switch, a new Run attempt and project close", async () => {
  const launch = vi.spyOn(commands, "androidRunVariant").mockImplementation(async (_id, _root, _module, variant) => ({
    status: "ok",
    data: result(variant),
  }));
  select("demoDebug");
  await refreshAndroidDevices();
  await runAndroidVariant();
  expect(detach).not.toHaveBeenCalled();
  select("fullDebug");
  expect(detach).toHaveBeenCalledTimes(1);
  await runAndroidVariant();
  launch.mockRejectedValueOnce(new Error("build failed"));
  const retry = runAndroidVariant();
  expect(detach).toHaveBeenCalledTimes(2);
  await retry;
  expect(useAndroidRun.getState().phase).toBe("failed");
  await runAndroidVariant();
  useProject.setState({ project: null });
  useAndroidVariants.setState(initialAndroidVariants);
  expect(detach).toHaveBeenCalledTimes(3);
  expect(useAndroidRun.getState().result).toBeNull();
});
it("ignores a canceled build that completes after the user switches to another variant", async () => {
  let finish!: (v: { status: "ok"; data: AndroidRunResult }) => void;
  const invoke = vi.spyOn(commands, "androidRunVariant").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  select("demoDebug");
  await refreshAndroidDevices();
  const late = runAndroidVariant();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
  select("fullDebug");
  expect(commands.cancelRequest).toHaveBeenCalledWith(invoke.mock.calls[0]![0]);
  finish({ status: "ok", data: result("demoDebug") });
  await late;
  expect(useAndroidRun.getState().result).toBeNull();
  expect(follow).not.toHaveBeenCalled();
});
it("does not select Android Run for an untrusted snapshot", () => {
  useAndroidVariants.setState({
    root,
    trusted: false,
    variants,
    application: ":app",
    selected: "demoDebug",
    phase: "ready",
  });
  expect(useRun.getState().selectedId).toBe("gradle");
  expect(commands.androidDevices).not.toHaveBeenCalled();
});
