// Run against pnpm dev:app; this driver opens a fresh copy without pre-generated indices. Node 22.18+ (global WebSocket).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const sample = "examples/android-variants";
const fixture = await mkdtemp(join(await realpath(tmpdir()), "android-variants-"));
const files = execFileSync("git", ["ls-files", "-z", "--", sample], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
for (const file of files) {
  const destination = join(fixture, relative(sample, file));
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(root, file), destination);
}
await chmod(join(fixture, "gradlew"), 0o755);
const indexRoot = join(fixture, "build", "openandroidstudio", "variants");
const missing = async (p) => assert.rejects(access(p), { code: "ENOENT" });
await missing(indexRoot);
console.log("Opening clean sample", fixture);

const oracle = JSON.parse(await readFile(join(fixture, "expected-usages.json"), "utf8"));
const deviceRun = process.argv.includes("--device-run");
const deviceDebug = process.argv.includes("--device-debug");
assert.ok(!(deviceRun && deviceDebug), "Choose a single verification mode");
const out =
  process.argv.slice(2).find((arg) => !arg.startsWith("--")) ??
  (await mkdtemp(join(tmpdir(), "openidea-android-desktop-")));
await mkdir(out, { recursive: true });

async function until(read, description, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await read();
    if (value) return value;
    await sleep(150);
  }
  throw new Error("Timed out waiting for " + description);
}

// Use the same discovery and worktree identity filter as pnpm dev:status.
const status = JSON.parse(execFileSync(process.execPath, ["scripts/dev-status.ts"], { cwd: root, encoding: "utf8" }));
assert.equal(await realpath(status.worktree), root);
assert.equal(status.bridges.length, 1, "Start pnpm dev:app in this checkout");
const { port } = status.bridges[0];
const socket = new WebSocket("ws://127.0.0.1:" + port);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let seq = 0;
function rpc(command, args = {}) {
  const id = "android-desktop-" + ++seq;
  return new Promise((resolve, reject) => {
    function finish(error, value) {
      clearTimeout(timer);
      socket.removeEventListener("message", listener);
      socket.removeEventListener("close", closed);
      if (error) reject(error);
      else resolve(value);
    }
    const closed = () => finish(new Error("Desktop bridge disconnected"));
    const timer = setTimeout(() => finish(new Error("Timed out calling " + command)), 45000);
    const listener = ({ data }) => {
      const reply = JSON.parse(String(data));
      if (reply.id === id) finish(reply.success ? null : new Error(reply.error), reply.data);
    };
    socket.addEventListener("message", listener);
    socket.addEventListener("close", closed);
    socket.send(JSON.stringify({ id, command, args }));
  });
}
const backend = () => rpc("invoke_tauri", { command: "plugin:mcp-bridge|get_backend_state" });
let windowLabel;
const js = (script) => rpc("execute_js", { script, windowLabel });

async function fixtureWindow() {
  const state = await until(async () => {
    const snapshot = await backend();
    return snapshot.windows.some((w) => w.label === "main" || w.title.includes(basename(fixture))) ? snapshot : null;
  }, "the isolated development app's project window");
  assert.equal(state.app.identifier, status.identifier);
  const open = state.windows.find((w) => w.title.includes(basename(fixture)));
  const main = state.windows.find((w) => w.label === "main");
  windowLabel = open?.label ?? main?.label;
  assert.ok(windowLabel, "Expected the isolated development app's project window");
  if (!open) {
    await js(`
      const { useProject } = await import("/src/platform/project.ts");
      const { openProjectInWindow } = await import("/src/features/app/windows.ts");
      const target = ${JSON.stringify(fixture)};
      const existing = useProject.getState().project?.root;
      const pending = [...document.querySelectorAll('[role="dialog"] [title]')].some((e) => e.title === target);
      if (existing !== target && !pending) void openProjectInWindow(target, Boolean(existing));
    `);
  }
  const origin = windowLabel;
  const originalWindows = new Set(state.windows.map((w) => w.label));
  return until(async () => {
    const next = await backend();
    for (const { label } of next.windows) {
      if (label !== origin && originalWindows.has(label)) continue;
      const ready = await rpc("execute_js", {
        windowLabel: label,
        script: `
          const { useProject } = await import("/src/platform/project.ts");
          const { tx } = await import("/src/platform/i18n.ts");
          const target = ${JSON.stringify(fixture)};
          const dialog = [...document.querySelectorAll('[role="dialog"]')].find(
            (d) => [...d.querySelectorAll("[title]")].some((e) => e.title === target));
          if (dialog) {
            if (dialog.querySelector('input[type="checkbox"]:checked'))
              throw new Error("Refusing to trust a parent folder");
            const preview = [...dialog.querySelectorAll("button")].find(
              (b) => b.textContent.trim() === tx("Preview in Restricted Mode"));
            preview?.click();
          }
          return useProject.getState().project?.root === target;
        `,
      });
      if (ready) return label;
    }
    return null;
  }, "the fresh fixture in its project window");
}

