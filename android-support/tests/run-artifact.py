#!/usr/bin/env python3
"""Check physical-Run artifact selection against real AGP and the manifest inside each APK."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

support = Path(__file__).resolve().parents[1]
fixture = support.parent / "examples/android-variants"
ignore = shutil.ignore_patterns("build", ".gradle", ".kotlin", ".openidea", ".idea", "local.properties")
sdk = Path(os.environ.get("ANDROID_HOME") or os.environ["ANDROID_SDK_ROOT"])
tool = next((directory / "aapt2" for directory in sorted((sdk / "build-tools").iterdir(), reverse=True)
             if (directory / "aapt2").is_file()), None)
if tool is None:
    raise SystemExit("Install Android SDK Build Tools with aapt2 first")


def artifact(project, module, variant, expected=None, failure=None, extra_args=(), debuggable=True):
    result = subprocess.run([project / "gradlew", "-p", project, "-q", "--no-configuration-cache",
                             "--no-configure-on-demand", "--init-script", support / "run.gradle",
                             f"-PopenAndroidApplication={module}", f"-PopenAndroidVariant={variant}",
                             *extra_args, ":openAndroidRunArtifact"], text=True, capture_output=True)
    marker = "OPENANDROIDSTUDIO_RUN_ARTIFACT="
    records = [json.loads(line.removeprefix(marker)) for line in result.stdout.splitlines() if line.startswith(marker)]
    if failure:
        if result.returncode == 0 or records or failure not in result.stderr:
            raise ValueError(f"{module} / {variant}: expected {failure}; got {records} {result.stderr}")
        return
    if result.returncode or len(records) != 1:
        raise ValueError(f"{module} / {variant}: expected one model, got {records} {result.stderr}")
    model = records[0]
    if (model["module"], model["variant"], model["applicationId"]) != (module, variant, expected):
        raise ValueError(f"Wrong Run model: {model}")
    relative = Path(model["apk"])
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError(f"Expected a project-local APK: {relative}")
    manifest = subprocess.check_output([tool, "dump", "badging", project / relative], text=True)
    package = re.search(r"^package: name='([^']+)'", manifest, re.MULTILINE)
    if not package or package.group(1) != expected or "launchable-activity: name='dev.openide.sample.MainActivity'" not in manifest:
        raise ValueError(f"Unexpected installed identity or launcher in {relative}")
    if model.get("debuggable") is not debuggable or ("application-debuggable" in manifest.splitlines()) != debuggable:
        raise ValueError(f"Wrong packaged debug flag in {relative}")
    print(f"{module} / {variant} built {relative} ({expected})", flush=True)
    return relative


with tempfile.TemporaryDirectory(prefix="openandroid-run-") as scratch:
    project = Path(scratch) / "example"
    shutil.copytree(fixture, project, ignore=ignore)
    for flavor in ("demo", "full"):
        artifact(project, ":app", flavor + "Debug", "dev.openide.sample." + flavor)
    artifact(project, ":app", "demoRelease", "dev.openide.sample.demo", debuggable=False)
    artifact(project, ":contract", "demoDebug", failure="No enabled application variant")
    artifact(project, ":app", "notRealDebug", failure="No enabled application variant")

    sibling = project / "shipping/secondary"
    shutil.copytree(project / "app", sibling, ignore=ignore)
    script = sibling / "build.gradle.kts"
    script.write_text(script.read_text().replace('applicationId = "dev.openide.sample"',
                      'applicationId = "dev.openide.second"') + '''
layout.buildDirectory.set(rootProject.layout.projectDirectory.dir("relocated-output"))
androidComponents {
    beforeVariants(selector().withName("fullDebug")) { it.enable = false }
    onVariants { model -> model.outputs.forEach { it.outputFileName.set("qa-${model.name}.apk") } }
}
''')
    with (project / "settings.gradle.kts").open("a") as settings:
        settings.write('\ninclude(":second")\nproject(":second").projectDir = file("shipping/secondary")\n')
    selected = artifact(project, ":second", "demoDebug", "dev.openide.second.demo")
    if selected.parts[0] != "relocated-output" or selected.name != "qa-demoDebug.apk":
        raise ValueError(f"Did not honor the selected module's AGP artifact: {selected}")
    artifact(project, ":second", "fullDebug", failure="No enabled application variant")
    # Simulate a broken custom packaging step: its recorded output points to another real application.
    shutil.copyfile(project / "app/build/outputs/apk/demo/debug/app-demo-debug.apk", project / selected)
    artifact(project, ":second", "demoDebug", failure="differs from the selected application ID",
             extra_args=("-x", ":second:packageDemoDebug"))

    # A directory containing merely old single APKs is never a substitute for the selected split artifact.
    with (project / "app/build.gradle.kts").open("a") as script:
        script.write('\nandroid { splits.abi { isEnable = true; reset(); include("arm64-v8a", "x86_64"); isUniversalApk = false } }\n')
    artifact(project, ":app", "demoDebug", failure="has split outputs")

    with (project / "settings.gradle.kts").open("a") as settings:
        settings.write('\ninclude(":feature")\n')
    feature = project / "feature"
    (feature / "src/main").mkdir(parents=True)
    (feature / "src/main/AndroidManifest.xml").write_text('<manifest xmlns:android="http://schemas.android.com/apk/res/android"/>')
    (feature / "build.gradle.kts").write_text('''
plugins { id("com.android.dynamic-feature") }
android { namespace = "dev.openide.feature"; compileSdk = 36; defaultConfig { minSdk = 24 } }
dependencies { implementation(project(":app")) }
''')
    with (project / "app/build.gradle.kts").open("a") as script:
        script.write('\nandroid { dynamicFeatures += setOf(":feature") }\n')
    artifact(project, ":app", "demoDebug", failure="applications with dynamic features")
