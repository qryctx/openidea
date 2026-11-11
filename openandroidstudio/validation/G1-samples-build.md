# G1-lite：最小样例、原生构建与真机运行合同

日期：**2026-11-11**。本报告对应用户收缩后的范围：只做真机，先证明看代码、
改动、编译、运行及断点的基础闭环。**本会话的样例构建与真机运行通过；
IDE 内断点、栈、变量查看仍由独立调试 spike 验证，不能据此宣布整个 G1-lite 通过。**

证据标签：**实测**＝真实命令及日志；**源码确认**＝工程配置/实现；
**官方文档声明**＝所列官方来源；**未验证**＝本轮不作通过结论。
没有用 mock、静态正则推算 AGP 模型或手写结果冒充真实集成。

## 1. 范围调整与工具链

用户最新决定替代 T03/T04 原合同：一套工具链、F1 Kotlin/F2 Java/F3 混编，
Plain Views、真机优先。T04 模型桥暂停，AGP 模型门槛取消。
**源码确认：未创建 `java/android-model-bridge`，没有 Rust/TypeScript 修改。**
前一次本地提交中的 Compose/kapt/flavor/第二套 wrapper 已在后续提交移除；
它们的初步结果不计入当前验收。品牌、产品标识与 IDE 主体均未改变。

