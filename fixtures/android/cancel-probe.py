"""Real Windows Gradle cancellation: retained process handles and task heartbeats."""
import argparse
import ctypes
from ctypes import wintypes
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

WAIT_OBJECT_0 = 0
WAIT_TIMEOUT = 258
ACCESS = 0x00100000 | 0x1000 | 0x0001  # SYNCHRONIZE, QUERY_LIMITED_INFORMATION, TERMINATE


class ProcessEntry(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
        ("pid", wintypes.DWORD), ("heap", ctypes.c_size_t),
        ("module", wintypes.DWORD), ("threads", wintypes.DWORD),
        ("parent", wintypes.DWORD), ("priority", wintypes.LONG),
        ("flags", wintypes.DWORD), ("exe", wintypes.WCHAR * 260),
    ]


class Windows:
    def __init__(self):
        self.api = ctypes.WinDLL("kernel32", use_last_error=True)
        signatures = {
            "OpenProcess": ([wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE),
            "CloseHandle": ([wintypes.HANDLE], wintypes.BOOL),
            "WaitForSingleObject": ([wintypes.HANDLE, wintypes.DWORD], wintypes.DWORD),
            "GetProcessTimes": ([wintypes.HANDLE, *[ctypes.POINTER(wintypes.FILETIME)] * 4], wintypes.BOOL),
            "CreateToolhelp32Snapshot": ([wintypes.DWORD, wintypes.DWORD], wintypes.HANDLE),
            "Process32FirstW": ([wintypes.HANDLE, ctypes.POINTER(ProcessEntry)], wintypes.BOOL),
            "Process32NextW": ([wintypes.HANDLE, ctypes.POINTER(ProcessEntry)], wintypes.BOOL),
        }
        for name, (arguments, result) in signatures.items():
            function = getattr(self.api, name)
            function.argtypes = arguments
            function.restype = result

    def processes(self):
        snapshot = self.api.CreateToolhelp32Snapshot(2, 0)
        if snapshot == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            entry = ProcessEntry()
            entry.dwSize = ctypes.sizeof(entry)
            more = self.api.Process32FirstW(snapshot, ctypes.byref(entry))
            result = []
            while more:
                result.append((int(entry.pid), int(entry.parent)))
                more = self.api.Process32NextW(snapshot, ctypes.byref(entry))
            if ctypes.get_last_error() != 18:  # ERROR_NO_MORE_FILES
                raise ctypes.WinError(ctypes.get_last_error())
            return result
        finally:
            self.api.CloseHandle(snapshot)

    def tree(self, root):
        processes = self.processes()
        parents = [root]
        seen = {root.pid}
        children = []
        try:
            while parents:
                parent = parents.pop()
                for pid, ppid in processes:
                    if ppid != parent.pid or pid in seen:
                        continue
                    seen.add(pid)
                    try:
                        child = OwnedProcess(self, pid)
                    except OSError as error:
                        if error.winerror == 87:  # Process exited between snapshot and open.
                            continue
                        raise
                    if child.created < parent.created:
                        child.close()
                        continue
                    children.append(child)
                    parents.append(child)
            return children
        except BaseException:
            for child in children:
                child.close()
            raise


class OwnedProcess:
    def __init__(self, windows, pid):
        self.windows = windows
        self.pid = pid
        self.handle = windows.api.OpenProcess(ACCESS, False, pid)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        times = [wintypes.FILETIME() for _ in range(4)]
        if not windows.api.GetProcessTimes(self.handle, *[ctypes.byref(t) for t in times]):
            error = ctypes.get_last_error()
            self.close()
            raise ctypes.WinError(error)
        self.created = (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime

    def running(self):
        status = self.windows.api.WaitForSingleObject(self.handle, 0)
        if status not in (WAIT_OBJECT_0, WAIT_TIMEOUT):
            raise ctypes.WinError(ctypes.get_last_error())
        return status == WAIT_TIMEOUT

    def wait(self, deadline):
        milliseconds = max(0, int((deadline - time.monotonic()) * 1000))
        status = self.windows.api.WaitForSingleObject(self.handle, milliseconds)
        if status not in (WAIT_OBJECT_0, WAIT_TIMEOUT):
            raise ctypes.WinError(ctypes.get_last_error())
        return status == WAIT_OBJECT_0

    def close(self):
        if self.handle:
            self.windows.api.CloseHandle(self.handle)
            self.handle = None

    def identity(self):
        return dict(pid=self.pid, creationTime100ns=self.created)


def decode_native(data):
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode(f"cp{ctypes.windll.kernel32.GetOEMCP()}")


def kill_client(client, children):
    """Mirror taskkill_tree_of followed by child.kill/wait, including the 5 s wait."""
    command_result = None
    if children:
        command = ["taskkill", "/T", "/F", "/PID", str(client.pid)]
        result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True,
                                creationflags=subprocess.CREATE_NO_WINDOW, timeout=15)
        command_result = dict(command=command, exitCode=result.returncode,
                              stdout=decode_native(result.stdout),
                              stderr=decode_native(result.stderr))
        deadline = time.monotonic() + 5
        for child in children:
            child.wait(deadline)
    if client.poll() is None:
        client.kill()
    client.wait(timeout=5)
    return command_result


def cleanup_owned(daemon, windows):
    """Explicit later cleanup, never counted as cancellation of the fresh client."""
    if not daemon.running():
        return dict(needed=False, completed=True, seconds=0)
    children = windows.tree(daemon)
    start = time.monotonic()
    try:
        # A retained live handle prevents PID reuse; the daemon was proven to be our child.
        command = ["taskkill", "/T", "/F", "/PID", str(daemon.pid)]
        result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True,
                                creationflags=subprocess.CREATE_NO_WINDOW, timeout=15)
        deadline = time.monotonic() + 5
        completed = daemon.wait(deadline)
        for child in children:
            completed = child.wait(deadline) and completed
        return dict(needed=True, completed=completed, command=command,
                    exitCode=result.returncode, seconds=round(time.monotonic() - start, 3))
    finally:
        for child in children:
            child.close()


