// Click the shipped workbench controls. adb only observes which process stopped and when it continued.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { adbExecutable, chooseDevice } from "./desktop-device.mjs";

const contract = "libraries/contracts/src/main";
const namespace = "dev/openide/sample/contract";
const cases = [
  { flavor: "demo", source: contract + "/java/" + namespace + "/JavaGreeting.java", at: 'return "Hello from Java";' },
  {
    flavor: "full",
    source: contract + "/kotlin/" + namespace + "/KotlinGreeting.kt",
    at: 'val greeting = "Hello from Kotlin"',
  },
];

async function toggle(js, until, path, line, enabled) {
  await js(`const { editorService } = await import("/src/workbench/contributions.ts");
    await editorService().openFile(${JSON.stringify(path)}, { selection: {line:${line},col:0}, focus:true });`);
  await until(
    () =>
      js(`const {activeEditor}=await import("/src/editor/api.ts");
    const ed=activeEditor();
    if (ed?.ctx.path !== ${JSON.stringify(path)}) return false;
    ed.view.dispatch({selection:{anchor:ed.view.state.doc.line(${line + 1}).from}});
    ed.view.focus(); return true;`),
    "open source line",
  );
  await action(js, "debug.toggleBreakpoint");
  assert.equal(
    await js(`const {breakpointsOf}=await import("/src/features/debugger/breakpoints/store.ts");
    return breakpointsOf(${JSON.stringify(path)}).some(b=>b.enabled && b.line===${line});`),
    enabled,
  );
}

async function action(js, id) {
  assert.equal(
    await js(`const {executeAction}=await import("/src/platform/actions.ts");
    return executeAction(${JSON.stringify(id)});`),
    true,
    id,
  );
}

async function paused(js, until, fixture, expected, afterStop = -1) {
  const state = await until(
    () =>
      js(`const {activeSession,useDebug,useExecutionPoint} = await import("/src/features/debugger/state.ts");
    const s=activeSession(), point=useExecutionPoint.getState(), seq=useDebug.getState().stopSeq;
    const status=document.querySelector("[data-android-run-stage]");
    if(status?.dataset.androidRunStage==="failed") throw Error(status.title||status.textContent);
    if(!s || s.status!=="paused" || seq<=${afterStop} || !s.frames.length || !point.top || point.path!==s.frames[0].path || point.line!==s.frames[0].line) return null;
    const rows=[...document.querySelectorAll('[role="listbox"] [role="option"]')].map(x=>x.textContent);
    if(!rows.length || !rows.some(x=>x.includes(${JSON.stringify(basename(expected))}))) return null;
    return {session:s.id,reason:s.stopReason,hits:s.hits,seq,frames:s.frames.map(({name,path,line})=>({name,path,line:line+1})),rows,point:{path:point.path,line:point.line+1}};`),
    "paused thread, frames and editor execution point",
    150000,
  );
  for (const frame of state.frames) if (frame.path) frame.path = relative(fixture, frame.path);
  state.point.path = relative(fixture, state.point.path);
  return state;
}