async function trustFixture() {
  await js(`
    const { useProject } = await import("/src/platform/project.ts");
    const { tx } = await import("/src/platform/i18n.ts");
    const project = useProject.getState().project;
    if (project?.root !== ${JSON.stringify(fixture)}) throw new Error("Unexpected project root");
    if (!project.trusted) {
      if (document.querySelector('[role="dialog"]')) throw new Error("Unexpected open dialog");
      const trust = [...document.querySelectorAll('[role="status"] button')].find(
        (b) => b.textContent.trim() === tx("Trust Project"));
      if (!trust) throw new Error("Missing trust banner for the fixture");
      trust.click();
    }
  `);
  await until(
    () =>
      js(`
    const { useProject } = await import("/src/platform/project.ts");
    const project = useProject.getState().project;
    return project?.root === ${JSON.stringify(fixture)} && project.trusted === true;
  `),
    "trusting only the fixture project",
  );
}

async function syncStatus() {
  return js(`
    const button = document.querySelector("button[data-android-phase]");
    return button ? {phase: button.dataset.androidPhase, label: button.textContent.trim()} : null;
  `);
}

async function checkFailure(status) {
  if (status?.phase !== "failed") return;
  const message = await js(`
    document.querySelector('button[data-android-phase]').click();
    return document.querySelector('[role="menu"]')?.textContent;
  `);
  throw new Error("Android project sync failed: " + (message || status.label));
}

async function choose(variant) {
  await until(
    async () => {
      const status = await syncStatus();
      await checkFailure(status);
      if (!status || !["idle", "ready"].includes(status.phase)) return false;
      return js(`
      const button = document.querySelector('button[data-android-phase]');
      button.click();
      return true;
    `);
    },
    "the automatically discovered variant picker",
    180000,
  );
  await until(
    () =>
      js(`
    const item = [...document.querySelectorAll('[role="menuitemcheckbox"]')].find(
      (e) => e.textContent.trim() === ${JSON.stringify(variant)});
    if (item) item.click();
    return Boolean(item);
  `),
    "the " + variant + " menu item",
  );
  await until(
    async () => {
      const status = await syncStatus();
      await checkFailure(status);
      return status?.phase === "ready" && status.label === variant;
    },
    "ready status for the selected variant",
    600000,
  );
  const indexed = JSON.parse(await readFile(join(indexRoot, "3a617070", variant + ".json"), "utf8"));
  assert.equal(indexed.application, ":app");
  assert.equal(indexed.variant, variant);
}

