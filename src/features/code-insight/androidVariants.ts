import { editorsFor } from "@/editor/api";
import { formatMessage, tx } from "@/platform/i18n";
import { commands, call, IpcError, isTauri, nextRequestId, type RequestId } from "@/platform/ipc";
import { isRemoteWindow } from "@/platform/remote";
import { maybeEditorService } from "@/workbench/contributions";
import { androidCallUsages, indexDir, moduleIndexPath, StaleAndroidSources, validVariant } from "./androidIndex";
import type { CaretContext } from "./ipc";

import {
  initialAndroidVariants as initial,
  useAndroidVariants,
  type AndroidChoice as Choice,
} from "@/platform/androidVariants";
export { useAndroidVariants } from "@/platform/androidVariants";

let revision = 0;
let activeRequest: RequestId | null = null;
let pending: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let scheduled: "model" | "index" | null = null;

function supersede() {
  if (activeRequest !== null) void commands.cancelRequest(activeRequest).catch(() => {});
  if (timer !== null) clearTimeout(timer);
  activeRequest = null;
  pending = null;
  timer = null;
  scheduled = null;
  return ++revision;
}

const cancelled = () => new IpcError({ kind: "cancelled", message: tx("Android project changed") });

async function runRequest<T>(job: number, run: (id: RequestId) => Promise<T>) {
  if (job !== revision) throw cancelled();
  const id = nextRequestId();
  activeRequest = id;
  try {
    const result = await run(id);
    if (job !== revision) throw cancelled();
    return result;
  } finally {
    if (activeRequest === id) activeRequest = null;
  }
}

function track(job: number, work: () => Promise<void>) {
  const task = Promise.resolve()
    .then(work)
    .catch((e: unknown) => {
      if (job === revision)
        useAndroidVariants.setState({ phase: "failed", error: e instanceof Error ? e.message : String(e) });
    })
    .finally(() => {
      if (job === revision) pending = null;
    });
  pending = task;
  return task;
}

async function indexSelected(job: number, root: string, choice: Choice) {
  if (job !== revision) return;
  if (choice.module !== null && useAndroidVariants.getState().trusted) {
    const module = choice.module;
    useAndroidVariants.setState({ phase: "indexing", error: null });
    const path = await runRequest(job, (id) => call(commands.androidIndexVariant(id, root, module, choice.name)));
    if (path !== moduleIndexPath(module, choice.name))
      throw new Error(tx("Invalid Android index. Regenerate the variant index."));
  }
  if (job === revision) useAndroidVariants.setState({ phase: "ready", error: null });
}

// Read already-generated snapshots in restricted mode without invoking project code.
async function savedVariants(root: string): Promise<Choice[]> {
  const dir = indexDir(root);
  const readDir = (p: string) => call(commands.fsReadDir(p)).catch(() => []);
  const files = await readDir(dir);
  const names = (entries: typeof files) =>
    entries
      .filter((f) => f.kind === "file" && f.name.endsWith(".json"))
      .map((f) => f.name.slice(0, -5))
      .filter(validVariant)
      .sort();
  const scoped: Choice[] = [];
  for (const f of files) {
    if (f.kind !== "dir" || !/^(?:[0-9a-f]{2})+$/.test(f.name)) continue;
    let module: string;
    try {
      module = new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(f.name.match(/../g)!, (byte) => parseInt(byte, 16)),
      );
    } catch {
      continue;
    }
    if (!module.startsWith(":") || /[\\/]/.test(module)) continue;
    for (const name of names(await readDir(dir + "/" + f.name))) scoped.push({ module, name });
  }
  const found = new Set(scoped.map((v) => v.name));
  return [
    ...scoped,
    ...names(files)
      .filter((name) => !found.has(name))
      .map((name) => ({ module: null, name })),
  ];
}

export function discoverAndroidVariants(root: string | null, trusted: boolean) {
  const job = supersede();
  const s = useAndroidVariants.getState();
  if (s.root !== root || s.trusted !== trusted) useAndroidVariants.setState({ ...initial, root, trusted });
  if (!root || !isTauri() || isRemoteWindow()) {
    useAndroidVariants.setState({ ...initial });
    return Promise.resolve();
  }
  useAndroidVariants.setState({ phase: "discovering", error: null });
  return track(job, async () => {
    const variants = trusted
      ? await runRequest(job, (id) => call(commands.androidDiscoverVariants(id, root)))
      : await savedVariants(root);
    if (job !== revision) return;
    const { application, selected } = useAndroidVariants.getState();
    const choice = variants.find((v) => v.module === application && v.name === selected);
    if (selected && !choice) {
      useAndroidVariants.setState({
        variants,
        phase: "failed",
        error: formatMessage(tx("Android variant {variant} is no longer available. Select another variant."), {
          variant: selected,
        }),
      });
      return;
    }
    useAndroidVariants.setState({
      variants,
      selected: choice?.name ?? null,
      application: choice?.module ?? null,
      phase: choice ? "indexing" : "idle",
    });
    if (choice) await indexSelected(job, root, choice);
  });
}

