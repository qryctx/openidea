import { useCallback, useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import {
  call,
  commands,
  isCancelled,
  nextRequestId,
  type AndroidDevice,
  type AndroidEnvironment,
  type AndroidRunEvent,
  type AndroidRunResult,
  type LogcatLine,
} from "@/platform/ipc";
import { executeAction, registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { maybeEditorService } from "@/workbench/contributions";
import { Button, EmptyState, Input, Select, T } from "@/ui";
import {
  defaultAndroidDevice,
  phaseAfterAndroidCancellation,
  phaseAfterAndroidEvent,
  physicalAndroidDevices,
  type AndroidRunPhase,
} from "./androidRunState";
import styles from "./AndroidBuildRun.module.css";

type OutputLine = { kind: "build" | "device"; text: string };

function describePhase(phase: AndroidRunPhase): string {
  switch (phase) {
    case "idle":
      return "Ready";
    case "saving":
      return "Saving project files";
    case "build-started":
      return "Building Android app";
    case "installing":
      return "Installing Android app";
    case "launching":
      return "Launching Android app";
    case "running":
      return "Android app is running";
    case "cancel-requested":
      return "Cancellation requested";
    case "build-stopped":
      return "Gradle build stopped";
    case "cleanup-complete":
      return "Gradle process cleanup complete";
    case "operation-stopped":
      return "Android operation stopped";
    case "stopped":
      return "Android app stopped";
    case "failed":
      return "Android run failed";
    default:
      return phase;
  }
}

export function AndroidBuildRun() {
  const root = useProject((state) => state.project?.root ?? null);
  const [devices, setDevices] = useState<AndroidDevice[]>([]);
  const [serial, setSerial] = useState<string | null>(null);
  const [module, setModule] = useState("app");
  const [variant, setVariant] = useState("debug");
  const [javaHome, setJavaHome] = useState("");
  const [sdkOrAdb, setSdkOrAdb] = useState("");
  const [environment, setEnvironment] = useState<AndroidEnvironment | null>(null);
  const [overridePathCheck, setOverridePathCheck] = useState(false);
  const [request, setRequest] = useState<number | null>(null);
  const [logRequest, setLogRequest] = useState<number | null>(null);
  const requestRef = useRef<number | null>(null);
  const logRequestRef = useRef<number | null>(null);
  const cancelRequestedRef = useRef(false);
  const [result, setResult] = useState<AndroidRunResult | null>(null);
  const [phase, setPhase] = useState<AndroidRunPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<OutputLine[]>([]);
  const building = request !== null;
  const actionHandlers = useRef({
    start: () => {},
    stop: () => {},
    refreshDevices: () => {},
    canStart: false,
    canStop: false,
    canRefresh: false,
  });

  const refreshDevices = useCallback((path: string) => {
    void call(commands.androidDevicesAt(path.trim() || null))
      .then((found) => {
        const physical = physicalAndroidDevices(found);
        setDevices(physical);
        setSerial((current) => defaultAndroidDevice(physical, current));
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  useEffect(() => {
    refreshDevices("");
    void call(commands.androidEnvironment())
      .then((found) => {
        setEnvironment(found);
        setJavaHome(found.javaHome ?? "");
        setSdkOrAdb(found.sdkRoot ?? "");
        refreshDevices(found.sdkRoot ?? "");
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [refreshDevices]);

  useEffect(() => {
    requestRef.current = request;
  }, [request]);
  useEffect(() => {
    logRequestRef.current = logRequest;
  }, [logRequest]);
  useEffect(
    () => () => {
      cancelRequestedRef.current = true;
      if (requestRef.current !== null) void commands.cancelRequest(requestRef.current);
      if (logRequestRef.current !== null) void commands.cancelRequest(logRequestRef.current);
    },
    [],
  );

  const startLogcat = (run: AndroidRunResult, device: string) => {
    const id = nextRequestId();
    const channel = new Channel<LogcatLine[]>();
    channel.onmessage = (batch) =>
      setOutput((lines) =>
        [
          ...lines,
          ...batch.map((line) => ({
            kind: "device" as const,
            text: `${line.time} ${line.pid} ${line.level.toString()[0]?.toUpperCase() ?? "?"} ${line.tag}: ${line.message}`,
          })),
        ].slice(-5000),
      );
    logRequestRef.current = id;
    setLogRequest(id);
    void call(commands.androidAppLogcat(id, device, run.pid, sdkOrAdb.trim() || null, channel))
      .catch((cause) => {
        if (!isCancelled(cause)) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (logRequestRef.current === id) {
          logRequestRef.current = null;
          setLogRequest(null);
        }
      });
  };

  const start = async () => {
    if (!root || !serial || requestRef.current !== null) return;
    cancelRequestedRef.current = false;
    if (logRequest !== null) void commands.cancelRequest(logRequest);
    logRequestRef.current = null;
    setLogRequest(null);
    setResult(null);
    setError(null);
    setOutput([]);
    const id = nextRequestId();
    requestRef.current = id;
    setRequest(id);
    setPhase("saving");
    const channel = new Channel<AndroidRunEvent>();
    channel.onmessage = (event) => {
      if (event.phase === "output") {
        setOutput((lines) => [...lines, { kind: "build" as const, text: event.message }].slice(-5000));
      } else setPhase((current) => phaseAfterAndroidEvent(current, event.phase));
    };
    try {
      await maybeEditorService()?.saveAll();
      if (cancelRequestedRef.current) {
        setPhase("operation-stopped");
        return;
      }
      const run = await call(
        commands.androidBuildInstallLaunch(
          module,
          variant,
          serial,
          sdkOrAdb.trim() || null,
          javaHome.trim() || null,
          overridePathCheck,
          id,
          channel,
        ),
      );
      setResult(run);
      setPhase("running");
      startLogcat(run, serial);
    } catch (cause) {
      if (isCancelled(cause)) {
        setPhase(phaseAfterAndroidCancellation);
      } else {
        const text = cause instanceof Error ? cause.message : String(cause);
        setError(text);
        setPhase("failed");
        setOutput((lines) => [...lines, { kind: "build" as const, text }].slice(-5000));
      }
    } finally {
      requestRef.current = null;
      setRequest(null);
    }
  };

  const stop = async () => {
    if (request !== null) {
      cancelRequestedRef.current = true;
      setPhase("cancel-requested");
      void commands.cancelRequest(request);
      return;
    }
    if (!result || !serial) return;
    setError(null);
    try {
      await call(commands.androidStopApp(serial, result.applicationId, sdkOrAdb.trim() || null));
      if (logRequest !== null) void commands.cancelRequest(logRequest);
      logRequestRef.current = null;
      setLogRequest(null);
      setResult(null);
      setPhase("stopped");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useEffect(() => {
    actionHandlers.current = {
      start: () => void start(),
      stop: () => void stop(),
      refreshDevices: () => refreshDevices(sdkOrAdb),
      canStart: !!root && !!serial && !building && !!module.trim() && !!variant.trim(),
      canStop: building ? phase !== "cancel-requested" : !!result,
      canRefresh: !building,
    };
  });

  useEffect(
    () =>
      registerActions([
        {
          id: "android.buildRun",
          title: "Build, install & run",
          category: "Run",
          enabled: () => actionHandlers.current.canStart,
          run: () => actionHandlers.current.start(),
        },
        {
          id: "android.stop",
          title: "Stop",
          category: "Run",
          enabled: () => actionHandlers.current.canStop,
          run: () => actionHandlers.current.stop(),
        },
        {
          id: "android.refreshDevices",
          title: "Refresh devices",
          category: "Run",
          enabled: () => actionHandlers.current.canRefresh,
          run: () => actionHandlers.current.refreshDevices(),
        },
      ]),
    [],
  );

  const options = devices.map((device) => ({
    value: device.serial,
    label: device.model ? `${device.model} (${device.serial})` : device.serial,
    detail: device.state === "device" ? undefined : device.state,
    disabled: device.state !== "device",
  }));

  if (!root) return <EmptyState title="Open an Android project to build and run it" />;

  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <Select
          aria-label="Android device"
          value={serial}
          options={options}
          placeholder="No authorized device"
          onChange={setSerial}
          disabled={building || result !== null}
          searchable
        />
        <Input aria-label="Gradle module" value={module} onChange={(event) => setModule(event.target.value)} />
        <Input aria-label="Build variant" value={variant} onChange={(event) => setVariant(event.target.value)} />
        <Button
          onClick={() => void executeAction("android.buildRun")}
          disabled={building || !serial || !module.trim() || !variant.trim()}
        >
          <T>Build, install & run</T>
        </Button>
        <Button
          onClick={() => void executeAction("android.stop")}
          disabled={building ? phase === "cancel-requested" : !result}
        >
          <T>Stop</T>
        </Button>
        <Button onClick={() => void executeAction("android.refreshDevices")} disabled={building}>
          <T>Refresh devices</T>
        </Button>
      </div>
      <div className={styles.toolchain}>
        <Input
          aria-label="Java home"
          placeholder="Existing JDK path (optional)"
          value={javaHome}
          onChange={(event) => setJavaHome(event.target.value)}
          disabled={building || result !== null}
          mono
        />
        <Input
          aria-label="Android SDK or adb path"
          placeholder="SDK path or adb executable (optional)"
          value={sdkOrAdb}
          onChange={(event) => setSdkOrAdb(event.target.value)}
          disabled={building || result !== null}
          mono
        />
        <span>
          {environment?.adbPath ? (
            <>
              <T>Detected adb</T>: {environment.adbPath}
            </>
          ) : (
            <T>No adb found</T>
          )}
        </span>
      </div>
      <label className={styles.override}>
        <input
          type="checkbox"
          checked={overridePathCheck}
          onChange={(event) => setOverridePathCheck(event.target.checked)}
          disabled={building}
        />
        <T>Explicitly allow AGP non-ASCII path override</T>
      </label>
      <div className={styles.status} role="status">
        <T>{describePhase(phase)}</T>
        {result && <span>{result.applicationId}</span>}
        {error && <span className={styles.error}>{error}</span>}
        {devices.some((device) => device.state !== "device") && (
          <span>
            {devices
              .filter((device) => device.state !== "device")
              .map((device) => `${device.model ?? device.serial}: ${device.state}`)
              .join(" · ")}
          </span>
        )}
      </div>
      <div className={styles.output} role="log" aria-label="Android build and app output">
        {output.map((line, index) => (
          <div className={line.kind === "device" ? styles.deviceLine : styles.buildLine} key={index}>
            {line.text}
          </div>
        ))}
      </div>
    </div>
  );
}
