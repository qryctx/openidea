"""Host-only proof: deferred/replaced breakpoints, steps, variables, detach and EOF."""
import json
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import time
from dap_client import Dap, ROOT, marker, stopped_frame

SOURCE = ROOT / "tests" / "spike" / "DebugTarget.java"


def start_target(output):
    process = subprocess.Popen(
        ["java", "-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:0",
         "-cp", str(output), "spike.DebugTarget"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
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
    start = time.monotonic()
    dap.request("attach", dict(hostName="127.0.0.1", port=port,
                              sourceRoots=[str(SOURCE.parents[1])], classFilters=["spike.*"]))
    dap.event("initialized")
    return round((time.monotonic() - start) * 1000, 1)


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
        start = time.monotonic()
        dap.request("configurationDone")
        dap.event("breakpoint", lambda body: body["breakpoint"]["id"] == bp["id"]
                  and body["breakpoint"]["verified"])
        stop = dap.event("stopped")
        timings["firstHitMs"] = round((time.monotonic() - start) * 1000, 1)
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
            start = time.monotonic()
            dap.request(command, dict(threadId=stop["threadId"]))
            stop = dap.event("stopped", lambda body: body["reason"] == "step")
            timings[command + "Ms"] = round((time.monotonic() - start) * 1000, 1)
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
        dap.close()
        target.kill()
        target.wait()