async function find(id, declaration, expected, variant) {
  const symbol = id.includes("#") ? id.split("#")[1].split("(")[0] : id;
  const path = join(fixture, declaration.uri);
  const { line, character } = declaration.range.start;
  await js(`
    const { editorService } = await import("/src/workbench/contributions.ts");
    await editorService().openFile(${JSON.stringify(path)}, {
      selection: { line: ${line}, col: ${character + 1} }, focus: true,
    });
  `);
  await until(
    () =>
      js(`
    const { activeEditor } = await import("/src/editor/api.ts");
    const ed = activeEditor();
    if (ed?.ctx.path !== ${JSON.stringify(path)}) return false;
    const view = ed.view;
    const pos = view.state.doc.line(${line + 1}).from + ${character + 1};
    view.dispatch({ selection: { anchor: pos } });
    view.focus();
    return view.state.selection.main.head === pos;
  `),
    "the active declaration editor",
  );
  assert.equal(
    await js(`
    const { executeAction } = await import("/src/platform/actions.ts");
    return await executeAction("find.usages");
  `),
    true,
    "Find Usages action must run",
  );

  const observation = await until(
    () =>
      js(`
    const { activeUsageSearch, useUsages } = await import("/src/features/code-insight/usages.ts");
    const search = activeUsageSearch(useUsages.getState());
    if (search?.symbol !== ${JSON.stringify(symbol)} || search.loading) return null;
    if (search.error) throw new Error(search.error);
    const tree = document.querySelector('[role="tree"][aria-label="Usages"]');
    if (!tree || !tree.getBoundingClientRect().width || !tree.querySelector("mark")) return null;
    return {
      note: search.note,
      groups: search.groups.map(({ path, usages }) => ({ path, usages: usages.map(
        ({ line, col, endCol }) => ({ line, col, endCol })) })),
      rows: [...tree.querySelectorAll('[role="treeitem"]')].map((e) => e.textContent),
      marks: [...tree.querySelectorAll("mark")].map((mark) => {
        const prefix = document.createRange();
        prefix.selectNodeContents(mark.parentElement);
        prefix.setEndBefore(mark);
        return { text: mark.textContent, prefix: prefix.toString(),
          line: Number(mark.parentElement.previousElementSibling.textContent) - 1 };
      }),
    };
  `),
    "rendered Find Usages results",
  );
  const ranges = observation.groups.flatMap(({ path, usages }) =>
    usages.map(({ line, col, endCol }) => ({
      uri: relative(fixture, path).split("\\").join("/"),
      range: { start: { line, character: col }, end: { line, character: endCol } },
    })),
  );
  assert.deepEqual(ranges, expected, id + " in " + variant);
  assert.ok(observation.note?.includes(variant), "Expected the selected Android provider");
  assert.ok(
    observation.rows.some((r) => r.includes(observation.note)),
    "Provider note must be rendered",
  );
  assert.equal(observation.marks.length, expected.length, "All rendered hits must match the oracle");
  for (const [index, e] of expected.entries()) {
    assert.ok(observation.rows.some((row) => row.includes(dirname(e.uri)) && row.includes(basename(e.uri))));
    const hit = observation.marks[index];
    const sourceLine = (await readFile(join(fixture, e.uri), "utf8")).split("\n")[e.range.start.line];
    assert.equal(hit.text, symbol);
    assert.equal(hit.line, e.range.start.line, "Rendered line number");
    assert.equal(
      hit.prefix,
      sourceLine.slice(0, e.range.start.character).trimStart(),
      "Rendered highlight must start at the oracle column, including for the overload on the same line",
    );
    assert.equal(hit.text.length, e.range.end.character - e.range.start.character, "Rendered highlight length");
  }
  return { variant, id, symbol, references: ranges, note: observation.note };
}

// Mutate only the private fixture copy. The native watcher must refresh the active variant on add and remove.
async function verifySourceRefresh() {
  const id = "dev.openide.sample.contract.KotlinGreeting#message()";
  const original = oracle.memberVariants.demoDebug[id];
  const uri = "app/src/demo/java/dev/openide/sample/contract/ZAddedCaller.java";
  const line = "    static String read(KotlinGreeting g) { return g.message(); }";
  const col = line.indexOf("message");
  const added = { uri, range: { start: { line: 2, character: col }, end: { line: 2, character: col + 7 } } };
  const path = join(fixture, uri);
  const snapshot = join(indexRoot, "3a617070/demoDebug.json");
  async function waitForEntry(present) {
    await until(
      async () => {
        const sync = await syncStatus();
        await checkFailure(sync);
        if (sync?.phase !== "ready") return false;
        try {
          const index = JSON.parse(await readFile(snapshot, "utf8"));
          return Object.hasOwn(index.files, uri) === present;
        } catch (error) {
          if (error.code === "ENOENT") return false;
          throw error;
        }
      },
      "automatic refresh after source " + (present ? "creation" : "deletion"),
      180000,
    );
  }
  await writeFile(path, ["package dev.openide.sample.contract;", "class ZAddedCaller {", line, "}", ""].join("\n"), {
    flag: "wx",
  });
  try {
    await waitForEntry(true);
    await find(id, oracle.memberDeclarations[id], [...original, added], "demoDebug");
  } finally {
    await unlink(path);
  }
  await waitForEntry(false);
  await find(id, oracle.memberDeclarations[id], original, "demoDebug");
  return { variant: "demoDebug", addedResults: original.length + 1, restoredResults: original.length };
}

