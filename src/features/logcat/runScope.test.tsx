import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { commands, type LogcatLine } from "@/platform/ipc";
import { LogcatView } from "./LogcatView";
import { detachRunLog, followRunLog, resetLogcat, setDevices, setPaused, useLogcat, watchDevice } from "./store";

vi.mock("@tauri-apps/api/core", async (orig) => ({
  ...(await orig<typeof import("@tauri-apps/api/core")>()),
  Channel: class {},
}));

afterEach(() => {
  resetLogcat();
  vi.restoreAllMocks();
});
it("replaces the device's old process stream and late paused rows when another flavor launches", async () => {
  vi.spyOn(commands, "androidDevices").mockResolvedValue({
    status: "ok",
    data: [{ serial: "usb", state: "device", model: "phone", product: null, device: null, transportId: null }],
  });
  vi.spyOn(commands, "cancelRequest").mockResolvedValue(undefined);
  const stream = vi.spyOn(commands, "androidLogcat").mockImplementation(() => new Promise(() => {}));
  followRunLog("usb", { pid: 101, applicationId: "example.demo", logSince: "100.001" });
  const view = render(<LogcatView />);
  await waitFor(() => expect(stream).toHaveBeenCalledTimes(1));
  const first = stream.mock.calls[0]!;
  expect(first.slice(1, 5)).toEqual(["usb", false, 101, "100.001"]);
  const row: LogcatLine = {
    time: "01-01 00:00:01.000",
    pid: 101,
    tid: 101,
    level: "info",
    tag: "App",
    message: "demo",
  };
  act(() => {
    setPaused(true);
    first[5].onmessage([row]);
    followRunLog("usb", { pid: 202, applicationId: "example.full", logSince: "101.002" });
  });
  await waitFor(() => expect(stream).toHaveBeenCalledTimes(2));
  expect(commands.cancelRequest).toHaveBeenCalledWith(first[0]);
  const second = stream.mock.calls[1]!;
  expect(second.slice(1, 5)).toEqual(["usb", false, 202, "101.002"]);
  act(() => {
    first[5].onmessage([row]);
    second[5].onmessage([{ ...row, pid: 202, message: "full" }]);
    setPaused(false);
  });
  expect(screen.getByText(/example.full · PID 202/)).toBeTruthy();
  expect(useLogcat.getState().lines.map((r) => r.message)).toEqual(["full"]);
  view.unmount();
  expect(commands.cancelRequest).toHaveBeenCalledWith(second[0]);
});
it("stops a detached Run without opening all processes and leaves an explicit manual stream alone", async () => {
  const devices = [{ serial: "usb", state: "device", model: "phone", product: null, device: null, transportId: null }];
  vi.spyOn(commands, "androidDevices").mockResolvedValue({ status: "ok", data: devices });
  vi.spyOn(commands, "cancelRequest").mockResolvedValue(undefined);
  const stream = vi.spyOn(commands, "androidLogcat").mockImplementation(() => new Promise(() => {}));
  followRunLog("usb", { pid: 101, applicationId: "example.demo", logSince: "100.001" });
  const view = render(<LogcatView />);
  await waitFor(() => expect(stream).toHaveBeenCalledTimes(1));
  const first = stream.mock.calls[0]!;
  const row: LogcatLine = {
    time: "01-01 00:00:01.000",
    pid: 101,
    tid: 101,
    level: "info",
    tag: "App",
    message: "demo",
  };
  act(() => {
    first[5].onmessage([row]);
    setPaused(true);
    first[5].onmessage([row]);
    detachRunLog();
    first[5].onmessage([row]);
    setDevices(devices);
    setPaused(false);
  });
  expect(commands.cancelRequest).toHaveBeenCalledWith(first[0]);
  expect(useLogcat.getState()).toMatchObject({ serial: null, scope: null, lines: [], status: "idle" });
  expect(stream).toHaveBeenCalledTimes(1);
  act(() => watchDevice("usb"));
  await waitFor(() => expect(stream).toHaveBeenCalledTimes(2));
  const manual = stream.mock.calls[1]!;
  expect(manual.slice(1, 5)).toEqual(["usb", false, null, null]);
  act(() => {
    manual[5].onmessage([row]);
    detachRunLog();
  });
  expect(commands.cancelRequest).not.toHaveBeenCalledWith(manual[0]);
  expect(useLogcat.getState().lines).toHaveLength(1);
  view.unmount();
});
