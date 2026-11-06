# Android variant references

Open this directory as a project. The app has two flavors, `demo` and `full`, and depends on the Android library `:contract`. Gradle maps the library to `libraries/contracts`. Both flavors define the same caller names in separate source sets, so changing the active variant changes the locations returned by Find Usages.

## Build both variants

Install JDK 21 and an Android SDK containing platform 36. Point `JAVA_HOME` and `ANDROID_HOME` at those installations. The project uses AGP 9.3.1 with built-in Kotlin and a Gradle 9.5.0 Wrapper. It resolves dependencies from Google Maven and Maven Central.

```sh
./gradlew :app:assembleDemoDebug :app:assembleFullDebug
```

The APKs appear under `app/build/outputs/apk/demo/debug` and `app/build/outputs/apk/full/debug`. The application IDs end in `.demo` and `.full`. The button exercises both cross-language calls and displays the active edition.

## Check Find Usages

From the IDE checkout, generate the two constructor indices with `android-support/index-variants examples/android-variants demoDebug fullDebug`. Open **examples/android-variants** itself in the fork. If the IDE was already open, run **Reload Android reference variants** via Find Action. Select the desired edition in the **Android reference variant** status button. This controls Find Usages for Java/Kotlin constructors and ordinary methods; it does not change the Gradle run configuration.

Start at either class declaration in `:contract`, then at its zero-argument `message()` declaration. Find usages with the declaration excluded. Check `demoDebug`, switch to `fullDebug`, then switch back to `demoDebug`. Each query should return exactly one constructor use or one call to the zero-argument method in the active flavor's app source set. Each caller also invokes `message(String)`, on the same line as `message()`, to check overload identity and precise selection.

| Declaration in the library                   | Expected caller in the app                        |
| -------------------------------------------- | ------------------------------------------------- |
| `dev.openide.sample.contract.JavaGreeting`   | Kotlin, `src/<flavor>/kotlin/…/FlavorGreeting.kt` |
| `dev.openide.sample.contract.KotlinGreeting` | Java, `src/<flavor>/java/…/JavaCaller.java`       |

`expected-usages.json` records the project-relative URI and zero-based UTF-16 range for each declaration and result. End positions are exclusive. The callers deliberately share the declarations' package so the expected locations contain only constructor calls. The `decoy` package supplies two distinct same-named types, their own `message()` methods and calls, plus matching comment and string text. Those locations and callers in the inactive flavor must be excluded.

## Run the desktop acceptance check

From the repository root, generate both variant indexes, then start the development application:

```sh
android-support/index-variants examples/android-variants demoDebug fullDebug
pnpm dev:app
```

In a second terminal run `node android-support/verify-desktop.mjs`. The driver discovers this checkout's development window, selects demo → full → demo in the status bar, invokes Find Usages on each declaration, and compares the displayed results and source ranges against `expected-usages.json`. It writes twelve native screenshots and a JSON report to a printed temporary path. To choose the evidence directory, pass it as the first argument.

## Wrapper provenance

The unmodified launcher scripts and JAR come from [Gradle v9.5.0](https://github.com/gradle/gradle/tree/v9.5.0). The JAR contains its Apache 2.0 license. Its SHA-256 is `497c8c2a7e5031f6aa847f88104aa80a93532ec32ee17bdb8d1d2f67a194a9c7`. The Wrapper properties also pin the distribution SHA-256. Both hashes can be checked against [Gradle's published checksums](https://gradle.org/release-checksums/).
