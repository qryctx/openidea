import type { Location } from "@/bindings";
import { formatMessage, tx } from "@/platform/i18n";

type Point = { line: number; character: number };
type Site = { path: string; symbol: string; range: { start: Point; end: Point } };
interface Index {
  schema: 1;
  variant: string;
  files: Record<string, string>;
  declarations: Site[];
  references: Site[];
  incompleteMethodNames?: string[];
}

export const validVariant = (v: string) => /^[A-Za-z][A-Za-z0-9]*$/.test(v);
const sourcePath = (p: string) =>
  !p.includes("\0") &&
  !/[\\:]/.test(p) &&
  p.split("/").every((s) => s && s !== ".." && s !== ".") &&
  /\.(kt|java)$/.test(p);
const obj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const point = (v: unknown): v is Point =>
  obj(v) &&
  Number.isSafeInteger(v.line) &&
  Number(v.line) >= 0 &&
  Number.isSafeInteger(v.character) &&
  Number(v.character) >= 0;
const cmp = (a: Point, b: Point) => a.line - b.line || a.character - b.character;
const site = (v: unknown): v is Site =>
  obj(v) &&
  typeof v.path === "string" &&
  sourcePath(v.path) &&
  typeof v.symbol === "string" &&
  !!v.symbol &&
  obj(v.range) &&
  point(v.range.start) &&
  point(v.range.end) &&
  cmp(v.range.start, v.range.end) < 0;

function parseIndex(text: string, variant: string): Index {
  try {
    const i: unknown = JSON.parse(text);
    if (
      obj(i) &&
      i.schema === 1 &&
      i.variant === variant &&
      (i.incompleteMethodNames === undefined ||
        (Array.isArray(i.incompleteMethodNames) && i.incompleteMethodNames.every((n) => typeof n === "string"))) &&
      obj(i.files) &&
      Object.keys(i.files).length &&
      Object.entries(i.files).every(([p, h]) => sourcePath(p) && typeof h === "string" && /^[0-9a-f]{64}$/.test(h)) &&
      Array.isArray(i.declarations) &&
      Array.isArray(i.references) &&
      [...i.declarations, ...i.references].every((s) => site(s) && Object.hasOwn(i.files as object, s.path))
    )
      return i as unknown as Index;
  } catch {
    /* Same actionable error for invalid JSON and invalid schema. */
  }
  throw new Error(tx("Invalid Android index. Regenerate the variant index."));
}

export const indexDir = (root: string) => root.replace(/[/\\]$/, "") + "/build/openandroidstudio/variants";

export async function androidCallUsages(
  root: string,
  variant: string,
  caret: { path: string; line: number; col: number; word?: string | null },
  read: (path: string) => Promise<string>,
  dirty: (path: string) => boolean,
): Promise<{ locations: Location[]; note: string }> {
  if (!validVariant(variant)) throw new Error(tx("Invalid Android index. Regenerate the variant index."));
  const prefix = root.replaceAll("\\", "/").replace(/\/$/, "") + "/";
  let raw: string;
  try {
    raw = await read(indexDir(root) + "/" + variant + ".json");
  } catch {
    throw new Error(tx("Android index unavailable. Regenerate the variant index."));
  }
  const i = parseIndex(raw, variant);
  const entries = Object.entries(i.files);
  const stale = () => new Error(tx("Android sources changed. Save and regenerate the variant index."));
  // Validate every fingerprint, including files with no matches: an edit there could add a usage.
  for (let n = 0; n < entries.length; n += 6) {
    await Promise.all(
      entries.slice(n, n + 6).map(async ([p, expected]) => {
        const full = prefix + p;
        if (dirty(full)) throw stale();
        let text: string;
        try {
          text = await read(full);
        } catch {
          throw stale();
        }
        const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
        if (Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("") !== expected)
          throw stale();
      }),
    );
  }
  const path = caret.path.replaceAll("\\", "/");
  const at = { line: caret.line, character: caret.col };
  const symbol = [...i.declarations, ...i.references].find(
    (s) => path === prefix + s.path && cmp(s.range.start, at) <= 0 && cmp(at, s.range.end) < 0,
  )?.symbol;
  if (!symbol && caret.word && i.incompleteMethodNames?.includes(caret.word))
    throw new Error(
      tx("Android lint could not resolve all calls with this method name. Use the default language service."),
    );
  if (!symbol)
    throw new Error(tx("No indexed class or method at the caret. Use the default language service for other symbols."));
  return {
    locations: i.references
      .filter((s) => s.symbol === symbol)
      .map(({ path, range }) => ({
        path: prefix + path,
        range: {
          start: { line: range.start.line, col: range.start.character },
          end: { line: range.end.line, col: range.end.character },
        },
      })),
    note: formatMessage(
      symbol.includes("#") ? tx("Android method calls · {variant}") : tx("Android constructor usages · {variant}"),
      { variant },
    ),
  };
}
