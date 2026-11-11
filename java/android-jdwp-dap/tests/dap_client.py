"""Reusable framed DAP client; logs no device identifiers."""
from collections import deque
import json
from pathlib import Path
import queue
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parents[1]


class Dap:
    def __init__(self):
        self.process = subprocess.Popen(
            ["java", "--add-modules", "jdk.jdi", "-jar",
             str(ROOT / "build" / "android-jdwp-dap.jar")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.messages = queue.Queue()
        self.events = deque()
        self.stderr = []
        self.seq = 0
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._errors, daemon=True).start()

    def _errors(self):
        for line in self.process.stderr:
            self.stderr.append(line.decode("utf-8", errors="replace").rstrip())

    def _read(self):
        try:
            while True:
                headers = {}
                while True:
                    line = self.process.stdout.readline()
                    if not line:
                        raise EOFError("Adapter exited")
                    if line == b"\r\n":
                        break
                    key, value = line.decode("ascii").split(":", 1)
                    headers[key.lower()] = value.strip()
                size = int(headers["content-length"])
                body = self.process.stdout.read(size)
                if len(body) != size:
                    raise EOFError("Truncated DAP body")
                self.messages.put(json.loads(body))
        except Exception as error:
            self.messages.put(error)

    def _next(self, deadline):
        try:
            message = self.messages.get(timeout=max(0, deadline - time.monotonic()))
        except queue.Empty as error:
            raise TimeoutError(f"DAP timeout; stderr={self.stderr}") from error
        if isinstance(message, Exception):
            raise message
        return message

    def request(self, command, arguments=None, success=True):
        self.seq += 1
        message = dict(seq=self.seq, type="request", command=command, arguments=arguments or {})
        payload = json.dumps(message, ensure_ascii=False).encode("utf-8")
        self.process.stdin.write(f"Content-Length: {len(payload)}\r\n\r\n".encode("ascii") + payload)
        self.process.stdin.flush()
        deadline = time.monotonic() + 20
        while True:
            response = self._next(deadline)
            if response["type"] == "event":
                self.events.append(response)
                continue
            assert response["request_seq"] == self.seq, response
            assert response["success"] == success, response
            return response.get("body", {}) if success else response

    def event(self, name, predicate=lambda body: True, timeout=20):
        deadline = time.monotonic() + timeout
        while True:
            for event in list(self.events):
                if event["event"] == name and predicate(event.get("body", {})):
                    self.events.remove(event)
                    return event.get("body", {})
            message = self._next(deadline)
            assert message["type"] == "event", message
            self.events.append(message)

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        assert self.process.returncode == 0, self.stderr


def marker(source, text):
    matches = [index for index, line in enumerate(source.read_text(encoding="utf-8").splitlines(), 1)
               if text in line]
    assert len(matches) == 1, (source.name, text, matches)
    return matches[0]


def stopped_frame(dap, stop):
    trace = dap.request("stackTrace", dict(threadId=stop["threadId"], startFrame=0, levels=10))
    assert trace["stackFrames"], trace
    frame = trace["stackFrames"][0]
    scopes = dap.request("scopes", dict(frameId=frame["id"]))["scopes"]
    locals_ = dap.request("variables", dict(variablesReference=scopes[0]["variablesReference"]))["variables"]
    return frame, {value["name"]: value for value in locals_}
