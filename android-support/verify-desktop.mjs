// Run after index-variants and pnpm dev:app. Node 22.18+ (global WebSocket).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const fixture = join(root, "examples/android-variants");
const oracle = JSON.parse(await readFile(join(fixture, "expected-usages.json"), "utf8"));
const out = process.argv[2] ?? (await mkdtemp(join(tmpdir(), "openidea-android-desktop-")));
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
  const state = await backend();
  assert.equal(state.app.identifier, status.identifier);
  const open = state.windows.find((w) => w.title.includes(basename(fixture)));
  const main = state.windows.find((w) => w.label === "main");
  windowLabel = open?.label ?? main?.label;
  assert.ok(windowLabel, "Expected the isolated development app's project window");
  if (!open) {
    await js(`
      const { useProject } = await import("/src/platform/project.ts");
      const { openProjectInWindow } = await import("/src/features/app/windows.ts");
      const existing = useProject.getState().project?.root;
      if (existing !== ${JSON.stringify(fixture)})
        void openProjectInWindow(${JSON.stringify(fixture)}, Boolean(existing));
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
            const approve = [...dialog.querySelectorAll("button")].find(
              (b) => b.textContent.trim() === tx("Trust Project"));
            approve?.click();
          }
          return useProject.getState().project?.root === target;
        `,
      });
      if (ready) return label;
    }
    return null;
  }, "the trusted fixture in its project window");
}

async function choose(variant) {
  await js(`
    const { tx } = await import("/src/platform/i18n.ts");
    const button = [...document.querySelectorAll("button[data-tooltip]")].find(
      (b) => b.dataset.tooltip === tx("Android reference variant"));
    if (!button) throw new Error("Missing Android variant picker. Generate the indexes first.");
    button.click();
  `);
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
    () =>
      js(`return [...document.querySelectorAll("button[data-tooltip]")].some(
    (b) => b.textContent.trim() === ${JSON.stringify(variant)});`),
    "the selected variant",
  );
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

try {
  windowLabel = await fixtureWindow();
  await rpc("set_window_state", { action: "focus", windowId: windowLabel });
  assert.equal(
    await js(`const { useProject } = await import("/src/platform/project.ts");
    return useProject.getState().project?.root;`),
    fixture,
  );
  const results = [];
  for (const variant of ["demoDebug", "fullDebug", "demoDebug"]) {
    await choose(variant);
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
  await writeFile(join(out, "results.json"), JSON.stringify({ app: status.identifier, results }, null, 2) + "\n");
  console.log("Verified", results.length, "native Find Usages queries. Evidence:", out);
} finally {
  socket.close();
}