async function verifyModelRecovery() {
  const script = join(fixture, "app/build.gradle.kts");
  const original = await readFile(script, "utf8");
  try {
    await writeFile(script, original + '\nthrow GradleException("Android sync acceptance failure")\n');
    await until(async () => (await syncStatus())?.phase === "failed", "surfacing a broken Gradle model", 180000);
    assert.equal(
      await js(`return !document.querySelector('[aria-label="Usage searches"] [role="tab"]');`),
      true,
      "Old results were cleared on model failure",
    );
  } finally {
    await writeFile(script, original);
  }
  await until(
    async () => {
      const status = await syncStatus();
      return status?.phase === "ready" && status.label === "demoDebug";
    },
    "automatic rediscovery after the Gradle model is repaired",
    180000,
  );
  const id = "dev.openide.sample.contract.KotlinGreeting#message()";
  await find(id, oracle.memberDeclarations[id], oracle.memberVariants.demoDebug[id], "demoDebug");
  return { brokenBuild: "failed", oldResultsCleared: true, repairedBuild: "ready", selected: "demoDebug" };
}

async function verifyReferences() {
  const results = [];
  const switches = [];
  let previous = null;
  for (const variant of ["demoDebug", "fullDebug", "demoDebug"]) {
    const priorTabs = await js(`
      const { useUsages } = await import("/src/features/code-insight/usages.ts");
      return useUsages.getState().tabs.length;
    `);
    await choose(variant);
    if (results.length === 0) await missing(join(indexRoot, "3a617070", "fullDebug.json"));
    if (previous !== null) {
      assert.ok(priorTabs > 0, "The previous variant must have search tabs");
      await until(
        () =>
          js(`
        const { useUsages } = await import("/src/features/code-insight/usages.ts");
        return useUsages.getState().tabs.length === 0 &&
          !document.querySelector('[aria-label="Usage searches"] [role="tab"]');
      `),
        "clearing stale Find Usages tabs on variant change",
      );
      switches.push({ from: previous, to: variant, priorTabs, remainingTabs: 0 });
    }
    previous = variant;
    const declarations = { ...oracle.declarations, ...oracle.memberDeclarations };
    const expected = { ...oracle.variants[variant], ...oracle.memberVariants[variant] };
    for (const [id, declaration] of Object.entries(declarations)) {
      const result = await find(id, declaration, expected[id], variant);
      const { dataUrl: shot } = await rpc("capture_native_screenshot", { windowLabel, format: "png" });
      assert.ok(shot.startsWith("data:image/png;base64,"), "Invalid desktop screenshot");
      const name =
        String(results.length + 1).padStart(2, "0") + "-" + variant + "-" + id.replace(/[^A-Za-z0-9-]/g, "_") + ".png";
      await writeFile(join(out, name), Buffer.from(shot.slice(22), "base64"));
      results.push({ ...result, screenshot: name });
      console.log(variant, id, result.references.map((l) => l.uri).join(", "));
    }
  }
  const sourceRefresh = await verifySourceRefresh();
  const modelRecovery = await verifyModelRecovery();
  await writeFile(
    join(out, "results.json"),
    JSON.stringify(
      {
        app: status.identifier,
        cleanFixture: true,
        restrictedBeforeTrust: true,
        trusted: true,
        module: ":app",
        indexedOnSelection: true,
        sourceRefresh,
        modelRecovery,
        switches,
        results,
      },
      null,
      2,
    ) + "\n",
  );
  console.log("Verified", results.length, "native Find Usages queries. Evidence:", out);
}

try {
  windowLabel = await fixtureWindow();
  await rpc("set_window_state", { action: "focus", windowId: windowLabel });
  assert.equal(
    await js(`const { useProject } = await import("/src/platform/project.ts");
    return useProject.getState().project?.root;`),
    fixture,
  );
  assert.equal(
    await js(`const {useProject} = await import("/src/platform/project.ts");
    return useProject.getState().project.trusted;`),
    false,
    "Fresh fixture must start restricted",
  );
  await missing(indexRoot);
  await trustFixture();
  if (deviceRun || deviceDebug) {
    const verify = deviceDebug
      ? (await import("./verify-device-debug.mjs")).verifyDeviceDebug
      : (await import("./verify-device-run.mjs")).verifyDeviceRun;
    await verify({
      fixture,
      out,
      js,
      choose,
      until,
      capture: () => rpc("capture_native_screenshot", { windowLabel, format: "png" }),
    });
  } else {
    await verifyReferences();
  }
} finally {
  socket.close();
}