| 组件                   | 选择            | 证据与理由（来源均查询于 2026-11-11）                                                                                                                                                                                                                                        |
| ---------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AGP                    | 8.13.2          | **官方文档声明**：[Google Maven 元数据](https://dl.google.com/dl/android/maven2/com/android/tools/build/gradle/maven-metadata.xml) 中最后的 8.x 稳定补丁；[8.13 发布说明](https://developer.android.com/build/releases/agp-8-13-0-release-notes) 明确 8.13.2 支持 Kotlin 2.3 |
| Gradle                 | 8.14.6          | **官方文档声明**：[发布页](https://gradle.org/releases/) 的 8.x 最新补丁；满足 AGP 8.13 要求的最低 8.13。无需 AGP 9 的 DSL/内置 Kotlin 迁移                                                                                                                                  |
| Kotlin/KGP             | 2.3.21          | **官方文档声明**：[兼容表](https://kotlinlang.org/docs/gradle-configure-project.html)：2.3.20–2.3.21 完全支持 Gradle 7.6.3–9.3.0、AGP 8.2.2–9.0.0，所选组合位于两者范围内                                                                                                    |
| 构建 JDK               | Temurin 21.0.12 | **实测**：`java -version` 为 21.0.12+8；[Gradle Java 兼容表](https://docs.gradle.org/current/userguide/compatibility.html) 声明 JDK 21 从 Gradle 8.5 起可运行                                                                                                                |
| platform / compile SDK | android-36 / 36 | **实测**：已有 SDK 目录；AGP 8.13 最高支持 36.1。显式 compile/target SDK 36                                                                                                                                                                                                  |
| build-tools            | 36.0.0          | **实测**：已有目录；高于 AGP 8.13 的最低 35.0.0，公共脚本显式指定                                                                                                                                                                                                            |
| min SDK / versionCode  | 23 / 1          | **源码确认**：公共脚本；metadata 与 merged manifest **实测一致**                                                                                                                                                                                                             |

没有选 alpha/beta/rc。Google 元数据当日还有稳定 AGP 9.5.1；“最简单、兼容表内”
而非“全部组件追最新”是本轮选择原则。JDK 21、既有 SDK 足够，
未执行 SDK 包下载、许可证接受、管理员安装或全局环境修改。
三个工程都设置 `android.builder.sdkDownload=false`。

Gradle 使用独立 `GRADLE_USER_HOME`，测试命令设置为用户目录下 `oas-gh`；
不共用默认 `.gradle`。构件从 Google Maven、Maven Central 和 Gradle 官方分发获取，
未复制 Android Studio 文件、未使用第三方镜像或提交凭据。
wrapper 由 Gradle 自动生成，校验官方 distribution SHA-256：
`7988ed071b2a07900e2ec715fca15c6ab72bce6db433af301fa7fa7e9407bd24`。
[校验值来源](https://services.gradle.org/distributions/gradle-8.14.6-bin.zip.sha256)。

合规边界：样例及驱动为原创、仓库 Apache-2.0；随源码提交的第三方二进制只有
Gradle wrapper JAR（Gradle 项目 Apache-2.0，官方生成物）。
`com.android.tools.build:gradle:8.13.2`、`org.jetbrains.kotlin:kotlin-gradle-plugin:2.3.21`、
Kotlin stdlib 及 Gradle 8.14.6 分发只进入本机专用构建缓存，不嵌入产品。
Google/Gradle 的完整传递依赖合规审计仍归合规账本，不因这张直接依赖表自动完成。

## 2. 三个原创样例与调试准备

| 样例                            | applicationId                    | 已证明                                                                       |
| ------------------------------- | -------------------------------- | ---------------------------------------------------------------------------- |
| F1 `fixtures/android/f1-kotlin` | `dev.openandroid.samples.kotlin` | **实测** Kotlin 单模块 APK、Plain Views、三层调用链、lambda、十次日志        |
| F2 `fixtures/android/f2-java`   | `dev.openandroid.samples.java`   | **实测** Java/XML 单模块 APK、三层调用链、十次日志                           |
| F3 `fixtures/android/f3-mixed`  | `dev.openandroid.samples.mixed`  | **实测** app + library，app Kotlin → library Java → library Kotlin，十次日志 |

**源码确认**：启动后后台线程等 2 秒，每秒一次、共 10 次；不点击、不联网。
调试局部量包含 primitive/String/array/List/Map/custom object，Kotlin 还有 lambda。
debug 显式 debuggable，Activity 销毁会中断自有线程。
`// BREAKPOINT-TARGET-n` 放在可执行行；源代码位置如下（后续修改应重新查标记）：

| 位置                                           | 断点标记行   |
| ---------------------------------------------- | ------------ |
| F1 app `MainActivity.kt`                       | 37 / 44 / 51 |
| F2 app `MainActivity.java`                     | 44 / 51 / 57 |
| F3 app `MainActivity.kt`                       | 19 / 37      |
| F3 library `JavaProbe.java` / `KotlinProbe.kt` | 13 / 8、10   |

**实测**：JDK `javap -p -l` 检查 F1/F2 编译 class，上述 F1/F2 行进入
`LineNumberTable`，`values`、`labels`、`counters`、`value` 等进入
`LocalVariableTable`，Kotlin 包含 `Function1` 与 lambda 实现。
这是编译产物调试信息存在的证明，**不是 DAP/JDWP 变量显示已通过的证明**。

**源码确认**：检索 smoke、脚本与测试后，现有项目/语言 smoke 用显式 fixture 名单，
`read_dir` 用于复制选定工程，不枚举所有顶层 `fixtures/*` 自动构建。
新增 Android 目录没有修改它们的名单；未运行 Rust 重型构建或全仓测试。

## 3. 原生构建结果

从仓库根运行，示例中的 evidence 目录由调用方选择，实际完整日志保存在本会话。

```powershell
$env:GRADLE_USER_HOME = "$env:USERPROFILE\oas-gh"
$env:PYTHONIOENCODING = 'utf-8'
python fixtures\android\build-fixtures.py --evidence "$env:TEMP\oas-builds"
```

Python 驱动实际执行：

```powershell
.\fixtures\android\toolchains\conservative\gradlew.bat -p fixtures\android\f1-kotlin -Ptoolchain=conservative --no-daemon --console=plain :app:assembleDebug
.\fixtures\android\toolchains\conservative\gradlew.bat -p fixtures\android\f2-java -Ptoolchain=conservative --no-daemon --console=plain :app:assembleDebug
.\fixtures\android\toolchains\conservative\gradlew.bat -p fixtures\android\f3-mixed -Ptoolchain=conservative --no-daemon --console=plain :app:assembleDebug
```

| 2026-11-11 主工作树构建 | 退出码 | 端到端耗时 | 结果         |
| ----------------------- | ------ | ---------- | ------------ |
| F1                      | 0      | 15.391 s   | **实测通过** |
| F2                      | 0      | 9.062 s    | **实测通过** |
| F3                      | 0      | 15.391 s   | **实测通过** |

这些时间含 JVM/单次 daemon 启动，依赖缓存已有前一轮下载；不是冷缓存性能基准。
在三个 APK 已生成后运行 `validate-run.py --host-only`，退出 0，三个 host 合同通过。

### 空格与中文路径（低优先级）

实际测试目录名为 `oas 样例 space`。不改系统 LongPathsEnabled，也未使用 subst。
默认 AGP 在 plugin apply 阶段拒绝 non-ASCII 路径，三个工程退出 1；
这不是 Kotlin 代码失败，不应宣称默认中文路径支持。

```powershell
python fixtures\android\build-fixtures.py --unicode-root "$env:USERPROFILE\oas 样例 space" --evidence "$env:TEMP\oas-unicode-default"
# 同一复制目录的驱动重试；只加 AGP 明示的实验开关：
python "$env:USERPROFILE\oas 样例 space\build-fixtures.py" --override-path-check --evidence "$env:TEMP\oas-unicode-override"
```

| 样例 | 默认检查：退出码 / 耗时 | 明示 `-Pandroid.overridePathCheck=true`：退出码 / 耗时 |
| ---- | ----------------------- | ------------------------------------------------------ |
| F1   | 1 / 4.875 s             | 0 / 15.047 s                                           |
| F2   | 1 / 4.500 s             | 0 / 9.296 s                                            |
| F3   | 1 / 4.360 s             | 0 / 16.032 s                                           |

**实测**：实际 javac/Kotlin/aapt/dex/package 完成，不只跳过了检查。
使用 Python 参数数组传路径、UTF-8 日志/JVM 编码，未出现编码或 shell 转义故障。
覆盖开关没有写进所有项目默认配置；更复杂工程和其他外部工具的 Unicode 路径仍未验证。

**实测清理限制**：旧 Compose/kapt 输出的深层目录在 PowerShell 删除时触发长路径类错误；
对两个确认属于本任务的目录使用 Windows `\\?\` 扩展路径，由 Python 完成清理。
没有修改系统长路径设置。测试用 Unicode 复制工程也已删除，日志单独保留。

## 4. 最小运行合同与 Pixel 6 实测

Host 不解析 build script：读取 AGP 已产生的文件。

- **实测** `app/build/outputs/apk/debug/output-metadata.json` 存在：
  schema `version=3`、`variantName=debug`、`applicationId` 如上，
  `elements[0].versionCode=1`、`outputFile=app-debug.apk`、`type=SINGLE`、无 filters。
  APK 相对该 metadata 所在目录解析。缺文件为 `NOT_BUILT`，不返回空结果。
- **实测** `app/build/intermediates/merged_manifests/debug/processDebugManifest/AndroidManifest.xml`
  存在；package/versionCode 与 metadata 一致，application debuggable=true。
  同一 intent-filter 包含 MAIN + LAUNCHER 的唯一 Activity 为各包的 `.MainActivity`。
  驱动拒绝多个 launcher、不匹配包名、非 debug、非单 APK、缺产物等情况；
  泛化到 alias/splits/flavor 的产品合同未验证。
- 安装可用 `gradlew :app:installDebug` 或显式选设备的 adb 安装。
  **本轮实测的是 `assembleDebug` + `adb -s <device> install -r <metadata-resolved-apk>`；
  `:app:installDebug` 本身未执行**，不把替代路径描述为该任务已经通过。

实际设备为一台已授权物理 Pixel 6；`adb devices -l` 恰有一台处于 `device`，
并检查 `ro.kernel.qemu` 不为 1。serial 不入库、日志中用 `<device>` 替换。
没有结束共享 adb server、清 Logcat、pm clear、改设置、重启或影响其他应用。

```powershell
python fixtures\android\validate-run.py --evidence "$env:TEMP\oas-run"
# 驱动内部每条 adb 都显式指定同一设备：
adb -s <device> install -r <apk>
adb -s <device> shell cmd package resolve-activity --brief -c android.intent.category.LAUNCHER <pkg>
adb -s <device> shell am start -W -n <resolved-component>
adb -s <device> shell pidof <pkg>
adb -s <device> logcat --pid=<pid> -d -s OAS:I '*:S'
adb -s <device> uninstall <pkg>
```

| 样例 | 包/launcher 一致 | 启动         | OAS iteration | 安装→等待日志耗时 |
| ---- | ---------------- | ------------ | ------------- | ----------------- |
| F1   | 通过             | `Status: ok` | 顺序 0–9 全部 | 13.735 s          |
| F2   | 通过             | `Status: ok` | 顺序 0–9 全部 | 13.859 s          |
| F3   | 通过             | `Status: ok` | 顺序 0–9 全部 | 13.860 s          |

**实测**：脚本退出 0。安装/解析/启动/logcat/卸载均退出 0；
每个样例卸载返回 `Success`，随后 `pm path` 返回 1 且 stdout/stderr 为空，
这是本机“包不存在”的预期结果，而非隐藏 adb 错误。
驱动仅对这一精确缺包情形接受非零状态；若预先已有同包则拒绝替换另一会话的安装。
已向协调者报告真机释放，后续断点 spike 的安装不属于本会话。

## 5. Windows Gradle 取消实验

### 初次控制台信号（历史结果，不重复执行）

初次驱动使用真实 Gradle 8.14.6、专用缓存、`--no-daemon`；临时 init script
注册 30 秒 sleep 任务，观察执行标记后向自有进程组发送 CTRL_BREAK_EVENT。
**实测失败**：只触发 JVM Full thread dump；请求后 27.984 s 任务自行成功完成，
Gradle 退出 0。信号送达、客户端退出或清理完成都不能单独代表取消通过。
原 `g1-lite-cancel` 日志保留，后续没有重跑 CTRL_BREAK。

### M2 补充：现有 PID 树终止策略（2026-11-11）

```powershell
python fixtures\android\cancel-probe.py --mode both --repeats 2 --evidence "$env:TEMP\oas-cancel-first"
python fixtures\android\cancel-probe.py --mode both --repeats 2 --evidence "$env:TEMP\oas-cancel-rerun"
```

**源码确认**：`crates/ide-build/src/process.rs` 的取消分支调用
`ide_core::process::kill_tree`，然后返回 Cancelled；
`crates/ide-core/src/process.rs` 在 Windows 不创建 Unix 式进程组，
以 `CREATE_NO_WINDOW` 启动，捕获子孙进程及其创建时间/handle，
有子进程才执行 `taskkill /T /F /PID <根 PID>`，等待已捕获子孙最多 5 秒，
再由持有 Child 的调用方终止并回收根进程。无子进程时省略 taskkill。

当前 Python 驱动以标准库 ctypes 镜像上述 Toolhelp 快照、OpenProcess/
GetProcessTimes/WaitForSingleObject 及精确 PID taskkill，不依赖 MSVC、新包或模型桥。
不改 Rust/前端，不启动或接触 adb。每次运行在专用缓存下建立新的私有 Gradle
user home 与可删除工程，任何实验 daemon 必须先证明属于自己启动的客户端。
所有权无法证明即失败并停止，不因目录名、进程名或 guessed PID 终止资源。

可删除工程的真实 Gradle task 每 250 ms 追加持久化心跳（运行 token、JVM PID、
递增序号、时间）；正常完成需要 120 次，即约 30 秒。
睡眠若被中断，先记录 `INTERRUPTED` 再抛出异常，不能吞异常继续工作。
在至少五次心跳后请求取消，保存请求 UTC 时间和 monotonic 计时。
逐用例记录客户端树、task JVM 是否属于该树、创建时间、taskkill 退出码、
客户端反馈时间/退出码、实际工作停止证据和上界。

**验收不偷换**：不是“客户端退出即通过”，也不是“心跳短暂不变即通过”。
只有 task JVM 的保留 handle 已 signalled（进程确实退出），或任务明确记录
`InterruptedException`，才得到工作停止上界；反馈和工作停止都需 ≤5 秒，
客户端须非零退出，taskkill 须成功。额外观察一秒确认没有继续追加工作。
5 秒预算没有提高；`workStopBoundSeconds=null`、失败、残留或输入改变都会非零退出。

预热模式先让 warm task 成功完成，证明 daemon 是 warm 客户端的子孙并保留 handle；
随后使用**不同的新客户端**，确认实际 task JVM 的 PID/创建时间就是该 daemon。
**实测**该 task JVM 不在新客户端树内，第一次树终止没有直接杀它；
daemon 日志出现 `client disconnection detected, canceling the build`，
任务追加 `INTERRUPTED`，证明 Gradle 因客户端断开而停止实际任务。
等取消观测结束后，才对已证明独享、仍存活的 daemon 做显式 PID 清理。

| 独立执行 / 用例      | 客户端反馈 | 实际工作停止上界 | 客户端退出码 | 停止证据               | 后续 daemon 清理 |
| -------------------- | ---------- | ---------------- | ------------ | ---------------------- | ---------------- |
| 首次 / no-daemon 1   | 0.468 s    | 0.484 s          | 1            | task JVM handle 已退出 | 无需             |
| 首次 / warm-daemon 1 | 0.281 s    | 0.359 s          | 1            | 任务记录中断           | 0.329 s          |
| 首次 / no-daemon 2   | 0.266 s    | 0.281 s          | 1            | task JVM handle 已退出 | 无需             |
| 首次 / warm-daemon 2 | 0.281 s    | 0.297 s          | 1            | 任务记录中断           | 0.266 s          |
| 重跑 / no-daemon 1   | 0.140 s    | 0.140 s          | 1            | task JVM handle 已退出 | 无需             |
| 重跑 / warm-daemon 1 | 0.125 s    | 0.172 s          | 1            | 任务记录中断           | 0.094 s          |
| 重跑 / no-daemon 2   | 0.094 s    | 0.094 s          | 1            | task JVM handle 已退出 | 无需             |
| 重跑 / warm-daemon 2 | 0.062 s    | 0.125 s          | 1            | 任务记录中断           | 0.094 s          |

**实测通过**：两条命令均退出 0；八个用例的取消及清理都通过。
每个用例清理后所有已保留的自有进程 handle 均已退出，心跳不再增加；
最终私有 home 的 daemon 扫描为空，两次 `fixtureInputsUnchanged=true`。
临时工程/cache home 均清除，没有改动三个样例的源码、APK、配置或 metadata。
没有执行 `gradle --stop`、按名称 kill、SDK 修改或共享 daemon 清理。
第一次 taskkill 的本地编码日志在重跑前改用 Windows OEM code page 解码，
不是改变取消策略或阈值。

**实现选择**：保留现有自有客户端 PID 树终止；不引入 JVM 桥或新生产架构。
单次 daemon 用例通过直接结束 task JVM 提供更强的隔离，
预热 daemon 用例通过断连触发 Gradle 的中断处理。显式 daemon 清理是实验收尾，
不是将“取消时工作仍继续”掩盖为成功。
本证据只覆盖可处理中断的持久心跳 Gradle task；无响应 native 工具、
忽略中断的插件或额外外部 worker 仍未验证，不据此保证所有 AGP 工作都可 5 秒终止。
**真实原生 IDE Stop 按钮、CancellationToken → UI 状态反馈和 native build 仍未验收**；
本次不需要 MSVC 的宿主机回归不能替代它们。

## 6. 门槛结论、日志与后续使用

**通过**：一套官方兼容范围内的工具链，F1–F3 原生 debug 构建，
三个 host 运行合同与真机安装/启动/Logcat/卸载；标记行及局部变量调试信息存在。
补充通过现有 Windows PID 树策略在单次/预热 daemon 下的八次宿主机取消回归。
**部分**：Windows 中文路径需要用户可见的显式 AGP 覆盖；仅本组最小工程实测通过。
**未通过/未验证**：CTRL_BREAK 取消；IDE 内真实断点、单步、跨模块栈、变量与 lambda
展示；其他手机/API、installDebug 任务、splits/flavors、release/minify、
文件编辑与语言服务都不在本会话通过结论内。

因此，本会话已经交付 G1-lite 的**build→install→run 输入与证据**，
完整 build→install→run→breakpoint 门槛必须合并调试 spike 结论后判断。
不要恢复旧 AGP 模型门槛或以此进入大规模删除/UI 重构。

可重现入口为 [`fixtures/android/README.md`](../../fixtures/android/README.md)。
首次完整样例提交 `05751771a1d9b74ff8c068ca9b32faf97eee3b80` 已立即交接；
最终报告与测量驱动在后续小提交中补齐。未 push、未创建 PR。

完整日志作为本会话独立证据包保存/发布，不提交构建输出或本机路径：
`g1-lite-builds`（逐工程 stdout + 命令/退出码/耗时 JSON）、
`g1-lite-run`（host contracts、serial 脱敏 adb 命令/输出、十次循环结果）、
`g1-lite-unicode-default` / `g1-lite-unicode-override`、`g1-lite-cancel`
（历史线程转储与取消耗时），以及 `m2-pid-cancel` / `m2-pid-cancel-rerun`
（逐例心跳、请求时间、进程身份、停止上界、分开的清理结果与重跑 daemon 日志）。
缓存和临时复制/取消工程不属于交付代码。
