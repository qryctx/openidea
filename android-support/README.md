# Android variant references

Open the Gradle root as a trusted project in the Android edition. The IDE asks AGP which application variants are enabled. Select one in the status bar to prepare its reference index. Discovery uses the project's Gradle Wrapper. It does not run lint or require a prebuilt index.

The tested combination is JDK 21, Gradle Wrapper 9.5.0, AGP 9.3.1, Android SDK Platform 36 and Android lint 32.3.1. On first indexing, the project's wrapper builds the detector in a writable companion cache. Gradle can download lint's compiler and analysis dependencies on first use.

## Reproduce a single application from the command line

```sh
android-support/index-variants --application :app examples/android-variants demoDebug fullDebug
python3 android-support/verify-fixture.py --application :app
```

The first command runs AGP lint for each selected application variant, including its Android library dependencies. Snapshots live in `<project>/build/openandroidstudio/variants/<module-hex>/<variant>.json`. The module directory is the lowercase hexadecimal encoding of the Gradle path's UTF-8 bytes. For example, `:app` becomes `3a617070`. Each index also records the original application path. This keeps `:app/demoDebug` distinct from another application's `demoDebug`. Omitting `--application` retains the original flat output for callers that use the earlier single-application CLI. The second command checks exact locations against the sample's separately authored expectations and verifies the digests. It requires Python 3.9+.

To inspect the same model the IDE receives, set `support` to this directory's absolute path and run the following from the Android project:

```sh
./gradlew --console=plain --no-configuration-cache --no-configure-on-demand \
  --init-script "$support/discover.gradle" :openAndroidVariants
```

The `OPENANDROIDSTUDIO_VARIANTS=` output line contains a JSON array of `module` and `name` pairs. It lists applications in the selected Gradle build. AGP's variant callbacks omit disabled variants and honor Gradle module-to-directory mappings. Library variants, buildSrc and applications from included builds are outside the selector's scope.

Each call's identity comes from Java/Kotlin UAST `resolve()` on AGP lint's variant classpath. A constructor call uses its declaring class's qualified name. An explicit member method uses its declaring class, JVM method name and erased, fully qualified parameter types, e.g. `example.Greeting#message(java.lang.String)`. The snapshot lists declaration and call identifier ranges with project-relative paths and zero-based UTF-16 coordinates. Each analysed source is fingerprinted with SHA-256 of UTF-8 text after removing a leading BOM and normalising CRLF/CR to LF, matching the editor's document representation.

## Coverage

- Open a project's source declaration or use site and select a generated variant in the IDE. The provider covers constructor calls to named classes and explicit calls to ordinary Java/Kotlin member methods. Choose the default language service to query other source constructs. Imports, parameter/field type uses, override-family expansion, callable references, Kotlin suspend/extension/top-level functions, synthetic properties, generated/test sources and unsaved edits are outside this provider's scope. The two call directions in the example exercise both a no-argument method and its distinct String overload.
- A compile, lint or unresolved-constructor error aborts indexing. If lint cannot bind an explicit call, the snapshot lists its simple name in `incompleteMethodNames` and omits **all** methods with that name. When a resolved JVM method name differs from the source token, both names are withheld. This conservative rule avoids offering a partial answer for a matching symbol while allowing other member and constructor queries.
- The example has one app, with a Java and a Kotlin declaration in its library. For a project with multiple applications exposing the same variant, choose the specific module in the IDE or pass `--application :module` to the CLI. Absolute source paths must resolve under the project root. Projects with an existing lint baseline are currently unsupported. Project lint suppressions can hide indexed locations. Recheck with the sample before relying on different AGP or lint versions.
- Existing recorded files have digests. Adding a file or changing the build model requires regeneration. IDE requests stage a fresh result in the selected module's `.requests` directory. The native caller publishes it only after a successful, current request, so a cancelled Gradle process cannot overwrite the active result later. The manual CLI invalidates its own previous snapshot when project configuration begins, then writes a new snapshot atomically after lint and digest checks succeed.

To inspect one invocation, first build the detector with the wrapper, then run this from an Android project. Use an absolute path to the fork's `android-support` directory.

```sh
./gradlew -p "$support" jar
./gradlew --no-configuration-cache --no-configure-on-demand --init-script "$support/index.gradle" \
  "-PopenAndroidSupportDir=$support" -PopenAndroidApplication=:app -PopenAndroidVariant=demoDebug :openAndroidIndex
```

The init script configures lint only for the indexing invocation. It does not require modifying the app's Gradle scripts or adding a runtime dependency to the APK.

Run `python3 android-support/tests/sync-variants.py` to check AGP discovery, a disabled variant, two applications that resolve the same variant name to different files, and staged request isolation after a source edit.

Run `python3 android-support/tests/renamed-method.py` for the isolated Kotlin/JVM name regression. It creates a temporary copy of the public fixture, compiles a Kotlin member with `@JvmName` and calls it by both spellings. The index must withhold those method names and still resolve ordinary member and constructor queries.
