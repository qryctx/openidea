import { executeAction } from "@/platform/actions";
import { useTx } from "@/platform/i18n";
import { BarButton, showContextMenu } from "@/ui";
import { useAndroidVariants } from "./androidVariants";

export function AndroidVariantStatus() {
  const { names, selected } = useAndroidVariants();
  const tx = useTx();
  if (!names.length) return null;
  return (
    <BarButton
      tooltip={tx("Android reference variant")}
      aria-haspopup="menu"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        showContextMenu({ x: rect.left, y: rect.top }, [
          {
            label: tx("Default language service"),
            checked: selected === null,
            run: () => void executeAction("android.selectVariant", null),
          },
          ...names.map((name) => ({
            label: name,
            verbatim: true,
            checked: selected === name,
            run: () => void executeAction("android.selectVariant", name),
          })),
          { kind: "separator" },
          { kind: "action", action: "android.refreshVariants" },
        ]);
      }}
    >
      {selected ?? tx("Android reference variant")}
    </BarButton>
  );
}
