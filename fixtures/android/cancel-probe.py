"""Measure a Windows console-break request against an isolated real Gradle task."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser()
parser.add_argument("--evidence", type=Path, required=True)
args = parser.parse_args()
if os.name != "nt":
    parser.error("This experiment measures Windows CTRL_BREAK_EVENT only")
cache = os.environ.get("GRADLE_USER_HOME")
if not cache or Path(cache).resolve() == (Path.home() / ".gradle").resolve():
    parser.error("A dedicated GRADLE_USER_HOME is required")
root = Path(__file__).resolve().parent
args.evidence.mkdir(parents=True, exist_ok=True)
log = args.evidence / "cancel.log"
with tempfile.TemporaryDirectory(prefix="cancel-", dir=cache) as temp:
    init = Path(temp) / "probe.gradle"
    init.write_text("""
gradle.projectsEvaluated {
    gradle.rootProject.tasks.register('oasCancellationProbe') {
        doLast {
            println 'OAS_CANCEL_PROBE_RUNNING'
            Thread.sleep(30000)
        }
    }
}
""", encoding="utf-8")
    command = [str(root / "toolchains/conservative/gradlew.bat"), "-p",
               str(root / "f1-kotlin"), "-I", str(init), "oasCancellationProbe",
               "--no-daemon", "--console=plain"]
    result = dict(command=command, requestedSignal="CTRL_BREAK_EVENT")
    with log.open("wb") as output:
        process = subprocess.Popen(command, stdout=output, stderr=subprocess.STDOUT,
                                   creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
        deadline = time.monotonic() + 120
        while process.poll() is None and time.monotonic() < deadline:
            if "OAS_CANCEL_PROBE_RUNNING" in log.read_text(encoding="utf-8", errors="replace"):
                break
            time.sleep(0.1)
        else:
            raise RuntimeError("Gradle probe did not reach task execution")
        start = time.monotonic()
        try:
            process.send_signal(signal.CTRL_BREAK_EVENT)
            result["signalDelivered"] = True
        except OSError as failure:
            result["signalDelivered"] = False
            result["error"] = str(failure)
        try:
            process.wait(timeout=5)
            result["exitedWithin5Seconds"] = True
        except subprocess.TimeoutExpired:
            result["exitedWithin5Seconds"] = False
            # The deliberately bounded task completes on its own; do not kill shared daemons.
            process.wait(timeout=45)
        result["secondsAfterRequest"] = round(time.monotonic() - start, 3)
        result["exitCode"] = process.returncode
        result["status"] = ("cancelled" if result["signalDelivered"]
                            and result["exitedWithin5Seconds"] and process.returncode != 0
                            else "notCancelled")
    (args.evidence / "cancel-result.json").write_text(
        json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result), flush=True)
