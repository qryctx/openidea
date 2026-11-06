#!/usr/bin/env python3
"""Check the public fixture against human-authored UTF-16 locations."""
import hashlib
import json
import sys
from pathlib import Path


def locations(rows, symbol):
    return [{"uri": row["path"], "range": row["range"]}
            for row in rows if row["symbol"] == symbol]


def check_symbol(index, expected_decl, expected_refs, symbol, variant):
    actual = locations(index["references"], symbol)
    declaration = locations(index["declarations"], symbol)
    if actual != expected_refs or declaration != [expected_decl]:
        raise ValueError(f"{variant} {symbol}: expected {expected_refs}, got {actual}; declaration={declaration}")
    print(f"{variant} {symbol} -> {actual[0]['uri']} ({len(actual)} exact match)")
    return actual


def verify(project):
    oracle = json.loads((project / "expected-usages.json").read_text())
    for variant, expected in oracle["variants"].items():
        index = json.loads((project / "build/openandroidstudio/variants" / (variant + ".json")).read_text())
        if index["schema"] != 1 or index["variant"] != variant:
            raise ValueError(f"Wrong variant in {variant}.json")
        for path, digest in index["files"].items():
            source = (project / path).resolve()
            if not source.is_relative_to(project) or hashlib.sha256(source.read_text(encoding="utf-8-sig").encode()).hexdigest() != digest:
                raise ValueError(f"Missing or stale {variant} source {path}")
        for name, refs in expected.items():
            symbol = "dev.openide.sample.contract." + name
            check_symbol(index, oracle["declarations"][name], refs, symbol, variant)
            decoy = "dev.openide.sample.decoy." + name
            if len(locations(index["references"], decoy)) != 1:
                raise ValueError(f"Missing independently resolved namesake {decoy}")
        for symbol, refs in oracle["memberVariants"][variant].items():
            actual = check_symbol(index, oracle["memberDeclarations"][symbol], refs, symbol, variant)
            overload = symbol.removesuffix("()") + "(java.lang.String)"
            overload_calls = locations(index["references"], overload)
            if (len(locations(index["declarations"], overload)) != 1 or len(overload_calls) != 1
                    or overload_calls[0]["uri"] != actual[0]["uri"] or overload_calls[0]["range"] == actual[0]["range"]):
                raise ValueError(f"Overload did not resolve to a separate call site: {overload}")
            decoy = symbol.replace(".contract.", ".decoy.")
            if len(locations(index["references"], decoy)) != 1:
                raise ValueError(f"Missing distinct decoy method {decoy}")


if __name__ == "__main__":
    default = Path(__file__).resolve().parents[1] / "examples/android-variants"
    verify((Path(sys.argv[1]) if len(sys.argv) > 1 else default).resolve())
