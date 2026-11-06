# Android 工程同步与精简发行包

打开使用 Gradle Wrapper 的本地 Android 工程，选择 **Trust Project**。状态栏会显示发现变体的进度。在 **Android reference variant** 中选择应用模块和变体，等状态栏显示选中的名字，再在 Java 或 Kotlin 声明上执行 **Find Usages**（macOS 默认 ⌥F7）。首次使用需要可用的 JDK、项目要求的 Android SDK 以及 Gradle 依赖。

以 [双模块示例](../examples/android-variants/README.md) 为例，从没有任何生成目录的工程开始。选择 `demoDebug`，在库里的 `KotlinGreeting.message()` 上查引用，结果应为 `app/src/demo/java/…/JavaCaller.java`。切换到 `fullDebug`，结果会变成 `app/src/full/java/…/JavaCaller.java`。同一行的 `message(String)` 调用属于另一个重载。对 Java 声明的查询则返回 app 中的 Kotlin 调用。

工程打开时通过 AGP 枚举已启用的应用变体，选中后才通过项目的 Wrapper 和 lint 生成对应的语义索引。索引按“应用模块＋变体”分目录，两个应用可以各自拥有名为 `demoDebug` 的变体。状态栏显示准备或失败的状态，菜单中提供重新同步入口。仅在受信任的本地工程执行 Gradle。生成索引所需的分析规则由应用提供。当前认证的环境是 macOS arm64、JDK 21、Gradle 9.5.0、AGP 9.3.1、SDK Platform 36。支持范围是构造调用和普通成员方法直接调用。构建与部署仍使用独立的运行配置。

## 构建

在仓库根目录使用与上游相同的 Rust、CMake、Node 和 pnpm 工具链执行：

```sh
pnpm install --frozen-lockfile
pnpm package:android:mac
```

产物在 `target/release/bundle/macos/OpenAndroidStudio.app`。Android 发行版使用独立应用标识 `io.github.qryctx.openandroidstudio`，可以和上一版 Pilot 同时运行。打包脚本会做本地 ad-hoc 签名并验证。Android 专用构建先生成带匹配 source map 的前端资产，将映射另存在 `target/android-frontend/sourcemaps`，Tauri 只嵌入同级的 `web` 目录。可以按构建提交归档诊断文件，用于还原对应版本的前端堆栈。通用前端构建仍使用原有配置。

## 复现桌面验收

在两个终端分别运行 `pnpm dev:app` 和 `node android-support/verify-desktop.mjs`。验证脚本从 Git 跟踪的示例文件复制出新的临时工作区，只信任该工作区。由桌面界面发现、选择和生成索引，手写预期只用于比对结果。脚本检查 demo → full → demo 的双向 Java/Kotlin 构造与成员方法调用，还会向临时工作区新增一个 Java 调用再移除，检查活动变体的引用随之更新。

## 已验证的工程行为

在两份独立的干净工程副本上各执行 12 次 Find Usages，返回的文件和 UTF-16 区间一致。首次发现列出了 demo/full 的 debug 和 release 变体，选择 demo 时仅生成对应模块的 demo 索引。两次变体切换均把旧搜索标签从 1 清到 0。新增一个 Java 调用，查询结果自动从 1 变到 2，移除后回到 1。另一次在临时工程里引入 Gradle 配置错误，界面清除旧结果并显示失败，修复后自动恢复到原选的 `demoDebug`。具有重复变体名的两个应用以及 AGP 禁用的变体另有真实 Gradle 回归覆盖。[桌面返回位置](validation/android-project-sync.json) · [多应用与禁用变体验证](../android-support/tests/sync-variants.py)
