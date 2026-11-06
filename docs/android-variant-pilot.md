# OpenAndroidStudio: Android 变体查引用实验

这个分支回答一个具体问题：同一个 Android 工程中，当两个 flavor 有同名调用方时，能否在不重启 IDE 的情况下，只查到当前变体真正解析到的 Java 或 Kotlin 调用？

## 本机复现

1. 从本分支检出源码，安装上游桌面构建依赖；macOS 需要 Xcode Command Line Tools、Node、pnpm、Rust 和 CMake。Android 示例使用 JDK 21、Android SDK Platform 36；将 `JAVA_HOME`、`ANDROID_HOME` 指向本机安装位置。桌面构建与 Android SDK 使用的是两套工具链。
2. 在仓库根目录执行 `pnpm install --frozen-lockfile`。在示例目录执行 `./gradlew :app:assembleDemoDebug :app:assembleFullDebug`。两个 APK 可以分别安装，application ID 后缀分别为 `.demo`、`.full`。
3. 回仓库根目录执行 `android-support/index-variants examples/android-variants demoDebug fullDebug`，再执行 `python3 android-support/verify-fixture.py`。这一步分别运行两个变体的 AGP lint，在本机生成语义索引；预期位置来自独立手写文件。
4. 运行 `pnpm dev:app`，用桌面应用打开 **examples/android-variants**。点击状态栏 **Android 引用变体 / Android reference variant**；已打开的工程可以在 Find Action 中执行 **Reload Android reference variants** 刷新列表。
5. 在库 `:contract` 的声明上执行 **Find Usages**（macOS 默认 ⌥F7），依次选择 `demoDebug → fullDebug → demoDebug`。选择器只控制 Java/Kotlin 查引用，不更改 Gradle 的构建或运行配置。
6. 自动复现相同的桌面操作：保持上述开发窗口开启，在第二个终端运行 `node android-support/verify-desktop.mjs`。脚本连接该工作树的 Tauri 调试桥，操作真实状态栏和编辑器，检查 Find Usages 结果、文件、UTF-16 区间及界面高亮，并在本机输出截图和 JSON。也可传入自选的证据目录。

## 打包本机桌面应用

