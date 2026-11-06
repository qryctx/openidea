import { executeAction } from "@/platform/actions";
import { formatMessage, useTx } from "@/platform/i18n";
import { BarButton, showContextMenu } from "@/ui";
import { useAndroidVariants } from "./androidVariants";

export function AndroidVariantStatus() {
  const { variants, selected, application, phase, error } = useAndroidVariants();
  const tx = useTx();
  if (!variants.length && phase === "idle") return null;
  const modules = new Set(variants.map((v) => v.module)).size > 1;
  const selection = selected && modules && application ? application + " · " + selected : selected;
  const title =
    phase === "discovering"
      ? tx("Syncing Android variants…")
      : phase === "indexing"
        ? formatMessage(tx("Preparing {variant}…"), { variant: selection ?? "" })
        : phase === "failed"
          ? tx("Android project sync failed")
          : phase === "stale"
            ? tx("Refreshing Android references…")
            : (selection ?? tx("Android reference variant"));
  return (
    <BarButton
      tooltip={tx("Android reference variant")}
      aria-haspopup="menu"
      aria-busy={phase === "discovering" || phase === "indexing"}
      data-android-phase={phase}
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        showContextMenu({ x: rect.left, y: rect.top }, [
          ...(error ? [{ label: error, verbatim: true, disabled: true }] : []),
          {
            label: tx("Default language service"),
            checked: selected === null,
            disabled: phase === "discovering" || (!variants.length && !selected),
            run: () => void executeAction("android.selectVariant", null),
          },
          ...variants.map((v) => ({
            label: modules && v.module ? v.module + " · " + v.name : v.name,
            verbatim: true,
            disabled: phase === "discovering",
            checked: selected === v.name && application === v.module,
            run: () => void executeAction("android.selectVariant", v),
          })),
          { kind: "separator" },
          ...(["discovering", "indexing", "stale"].includes(phase)
            ? [{ kind: "action" as const, action: "android.cancelSync" }]
            : []),
          { kind: "action", action: "android.refreshVariants" },
        ]);
      }}
    >
      {title}
    </BarButton>
  );
}
