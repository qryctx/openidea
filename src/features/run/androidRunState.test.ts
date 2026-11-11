import { describe, expect, it } from "vitest";
import type { AndroidDevice } from "@/platform/ipc";
import {
  defaultAndroidDevice,
  phaseAfterAndroidCancellation,
  phaseAfterAndroidEvent,
  physicalAndroidDevices,
  type AndroidRunPhase,
} from "./androidRunState";

describe("Android build cancellation stages", () => {
  it("keeps request, stopped, and cleanup completion as separate states", () => {
    let phase: AndroidRunPhase = "build-started";
    phase = "cancel-requested";
    phase = phaseAfterAndroidEvent(phase, "output");
    expect(phase).toBe("cancel-requested");
    phase = phaseAfterAndroidEvent(phase, "build-stopped");
    expect(phase).toBe("build-stopped");
    phase = phaseAfterAndroidEvent(phase, "cleanup-complete");
    expect(phase).toBe("cleanup-complete");
    expect(phaseAfterAndroidCancellation(phase)).toBe("cleanup-complete");
    expect(phaseAfterAndroidCancellation(phaseAfterAndroidEvent(phase, "operation-stopped"))).toBe("operation-stopped");
  });

  describe("Android device selection", () => {
    const device = (serial: string, state: string, model: string | null): AndroidDevice => ({
      serial,
      state,
      model,
      product: null,
      device: null,
      transportId: null,
    });
    const devices = [
      device("phone-1", "device", "Pixel"),
      device("phone-2", "unauthorized", null),
      device("phone-3", "offline", null),
      device("emulator-5554", "device", "Emulator"),
    ];

    it("shows physical-device authorization states and hides emulators", () => {
      expect(physicalAndroidDevices(devices).map((device) => device.state)).toEqual([
        "device",
        "unauthorized",
        "offline",
      ]);
    });

    it("requires a choice when more than one phone is online", () => {
      const online = physicalAndroidDevices(devices).concat(device("phone-4", "device", "Pixel"));
      expect(defaultAndroidDevice(online, null)).toBeNull();
      expect(defaultAndroidDevice(online, "phone-4")).toBe("phone-4");
      expect(defaultAndroidDevice(physicalAndroidDevices(devices), null)).toBe("phone-1");
    });
  });
});