export function selectAndroidVariant(arg: unknown): Promise<void> | void {
  const { root, variants, phase } = useAndroidVariants.getState();
  if (!root || phase === "discovering") return;
  if (arg === null) {
    supersede();
    useAndroidVariants.setState({ selected: null, application: null, phase: "idle", error: null });
    return;
  }
  // Keep the original single-module action form, but never resolve an ambiguous name to the wrong application.
  const matches = variants.filter((v) =>
    typeof arg === "string"
      ? v.name === arg
      : !!arg &&
        typeof arg === "object" &&
        "module" in arg &&
        "name" in arg &&
        v.module === arg.module &&
        v.name === arg.name,
  );
  if (matches.length !== 1) return;
  const choice = matches[0]!;
  const job = supersede();
  useAndroidVariants.setState({
    selected: choice.name,
    application: choice.module,
    phase: choice.module === null ? "ready" : "indexing",
    error: null,
  });
  return track(job, () => indexSelected(job, root, choice));
}

export function cancelAndroidSync() {
  if (!["stale", "discovering", "indexing"].includes(useAndroidVariants.getState().phase)) return;
  supersede();
  useAndroidVariants.setState({
    phase: "failed",
    error: tx("Android sync cancelled. Reload Android reference variants to retry."),
  });
}

function flushChanges() {
  const kind = scheduled;
  const s = useAndroidVariants.getState();
  if (kind === "model") return discoverAndroidVariants(s.root, s.trusted);
  if (kind === "index" && s.selected) return selectAndroidVariant({ module: s.application, name: s.selected });
}

/** Coalesce editor saves and filesystem notifications. Gradle's generated outputs cannot trigger another indexing run. */
export function androidFilesChanged(paths: string[]) {
  const s = useAndroidVariants.getState();
  if (!s.root || !s.trusted) return;
  const prefix = s.root.replaceAll("\\", "/").replace(/\/$/, "") + "/";
  const relative = paths
    .map((p) => p.replaceAll("\\", "/"))
    .filter((p) => p.startsWith(prefix))
    .map((p) => p.slice(prefix.length))
    .filter(
      (p) =>
        !p
          .split("/")
          .slice(0, -1)
          .some((d) => [".gradle", ".kotlin", ".git", ".openidea", "build", "out", "node_modules"].includes(d)),
    );
  const model = relative.some(
    (p) =>
      /(?:\.gradle(?:\.kts)?|(?:^|\/)(?:gradle\.properties|gradle-wrapper\.properties|AndroidManifest\.xml)|\.versions\.toml)$/.test(
        p,
      ) ||
      (/^(?:buildSrc|build-logic)\//.test(p) && /\.(kt|java|groovy)$/.test(p)),
  );
  if (!model && (!s.selected || !relative.some((p) => /\.(kt|java)$/.test(p)))) return;
  const next = model || scheduled === "model" || s.phase === "discovering" ? "model" : "index";
  supersede();
  scheduled = next;
  useAndroidVariants.setState({ phase: "stale", error: null });
  timer = setTimeout(flushChanges, 600);
}

export async function selectedAndroidUsages(c: CaretContext) {
  const s = useAndroidVariants.getState();
  if (!s.root || !s.selected || !/\.(kt|java)$/.test(c.path)) return null;
  if (scheduled) flushChanges();
  const { root, selected, application } = s;
  async function query(job: number) {
    await pending;
    if (job !== revision) throw cancelled();
    const current = useAndroidVariants.getState();
    if (current.phase === "failed") throw new Error(current.error ?? tx("Android project sync failed"));
    if (current.phase !== "ready" || current.application !== application || current.selected !== selected)
      throw cancelled();
    const dirtyDocs = new Set(maybeEditorService()?.dirtyDocumentIds?.() ?? []);
    const result = await androidCallUsages(
      root,
      selected,
      c,
      (p) => call(commands.fsReadText(p)),
      (p) => editorsFor(p).some((e) => dirtyDocs.has(e.ctx.doc)),
      application,
    );
    if (job !== revision) throw cancelled();
    return result;
  }
  const started = revision;
  try {
    return await query(started);
  } catch (e) {
    if (started !== revision) throw cancelled();
    // A missed filesystem event is still detectable for every saved source in the snapshot.
    if (!(e instanceof StaleAndroidSources) || !e.saved || !s.trusted || !application) throw e;
    void selectAndroidVariant({ module: application, name: selected });
    return query(revision);
  }
}
