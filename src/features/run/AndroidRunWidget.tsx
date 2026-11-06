import { useRef, useState } from "react";
import clsx from "clsx";
import { useAndroidVariants } from "@/platform/androidVariants";
import { executeAction } from "@/platform/actions";
import { useTx } from "@/platform/i18n";
import { shortcutLabel } from "@/platform/keymap";
import { BarButton, Icon, IconButton, Menu, type MenuItem } from "@/ui";
import { androidBusy, useAndroidRun } from "./androidRun";
import { useRun } from "./store";
import styles from "./Run.module.css";

export function AndroidRunWidget({ module, variant }: { module: string; variant: string }) {
  const tx = useTx();
  const chooserOpen = useRun((s) => s.chooserOpen);
  const { devices, serial, devicesError, phase, mode, error, result } = useAndroidRun();
  const indexReady = useAndroidVariants((s) => s.phase === "ready");
  const device = devices.find((d) => d.serial === serial);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const busy = androidBusy(phase);
  const status = {
    idle: "",
    building: tx("Building…"),
    installing: tx("Installing…"),
    launching: tx("Launching…"),
    launched: tx("Launched"),
    attaching: tx("Attaching debugger…"),
    debugging: tx("Debugging"),
    failed: mode === "debug" ? tx("Debug failed") : tx("Run failed"),
  }[phase];
  const deviceRows: MenuItem[] = devices.map((d) => ({
    id: d.serial,
    label: [d.model, d.serial, d.state === "device" ? null : d.state].filter(Boolean).join(" · "),
    verbatim: true,
    checked: d.serial === serial,
    disabled: d.state !== "device" || busy,
    run: () => void executeAction("android.selectRunDevice", d.serial),
  }));
  if (!deviceRows.length)
    deviceRows.push({ label: devicesError ?? tx("No Android devices"), verbatim: true, disabled: true });
  deviceRows.push({ kind: "separator" }, { kind: "action", action: "android.refreshRunDevices" });
  return (
    <div className={styles.widget}>
      <BarButton
        variant="title"
        className={styles.widgetChooser}
        tooltip={tx("Run/Debug Configurations")}
        aria-haspopup="listbox"
        aria-expanded={chooserOpen}
        data-run-chooser=""
        onClick={() => void executeAction("run.chooseConfig", "select")}
      >
        <span className={styles.widgetName}>
          {module} · {variant}
        </span>
        <Icon name="chevron-down" size={14} />
      </BarButton>
      <BarButton
        ref={anchor}
        variant="title"
        tooltip={tx("Android deployment device")}
        aria-haspopup="menu"
        aria-expanded={open}
        data-android-device={serial ?? ""}
        onClick={() => {
          if (!open) void executeAction("android.refreshRunDevices");
          setOpen(!open);
        }}
      >
        {device?.model ?? serial ?? tx("Select Android device")}
        <Icon name="chevron-down" size={14} />
      </BarButton>
      <Menu open={open} anchor={anchor} items={deviceRows} placement="bottom-start" onClose={() => setOpen(false)} />
      <span className={styles.widgetButtons}>
        <IconButton
          icon="run"
          size="large"
          iconSize={18}
          className={clsx(styles.widgetButton, styles.widgetRun)}
          title={tx`Run '${variant}'`}
          shortcut={shortcutLabel("run.run")}
          data-android-run=""
          disabled={busy || !device || device.state !== "device"}
          onClick={() => void executeAction("run.run")}
        />
        <IconButton
          icon="debug"
          size="large"
          iconSize={18}
          className={styles.widgetButton}
          title={tx`Debug '${variant}'`}
          shortcut={shortcutLabel("run.debug")}
          data-android-debug=""
          disabled={busy || !indexReady || !device || device.state !== "device"}
          onClick={() => void executeAction("run.debug")}
        />
        {busy && (
          <IconButton
            icon="stop-filled"
            size="large"
            iconSize={16}
            className={styles.widgetButton}
            title={mode === "debug" ? tx("Stop Android Debug") : tx("Cancel Android Run")}
            onClick={() => void executeAction("android.cancelRun")}
          />
        )}
      </span>
      {status && (
        <span
          className={styles.androidStatus}
          role="status"
          data-android-run-stage={phase}
          title={error ?? result?.applicationId ?? undefined}
        >
          {status}
        </span>
      )}
    </div>
  );
}
