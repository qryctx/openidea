// Invoked by verify-desktop.mjs --device-run. ADB is an independent, read-only witness here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

async function adbExecutable() {
  if (process.env.OPENIDEA_ADB) return process.env.OPENIDEA_ADB;
  for (const sdk of [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.HOME && join(process.env.HOME, "Library/Android/sdk"),
  ]) {
    if (!sdk) continue;
    const path = join(sdk, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
    if (
      await access(path).then(
        () => true,
        () => false,
      )
    )
      return path;
  }
  return "adb";
}

export async function verifyDeviceRun({ fixture, out, js, choose, until, capture }) {
  const serial = process.env.ANDROID_SERIAL;
  assert.ok(
    serial && process.stdin.isTTY,
    "Set ANDROID_SERIAL and run interactively to verify each phone screen before switching.",
  );
  const adb = await adbExecutable();
  const onPhone = (...args) => execFileSync(adb, ["-s", serial, "shell", ...args], { encoding: "utf8" }).trim();
  const results = [];
  const cli = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const flavor of ["demo", "full"]) {
      const variant = flavor + "Debug";
      const app = "dev.openide.sample." + flavor;
      await choose(variant);
      if (results.length) {
        assert.equal(
          await js(`return document.querySelector("[data-logcat-application]")?.dataset.logcatApplication ?? null;`),
          null,
        );
        assert.equal(
          await js(
            `return document.querySelector('[role="log"]')?.textContent.includes("package=dev.openide.sample.demo ") ?? false;`,
          ),
          false,
        );
      }
      // The real toolbar, not an invocation of the build/install IPC from the test.
      await until(
        () =>
          js(`const d=document.querySelector("[data-android-device]");
        return d && !d.disabled && Boolean(d.dataset.androidDevice || d.textContent.trim());`),
        "Android device selector",
      );
      const selected = await js(`return document.querySelector("[data-android-device]").dataset.androidDevice;`);
      if (selected !== serial) {
        await js(`document.querySelector("[data-android-device]").click();`);
        await until(
          () =>
            js(`const e=[...document.querySelectorAll('[role^="menuitem"]')].find(e=>e.textContent.includes(${JSON.stringify(serial)}));
          if(e)e.click(); return Boolean(e);`),
          "the selected physical device",
        );
      }
      assert.equal(await js(`return document.querySelector("[data-android-device]").dataset.androidDevice;`), serial);
      const clickedAt = new Date().toISOString();
      await js(`window.__runStages=[];
        const stage=()=>{const val=document.querySelector("[data-android-run-stage]")?.dataset.androidRunStage;
          if(val && window.__runStages.at(-1)!==val)window.__runStages.push(val);};
        window.__runStageObserver=new MutationObserver(stage);
        window.__runStageObserver.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:["data-android-run-stage"]});`);

      await until(
        () =>
          js(
            `const b=document.querySelector("[data-android-run]"); if(!b || b.disabled)return false; b.click();return true;`,
          ),
        "enabled Android Run button",
      );
      const scope = await until(
        async () => {
          return js(`const stage=document.querySelector("[data-android-run-stage]");
          if(stage?.dataset.androidRunStage==="failed") throw new Error(stage.title || stage.textContent);
          const scope=document.querySelector("[data-logcat-application]");
          if (stage?.dataset.androidRunStage!=="launched" || scope?.dataset.logcatApplication!==${JSON.stringify(app)}) return null;
          return {app:scope.dataset.logcatApplication,pid:Number(scope.dataset.logcatPid)};`);
        },
        "visible Run completion and matching Logcat scope",
        600000,
      );
      const pid = scope.pid;
      assert.ok(pid > 0);
      await js(`const input=document.querySelector("input[aria-label='Filter log lines']"); if (!input) throw new Error("Missing Logcat filter");
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"tag:OpenAndroidStudioRun");
        input.dispatchEvent(new Event("input",{bubbles:true}));`);
      const marker =
        "launch variant=" + variant + " package=" + app + " greeting=" + (flavor === "demo" ? "Demo" : "Full") + ":";
      const message = await until(
        () =>
          js(
            `const log=document.querySelector("[role=log]"); return log && [...log.querySelectorAll("span")].map(x=>x.textContent).find(x=>x.startsWith(${JSON.stringify(marker)}));`,
          ),
        "rendered package-specific Logcat line",
        60000,
      );
      const deviceLine = onPhone("logcat", "-d", "--pid=" + pid, "-s", "OpenAndroidStudioRun:I")
        .split(/\r?\n/)
        .find((l) => l.includes(message));
      assert.ok(deviceLine, "Same message must exist on the physical device");
      const visible = await js(`const log=document.querySelector("[role=log]"); return log?.textContent;`);
      assert.ok(
        !visible.includes("package=dev.openide.sample." + (flavor === "demo" ? "full" : "demo") + " "),
        "Logcat still shows the previous flavor",
      );
      assert.ok(onPhone("pidof", app).split(/\s+/).includes(String(pid)));
      const resumed = onPhone("dumpsys", "activity", "activities")
        .split(/\r?\n/)
        .find((l) => /topResumedActivity|mResumedActivity/.test(l) && l.includes(app + "/"));
      assert.ok(resumed, "Launched package is not the resumed foreground activity");
      const component = resumed.match(/\b(dev\.openide\.sample[^/\s]*\/[^\s}]+)/)?.[1];
      assert.equal(component, app + "/dev.openide.sample.MainActivity");
      const installed = onPhone("pm", "path", app).split(/\r?\n/);
      assert.equal(installed.length, 1);
      assert.ok(installed[0].startsWith("package:"));
      const installedSHA = onPhone("sha256sum", installed[0].slice(8)).split(/\s+/)[0];
      const outputs = join(fixture, "app/build/outputs/apk");
      const matches = [];
      for (const f of await readdir(outputs, { recursive: true, withFileTypes: true })) {
        if (f.name !== "output-metadata.json" || !f.isFile()) continue;
        const metaFile = join(f.parentPath, f.name);
        const meta = JSON.parse(await readFile(metaFile, "utf8"));
        if (meta.variantName === variant && meta.applicationId === app && meta.elements.length === 1)
          matches.push(join(dirname(metaFile), meta.elements[0].outputFile));
      }
      assert.equal(matches.length, 1, "Expected one AGP output for the selected sample variant");
      const builtSHA = createHash("sha256")
        .update(await readFile(matches[0]))
        .digest("hex");
      assert.equal(installedSHA, builtSHA, "Installed base APK differs from the selected build artifact");
      const details = onPhone("dumpsys", "package", app);
      const when = /lastUpdateTime=([^\r\n]+)/.exec(details)?.[1]?.trim();
      assert.ok(when);
      const shot = await capture();
      const shotName = flavor + "-desktop.png";
      await writeFile(join(out, shotName), Buffer.from(shot.dataUrl.split(",")[1], "base64"));
      const stages = await js(`window.__runStageObserver.disconnect();return window.__runStages;`);
      assert.deepEqual(stages, ["building", "installing", "launching", "launched"]);
      const item = {
        stages,
        variant,
        package: app,
        component,
        pid,
        device: onPhone("getprop", "ro.product.model"),
        sameSelectedSerial: true,
        clickedAt,
        lastUpdateTime: when,
        builtApkSha256: builtSHA,
        installedApkSha256: installedSHA,
        foregroundVerified: true,
        previousScopeDetachedBeforeRun: results.length ? true : null,
        desktopLogcatMessage: message,
        deviceLogcatMatched: true,
        desktopScreenshot: shotName,
      };
      results.push(item);
      await writeFile(join(out, flavor + "-desktop.json"), JSON.stringify(item, null, 2) + "\n");
      console.log(variant, app, "matches phone APK and foreground, with IDE log:", message);
      await cli.question("Observe and record the " + flavor + " page on the phone. Press Enter when complete. ");
    }
    await writeFile(join(out, "desktop-results.json"), JSON.stringify({ runs: results }, null, 2) + "\n");
  } finally {
    cli.close();
  }
}