def progress(path, token):
    if not path.exists():
        return None
    data = path.read_bytes()
    lines = data.split(b"\n")[:-1]  # An in-progress append is not a complete heartbeat.
    if not lines:
        return None
    event, run, pid, count, timestamp = lines[-1].decode("utf-8").split(",")
    if run != token or event not in ("WARM", "HEARTBEAT", "INTERRUPTED", "FINISHED"):
        raise RuntimeError("OWNERSHIP_FAILED: unexpected heartbeat identity")
    return dict(event=event, pid=int(pid), count=int(count), epochMillis=int(timestamp))


def await_progress(path, token, client, minimum=0):
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        event = progress(path, token)
        if event and event["count"] >= minimum:
            return event
        if client.poll() is not None:
            raise RuntimeError(f"BUILD_FAILED_BEFORE_PROBE: exit={client.returncode}")
        time.sleep(0.05)
    raise RuntimeError("PROBE_TIMEOUT: Gradle did not execute the disposable task")


def fixture_fingerprint(root):
    excluded = {"build", ".gradle", ".kotlin", "__pycache__"}
    files = [p for p in root.rglob("*") if p.is_file()
             and not excluded.intersection(p.relative_to(root).parts)
             and p.name != "local.properties"]
    return {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}


def experiment(windows, wrapper, project, home, evidence, mode, iteration):
    label = f"{mode}-{iteration}"
    token = label
    heartbeat = project / (label + ".csv")
    warm_marker = project / (label + "-warm.csv")
    events = []
    result = dict(mode=mode, iteration=iteration, cancellationPassed=False)
    handles = []
    daemon = None
    client = None
    try:
        def launch(task, marker):
            command = [str(wrapper), "-p", str(project), "--gradle-user-home", str(home),
                       "--console=plain", "--daemon" if mode == "warm-daemon" else "--no-daemon",
                       "-PoasToken=" + token, "-PoasProgress=" + str(marker), task]
            output = (evidence / (label + "-" + task + ".log")).open("wb")
            try:
                launched = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=output,
                                            stderr=subprocess.STDOUT,
                                            creationflags=subprocess.CREATE_NO_WINDOW)
            finally:
                output.close()
            events.append(dict(kind="launch", command=command, clientPid=launched.pid))
            return launched

        if mode == "warm-daemon":
            client = launch("oasWarmDaemon", warm_marker)
            root_handle = OwnedProcess(windows, client.pid)
            handles.append(root_handle)
            warm_event = await_progress(warm_marker, token, client)
            warm_children = windows.tree(root_handle)
            handles.extend(warm_children)
            daemon = next((p for p in warm_children if p.pid == warm_event["pid"]), None)
            if daemon is None:
                raise RuntimeError("OWNERSHIP_FAILED: warmed daemon was not created by our warm client")
            client.wait(timeout=120)
            if client.returncode != 0 or not daemon.running():
                raise RuntimeError("WARM_FAILED: daemon must remain live after a successful warm client")
            result["warmedDaemon"] = daemon.identity()
            events.append(dict(kind="warmClientExited", exitCode=client.returncode))
            client = None

        client = launch("oasCancellationProbe", heartbeat)
        root_handle = OwnedProcess(windows, client.pid)
        handles.append(root_handle)
        before = await_progress(heartbeat, token, client, minimum=5)
        children = windows.tree(root_handle)
        handles.extend(children)
        if mode == "no-daemon":
            daemon = next((p for p in children if p.pid == before["pid"]), None)
            if daemon is None:
                raise RuntimeError("OWNERSHIP_FAILED: task JVM is not inside the owned client tree")
        elif before["pid"] != daemon.pid or not daemon.running():
            raise RuntimeError("DAEMON_REUSE_FAILED: task must run in the retained warmed daemon")
        result["taskJvm"] = daemon.identity()
        result["clientTree"] = [root_handle.identity(), *[p.identity() for p in children]]
        result["taskJvmInClientTree"] = any(p.pid == daemon.pid for p in children)
        request = time.monotonic()
        result["cancellationRequestUtc"] = datetime.now(timezone.utc).isoformat()
        result["heartbeatBeforeRequest"] = before
        events.append(dict(kind="cancellationRequest", epochMillis=int(time.time() * 1000)))
        result["taskkill"] = kill_client(client, children)
        feedback = time.monotonic() - request
        result["clientExitCode"] = client.returncode
        result["clientFeedbackSeconds"] = round(feedback, 3)
        result["clientFeedbackWithin5Seconds"] = feedback <= 5
        stopped = None
        reason = None
        while True:
            current = progress(heartbeat, token)
            elapsed = time.monotonic() - request
            events.append(dict(kind="observation", seconds=round(elapsed, 3), progress=current))
            if not daemon.running():
                stopped, reason = elapsed, "retainedTaskJvmHandleSignalled"
                break
            if current and current["event"] == "INTERRUPTED":
                stopped, reason = elapsed, "taskRecordedInterruptedException"
                break
            if elapsed >= 5:
                break
            time.sleep(0.05)
        result["workStopBoundSeconds"] = None if stopped is None else round(stopped, 3)
        result["workStopEvidence"] = reason
        result["heartbeatAtCancellationObservationEnd"] = progress(heartbeat, token)
        result["cancellationPassed"] = (stopped is not None and stopped <= 5
                                        and result["clientFeedbackWithin5Seconds"]
                                        and client.returncode != 0
                                        and (result["taskkill"] is None or result["taskkill"]["exitCode"] == 0))
        # Observe for another second to reject a transient quiet heartbeat or new work.
        settled = progress(heartbeat, token)
        time.sleep(1)
        after = progress(heartbeat, token)
        result["heartbeatStableAfterObservation"] = after == settled
        if result["cancellationPassed"] and after != settled:
            result["cancellationPassed"] = False
            result["failure"] = "WORK_RESTARTED_AFTER_CANCELLATION"
        result["heartbeatBeforeExplicitCleanup"] = after
    except (OSError, RuntimeError, subprocess.SubprocessError) as failure:
        result["failure"] = str(failure)
    finally:
        if client is not None and client.poll() is None:
            root = OwnedProcess(windows, client.pid)
            pending = windows.tree(root)
            try:
                events.append(dict(kind="failedProbeClientCleanup", result=kill_client(client, pending)))
            finally:
                root.close()
                for child in pending:
                    child.close()
        if daemon is not None:
            cleanup_start = time.monotonic()
            result["explicitDaemonCleanup"] = cleanup_owned(daemon, windows)
            final = progress(heartbeat, token)
            time.sleep(1)
            result["heartbeatAfterExplicitCleanup"] = progress(heartbeat, token)
            result["cleanupHeartbeatStable"] = final == result["heartbeatAfterExplicitCleanup"]
            result["cleanupObservationSeconds"] = round(time.monotonic() - cleanup_start, 3)
            daemon_log = home / "daemon/8.14.6" / f"daemon-{daemon.pid}.out.log"
            if daemon_log.exists():
                (evidence / (label + "-daemon.log")).write_bytes(daemon_log.read_bytes())
        result["ownedProcessesStillRunning"] = [p.identity() for p in handles if p.running()]
        result["cleanupPassed"] = (not result["ownedProcessesStillRunning"]
                                   and result.get("explicitDaemonCleanup", {}).get("completed", False)
                                   and result.get("cleanupHeartbeatStable", False))
        if heartbeat.exists():
            (evidence / (label + "-heartbeat.csv")).write_bytes(heartbeat.read_bytes())
        if warm_marker.exists():
            (evidence / (label + "-warm.csv")).write_bytes(warm_marker.read_bytes())
        for handle in handles:
            handle.close()
        result["events"] = events
        (evidence / (label + "-result.json")).write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--mode", choices=["both", "no-daemon", "warm-daemon"], default="both")
    parser.add_argument("--repeats", type=int, default=2)
    args = parser.parse_args()
    if os.name != "nt" or args.repeats < 1:
        parser.error("Windows and --repeats >= 1 are required")
    cache = os.environ.get("GRADLE_USER_HOME")
    if not cache or Path(cache).resolve() == (Path.home() / ".gradle").resolve():
        parser.error("Set a dedicated GRADLE_USER_HOME; no default/shared daemon is eligible")
    root = Path(__file__).resolve().parent
    before = fixture_fingerprint(root)
    args.evidence.mkdir(parents=True, exist_ok=True)
    results = []
    windows = Windows()
    with tempfile.TemporaryDirectory(prefix="m2-", dir=cache) as temporary:
        home = Path(temporary)
        project = home / "project"
        project.mkdir()
        (project / "settings.gradle").write_text("rootProject.name = 'oas-owned-cancellation'\n", encoding="utf-8")
        (project / "gradle.properties").write_text(
            "org.gradle.jvmargs=-Xmx512m -Dfile.encoding=UTF-8\norg.gradle.workers.max=1\n", encoding="utf-8")
        (project / "build.gradle").write_text("""
def record = { String state, int sequence ->
    def file = new File(providers.gradleProperty('oasProgress').get())
    file.append("${state},${providers.gradleProperty('oasToken').get()},${ProcessHandle.current().pid()},${sequence},${System.currentTimeMillis()}\\n", 'UTF-8')
}
tasks.register('oasWarmDaemon') {
    doLast {
        record('WARM', 1)
        Thread.sleep(3000)
    }
}
tasks.register('oasCancellationProbe') {
    doLast {
        int sequence = 0
        try {
            while (sequence < 120) {
                record('HEARTBEAT', ++sequence)
                Thread.sleep(250)
            }
            record('FINISHED', sequence)
        } catch (InterruptedException interrupted) {
            record('INTERRUPTED', sequence)
            throw interrupted
        }
    }
}
""", encoding="utf-8")
        modes = ["no-daemon", "warm-daemon"] if args.mode == "both" else [args.mode]
        for iteration in range(1, args.repeats + 1):
            for mode in modes:
                row = experiment(windows, root / "toolchains/conservative/gradlew.bat",
                                 project, home, args.evidence, mode, iteration)
                results.append(row)
                print(json.dumps({k: row.get(k) for k in (
                    "mode", "iteration", "cancellationPassed", "clientFeedbackSeconds",
                    "workStopBoundSeconds", "cleanupPassed", "failure")}), flush=True)
                if not row["cleanupPassed"]:
                    raise RuntimeError("OWNED_CLEANUP_FAILED: stop; do not start another build")
        # No new descendants may survive outside the snapshots we retained.
        live = []
        for pid, _ in windows.processes():
            # Gradle writes daemon PID registry/logs only in this disposable private home.
            if (home / "daemon/8.14.6" / f"daemon-{pid}.out.log").exists():
                try:
                    process = OwnedProcess(windows, pid)
                except OSError as error:
                    if error.winerror == 87:
                        continue
                    raise
                try:
                    if process.running():
                        live.append(process.identity())
                finally:
                    process.close()
        if live:
            raise RuntimeError("UNPROVEN_LIVE_DAEMON: no cleanup by guessed PID; " + json.dumps(live))
    unchanged = before == fixture_fingerprint(root)
    summary = dict(results=results, fixtureInputsUnchanged=unchanged,
                   allCancellationsPassed=all(r["cancellationPassed"] for r in results),
                   allCleanupPassed=all(r["cleanupPassed"] for r in results),
                   finalPrivateDaemonScanEmpty=True)
    (args.evidence / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return 0 if summary["allCancellationsPassed"] and summary["allCleanupPassed"] and unchanged else 1


if __name__ == "__main__":
    raise SystemExit(main())