export async function verifyDeviceDebug({ fixture, out, js, choose, until, capture }) {
  const serial = process.env.ANDROID_SERIAL;
  assert.ok(serial, "Set ANDROID_SERIAL to the physical device under test.");
  const adb = await adbExecutable();
  const onDevice = (...args) => execFileSync(adb, ["-s", serial, ...args], { encoding: "utf8", timeout: 10000 }).trim();
  const tag = "OpenAndroidStudioRun";
  const results = [];
  const saveShot = async (name) => {
    const shot = await capture();
    await writeFile(join(out, name), Buffer.from(shot.dataUrl.split(",")[1], "base64"));
  };
  for (const c of cases) {
    const { flavor, source } = c;
    const path = join(fixture, source),
      variant = flavor + "Debug",
      pkg = "dev.openide.sample." + flavor;
    const lines = (await readFile(path, "utf8")).split(/\r?\n/);
    const line = lines.findIndex((s) => s.trim() === c.at);
    assert.ok(line >= 0);
    await choose(variant);
    await chooseDevice(serial, js, until);
    await toggle(js, until, path, line, true);
    console.log("Clicking Debug", variant, source, line + 1);
    await until(
      () =>
        js(
          `const b=document.querySelector("[data-android-debug]"); if(!b||b.disabled)return false;b.click();return true;`,
        ),
      "enabled Android Debug button",
    );
    try {
      const stop = await paused(js, until, fixture, source);
      assert.equal(stop.reason, "breakpoint");
      assert.deepEqual(stop.point, { path: source, line: line + 1 });
      assert.equal(stop.hits, 1, "The first breakpoint pause counts once");
      const paths = stop.frames.map((f) => f.path);
      assert.ok(paths.includes("app/src/" + flavor + "/kotlin/" + namespace + "/FlavorGreeting.kt"));
      assert.ok(paths.includes("app/src/main/kotlin/dev/openide/sample/MainActivity.kt"));
      if (flavor === "full") assert.ok(paths.includes("app/src/full/java/" + namespace + "/JavaCaller.java"));
      const pid = Number(onDevice("shell", "pidof", pkg));
      assert.ok(pid > 0);
      const forwards = () => onDevice("forward", "--list").split(/\r?\n/);
      const owned = forwards().filter((f) => f.startsWith(serial + " ") && f.endsWith(" jdwp:" + pid));
      assert.equal(owned.length, 1);
      const logs = () => onDevice("shell", "logcat", "-d", "--pid=" + pid, "-s", tag + ":I");
      const prefix = "variant=" + variant + " package=" + pkg;
      const logBefore = logs().split(/\r?\n/);
      const starts = logBefore.filter((l) => l.includes("before greeting " + prefix));
      assert.equal(starts.length, 1, "expected the first onCreate call in the new PID");
      assert.ok(!logBefore.some((l) => l.includes("launch " + prefix)), "onCreate already finished before breakpoint");
      await saveShot(flavor + "-breakpoint.png");
      const result = {
        variant,
        applicationId: pkg,
        pid,
        model: onDevice("shell", "getprop", "ro.product.model"),
        api: onDevice("shell", "getprop", "ro.build.version.sdk"),
        sameSelectedSerial: true,
        stop,
        firstStartMarkers: starts.length,
        completionMarkerAbsentWhilePaused: true,
        forwardVerified: true,
      };
      if (flavor === "full") {
        await action(js, "debug.stepOver");
        const step = await paused(js, until, fixture, source, stop.seq);
        assert.equal(step.reason, "step");
        assert.deepEqual(step.point, {
          path: source,
          line: lines.findIndex((l) => l.trim() === "return greeting") + 1,
        });
        const locals = await until(
          () =>
            js(`const vars=document.querySelector('[role="tree"][aria-label="Variables"]');
          return [...(vars?.querySelectorAll('[role="treeitem"]')??[])].map(r=>r.textContent).find(s=>s.includes("greeting")&&s.includes("Hello from Kotlin"))||null;`),
          "visible Kotlin greeting local",
        );
        result.step = { ...step, local: locals };
        await saveShot(flavor + "-step.png");
      }
      await action(js, "debug.resume");
      result.afterResume = await until(
        () =>
          logs()
            .split(/\r?\n/)
            .find((l) => l.includes("launch " + prefix + " greeting="))
            ?.split("launch " + prefix)[1],
        "greeting log after Continue",
      );
      await action(js, "debug.stop");
      await until(() => !forwards().includes(owned[0]), "release the session's JDWP forward");
      result.forwardReleased = true;
      results.push(result);
      await writeFile(join(out, flavor + "-debug.json"), JSON.stringify(result, null, 2) + "\n");
      console.log(variant, "verified", stop.point, result.step?.point ?? "");
    } finally {
      // Clean up an active session if an assertion or the transport failed.
      await js(`const active=document.querySelector("[data-android-run-stage]")?.dataset.androidRunStage;
        if(["attaching","debugging"].includes(active)){const {executeAction}=await import("/src/platform/actions.ts"); await executeAction("debug.stop");}`).catch(
        () => {},
      );
    }
    await toggle(js, until, path, line, false);
  }
  await writeFile(join(out, "debug-results.json"), JSON.stringify({ runs: results }, null, 2) + "\n");
}