在 macOS 上，从本分支根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm tauri build --bundles app --config src-tauri/tauri.android-pilot.conf.json
```

产物是 `target/release/bundle/macos/OpenAndroidStudio Pilot.app`（自定义了 `CARGO_TARGET_DIR` 时在对应目录下）。Pilot 使用独立的应用标识，保留上游许可证和 NOTICE；不指向上游更新服务。这是供本地验证的构建，没有发布为已公证的 macOS 安装包。生成 Android 索引时仍需本机 JDK 和 SDK。

## 查的是哪些引用

| 库里的声明                                 | app 中的调用方              | demoDebug             | fullDebug             |
| ------------------------------------------ | --------------------------- | --------------------- | --------------------- |
| Java 类 `JavaGreeting` 的构造调用          | Kotlin，`FlavorGreeting.kt` | `app/src/demo/kotlin` | `app/src/full/kotlin` |
| Kotlin 类 `KotlinGreeting` 的构造调用      | Java，`JavaCaller.java`     | `app/src/demo/java`   | `app/src/full/java`   |
| Java 实例方法 `JavaGreeting.message()`     | Kotlin，`FlavorGreeting.kt` | `app/src/demo/kotlin` | `app/src/full/kotlin` |
| Kotlin 实例方法 `KotlinGreeting.message()` | Java，`JavaCaller.java`     | `app/src/demo/java`   | `app/src/full/java`   |

两个模块分别是 `:app` 和 `:contract`，后者的实际目录是 `libraries/contracts`。应用里的 Kotlin 和 Java 分属不同源集。每项都要求恰好返回一个调用位置，排除未选 flavor、其他包里的同名类、字符串、注释和不匹配的方法重载。[逐项预期](../examples/android-variants/expected-usages.json)使用从零开始的 UTF-16 位置，结束位置不包含在内。

## 如何判断是否通过

- **能编译**：两个变体都能独立生成 APK；字节码能确认调用实际指向的类和方法。这一步不能证明编辑器查引用正确。
- **能解析**：Android Gradle Plugin 为选定变体提供 classpath，lint/UAST 解析源声明和调用目标，按所属类型和签名记录位置。两个变体各有自己的索引；运行协议中的文本预期仅用于验收，不参与 IDE 返回结果。
- **能在 IDE 使用**：在一次桌面会话里切两次变体，分别从两个声明语言查到另一个模块里的调用。结果必须在 Find Usages 面板中展示正确文件、标识符区间和变体名。仅在磁盘上生成 JSON 不算这一步通过。

## 实测记录 · 2026-11-06

- 基线：个人 fork 保留 [上游 v0.1.37](https://github.com/l0ng-ai/openidea/releases/tag/v0.1.37) 历史，起点为 `d3d0fd23c6141a019632e71ac89796c2c4d5e76b`。
- 上游桌面构建：macOS arm64、Node 26.13、pnpm 11.25.0、Rust 1.99.1。从干净标签构建 Tauri release，Cargo 报告 19 分 37 秒；应用包 148.20 MiB。实际启动后窗口显示 `OpenIDEA 0.1.37`；独立冒烟工程成功打开，日志确认两个文件完成索引。应用包不含 JDK、Android SDK、Rust 构建目录或通用 Gradle 缓存。
- Android：Gradle 9.5.0 / AGP 9.3.1 / lint 32.3.1 / JDK 21 / compileSdk 36。两个 APK 大小分别为 879,276 和 879,288 字节；字节码中有两个不同的方法签名。每个变体分析 7 个 Java/Kotlin 源文件；本次输出的两份 JSON 合计约 30 KiB。
- 精度：生成器的 2 变体 × 2 声明语言 × 2 种调用共 8 组独立比对通过，文件和标识符区间逐项吻合。测试还验证了同名类、方法重载、已修改文件、错误变体、编译失败导致旧索引失效，以及 BOM / CRLF / 补充字符的 UTF-16 位置。另有 [Kotlin 与 JVM 名称不同的回归测试](../android-support/tests/renamed-method.py)：无法完整对应名称的调用会明确标为不完整。
- 桌面：在同一个 Tauri 原生窗口点击状态栏，按 demo → full → demo 执行 Find Usages，12/12 通过。两次切换均把旧结果标签从 1 清为 0；无参调用与带参重载在同一行时仍只高亮正确的方法名。见[这次运行逐项返回的真实路径和区间](validation/android-variant-desktop.json)。在受限模式和信任工程模式分别运行，各 12/12，返回的文件和 UTF-16 区间逐项一致。两轮使用同一份预生成索引，未在 IDE 中安装可选的 JDT、Kotlin 语言服务，也未从窗口发起 Gradle 命令。
- 前端：全量 Vitest 6,582 通过、6 跳过；搜索与引用高亮的 Chromium 回归用例 9 通过。

## 范围与代价

当前支持已生成索引里的类构造调用、普通成员方法直接调用。这些查询使用 AGP 自带的 lint 分析，无需默认 Kotlin 语言服务先启动。它不是对 Android Studio 所有引用类型的替代：字段、任意类型使用、完整继承/覆写关系、反射、XML/资源和 Compose 约定均不在本次验收范围。选择 **Default language service** 可回到上游的语言服务，其结果不承诺按本功能选定的 Android 变体过滤。

索引按需生成，首次运行要下载分析依赖。本次样例只有两个模块；没有据此推算大型工程的性能或节省的磁盘空间。当前查询会核对索引记录的源文件摘要；修改已有源文件时要求保存、重新生成，新增文件及构建脚本、依赖或 source set 变化也需要手工重新生成。下一步最有价值的是把生成和失效检测接到 IDE 的 Gradle 同步，而后再扩大符号类型覆盖。
