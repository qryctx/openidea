import { webcrypto, createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CaretContext } from "./ipc";

const api = vi.hoisted(() => ({
  androidDiscoverVariants: vi.fn(),
  androidIndexVariant: vi.fn(),
  fsReadDir: vi.fn(),
  fsReadText: vi.fn(),
  cancelRequest: vi.fn(),
}));
vi.mock("@/platform/ipc", async (orig) => ({
  ...(await orig<typeof import("@/platform/ipc")>()),
  commands: api,
  isTauri: () => true,
}));
vi.mock("@/platform/remote", () => ({ isRemoteWindow: () => false }));
import {
  androidFilesChanged,
  cancelAndroidSync,
  discoverAndroidVariants,
  selectAndroidVariant,
  selectedAndroidUsages,
  useAndroidVariants,
} from "./androidVariants";
import { moduleIndexPath } from "./androidIndex";

const root = "/fixture";
const demo = { module: ":app", name: "demoDebug" };
const full = { module: ":app", name: "fullDebug" };
const caret: CaretContext = { path: root + "/A.java", line: 0, col: 1, doc: 2, word: "A", view: null };
const ok = <T>(data: T) => ({ status: "ok", data });
function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  api.androidDiscoverVariants.mockResolvedValue(ok([demo, full]));
  api.androidIndexVariant.mockImplementation(async (_request, _root, module: string, variant: string) =>
    ok(moduleIndexPath(module, variant)),
  );
  api.cancelRequest.mockResolvedValue(ok(null));
  api.fsReadDir.mockResolvedValue(ok([{ name: "demoDebug.json", kind: "file" }]));
});
afterEach(async () => {
  await discoverAndroidVariants(null, false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("opens a clean trusted project and only generates the chosen application's index", async () => {
  await discoverAndroidVariants(root, true);
  expect(useAndroidVariants.getState().variants).toEqual([demo, full]);
  expect(api.androidIndexVariant).toHaveBeenCalledWith(expect.any(Number), root, demo.module, demo.name);
  expect(api.fsReadDir).not.toHaveBeenCalled();
  await selectAndroidVariant("demoDebug");
  expect(api.androidIndexVariant).toHaveBeenCalledWith(expect.any(Number), root, demo.module, demo.name);
  expect(useAndroidVariants.getState()).toMatchObject({
    selected: demo.name,
    application: demo.module,
    phase: "ready",
  });
});

it("keeps identical variant names in separate application modules", async () => {
  const second = { module: ":apps:second", name: "demoDebug" };
  api.androidDiscoverVariants.mockResolvedValue(ok([demo, second]));
  await discoverAndroidVariants(root, true);
  await selectAndroidVariant("demoDebug");
  expect(api.androidIndexVariant).not.toHaveBeenCalled();
  await selectAndroidVariant(second);
  expect(api.androidIndexVariant).toHaveBeenCalledWith(expect.any(Number), root, second.module, second.name);
  api.androidIndexVariant.mockResolvedValueOnce(ok(moduleIndexPath(demo.module, demo.name)));
  await selectAndroidVariant(second);
  expect(useAndroidVariants.getState().phase).toBe("failed");
});

it("stops an old index and will not publish or query it after a fast switch", async () => {
  await discoverAndroidVariants(root, true);
  api.androidIndexVariant.mockClear();
  const deferredDemo = deferred<ReturnType<typeof ok<string>>>();
  api.androidIndexVariant.mockImplementationOnce(() => deferredDemo.promise);
  const old = selectAndroidVariant(demo);
  await Promise.resolve();
  const oldId = api.androidIndexVariant.mock.calls[0]![0];
  const query = selectedAndroidUsages(caret);
  await selectAndroidVariant(full);
  deferredDemo.resolve(ok(moduleIndexPath(demo.module, demo.name)));
  await old;
  await expect(query).rejects.toMatchObject({ kind: "cancelled" });
  expect(api.cancelRequest).toHaveBeenCalledWith(oldId);
  expect(useAndroidVariants.getState()).toMatchObject({ selected: full.name, phase: "ready" });
  expect(api.fsReadText).not.toHaveBeenCalled();
});

it("waits for generation, exposes failure rather than reading stale data, and retries", async () => {
  await discoverAndroidVariants(root, true);
  const build = deferred<{ status: "error"; error: { kind: "internal"; message: string } }>();
  api.androidIndexVariant.mockImplementationOnce(() => build.promise);
  const gen = selectAndroidVariant(demo);
  const query = selectedAndroidUsages(caret);
  expect(api.fsReadText).not.toHaveBeenCalled();
  build.resolve({ status: "error", error: { kind: "internal", message: "Gradle could not configure :app" } });
  await expect(query).rejects.toThrow(/configure :app/);
  await gen;
  expect(api.fsReadText).not.toHaveBeenCalled();
  expect(useAndroidVariants.getState()).toMatchObject({ phase: "failed", selected: demo.name });
  await discoverAndroidVariants(root, true);
  expect(useAndroidVariants.getState()).toMatchObject({ phase: "ready", selected: demo.name });
});

it("restricted projects consume only legacy snapshots, even if trusted discovery was already in flight", async () => {
  const discovery = deferred<ReturnType<typeof ok<(typeof demo)[]>>>();
  api.androidDiscoverVariants.mockImplementationOnce(() => discovery.promise);
  const original = discoverAndroidVariants(root, true);
  await Promise.resolve();
  await discoverAndroidVariants(root, false);
  discovery.resolve(ok([demo, full]));
  await original;
  expect(useAndroidVariants.getState().variants).toEqual([{ module: null, name: demo.name }]);
  await selectAndroidVariant(demo.name);
  androidFilesChanged([root + "/build.gradle.kts"]);
  expect(useAndroidVariants.getState()).toMatchObject({ phase: "ready", trusted: false, application: null });
  expect(api.androidDiscoverVariants).toHaveBeenCalledTimes(1);
  expect(api.androidIndexVariant).not.toHaveBeenCalled();
});

it("coalesces saved or newly created sources, ignores generated files and rediscovers edited models", async () => {
  vi.useFakeTimers();
  await discoverAndroidVariants(root, true);
  await selectAndroidVariant(demo);
  androidFilesChanged([root + "/app/build/generated/A.java", root + "/.gradle/tasks/build.gradle"]);
  expect(useAndroidVariants.getState().phase).toBe("ready");
  androidFilesChanged([root + "/contract/src/main/kotlin/New.kt"]);
  androidFilesChanged([root + "/app/src/main/java/A.java"]);
  expect(useAndroidVariants.getState().phase).toBe("stale");
  await vi.advanceTimersByTimeAsync(700);
  expect(api.androidDiscoverVariants).toHaveBeenCalledTimes(1);
  expect(api.androidIndexVariant).toHaveBeenCalledTimes(3);
  api.androidDiscoverVariants.mockResolvedValueOnce(ok([full]));
  androidFilesChanged([root + "/settings.gradle.kts"]);
  androidFilesChanged([root + "/app/src/main/java/A.java"]);
  await vi.advanceTimersByTimeAsync(700);
  expect(api.androidDiscoverVariants).toHaveBeenCalledTimes(2);
  expect(api.androidIndexVariant).toHaveBeenCalledTimes(3);
  await expect(selectedAndroidUsages(caret)).rejects.toThrow(/no longer available/);
});

it("uses a prepared module snapshot in restricted mode without invoking Gradle", async () => {
  api.fsReadDir.mockImplementation(async (p: string) =>
    ok(
      p.endsWith("/3a617070")
        ? [{ kind: "file", name: "demoDebug.json" }]
        : [
            { kind: "dir", name: "3a617070" },
            { kind: "file", name: "demoDebug.json" },
            { kind: "symlink", name: "3a626164" },
          ],
    ),
  );
  await discoverAndroidVariants(root, false);
  expect(useAndroidVariants.getState().variants).toEqual([demo]);
  await selectAndroidVariant(demo);
  expect(useAndroidVariants.getState()).toMatchObject({ phase: "ready", trusted: false, application: ":app" });
  expect(api.androidDiscoverVariants).not.toHaveBeenCalled();
  expect(api.androidIndexVariant).not.toHaveBeenCalled();
});

it("cancels a pending generation and does not restore an old successful result", async () => {
  await discoverAndroidVariants(root, true);
  const build = deferred<ReturnType<typeof ok<string>>>();
  api.androidIndexVariant.mockImplementationOnce(() => build.promise);
  const pending = selectAndroidVariant(demo);
  await Promise.resolve();
  cancelAndroidSync();
  build.resolve(ok(moduleIndexPath(demo.module, demo.name)));
  await pending;
  expect(useAndroidVariants.getState().phase).toBe("failed");
  await expect(selectedAndroidUsages(caret)).rejects.toThrow(/cancelled/);
  expect(api.fsReadText).not.toHaveBeenCalled();
});

it("a missed change to a saved source refreshes the selected variant once and re-runs Find Usages", async () => {
  vi.stubGlobal("crypto", webcrypto);
  await discoverAndroidVariants(root, true);
  await selectAndroidVariant(demo);
  const file = "A.java";
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } };
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  api.fsReadText.mockImplementation(async (p: string) => {
    if (p === root + "/" + moduleIndexPath(demo.module, demo.name))
      return ok(
        JSON.stringify({
          schema: 1,
          variant: demo.name,
          application: demo.module,
          files: { [file]: hash(api.androidIndexVariant.mock.calls.length > 1 ? "AA" : "old") },
          declarations: [{ symbol: "sample.AA", path: file, range }],
          references: [],
        }),
      );
    return ok("AA");
  });
  expect(await selectedAndroidUsages(caret)).toMatchObject({
    locations: [],
    note: "Android constructor usages · demoDebug",
  });
  expect(api.androidIndexVariant).toHaveBeenCalledTimes(2);
});

it("restores the selected Android variant after reopening the project", async () => {
  await discoverAndroidVariants(root, true);
  await selectAndroidVariant(full);
  await discoverAndroidVariants(null, false);
  await discoverAndroidVariants(root, true);
  expect(useAndroidVariants.getState()).toMatchObject({
    application: full.module,
    selected: full.name,
    phase: "ready",
  });
});

it("does not silently switch flavors when the saved variant disappears", async () => {
  await discoverAndroidVariants(root, true);
  await selectAndroidVariant(full);
  await discoverAndroidVariants(null, false);
  api.androidDiscoverVariants.mockResolvedValue(ok([demo]));
  await discoverAndroidVariants(root, true);
  expect(useAndroidVariants.getState()).toMatchObject({ phase: "failed" });
});
