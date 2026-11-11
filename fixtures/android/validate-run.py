"""Validate real metadata, launcher resolution and OAS logs on one physical phone."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as ET

ANDROID = "{http://schemas.android.com/apk/res/android}"
CASES = {"f1-kotlin": "kotlin", "f2-java": "java", "f3-mixed": "mixed"}


def host_contract(project, name):
    metadata_path = project / "app/build/outputs/apk/debug/output-metadata.json"
    if not metadata_path.is_file():
        raise RuntimeError(f"NOT_BUILT: missing {metadata_path}")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    package = metadata["applicationId"]
    if package != "dev.openandroid.samples." + name:
        raise RuntimeError("UNSAFE_PACKAGE: metadata is not this sample's applicationId")
    elements = metadata["elements"]
    if metadata["variantName"] != "debug" or len(elements) != 1 or elements[0]["filters"]:
        raise RuntimeError("UNSUPPORTED_OUTPUT: expected one unfiltered debug APK")
    apk = (metadata_path.parent / elements[0]["outputFile"]).resolve()
    if apk.parent != metadata_path.parent.resolve() or not apk.is_file():
        raise RuntimeError("INVALID_APK: output must exist next to metadata")
    manifest_path = project / "app/build/intermediates/merged_manifests/debug/processDebugManifest/AndroidManifest.xml"
    manifest = ET.parse(manifest_path).getroot()
    if manifest.attrib["package"] != package:
        raise RuntimeError("PACKAGE_MISMATCH: metadata and merged manifest disagree")
    application = manifest.find("application")
    if application is None or application.get(ANDROID + "debuggable") != "true":
        raise RuntimeError("NOT_DEBUGGABLE: merged manifest must explicitly enable debug")
    launchers = []
    for activity in list(application.findall("activity")) + list(application.findall("activity-alias")):
        for intent in activity.findall("intent-filter"):
            main = any(a.get(ANDROID + "name") == "android.intent.action.MAIN"
                       for a in intent.findall("action"))
            launcher = any(c.get(ANDROID + "name") == "android.intent.category.LAUNCHER"
                           for c in intent.findall("category"))
            if main and launcher:
                activity_name = activity.attrib[ANDROID + "name"]
                if activity_name.startswith("."):
                    activity_name = package + activity_name
                elif "." not in activity_name:
                    activity_name = package + "." + activity_name
                launchers.append(activity_name)
    if len(set(launchers)) != 1:
        raise RuntimeError("AMBIGUOUS_LAUNCHER: expected exactly one MAIN/LAUNCHER")
    version = elements[0]["versionCode"]
    if int(manifest.attrib[ANDROID + "versionCode"]) != version:
        raise RuntimeError("VERSION_MISMATCH: metadata and merged manifest disagree")
    return dict(applicationId=package, versionCode=version, apk=str(apk),
                metadata=str(metadata_path), manifest=str(manifest_path),
                launcher=launchers[0], debuggable=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--host-only", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    args.evidence.mkdir(parents=True, exist_ok=True)
    contracts = {fixture: host_contract(root / fixture, name) for fixture, name in CASES.items()}
    (args.evidence / "host-contracts.json").write_text(
        json.dumps(contracts, indent=2), encoding="utf-8")
    if args.host_only:
        print("PASS: all three host contracts")
        return
    sdk = os.environ.get("ANDROID_HOME")
    if not sdk:
        parser.error("ANDROID_HOME is required; this script never installs an SDK")
    adb = Path(sdk) / "platform-tools" / ("adb.exe" if os.name == "nt" else "adb")
    discovery = subprocess.run([str(adb), "devices", "-l"], check=True,
                               capture_output=True, encoding="utf-8")
    devices = [line.split() for line in discovery.stdout.splitlines()
               if len(line.split()) > 1 and line.split()[1] == "device"]
    if len(devices) != 1 or devices[0][0].startswith("emulator-"):
        parser.error("Exactly one authorized physical device is required")
    serial = devices[0][0]
    commands = []

    def run(*arguments, absent_package_ok=False):
        start = time.monotonic()
        result = subprocess.run([str(adb), "-s", serial, *arguments], capture_output=True,
                                encoding="utf-8", errors="strict", timeout=30)
        commands.append(dict(command=["adb", "-s", "<device>", *arguments],
                             exitCode=result.returncode,
                             seconds=round(time.monotonic() - start, 3),
                             stdout=result.stdout.replace(serial, "<device>"),
                             stderr=result.stderr.replace(serial, "<device>")))
        absent = (absent_package_ok and result.returncode == 1
                  and not result.stdout.strip() and not result.stderr.strip())
        if result.returncode and not absent:
            raise RuntimeError(f"ADB_FAILED: {arguments[0]} exited {result.returncode}: {result.stderr}")
        return result.stdout.strip()

    results = []
    try:
        if run("shell", "getprop", "ro.kernel.qemu") == "1":
            raise RuntimeError("NOT_PHYSICAL: emulators are outside this validation")
        for fixture, name in CASES.items():
            contract = contracts[fixture]
            package = contract["applicationId"]
            if run("shell", "pm", "path", package, absent_package_ok=True):
                raise RuntimeError(f"ALREADY_INSTALLED: {package}; do not replace another session's sample")
            installed = False
            try:
                start = time.monotonic()
                install = run("install", "-r", contract["apk"])
                if "Success" not in install:
                    raise RuntimeError("INSTALL_FAILED: adb did not confirm success")
                installed = True
                resolved = run("shell", "cmd", "package", "resolve-activity", "--brief",
                               "-c", "android.intent.category.LAUNCHER", package).splitlines()[-1]
                expected = package + "/" + contract["launcher"]
                if resolved.startswith(package + "/."):
                    resolved = package + "/" + package + resolved.split("/", 1)[1]
                if resolved != expected:
                    raise RuntimeError("LAUNCHER_MISMATCH: host and phone disagree")
                launch = run("shell", "am", "start", "-W", "-n", resolved)
                if "Status: ok" not in launch:
                    raise RuntimeError("START_FAILED: am start did not report Status: ok")
                pid = run("shell", "pidof", package)
                if not re.fullmatch(r"\d+", pid):
                    raise RuntimeError("INVALID_PID: expected one running sample process")
                time.sleep(13)
                logs = run("logcat", "--pid=" + pid, "-d", "-s", "OAS:I", "*:S")
                iterations = [int(n) for n in re.findall(name + r" iteration=(\d+)", logs)]
                if iterations != list(range(10)):
                    raise RuntimeError(f"PROBE_FAILED: expected 0..9, observed {iterations}")
                row = dict(fixture=fixture, status="passed", launcherMatches=True,
                           iterations=iterations, seconds=round(time.monotonic() - start, 3))
                results.append(row)
                print(json.dumps(row), flush=True)
            finally:
                if installed:
                    if "Success" not in run("uninstall", package):
                        raise RuntimeError("UNINSTALL_FAILED: sample cleanup was not confirmed")
                    if run("shell", "pm", "path", package, absent_package_ok=True):
                        raise RuntimeError("CLEANUP_FAILED: sample is still installed")
    finally:
        (args.evidence / "phone-commands.json").write_text(
            json.dumps(commands, indent=2, ensure_ascii=False), encoding="utf-8")
        (args.evidence / "phone-results.json").write_text(
            json.dumps(results, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
