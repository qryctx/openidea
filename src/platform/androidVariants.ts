import { create } from "zustand";

export type AndroidChoice = { module: string | null; name: string };
type Phase = "idle" | "discovering" | "indexing" | "stale" | "ready" | "failed";
interface State {
  root: string | null;
  trusted: boolean;
  variants: AndroidChoice[];
  selected: string | null;
  application: string | null;
  phase: Phase;
  error: string | null;
}
export const initialAndroidVariants: State = {
  root: null,
  trusted: false,
  variants: [],
  selected: null,
  application: null,
  phase: "idle",
  error: null,
};
export const useAndroidVariants = create<State>(() => initialAndroidVariants);

/** An application choice from the AGP model can drive device deployment in a trusted project. */
export function androidRunTarget(s: State) {
  if (
    !s.trusted ||
    !s.root ||
    !s.application ||
    !s.selected ||
    !s.variants.some((choice) => choice.module === s.application && choice.name === s.selected)
  )
    return null;
  return { root: s.root, module: s.application, variant: s.selected };
}
