# Android 真机基础样例

原创 Apache-2.0 样例；只覆盖改代码、编译、真机运行及调试准备。不需要 Compose、
网络、模拟器或代码生成插件。每个 F 目录是独立 Gradle 工程，保留父目录中的公共
脚本和 `matrix.json`。这是 G1-lite 输入，不是 IDE 断点能力已经通过的证明。

| 样例 | applicationId | 源码 |
| --- | --- | --- |
| `f1-kotlin` | `dev.openandroid.samples.kotlin` | Kotlin 单模块，Plain Views |
| `f2-java` | `dev.openandroid.samples.java` | Java 单模块，XML |
| `f3-mixed` | `dev.openandroid.samples.mixed` | app + library，Kotlin → Java → Kotlin |

启动无需点击：后台线程延迟 2 秒，执行 10 次，每次间隔 1 秒；Logcat tag 为 `OAS`。
三个层级调用链包含 primitive、String、array、List、Map、自定义对象；Kotlin
还包含 lambda。代码中的 `// BREAKPOINT-TARGET-n` 标记对应可执行行，不是独立空行。
调试会话可在启动前设置断点，或重启 Activity 后附加；Activity 销毁会中断自有线程。
Java 和 Kotlin 均输出 JVM 17 字节码，Gradle 使用 JDK 21，debug 明确为 debuggable。

## 锁定工具链

AGP **8.13.2** / Gradle **8.14.6** / Kotlin **2.3.21** / JDK **21**。
只读取已安装的 platform **android-36** 与 build-tools **36.0.0**；
compile/target SDK 36，min SDK 23，versionCode 1。所有样例禁用
`android.builder.sdkDownload`。本轮取消第二套组合、Compose、kapt 与 AGP 模型桥。

官方来源（查询日期 **2026-11-11**）：

- [Google Maven 元数据](https://dl.google.com/dl/android/maven2/com/android/tools/build/gradle/maven-metadata.xml)：8.x 最后稳定补丁 8.13.2。
- [AGP 8.13 发布说明](https://developer.android.com/build/releases/agp-8-13-0-release-notes)：8.13.2 支持 Kotlin 2.3，要求 Gradle ≥8.13、JDK ≥17、build-tools ≥35.0.0，最高 SDK 36.1。
- [Gradle 发布页](https://gradle.org/releases/)：8.14.6 为 8.x 最新补丁；不为追新引入 AGP 9 的 DSL/Kotlin 迁移。
- [Gradle Java 兼容表](https://docs.gradle.org/current/userguide/compatibility.html)：JDK 21 从 Gradle 8.5 起可运行。
- [Kotlin 兼容表](https://kotlinlang.org/docs/gradle-configure-project.html)：2.3.20–2.3.21 完全支持 Gradle 7.6.3–9.3.0、AGP 8.2.2–9.0.0。

## 原生构建

PowerShell，仓库根目录；`JAVA_HOME` 指向自有 JDK 21，`ANDROID_HOME` 指向已有 SDK。
不提交 `local.properties`，不使用用户默认 `.gradle`，不全局改环境：

```powershell
$env:GRADLE_USER_HOME = "$env:USERPROFILE\oas-gh"
$env:PYTHONIOENCODING = 'utf-8'
python fixtures\android\build-fixtures.py --evidence "$env:TEMP\oas-builds"
.\fixtures\android\toolchains\conservative\gradlew.bat -p fixtures\android\f1-kotlin :app:assembleDebug --no-daemon --console=plain
```

另两个工程替换 `-p` 目录即可；三者任务均为 `:app:assembleDebug`。
Python 驱动仅调用标准 `gradlew.bat`，记录完整日志、退出码与耗时，不经过 IDE。
Gradle 自动生成的 wrapper 固定 distribution SHA-256：
`7988ed071b2a07900e2ec715fca15c6ab72bce6db433af301fa7fa7e9407bd24`。
Linux/macOS 可直接用同目录 `gradlew`（必要时 `sh gradlew`）；本轮实测范围为 Windows。

## 最小运行合同

1. `:app:assembleDebug` 成功后，读取
   `app\build\outputs\apk\debug\output-metadata.json` 的 `applicationId`，
   `elements[].versionCode`、`elements[].outputFile`。APK 路径相对于 metadata 目录，
   不根据文件名猜包名；尚无 metadata 必须报告 notBuilt。
2. 从 `app\build\intermediates\merged_manifests\debug\processDebugManifest\AndroidManifest.xml`
   找到同时具有 MAIN action 和 LAUNCHER category 的 Activity，展开 `.MainActivity`
   相对名；多 launcher/alias 时不能随便选第一个（样例只有一个）。
3. 真机确认 `adb devices -l` 恰有一个物理设备处于 `device`。所有后续命令显式
   `adb -s <serial>`，仅安装/卸载 `dev.openandroid.samples.*`。
4. `gradlew ... :app:installDebug`（仅单个已授权设备）或
   `adb -s <serial> install -r <metadata-resolved-apk>`；随后：

```powershell
adb -s <serial> shell cmd package resolve-activity --brief -c android.intent.category.LAUNCHER <applicationId>
adb -s <serial> shell am start -W -n <resolved-component>
adb -s <serial> logcat --pid=<sample-pid> -d -s OAS:I '*:S'
adb -s <serial> uninstall <applicationId>
```

实际 serial 只留在本机运行参数，不能提交。不要清 Logcat、`pm clear`、重启、
修改系统设置、结束共享 adb server 或删除其他调试会话的转发。
`validate-run.py` 自动验证 host metadata/manifest 与真机解析、日志、清理；
依赖先构建成功，必须指定外部 evidence 目录：

```powershell
python fixtures\android\validate-run.py --evidence "$env:TEMP\oas-run"
```

实测结果、Windows 取消行为和已知限制见
[`G1-samples-build.md`](../../openandroidstudio/validation/G1-samples-build.md)。
