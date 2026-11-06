import { create } from "zustand";
import { editorsFor } from "@/editor/api";
import { commands, call } from "@/platform/ipc";
import { maybeEditorService } from "@/workbench/contributions";
import { androidCallUsages, indexDir, validVariant } from "./androidIndex";
import type { CaretContext } from "./ipc";

export const useAndroidVariants = create<{ root: string | null; names: string[]; selected: string | null }>(() => ({
  root: null,
  names: [],
  selected: null,
}));
let revision = 0;
export async function discoverAndroidVariants(root: string | null) {
  const request = ++revision;
  const prior = useAndroidVariants.getState();
  if (root !== prior.root) useAndroidVariants.setState({ root, names: [], selected: null });
  if (!root) return;
  let names: string[] = [];
  try {
    const files = await call(commands.fsReadDir(indexDir(root)));
    names = files
      .filter((f) => f.kind === "file" && f.name.endsWith(".json"))
      .map((f) => f.name.slice(0, -5))
      .filter(validVariant)
      .sort();
  } catch {
    /* Most projects have no Android index. */
  }
  if (request !== revision) return;
  const selected = useAndroidVariants.getState().selected;
  useAndroidVariants.setState({ names, selected: selected && names.includes(selected) ? selected : null });
}

export function selectAndroidVariant(arg: unknown) {
  const { names } = useAndroidVariants.getState();
  if (arg === null || (typeof arg === "string" && names.includes(arg))) useAndroidVariants.setState({ selected: arg });
}

export async function selectedAndroidUsages(c: CaretContext) {
  const { root, selected } = useAndroidVariants.getState();
  if (!root || !selected || !/\.(kt|java)$/.test(c.path)) return null;
  const dirtyDocs = new Set(maybeEditorService()?.dirtyDocumentIds?.() ?? []);
  return androidCallUsages(
    root,
    selected,
    c,
    (p) => call(commands.fsReadText(p)),
    (p) => editorsFor(p).some((e) => dirtyDocs.has(e.ctx.doc)),
  );
}
