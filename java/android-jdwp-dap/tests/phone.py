"""Real-device ART proof using the shared sample contract; cleans only owned resources."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from dap_client import Dap, ROOT, marker, stopped_frame

FIXTURES = ROOT.parents[1] / "fixtures" / "android"
spec = importlib.util.spec_from_file_location("sample_contract", FIXTURES / "validate-run.py")
contract_module = importlib.util.module_from_spec(spec)
sys.dont_write_bytecode = True
spec.loader.exec_module(contract_module)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--case", choices=["f1-kotlin", "f2-java", "f3-mixed"])
    parser.add_argument("--lambda-probe", action="store_true")
    parser.add_argument("--launch", action="store_true")
    parser.add_argument("--start-running", action="store_true")
    parser.add_argument("--stop-mode", choices=["detach", "terminate", "disconnect"], default="detach")
    args = parser.parse_args()
    if (args.start_running or args.stop_mode != "detach") and not args.launch:
        parser.error("--start-running and Stop tests require --launch")
    args.evidence.mkdir(parents=True, exist_ok=True)
    sdk = os.environ.get("ANDROID_HOME")
    if not sdk:
        parser.error("ANDROID_HOME must point to the existing SDK")
    adb = Path(sdk) / "platform-tools" / ("adb.exe" if os.name == "nt" else "adb")
    discovery = subprocess.run([str(adb), "devices", "-l"], check=True,
                               capture_output=True, encoding="utf-8")
    devices = [line.split() for line in discovery.stdout.splitlines()
               if len(line.split()) > 1 and line.split()[1] == "device"]
    if len(devices) != 1 or devices[0][0].startswith("emulator-"):
        parser.error("Exactly one authorized physical device is required")
    serial = devices[0][0]
    commands, results = [], []

    def run(*arguments, absent_package_ok=False):
        start = time.perf_counter()
        result = subprocess.run([str(adb), "-s", serial, *arguments], capture_output=True,
                                encoding="utf-8", errors="strict", timeout=30)
        if arguments == ("forward", "--list"):
            result.stdout = "\n".join(line for line in result.stdout.splitlines()
                                     if line.split() and line.split()[0] == serial)
        commands.append(dict(command=["adb", "-s", "<test-phone>", *arguments],
                             exitCode=result.returncode,
                             ms=round((time.perf_counter() - start) * 1000, 1),
                             stdout=result.stdout.replace(serial, "<test-phone>"),
                             stderr=result.stderr.replace(serial, "<test-phone>")))
        absent = (absent_package_ok and result.returncode == 1
                  and not result.stdout.strip() and not result.stderr.strip())
        if result.returncode and not absent:
            raise RuntimeError(f"ADB {arguments[0]} failed ({result.returncode}): {result.stderr}")
        return result.stdout.strip()

    def set_line(dap, source, text):
        line = marker(source, text)
        body = dap.request("setBreakpoints", dict(source=dict(path=str(source)),
                                               breakpoints=[dict(line=line)]))
        assert len(body["breakpoints"]) == 1, body
        return line, body["breakpoints"][0]

    def forwards():
        return {tuple(line.split()[1:]) for line in run("forward", "--list").splitlines()}

    def step(dap, command, stop, timings):
        start = time.perf_counter()
        dap.request(command, dict(threadId=stop["threadId"]))
        next_stop = dap.event("stopped")
        assert next_stop["reason"] == "step", next_stop
        timings[command + "Ms"] = round((time.perf_counter() - start) * 1000, 1)
        return next_stop

    try:
        if run("shell", "getprop", "ro.kernel.qemu") == "1":
            raise RuntimeError("Emulators are out of scope")
        cases = {"f1-kotlin": "kotlin", "f2-java": "java", "f3-mixed": "mixed"}
        for fixture, name in cases.items():
            if args.case and args.case != fixture:
                continue
            project = FIXTURES / fixture
            contract = contract_module.host_contract(project, name)
            package = contract["applicationId"]
            assert package == "dev.openandroid.samples." + name
            if run("shell", "pm", "path", package, absent_package_ok=True):
                raise RuntimeError(f"Already installed: {package}; another session may own it")
            if name == "mixed":
                source = project / "library/src/main/java/dev/openandroid/samples/library/JavaProbe.java"
                second = project / "library/src/main/kotlin/dev/openandroid/samples/library/KotlinProbe.kt"
                final_marker = "BREAKPOINT-TARGET-2"
            else:
                language = "kotlin" if name == "kotlin" else "java"
                extension = "kt" if name == "kotlin" else "java"
                source = project / f"app/src/main/{language}/dev/openandroid/samples/{name}/MainActivity.{extension}"
                second = source
                final_marker = "BREAKPOINT-TARGET-3"
            roots = [str(path.resolve()) for path in project.glob("*/src/main/*")
                     if path.name in ("java", "kotlin") and path.is_dir()]
            installed, forward, dap = False, None, None
            initial_forwards = forwards()
            prior_pid = None
            owned_forward = None
            try:
                # Ownership is established before install; a timeout still runs cleanup.
                installed = True
                assert "Success" in run("install", "-r", contract["apk"])
                component = run("shell", "cmd", "package", "resolve-activity", "--brief",
                                "-c", "android.intent.category.LAUNCHER", package).splitlines()[-1]
                expected = package + "/" + contract["launcher"]
                expanded = component
                if component.startswith(package + "/."):
                    expanded = package + "/" + package + component.split("/", 1)[1]
                assert expanded == expected, (expanded, expected)
                if args.start_running:
                    assert "Status: ok" in run("shell", "am", "start", "-W", "-n", component)
                    prior_pid = run("shell", "pidof", package)
                    assert re.fullmatch(r"\d+", prior_pid), prior_pid
                dap = Dap()
                caps = dap.request("initialize", dict(linesStartAt1=True, columnsStartAt1=True))
                timings = {}
                if args.launch:
                    assert caps["supportsTerminateRequest"] and caps["supportsTerminateDebuggee"], caps
                    start = time.perf_counter()
                    vm = dap.request("launch", dict(adbPath=str(adb.resolve()), serial=serial,
                                                   packageName=package, sourceRoots=roots,
                                                   classFilters=["dev.openandroid.samples.*"]))
                    dap.event("initialized")
                    timings["launchMs"] = round((time.perf_counter() - start) * 1000, 1)
                else:
                    launch = run("shell", "am", "start", "-D", "-n", component)
                    assert "Error" not in launch, launch
                deadline = time.perf_counter() + 10
                while True:
                    pid = run("shell", "pidof", package, absent_package_ok=True)
                    if pid:
                        break
                    if time.perf_counter() >= deadline:
                        raise RuntimeError("Sample process did not become ready within 10 seconds")
                    time.sleep(0.1)
                assert re.fullmatch(r"\d+", pid), "Expected a single app process"
                if prior_pid is not None:
                    assert pid != prior_pid, "launch -S must replace the previously running app process"
                if args.launch:
                    owned = forwards() - initial_forwards
                    assert len(owned) == 1 and next(iter(owned))[1] == "jdwp:" + pid, owned
                    owned_forward = next(iter(owned))
                else:
                    allocated = run("forward", "tcp:0", "jdwp:" + pid)
                    assert re.fullmatch(r"\d+", allocated), "adb must report its allocated port"
                    forward = "tcp:" + allocated
                    start = time.perf_counter()
                    vm = dap.request("attach", dict(hostName="127.0.0.1", port=int(allocated),
                                                   sourceRoots=roots, classFilters=["dev.openandroid.samples.*"]))
                    dap.event("initialized")
                    timings["attachMs"] = round((time.perf_counter() - start) * 1000, 1)
                line, bp = set_line(dap, source, "BREAKPOINT-TARGET-1")
                start = time.perf_counter()
                dap.request("configurationDone")
                stop = dap.event("stopped")
                timings["firstHitMs"] = round((time.perf_counter() - start) * 1000, 1)
                assert stop["reason"] == "breakpoint" and bp["id"] in stop["hitBreakpointIds"], stop
                frame, locals_ = stopped_frame(dap, stop)
                assert frame["line"] == line and Path(frame["source"]["path"]) == source.resolve(), frame
                if name != "mixed":
                    assert locals_["iteration"]["value"] == "0" and locals_["count"]["value"] == "1", locals_
                value = locals_["value"]
                fields = dap.request("variables", dict(variablesReference=value["variablesReference"]))["variables"]
                assert any(v["name"].endswith(".count") and v["value"] == "1" for v in fields), fields
                assert any(v["name"].endswith(".title") and v["value"] == json.dumps(name) for v in fields), fields
                array = dap.request("variables", dict(variablesReference=locals_["values"]["variablesReference"],
                                                     start=0, count=3))["variables"]
                assert [v["value"] for v in array] == ["0", "1", "2"], array
                assert locals_["labels"]["variablesReference"] > 0 and locals_["counters"]["variablesReference"] > 0
                collections = {}
                for key in ("labels", "counters"):
                    collections[key] = dap.request("variables", dict(
                        variablesReference=locals_[key]["variablesReference"]))["variables"]
                    assert collections[key], (key, collections[key])
                stop = step(dap, "stepIn", stop, timings)
                inner_frame, inner_locals = stopped_frame(dap, stop)
                if name == "mixed":
                    # First invocation may initialize Kotlin's object before entering its static method.
                    assert "KotlinProbe." in inner_frame["name"], inner_frame
                    assert any(method in inner_frame["name"] for method in ("levelThree", "<init>", "<clinit>"))
                    if "levelThree" in inner_frame["name"]:
                        assert "title" in inner_locals, inner_locals
                else:
                    assert "levelTwo" in inner_frame["name"] and "value" in inner_locals, inner_frame
                stop = step(dap, "next", stop, timings)
                next_frame = dap.request("stackTrace", dict(threadId=stop["threadId"], levels=1))["stackFrames"][0]
                if "source" in next_frame:
                    assert Path(next_frame["source"]["path"]).is_file(), next_frame
                else:
                    assert next_frame["line"] == 0 and next_frame["presentationHint"] == "subtle", next_frame
                stop = step(dap, "stepOut", stop, timings)
                out_frame = dap.request("stackTrace", dict(threadId=stop["threadId"], levels=1))["stackFrames"][0]
                assert "dev.openandroid.samples." in out_frame["name"], out_frame
                dap.request("setBreakpoints", dict(source=dict(path=str(source)), breakpoints=[]))
                final_line, final_bp = set_line(dap, second, final_marker)
                assert final_bp["verified"], final_bp
                dap.request("continue", dict(threadId=stop["threadId"]))
                stop = dap.event("stopped")
                assert stop["reason"] == "breakpoint" and final_bp["id"] in stop["hitBreakpointIds"], stop
                final_frame, final_locals = stopped_frame(dap, stop)
                assert final_frame["line"] == final_line and Path(final_frame["source"]["path"]) == second.resolve(), final_frame
                assert "sum" in final_locals and "count" in final_locals and "result" in final_locals, final_locals
                count = int(final_locals["count"]["value"])
                assert count >= 1
                if name == "mixed":
                    assert int(final_locals["transformed"]["value"]) == int(final_locals["sum"]["value"]) + count
                dap.request("setBreakpoints", dict(source=dict(path=str(second)), breakpoints=[]))
                lambda_proof = None
                if name == "kotlin" and args.lambda_probe:
                    lambda_line, _ = set_line(dap, source, "val transform:")
                    dap.request("continue", dict(threadId=stop["threadId"]))
                    for attempt in range(3):
                        stop = dap.event("stopped")
                        lambda_frame, lambda_locals = stopped_frame(dap, stop)
                        assert lambda_frame["line"] == lambda_line, lambda_frame
                        if not lambda_frame["name"].endswith(".levelOne"):
                            assert "lambda" in lambda_frame["name"].lower() or "invoke" in lambda_frame["name"]
                            assert "number" in lambda_locals, lambda_locals
                            assert any(key.endswith("count") for key in lambda_locals), lambda_locals
                            lambda_proof = dict(frame=lambda_frame,
                                                locals={key: value["value"] for key, value in lambda_locals.items()})
                            break
                        dap.request("continue", dict(threadId=stop["threadId"]))
                    assert lambda_proof, "No source-mapped lambda body breakpoint within three stops"
                    dap.request("setBreakpoints", dict(source=dict(path=str(source)), breakpoints=[]))
                dap.request("continue", dict(threadId=stop["threadId"]))
                time.sleep(0.5)
                worker = next(t for t in dap.request("threads")["threads"] if t["name"] == "OAS-" + name)
                dap.request("pause", dict(threadId=worker["id"]))
                dap.event("stopped", lambda body: body["reason"] == "pause")
                before = run("logcat", "--pid=" + pid, "-d", "-s", "OAS:I", "*:S")
                before_cycles = re.findall(name + r" iteration=(\d+)", before)
                if args.stop_mode == "terminate":
                    dap.request("terminate")
                    dap.event("terminated")
                    dap.request("disconnect", dict(terminateDebuggee=False))
                else:
                    dap.request("disconnect", dict(terminateDebuggee=args.stop_mode == "disconnect"))
                    dap.event("terminated")
                dap.close()
                if args.stop_mode == "detach":
                    time.sleep(2)
                    assert run("shell", "pidof", package) == pid, "Disconnect changed/killed app process"
                    after = run("logcat", "--pid=" + pid, "-d", "-s", "OAS:I", "*:S")
                    after_cycles = re.findall(name + r" iteration=(\d+)", after)
                    assert len(after_cycles) > len(before_cycles), (before_cycles, after_cycles)
                else:
                    assert not run("shell", "pidof", package, absent_package_ok=True), "Stop left the app running"
                    after_cycles = []
                if args.launch:
                    remaining = forwards()
                    assert owned_forward not in remaining and initial_forwards <= remaining, remaining
                assert not any(event["event"] in ("process", "processid") for event in dap.events), "Phone pid must not be announced"
                row = dict(fixture=fixture, result="PASS", vm=vm, timings=timings,
                           firstFrame=frame, stepInFrame=inner_frame, nextFrame=next_frame,
                           stepOutFrame=out_frame, finalFrame=final_frame,
                           locals={key: value["value"] for key, value in locals_.items()
                                   if key in ("iteration", "count", "title")},
                           finalLocals={key: value["value"] for key, value in final_locals.items()
                                        if key in ("sum", "count", "result", "transformed", "even")},
                           fields=fields, array=array, collectionFields=collections, listMapExpandable=True,
                           logCyclesBeforeDetach=before_cycles, logCyclesAfterDetach=after_cycles,
                           appSurvivesDetach=args.stop_mode == "detach", stopMode=args.stop_mode,
                           launch=args.launch, forwardRemovedByAdapter=args.launch, existingProcessReplaced=prior_pid is not None,
                           adapterWarnings=list(dap.stderr), lambdaProof=lambda_proof)
                results.append(row)
                print(json.dumps(dict(fixture=fixture, result="PASS", timings=timings,
                                      stopMode=args.stop_mode, forwardRemovedByAdapter=args.launch)), flush=True)
            finally:
                errors = []
                if dap is not None:
                    try:
                        dap.close()
                    except Exception as error:
                        errors.append(str(error))
                if forward is not None:
                    try:
                        run("forward", "--remove", forward)
                    except Exception as error:
                        errors.append(str(error))
                if owned_forward is not None:
                    try:
                        if owned_forward in forwards():
                            run("forward", "--remove", owned_forward[0])
                    except Exception as error:
                        errors.append(str(error))
                if installed:
                    try:
                        assert "Success" in run("uninstall", package)
                        assert not run("shell", "pm", "path", package, absent_package_ok=True)
                    except Exception as error:
                        errors.append(str(error))
                if errors:
                    raise RuntimeError("Cleanup failed: " + "; ".join(errors))
    except Exception as error:
        results.append(dict(result="FAIL", error=str(error).replace(serial, "<test-phone>")))
        raise
    finally:
        stem = args.case or "phone"
        (args.evidence / (stem + "-commands.json")).write_text(json.dumps(commands, indent=2), encoding="utf-8")
        (args.evidence / (stem + "-results.json")).write_text(json.dumps(results, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
