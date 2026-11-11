"""Build the standalone adapter with the installed JDK; no network or Maven."""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent
output = root / "build"
output.mkdir(exist_ok=True)
subprocess.run(["javac", "--add-modules", "jdk.jdi", "-encoding", "UTF-8",
                "-Xlint:all", "-Werror", "-d", str(output),
                *map(str, sorted((root / "src").glob("*.java")))], check=True)
subprocess.run(["jar", "--create", "--file", str(output / "android-jdwp-dap.jar"),
                "--main-class", "AndroidDap", "-C", str(output), "AndroidDap.class",
                "-C", str(output), "AndroidDap$LineBreakpoint.class",
                "-C", str(output), "AndroidLaunch.class",
                "-C", str(output), "Json.class"], check=True)
