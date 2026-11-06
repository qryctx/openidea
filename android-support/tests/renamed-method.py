#!/usr/bin/env python3
"""Exercise a Kotlin/JVM name mismatch on an isolated copy of the public Android fixture."""
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

support = Path(__file__).resolve().parents[1]
package = "dev.openide.sample.contract"
subdir = Path(*package.split("."))
with tempfile.TemporaryDirectory(prefix="openidea-renamed-") as temp:
    project = Path(temp) / "sample"
    shutil.copytree(support.parent / "examples/android-variants", project,
                    ignore=shutil.ignore_patterns("build", ".gradle", ".kotlin", ".openidea", ".idea", "local.properties"))
    (project / "libraries/contracts/src/main/kotlin" / subdir / "Renamed.kt").write_text(
        f'package {package}\nclass Renamed {{\n'
        '    @JvmName("renamedForJvm") fun originalInKotlin() = 1\n'
        '    fun ordinary() = 2\n}\n')
    (project / "app/src/demo/kotlin" / subdir / "RenameUse.kt").write_text(
        f'package {package}\nfun kotlinRename() = Renamed().originalInKotlin()\n')
    (project / "app/src/demo/java" / subdir / "RenameUse.java").write_text(
        f'package {package};\nclass RenameUse {{ int use() {{ '
        'Renamed r = new Renamed(); return r.renamedForJvm() + r.ordinary(); } }\n')
    subprocess.run([support / "index-variants", project, "demoDebug"], check=True)
    data = json.loads((project / "build/openandroidstudio/variants/demoDebug.json").read_text())
    withheld = {"originalInKotlin", "renamedForJvm"}
    if not withheld.issubset(data["incompleteMethodNames"]):
        raise ValueError(f"Both renamed identifiers must be marked incomplete: {data['incompleteMethodNames']}")
    for site in data["declarations"] + data["references"]:
        if any(("#" + name + "(") in site["symbol"] for name in withheld):
            raise ValueError(f"Exposed partial results: {site}")
    calls = [site["symbol"] for site in data["references"]]
    owner = package + ".Renamed"
    if calls.count(owner) != 2 or calls.count(owner + "#ordinary()") != 1:
        raise ValueError("Renamed calls should preserve independently resolved class and method queries")
    print("Correctly withheld renamed methods; both constructor calls and ordinary member usage still resolve.")
