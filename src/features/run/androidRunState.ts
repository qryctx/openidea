import type { AndroidDevice } from "@/platform/ipc";

export type AndroidRunPhase =
  | "idle"
  | "saving"
  | "build-started"
  | "installing"
  | "launching"
  | "running"
  | "cancel-requested"
  | "build-stopped"
  | "cleanup-complete"
  | "operation-stopped"
  | "stopped"
  | "failed";

function isAndroidRunPhase(value: string): value is AndroidRunPhase {
  return [
    "idle",
    "saving",
    "build-started",
    "installing",
    "launching",
    "running",
    "cancel-requested",
    "build-stopped",
    "cleanup-complete",
    "operation-stopped",
    "stopped",
    "failed",
  ].includes(value);
}

/** Build output does not replace the operation status; cancellation stages do. */
export function phaseAfterAndroidEvent(current: AndroidRunPhase, event: string): AndroidRunPhase {
  if (event === "output") return current;
  return isAndroidRunPhase(event) ? event : current;
}

/** Keep the three user-visible cancellation outcomes distinct and ordered. */
export function phaseAfterAndroidCancellation(current: AndroidRunPhase): AndroidRunPhase {
  return current === "cleanup-complete" || current === "build-stopped" || current === "operation-stopped"
    ? current
    : "build-stopped";
}

export function physicalAndroidDevices(devices: AndroidDevice[]): AndroidDevice[] {
  return devices.filter((device) => !device.serial.startsWith("emulator-"));
}

export function defaultAndroidDevice(devices: AndroidDevice[], current: string | null): string | null {
  const online = devices.filter((device) => device.state === "device");
  if (current && online.some((device) => device.serial === current)) return current;
  return online.length === 1 ? online[0]!.serial : null;
}
