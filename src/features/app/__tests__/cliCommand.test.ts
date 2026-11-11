import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getContext } from "@/platform/context";
import { provideNotificationService } from "@/workbench/contributions";

const { install, uninstall, notify } = vi.hoisted(() => ({ install: vi.fn(), uninstall: vi.fn(), notify: vi.fn() }));
vi.mock("@/platform/ipc", () => ({
  call: (result: Promise<unknown>) => result,
  commands: { appCliInstall: install, appCliUninstall: uninstall },
  isCancelled: (error: unknown) => (error as { kind?: string })?.kind === "cancelled",
}));

const { cliActions } = await import("../cliCommand");
const run = (id: string) =>
  cliActions()
    .find((action) => action.id === id)!
    .run({ ctx: getContext() });

beforeEach(() => {
  vi.resetAllMocks();
  provideNotificationService({ notify, expire: () => {} });
});

afterEach(() => vi.unstubAllEnvs());

it("labels the isolated v0 command without changing the stable action ids", async () => {
  vi.stubEnv("VITE_OPENIDEA_PROFILE", "v0");
  expect(cliActions().find((action) => action.id === "app.installCli")!.title).toBe("Install 'openidea-v0' Command");
  install.mockResolvedValue({ path: "C:/v0/bin/openidea-v0.cmd", pathDirectory: null });
  await run("app.installCli");
  expect(notify).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "The openidea-v0 command is installed",
      body: expect.stringContaining("use the openidea-v0 command"),
    }),
  );
  uninstall.mockResolvedValue([]);
  await run("app.uninstallCli");
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "The openidea-v0 command is not installed" }));
});

it("explains the Linux PATH step when the user bin is missing from PATH", async () => {
  install.mockResolvedValue({ path: "/home/user/.local/bin/openidea", pathDirectory: "/home/user/.local/bin" });
  await run("app.installCli");
  expect(notify).toHaveBeenCalledWith(
    expect.objectContaining({
      level: "info",
      body: expect.stringContaining("Add /home/user/.local/bin to the beginning of PATH"),
    }),
  );
});

it("tells users to open a new terminal after installation", async () => {
  install.mockResolvedValue({ path: "C:/Users/user/OpenIDEA/bin/openidea.cmd", pathDirectory: null });
  await run("app.installCli");
  expect(notify).toHaveBeenCalledWith(
    expect.objectContaining({ body: expect.stringContaining("Open a new terminal") }),
  );
});

it("reports an absent command on repeated uninstall", async () => {
  uninstall.mockResolvedValue([]);
  await run("app.uninstallCli");
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "The openidea command is not installed" }));
});

it("reports an install failure and stays quiet when an administrator prompt is cancelled", async () => {
  install.mockRejectedValueOnce(new Error("foreign command"));
  await run("app.installCli");
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ level: "error", body: "foreign command" }));
  notify.mockClear();
  install.mockRejectedValueOnce({ kind: "cancelled" });
  await run("app.installCli");
  expect(notify).not.toHaveBeenCalled();
});
