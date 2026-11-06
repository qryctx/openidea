// @vitest-environment node
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { androidCallUsages, indexDir, validVariant } from "./androidIndex";

const root = "/sample";
const cls = "lib/A.java";
const unrelated = "app/Empty.kt";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
const symbol = "library.A";
const snapshots = (variant: string) => {
  const caller = "app/" + variant + "/Caller.kt";
  const other = { symbol: "unrelated.A", path: unrelated, range };
  return {
    schema: 1,
    variant,
    files: { [cls]: sha("A"), [caller]: sha("A"), [unrelated]: sha(" ") },
    declarations: [{ symbol, path: cls, range }],
    references: [{ symbol, path: caller, range }, other],
  };
};
const caret = { path: root + "/" + cls, line: 0, col: 0 };
const source = (p: string) => (p.endsWith(unrelated) ? " " : "A");
it("changes the constructor result with the selected snapshot and excludes the homonym", async () => {
  for (const v of ["demoDebug", "fullDebug", "demoDebug"]) {
    const { locations } = await androidCallUsages(
      root,
      v,
      caret,
      async (p) => (p === indexDir(root) + "/" + v + ".json" ? JSON.stringify(snapshots(v)) : source(p)),
      () => false,
    );
    expect(locations).toEqual([
      {
        path: root + "/app/" + v + "/Caller.kt",
        range: {
          start: { line: 0, col: 0 },
          end: { line: 0, col: 1 },
        },
      },
    ]);
  }
});
it("rejects changes in a file that previously supplied no matching calls", async () => {
  for (const mode of ["saved", "dirty", "deleted"]) {
    await expect(
      androidCallUsages(
        root,
        "demoDebug",
        caret,
        async (p) => {
          if (p.endsWith(".json")) return JSON.stringify(snapshots("demoDebug"));
          if (p.endsWith(unrelated) && mode === "deleted") throw new Error("Missing source");
          return p.endsWith(unrelated) && mode === "saved" ? "A()" : source(p);
        },
        (p) => mode === "dirty" && p.endsWith(unrelated),
      ),
    ).rejects.toThrow(/regenerate/i);
  }
});
it("rejects corrupt, wrong-variant and path-traversal indices before reading source", async () => {
  const original = snapshots("demoDebug");
  for (const index of [
    "{",
    JSON.stringify(snapshots("fullDebug")),
    JSON.stringify({ ...original, files: { ...original.files, "../external.java": sha("A") } }),
    JSON.stringify({ ...original, references: [{ ...original.references[0], path: "missing.kt" }] }),
  ]) {
    let reads = 0;
    await expect(
      androidCallUsages(
        root,
        "demoDebug",
        caret,
        async () => {
          reads++;
          return index;
        },
        () => false,
      ),
    ).rejects.toThrow(/Invalid Android index/);
    expect(reads).toBe(1);
  }
});
it("does not turn a caret after the identifier into a text match", async () => {
  await expect(
    androidCallUsages(
      root,
      "demoDebug",
      { ...caret, col: 1 },
      async (p) => (p.endsWith(".json") ? JSON.stringify(snapshots("demoDebug")) : source(p)),
      () => false,
    ),
  ).rejects.toThrow(/No indexed class/);
});

it("accepts UTF-8 BOM and CRLF when the IDE has normalized its document", async () => {
  const snap = snapshots("demoDebug");
  snap.files[cls] = sha("A\n");
  const query = async (open: boolean) =>
    androidCallUsages(
      root,
      "demoDebug",
      caret,
      async (p) => {
        if (p.endsWith(".json")) return JSON.stringify(snap);
        if (p === root + "/" + cls) return open ? "A\n" : "\uFEFFA\r\n";
        return source(p);
      },
      () => false,
    );
  expect((await query(false)).locations).toEqual((await query(true)).locations);
});

it("keeps equal method names on overloads and unrelated owners separate", async () => {
  const i = snapshots("demoDebug");
  const target = "library.A#message()";
  i.declarations[0]!.symbol = target;
  i.references[0]!.symbol = target;
  i.references[1]!.symbol = "library.A#message(java.lang.String)";
  i.references.push({ ...i.references[1]!, symbol: "other.A#message()" });
  const result = await androidCallUsages(
    root,
    "demoDebug",
    caret,
    async (p) => (p.endsWith(".json") ? JSON.stringify(i) : source(p)),
    () => false,
  );
  expect(result.locations.map((l) => l.path)).toEqual([root + "/app/demoDebug/Caller.kt"]);
  expect(result.note).toBe("Android method calls · demoDebug");
});

it("explains an unresolved method name rather than reporting zero usages", async () => {
  const i = { ...snapshots("demoDebug"), incompleteMethodNames: ["message"] };
  await expect(
    androidCallUsages(
      root,
      "demoDebug",
      { ...caret, col: 1, word: "message" },
      async (p) => (p.endsWith(".json") ? JSON.stringify(i) : source(p)),
      () => false,
    ),
  ).rejects.toThrow(/could not resolve all calls/);
});

it("reads the module-qualified snapshot and rejects an index generated for a different application", async () => {
  const index = snapshots("demoDebug");
  const paths: string[] = [];
  await expect(
    androidCallUsages(
      root,
      "demoDebug",
      caret,
      async (path) => {
        paths.push(path);
        return JSON.stringify({ ...index, application: ":other" });
      },
      () => false,
      ":app",
    ),
  ).rejects.toThrow(/Invalid Android index/);
  expect(paths).toEqual([root + "/build/openandroidstudio/variants/3a617070/demoDebug.json"]);
});

it("accepts AGP variant separators and rejects path-like variants", () => {
  for (const v of ["internal_canaryDebug", "internal-canaryDebug"]) expect(validVariant(v)).toBe(true);
  for (const v of ["../debug", "app/demo", "app:demo", "/debug"]) expect(validVariant(v)).toBe(false);
});

it("does not accept a module-owned snapshot as a legacy index", async () => {
  const read = async () => JSON.stringify({ ...snapshots("demoDebug"), application: ":other" });
  await expect(androidCallUsages(root, "demoDebug", caret, read, () => false)).rejects.toThrow(/Invalid Android index/);
});
