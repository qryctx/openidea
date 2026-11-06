#!/usr/bin/env python3
"""Run the real AGP model and both same-named application variants on a clean fixture copy."""
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

support = Path(__file__).resolve().parents[1]
ignore_build = shutil.ignore_patterns("build", ".gradle", ".kotlin", ".openidea", ".idea", "local.properties")
with tempfile.TemporaryDirectory(prefix="openandroid-sync-") as scratch:
    project = Path(scratch) / "project"
    companion = Path(scratch) / "tool cache"
    shutil.copytree(support.parent / "examples/android-variants", project, ignore=ignore_build)
    shutil.copytree(support, companion, ignore=ignore_build)
    destination = project / "shipping/secondary"
    shutil.copytree(project / "app", destination)
    shutil.copytree(destination / "src/demo", destination / "src/internal_canary")
    with (project / "settings.gradle.kts").open("a") as f:
        f.write('\ninclude(":sibling")\nproject(":sibling").projectDir = file("shipping/secondary")\n')
    with (destination / "build.gradle.kts").open("a") as f:
        f.write('\nandroid.productFlavors.create("internal_canary") { dimension = "edition" }\n')
        f.write('\nandroidComponents.beforeVariants(androidComponents.selector().withName("fullDebug")) { it.enable = false }\n')
    with (project / "gradle.properties").open("a") as f:
        f.write("\norg.gradle.configureondemand=true\n")

    model_run = subprocess.run([project / "gradlew", "-p", project, "--console=plain", "--no-configuration-cache",
                                "--no-configure-on-demand", "--init-script", companion / "discover.gradle",
                                ":openAndroidVariants"], stdout=subprocess.PIPE, text=True, check=True)
    marker = "OPENANDROIDSTUDIO_VARIANTS="
    model, = [json.loads(line[len(marker):]) for line in model_run.stdout.splitlines() if line.startswith(marker)]
    expected = [(module, variant) for module in (":app", ":sibling")
                for variant in ("demoDebug", "demoRelease", "fullDebug", "fullRelease")
                if (module, variant) != (":sibling", "fullDebug")]
    expected.extend([(":sibling", "internal_canaryDebug"), (":sibling", "internal_canaryRelease")])
    if [(item["module"], item["name"]) for item in model] != expected:
        raise ValueError(f"Expected only enabled AGP application variants. Got {model}")
    snapshots = project / "build/openandroidstudio/variants"
    if snapshots.exists() or (companion / "build").exists():
        raise ValueError("Discovery must not run lint or build the detector")

    for module, prefix, flavor in [(":app", "app/", "demo"), (":sibling", "shipping/secondary/", "demo"),
                                    (":sibling", "shipping/secondary/", "internal_canary")]:
        variant = flavor + "Debug"
        subprocess.run([companion / "index-variants", "--application", module, project, variant], check=True)
        snapshot = snapshots / module.encode().hex() / (variant + ".json")
        data = json.loads(snapshot.read_text())
        calls = [row["path"] for row in data["references"]
                 if row["symbol"] == "dev.openide.sample.contract.JavaGreeting#message()"]
        wanted = prefix + f"src/{flavor}/kotlin/dev/openide/sample/contract/FlavorGreeting.kt"
        if data["application"] != module or data["variant"] != variant or calls != [wanted]:
            raise ValueError(f"{module} did not resolve to its own source set: {calls}")
    if (snapshots / "demoDebug.json").exists() or not (snapshots / b":app".hex() / "demoDebug.json").is_file():
        raise ValueError("The second index replaced the first application's snapshot")

    # A cancelled IDE request may finish after a newer one; only the native caller may publish its output.
    original = snapshots / b":app".hex() / "demoDebug.json"
    published = original.read_bytes()
    with (project / "app/src/demo/kotlin/dev/openide/sample/contract/FlavorGreeting.kt").open("a") as f:
        f.write("\nfun addedDuringSync() = JavaGreeting()\n")
    request = "1234567890abcdef" * 2
    subprocess.run([project / "gradlew", "-p", project, "--console=plain", "--no-configuration-cache",
                    "--no-configure-on-demand", "--init-script", companion / "index.gradle",
                    f"-PopenAndroidSupportDir={companion}", "-PopenAndroidApplication=:app",
                    "-PopenAndroidVariant=demoDebug", f"-PopenAndroidIndexRequest={request}", ":openAndroidIndex"], check=True)
    staged = (original.parent / ".requests" / f"{request}.json").read_bytes()
    if original.read_bytes() != published or staged == published or json.loads(staged)["application"] != ":app":
        raise ValueError("A staged request must produce fresh data without replacing the published index")
    print("Enabled variants, distinct application snapshots and isolated late request output all verified.")
