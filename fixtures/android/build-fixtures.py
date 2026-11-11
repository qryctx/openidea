"""Build original fixtures without an IDE; write complete logs outside the checkout."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument("--toolchain", choices=["conservative"], default="conservative")
parser.add_argument("--evidence", type=Path, required=True)
parser.add_argument("--unicode-root", type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parent
cache = os.environ.get("GRADLE_USER_HOME")
if not cache or Path(cache).resolve() == (Path.home() / ".gradle").resolve():
    parser.error("Set a dedicated GRADLE_USER_HOME before running this script.")
if args.unicode_root:
    if args.unicode_root.exists():
        parser.error("--unicode-root must be a new directory")
    shutil.copytree(root, args.unicode_root, ignore=shutil.ignore_patterns(
        "build", ".gradle", ".kotlin", "local.properties", "__pycache__"))
    root = args.unicode_root.resolve()
args.evidence.mkdir(parents=True, exist_ok=True)
wrapper = root / "toolchains" / args.toolchain / "gradlew.bat"
cases = {
    "f1-kotlin": [":app:assembleDebug"],
    "f2-java": [":app:assembleDebug"],
    "f3-mixed": [":app:assembleDebug"],
}
results = []
for fixture, tasks in cases.items():
    command = [str(wrapper), "-p", str(root / fixture), "-Ptoolchain=" + args.toolchain,
               "--no-daemon", "--console=plain", *tasks]
    start = time.monotonic()
    log = args.evidence / (args.toolchain + "-" + fixture + ".log")
    with log.open("wb") as output:
        result = subprocess.run(command, stdout=output, stderr=subprocess.STDOUT)
    row = dict(fixture=fixture, toolchain=args.toolchain, command=command,
               exitCode=result.returncode, seconds=round(time.monotonic() - start, 3),
               log=str(log.resolve()), root=str(root))
    results.append(row)
    print(json.dumps(row, ensure_ascii=False), flush=True)
(args.evidence / (args.toolchain + "-builds.json")).write_text(
    json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
raise SystemExit(0 if all(r["exitCode"] == 0 for r in results) else 1)
