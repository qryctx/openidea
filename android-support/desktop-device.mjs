import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";

export async function adbExecutable() {
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

export async function chooseDevice(serial, js, until) {
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
}
