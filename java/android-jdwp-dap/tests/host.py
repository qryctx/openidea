"""Host-only proof: deferred/replaced breakpoints, steps, variables, detach and EOF."""
import json
from contextlib import contextmanager
import os
from pathlib import Path
import queue
import shutil
import socket
import struct
import subprocess
import tempfile
import threading
import time
import uuid
from dap_client import Dap, ROOT, marker, stopped_frame

SOURCE = ROOT / "tests" / "spike" / "DebugTarget.java"


def start_target(output, suspended=True, progress=False):
    process = subprocess.Popen(
        ["java", "-agentlib:jdwp=transport=dt_socket,server=y,suspend="
         + ("y" if suspended else "n") + ",address=127.0.0.1:0",
         "-cp", str(output), "spike.DebugTarget", *(["progress"] if progress else [])],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    lines = queue.Queue()

    def read():
        for line in process.stdout:
            lines.put(line.decode("utf-8").rstrip())

    threading.Thread(target=read, daemon=True).start()
    try:
        first = lines.get(timeout=10)
        assert "Listening for transport dt_socket at address:" in first, first
        return process, lines, int(first.rsplit(":", 1)[1].strip())
    except BaseException:
        process.kill()
        process.wait()
        raise


def wait_ready(lines):
    deadline = time.monotonic() + 10
    while True:
        line = lines.get(timeout=max(0, deadline - time.monotonic()))
        if line == "READY":
            return


def attach(dap, port):
    dap.request("initialize", dict(linesStartAt1=True, columnsStartAt1=True))
    start = time.perf_counter()
    dap.request("attach", dict(hostName="127.0.0.1", port=port,
                              sourceRoots=[str(SOURCE.parents[1])], classFilters=["spike.*"]))
    dap.event("initialized")
    return round((time.perf_counter() - start) * 1000, 1)


def heartbeat(target, lines):
    token = uuid.uuid4().hex
    target.stdin.write((token + "\n").encode("ascii"))
    target.stdin.flush()
    deadline = time.monotonic() + 3
    while True:
        try:
            line = lines.get(timeout=max(0, deadline - time.monotonic()))
        except queue.Empty as error:
            raise AssertionError("Target stopped making progress: new heartbeat was not answered") from error
        if line == "HEARTBEAT:" + token:
            return


@contextmanager
def reject_class_prepare(port):
    """Forward to the real JVM, but reject this adapter's first ClassPrepare setup."""
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    listener.settimeout(10)
    connections, errors = [], []
    rejected, disposed = threading.Event(), threading.Event()
    output_lock = threading.Lock()

    def read(sock, size):
        data = bytearray()
        while len(data) < size:
            chunk = sock.recv(size - len(data))
            if not chunk:
                raise EOFError()
            data.extend(chunk)
        return bytes(data)

    def relay(source, destination, upstream):
        try:
            while True:
                header = read(source, 11)
                length, request_id = struct.unpack(">II", header[:8])
                assert 11 <= length <= 4 * 1024 * 1024, length
                body = read(source, length - 11)
                if upstream and header[8] == 0 and header[9:11] == bytes([15, 1]) and body[0] == 8 \
                        and b"spike.*" in body and not rejected.is_set():
                    rejected.set()
                    with output_lock:
                        source.sendall(struct.pack(">IIBH", 11, request_id, 0x80, 99))
                else:
                    if upstream and header[8] == 0 and header[9:11] == bytes([1, 6]):
                        disposed.set()
                    if upstream:
                        destination.sendall(header + body)
                    else:
                        with output_lock:
                            destination.sendall(header + body)
        except (EOFError, ConnectionResetError, BrokenPipeError):
            return
        except Exception as error:
            errors.append(error)

    def serve():
        try:
            client, _ = listener.accept()
            target = socket.create_connection(("127.0.0.1", port), timeout=10)
            client.settimeout(10)
            connections.extend([client, target])
            target.sendall(read(client, 14))
            client.sendall(read(target, 14))
            downstream = threading.Thread(target=relay, args=(target, client, False))
            downstream.start()
            try:
                relay(client, target, True)
            finally:
                for connection in connections:
                    connection.shutdown(socket.SHUT_RDWR)
                downstream.join(timeout=10)
                assert not downstream.is_alive(), "JDWP downstream did not stop"
        except Exception as error:
            errors.append(error)

    server = threading.Thread(target=serve)
    server.start()
    try:
        yield listener.getsockname()[1], rejected, disposed
    finally:
        for connection in connections:
            connection.close()
        listener.close()
        server.join(timeout=10)
        assert not server.is_alive() and not errors, errors


def lifecycle_test(output):
    source = Path(output) / "lifecycle" / "source" / "spike" / SOURCE.name
    stale_root = Path(output) / "lifecycle" / "stale"
    source.parent.mkdir(parents=True)
    (stale_root / "spike").mkdir(parents=True)
    shutil.copyfile(SOURCE, source)
    shutil.copyfile(SOURCE, stale_root / "spike" / SOURCE.name)
    classes = Path(output) / "lifecycle" / "classes"
    subprocess.run(["javac", "-g", "-d", str(classes), str(source)], check=True)
    target, lines, port = start_target(classes, suspended=False, progress=True)
    dap = Dap()
    try:
        heartbeat(target, lines)
        dap.request("initialize", dict(linesStartAt1=True, columnsStartAt1=True))
        valid = dict(hostName="127.0.0.1", port=port,
                     sourceRoots=[str(source.parents[1])], classFilters=["spike.*"])
        invalid = [
            dict(classFilters=[]),
            dict(classFilters=["spike.*", 7]),
            dict(classFilters=[""]),
            dict(classFilters=["spike.*.invalid"]),
            dict(sourceRoots=[str(stale_root), str(stale_root / "missing")]),
            dict(sourceRoots=[str(stale_root), 7]),
            dict(sourceRoots=[str(source)]),
            dict(sourceRoots=7),
        ]
        for overrides in invalid:
            response = dap.request("attach", {**valid, **overrides}, success=False)
            assert "Already attached" not in response["message"], response
            heartbeat(target, lines)
        with reject_class_prepare(port) as (proxy_port, rejected, disposed):
            response = dap.request("attach", {**valid, "port": proxy_port}, success=False)
            assert rejected.wait(3) and disposed.wait(3), "Failed setup must explicitly dispose its JDWP connection"
            assert "UnsupportedOperationException" in response["message"] or "InternalException" in response["message"], response
        deadline = time.monotonic() + 3
        while True:
            listening = lines.get(timeout=max(0, deadline - time.monotonic()))
            if "Listening for transport dt_socket at address:" in listening:
                valid["port"] = int(listening.rsplit(":", 1)[1].strip())
                break
        heartbeat(target, lines)
        dap.request("attach", valid)
        dap.event("initialized")
        line = marker(source, "BREAKPOINT-JAVA")
        body = dap.request("setBreakpoints", dict(source=dict(path=str(source)),
                                                breakpoints=[dict(line=line)]))
        assert body["breakpoints"][0]["verified"], body
        dap.request("configurationDone")
        stop = dap.event("stopped")
        frame, _ = stopped_frame(dap, stop)
        assert frame["line"] == line and Path(frame["source"]["path"]) == source, frame
        # A stale root from any rejected request would make this frame's source ambiguous.
        dap.request("setBreakpoints", dict(source=dict(path=str(source)), breakpoints=[]))
        dap.request("continue", dict(threadId=stop["threadId"]))
        heartbeat(target, lines)
        dap.request("disconnect", dict(terminateDebuggee=False))
        dap.event("terminated")
        dap.close()
        heartbeat(target, lines)
        print(json.dumps(dict(result="PASS", coverage="malformed attach rejection, failed JDWP setup disposed, uncontaminated retry, live heartbeat")))
    finally:
        try:
            dap.close()
        finally:
            target.kill()
            target.wait()

    target, lines, port = start_target(classes, suspended=False, progress=True)
    dap = Dap()
    try:
        heartbeat(target, lines)
        dap.request("initialize", dict(linesStartAt1=True, columnsStartAt1=True))
        dap.request("attach", dict(hostName="127.0.0.1", port=port, sourceRoots=[str(source.parents[1])],
                                  classFilters=["spike.*"]))
        dap.event("initialized")
        original_path = str(source).upper() if os.name == "nt" else str(source)
        body = dap.request("setBreakpoints", dict(source=dict(path=original_path),
                                                breakpoints=[dict(line=line)]))
        bp = body["breakpoints"][0]
        assert bp["verified"], body
        dap.request("configurationDone")
        stop = dap.event("stopped")
        assert stop["reason"] == "breakpoint" and stop["hitBreakpointIds"] == [bp["id"]], stop
        frame, _ = stopped_frame(dap, stop)
        assert Path(frame["source"]["path"]) == source, frame
        source.rename(source.with_suffix(".renamed"))
        assert not source.exists()
        for invalid_path in ("", None, 7, str(source.parent)):
            error = dap.request("setBreakpoints", dict(source=dict(path=invalid_path), breakpoints=[]), success=False)
            assert "source.path" in error["message"], error
        dap.request("setBreakpoints", dict(source=dict(path=original_path),
                                         breakpoints=[dict(line=line)]), success=False)
        cleared = dap.request("setBreakpoints", dict(source=dict(path=original_path), breakpoints=[]))
        assert cleared["breakpoints"] == [], cleared
        dap.request("continue", dict(threadId=stop["threadId"]))
        # Every heartbeat requires another work() call across the former breakpoint.
        for _ in range(3):
            heartbeat(target, lines)
        worker = next(t for t in dap.request("threads")["threads"] if t["name"] == "main")
        dap.request("pause", dict(threadId=worker["id"]))
        pause = dap.event("stopped")
        assert pause["reason"] == "pause", pause
        dap.request("disconnect", dict(terminateDebuggee=False))
        dap.event("terminated")
        dap.close()
        heartbeat(target, lines)
        print(json.dumps(dict(result="PASS", coverage="renamed disposable source, empty replacement clears requests, no re-hit, heartbeat after detach")))
    finally:
        try:
            dap.close()
        finally:
            target.kill()
            target.wait()


with tempfile.TemporaryDirectory(prefix="oas-jdi-") as output:
    subprocess.run(["python", str(ROOT / "build.py")], check=True)
    subprocess.run(["javac", "-g", "-d", output, str(SOURCE)], check=True)
    target, lines, port = start_target(output)
    dap = Dap()
    timings = {}
    try:
        timings["attachMs"] = attach(dap, port)
        line = marker(SOURCE, "BREAKPOINT-JAVA")
        bp = dap.request("setBreakpoints", dict(source=dict(path=str(SOURCE)),
                                               breakpoints=[dict(line=line)]))["breakpoints"][0]
        assert not bp["verified"], bp
        dap.request("setBreakpoints", dict(source=dict(path=str(SOURCE)),
                                         breakpoints=[dict(line=line, condition="false")]), success=False)
        dap.request("setExceptionBreakpoints", dict(filters=[]))
        start = time.perf_counter()
        dap.request("configurationDone")
        dap.event("breakpoint", lambda body: body["breakpoint"]["id"] == bp["id"]
                  and body["breakpoint"]["verified"])
        stop = dap.event("stopped")
        timings["firstHitMs"] = round((time.perf_counter() - start) * 1000, 1)
        assert stop["reason"] == "breakpoint" and stop["hitBreakpointIds"] == [bp["id"]], stop
        frame, locals_ = stopped_frame(dap, stop)
        assert frame["line"] == line and Path(frame["source"]["path"]) == SOURCE, frame
        assert locals_["seed"]["value"] == "3" and locals_["local"]["value"] == "12", locals_
        fields = dap.request("variables", dict(variablesReference=locals_["this"]["variablesReference"]))
        assert any(v["name"] == "spike.DebugTarget.field" and v["value"] == "9"
                   for v in fields["variables"]), fields
        array = dap.request("variables", dict(variablesReference=locals_["values"]["variablesReference"],
                                            start=1, count=1))
        assert array["variables"][0]["name"] == "[1]" and array["variables"][0]["value"] == "9", array
        stale = locals_["this"]["variablesReference"]
        for command, expected, expected_local in [
                ("stepIn", "BREAKPOINT-INNER", ("arg", "12")),
                ("next", "BREAKPOINT-RETURN", ("local", "13")),
                ("stepOut", "BREAKPOINT-JAVA", None),
                ("next", "BREAKPOINT-AFTER", ("result", "26"))]:
            start = time.perf_counter()
            dap.request(command, dict(threadId=stop["threadId"]))
            stop = dap.event("stopped", lambda body: body["reason"] == "step")
            timings.setdefault(command + "Ms", []).append(round((time.perf_counter() - start) * 1000, 1))
            frame, locals_ = stopped_frame(dap, stop)
            assert frame["line"] == marker(SOURCE, expected), (command, frame)
            if expected_local:
                assert locals_[expected_local[0]]["value"] == expected_local[1], locals_
        dap.request("variables", dict(variablesReference=stale), success=False)
        removed = dap.request("setBreakpoints", dict(source=dict(path=str(SOURCE)), breakpoints=[]))
        assert removed["breakpoints"] == [], removed
        dap.request("continue", dict(threadId=stop["threadId"]))
        wait_ready(lines)
        thread = next(t for t in dap.request("threads")["threads"] if t["name"] == "main")
        dap.request("pause", dict(threadId=thread["id"]))
        pause = dap.event("stopped", lambda body: body["reason"] == "pause")
        assert dap.request("stackTrace", dict(threadId=pause["threadId"]))["stackFrames"]
        dap.request("disconnect", dict(terminateDebuggee=True), success=False)
        dap.request("disconnect", dict(terminateDebuggee=False))
        dap.event("terminated")
        dap.close()
        time.sleep(0.2)
        assert target.poll() is None, "Disconnect killed the target"
        listening = lines.get(timeout=10)
        assert "Listening for transport dt_socket at address:" in listening, listening
        port = int(listening.rsplit(":", 1)[1].strip())
        dap = Dap()
        timings["reattachMs"] = attach(dap, port)
        bp = dap.request("setBreakpoints", dict(source=dict(path=str(SOURCE)),
                                               breakpoints=[dict(line=line)]))["breakpoints"][0]
        assert bp["verified"], bp
        dap.close()
        assert target.poll() is None, "EOF killed the target"
        print(json.dumps(dict(result="PASS", timings=timings,
                              coverage="deferred/loaded/replaced Java breakpoints, next/in/out, args/locals/fields/array, pause, stale handles, disconnect/EOF survives")))
    finally:
        try:
            dap.close()
        finally:
            target.kill()
            target.wait()
    lifecycle_test(output)
