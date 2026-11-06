# Android variant references

Build the rule from source and generate both indexes from the repository root. Install a JDK and an Android SDK compatible with the sample first. The tested combination is JDK 21, Gradle Wrapper 9.5.0, AGP 9.3.1, Android SDK Platform 36, and Android lint 32.3.1. Gradle downloads lint's compiler and analysis dependencies on first use.

```sh
android-support/index-variants examples/android-variants demoDebug fullDebug
python3 android-support/verify-fixture.py
```

The first command uses the project's Gradle Wrapper to build the detector JAR, then invokes AGP lint once for each selected application variant, including its Android library dependencies. It stores one snapshot per variant under `<project>/build/openandroidstudio/variants/`. The second command checks exact locations against the sample's separately authored expectations and verifies the digests. It requires Python 3.9+. Generated reports, classes and absolute machine paths stay in Gradle build directories.

Each call's identity comes from Java/Kotlin UAST `resolve()` on AGP lint's variant classpath. A constructor call uses its declaring class's qualified name. An explicit member method uses its declaring class, JVM method name and erased, fully qualified parameter types, e.g. `example.Greeting#message(java.lang.String)`. The snapshot lists declaration and call identifier ranges with project-relative paths and zero-based UTF-16 coordinates. Each analysed source is fingerprinted with SHA-256 of UTF-8 text after removing a leading BOM and normalising CRLF/CR to LF, matching the editor's document representation.

## Coverage

- Open a project's source declaration or use site and select a generated variant in the IDE. The provider covers constructor calls to named classes and explicit calls to ordinary Java/Kotlin member methods. Choose the default language service to query other source constructs. Imports, parameter/field type uses, override-family expansion, callable references, Kotlin suspend/extension/top-level functions, synthetic properties, generated/test sources and unsaved edits are outside this provider's scope. The two call directions in the example exercise both a no-argument method and its distinct String overload.
- A compile, lint or unresolved-constructor error aborts indexing. If lint cannot bind an explicit call, the snapshot lists its simple name in `incompleteMethodNames` and omits **all** methods with that name. When a resolved JVM method name differs from the source token, both names are withheld. This conservative rule avoids offering a partial answer for a matching symbol while allowing other member and constructor queries.
- The first example has one app, with a Java and a Kotlin declaration in its library. Projects with multiple applications exposing the same variant must explicitly pass `-PopenAndroidApplication=:module` to the Gradle task. Absolute source paths must resolve under the project root. Projects with an existing lint baseline are currently unsupported. Project lint suppressions can hide indexed locations. Recheck with the sample before relying on different AGP or lint versions.
- Refresh after editing or adding a source, changing the build model/dependencies or selecting a new variant. Existing recorded files have digests; adding a file or changing the build model requires regeneration. A rebuild removes the previous snapshot for its variant when it enters project configuration and writes a new one atomically only after lint and digest checks succeed. A failed refresh emits a Gradle error. Other variants retain their own saved results.

To inspect one invocation, first build the detector with the wrapper, then run this from an Android project. Use an absolute path to the fork's `android-support` directory.

```sh
./gradlew -p "$support" jar
./gradlew --no-configuration-cache --init-script "$support/index.gradle" \
  "-PopenAndroidSupportDir=$support" -PopenAndroidVariant=demoDebug openAndroidIndex
```

The init script configures lint only for the indexing invocation. It does not require modifying the app's Gradle scripts or adding a runtime dependency to the APK.

Run `python3 android-support/tests/renamed-method.py` for the isolated Kotlin/JVM name regression. It creates a temporary copy of the public fixture, compiles a Kotlin member with `@JvmName` and calls it by both spellings. The index must withhold those method names and still resolve ordinary member and constructor queries.
