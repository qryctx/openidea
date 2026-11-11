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

## Windows 路径与取消

AGP 默认拒绝中文工程路径；仅作显式实验，不改变所有用户工程的默认设置：

```powershell
python fixtures\android\build-fixtures.py --unicode-root "$env:USERPROFILE\oas 样例 space" --override-path-check --evidence "$env:TEMP\oas-unicode"
python fixtures\android\cancel-probe.py --mode both --repeats 2 --evidence "$env:TEMP\oas-cancel"
```

`--unicode-root` 必须是新目录，复制时不含 build/cache/local.properties。
覆盖开关是 AGP 提示的 `-Pandroid.overridePathCheck=true`；不传它时实际退出码为 1。
实测传开关后三个样例构建通过，但不等于所有 Windows 工具都支持 Unicode。

初次 CTRL_BREAK 实验只产生 JVM thread dump，不能取消；原日志保留，不再重复。
当前驱动改为镜像 `ide-core/src/process.rs` 的 Windows
`taskkill /T /F /PID <自有客户端 PID>`，等待已捕获子进程，再终止/回收客户端。
使用与生产路径一致的 `CREATE_NO_WINDOW`，不发送控制台信号。

每次运行在专用缓存下新建**独享、可删除的 Gradle user home 与工程**。
任务每 250 ms 向文件追加心跳；同时保留 PID、创建时间和进程 handle，
避免把 PID 重用或其他会话的 daemon 当成自己的。分别检查 `--no-daemon`、
成功预热后仍在运行的 daemon + 新客户端，默认每种重复两次。
只有真实任务 JVM 已退出或记录了 `InterruptedException`，且反馈/任务停止均 ≤5 秒，
才记为取消通过；不只检查客户端退出或心跳短暂安静。

读取 `summary.json` 与逐用例 `*-result.json`：
`clientFeedbackSeconds`、`workStopBoundSeconds`、`workStopEvidence`、
`explicitDaemonCleanup` 分开记录。失败/超时/残留/样例输入变更时驱动退出 1；
退出 0 表示全部所选用例通过并清理完成，不再表示“仅完成测量”。
预热 daemon 的后续精确 PID 清理**不计入取消成功**。不使用 `gradle --stop`、
按进程名 kill、共享缓存或 adb。

两次独立执行共八个用例通过，实际停止上界 0.094–0.484 秒；样例输入哈希不变，
自有进程与临时 user home 清理完成。保留现有 PID 树策略，不引入模型桥。
这是宿主机进程策略回归，**不是原生 IDE Stop 按钮或任意 AGP/native 阻塞任务已通过**。

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
