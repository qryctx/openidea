"""Real sample launch rejection/rollback proof; mock only selected adb replies."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
from dap_client import Dap
from phone import FIXTURES, contract_module


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    args.evidence.mkdir(parents=True, exist_ok=True)
    sdk = os.environ.get("ANDROID_HOME")
    if not sdk:
        parser.error("ANDROID_HOME is required")
    adb = (Path(sdk) / "platform-tools" / ("adb.exe" if os.name == "nt" else "adb")).resolve()
    discovery = subprocess.run([str(adb), "devices", "-l"], check=True, capture_output=True, encoding="utf-8")
    devices = [line.split() for line in discovery.stdout.splitlines()
               if len(line.split()) > 1 and line.split()[1] == "device"]
    if len(devices) != 1 or devices[0][0].startswith("emulator-"):
        parser.error("Exactly one authorized physical device is required")
    serial = devices[0][0]
    commands, results = [], []

    def run(*arguments, absent=False):
        result = subprocess.run([str(adb), "-s", serial, *arguments], capture_output=True,
                                encoding="utf-8", timeout=30)
        output = result.stdout.strip()
        if arguments == ("forward", "--list"):
            output = "\n".join(line for line in output.splitlines() if line.split()[0] == serial)
        commands.append(dict(command=["adb", "-s", "<test-phone>", *arguments],
                             exitCode=result.returncode, stdout=output.replace(serial, "<test-phone>"),
                             stderr=result.stderr.replace(serial, "<test-phone>")))
        if result.returncode and not (absent and result.returncode == 1 and not output and not result.stderr.strip()):
            raise RuntimeError(f"adb {arguments[0]} failed: {result.stderr.replace(serial, '<test-phone>')}")
        return output

    def forwards():
        return {tuple(line.split()[1:]) for line in run("forward", "--list").splitlines()}

    project = FIXTURES / "f2-java"
    contract = contract_module.host_contract(project, "java")
    package = contract["applicationId"]
    assert package == "dev.openandroid.samples.java"
    missing = "dev.openandroid.samples.missing"
    if run("shell", "pm", "path", package, absent=True) or run("shell", "pm", "path", missing, absent=True):
        raise RuntimeError("Test packages must not already be installed")
    initial = forwards()
    dap = Dap()
    installed = False
    try:
        assert run("shell", "getprop", "ro.kernel.qemu") != "1"
        installed = True
        assert "Success" in run("install", "-r", contract["apk"])
        dap.request("initialize", dict(linesStartAt1=True, columnsStartAt1=True))
        roots = [str((project / "app/src/main/java").resolve())]
        valid = dict(adbPath=str(adb), serial=serial, packageName=package,
                     sourceRoots=roots, classFilters=["dev.openandroid.samples.*"])
        with tempfile.TemporaryDirectory(prefix="oas-adb-failure-") as temporary:
            mocks = {}
            for mode in ("pid", "forward", "forward-output", "offline", "unauthorized"):
                path = Path(temporary) / ("adb-" + mode + ".cmd")
                if os.name != "nt":
                    raise RuntimeError("This reply-injection test currently targets Windows")
                if mode == "pid":
                    condition = 'if "%~3"=="shell" if "%~4"=="pidof" exit /b 1\n'
                elif mode == "forward":
                    condition = 'if "%~3"=="forward" if "%~4"=="tcp:0" goto bad_forward\n'
                elif mode == "forward-output":
                    condition = 'if "%~3"=="forward" if "%~4"=="tcp:0" goto malformed_forward\n'
                else:
                    condition = 'if "%~3"=="get-state" goto bad_state\n'
                path.write_text(
                    '@echo off\n' + condition + f'"{adb}" %*\nexit /b %errorlevel%\n'
                    + f':bad_forward\n"{adb}" -s "%~2" forward tcp:0 jdwp:0\nexit /b %errorlevel%\n'
                    + f':malformed_forward\n"{adb}" %*\necho injected corrupt reply\nexit /b 0\n'
                    + f':bad_state\necho device {mode}\nexit /b 1\n', encoding="utf-8")
                mocks[mode] = str(path.resolve())
            cases = [
                ("invalid-filters", dict(classFilters=[]), "classFilters must not be empty"),
                ("invalid-roots", dict(sourceRoots=[roots[0], False]), "sourceRoot must be a nonblank string"),
                ("not-installed", dict(packageName=missing), "not installed"),
                ("bad-component", dict(component=package + "/.MissingActivity"), "does not exist"),
                ("offline", dict(adbPath=mocks["offline"]), "offline"),
                ("unauthorized", dict(adbPath=mocks["unauthorized"]), "unauthorized"),
                ("pid-timeout", dict(adbPath=mocks["pid"]), "within 10 seconds"),
                ("jdwp-failure", dict(adbPath=mocks["forward"]), "handshake"),
                ("malformed-forward-output", dict(adbPath=mocks["forward-output"]), "allocated forward port"),
            ]
            for name, changes, expected in cases:
                start = time.perf_counter()
                response = dap.request("launch", {**valid, **changes}, success=False)
                message = response["message"].replace(serial, "<test-phone>")
                assert expected.lower() in message.lower(), response
                assert not run("shell", "pidof", package, absent=True), "Rollback left a waiting/running sample"
                assert forwards() == initial, "Rollback left a forward or removed a prior one"
                results.append(dict(case=name, result="PASS", error=message,
                                    ms=round((time.perf_counter() - start) * 1000, 1),
                                    appAbsent=True, forwardsUnchanged=True))
                print(json.dumps(results[-1]), flush=True)
            # The same adapter can launch successfully after every failed request.
            dap.request("launch", valid)
            dap.event("initialized")
            dap.request("configurationDone")
            pid = run("shell", "pidof", package)
            assert pid.isdigit()
            deadline = time.monotonic() + 10
            while True:
                logs = run("logcat", "--pid=" + pid, "-d", "-s", "OAS:I", "*:S")
                if "java iteration=0" in logs or time.monotonic() >= deadline:
                    break
                time.sleep(0.1)
            assert "java iteration=0" in logs, logs
            dap.request("terminate")
            dap.event("terminated")
            dap.request("disconnect", dict(terminateDebuggee=False))
            dap.close()
            assert not run("shell", "pidof", package, absent=True)
            assert forwards() == initial
            results.append(dict(case="retry-after-failures", result="PASS", appAbsent=True, forwardsUnchanged=True))
            print(json.dumps(results[-1]), flush=True)
    finally:
        try:
            dap.close()
        finally:
            if installed:
                assert "Success" in run("uninstall", package)
                assert not run("shell", "pm", "path", package, absent=True)
            remaining = forwards() - initial
            # The injected bad-JDWP command is the only fixture-created jdwp:0 forward.
            owned = [row for row in remaining if row[1] == "jdwp:0"]
            if len(owned) == 1:
                run("forward", "--remove", owned[0][0])
            assert not owned, "Adapter failed to remove its injected forward; emergency cleanup ran"
            (args.evidence / "launch-failures-results.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
            (args.evidence / "launch-failures-commands.json").write_text(json.dumps(commands, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
