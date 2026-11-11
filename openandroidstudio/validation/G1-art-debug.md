# G1 / T06：Windows 真机断点调试可行性

## 结论与当前证据

2026-11-11，第一阶段 **通过**：独立 JDK 21 JDI → stdio DAP 原型，无 Android
Studio、无 JDT LS、无第三方 Java 依赖。在本机 JVM 上验证延迟类加载断点、
已加载类断点、删除断点、stepIn/next/stepOut、参数/局部变量/对象字段/数组、
pause、过期句柄拒绝、disconnect 与 stdin EOF 后进程存活。

第二阶段 **通过**：测试手机上 F1 Kotlin、F2 Java、F3 Kotlin→Java→Kotlin
都通过真实 adb-forward JDWP + DAP 的行断点、stepIn/next/stepOut、
参数/局部变量/字段/数组与 List/Map 原始字段读取、pause、continue、
disconnect 后同一进程继续输出新日志。另验证 F1 Kotlin lambda 体断点及
捕获变量。JDI 报告 VM 为 Dalvik/version 8（兼容性字符串，不是 Android 版本）。

**v0 断点支柱：GO（有边界）**。Windows + 已安装 JDK/SDK + 单台 USB 真机 +
debuggable 未混淆 APK + 常规 Java/Kotlin 行调试有一条不依赖 Android Studio、
JDT LS、AGP model bridge 的简单路径。**不是完整 IDE 发布 GO**：
本次仅验证协议原型，不声称 OpenIDEA UI 已接入、完成 Rust 打包或支持所有 ART。

最新补验还通过适配器内 **DAP launch**：安装仍由外部负责，适配器独占本次
调试启动、JDWP forward、分离和两条 Stop 清理路径；F1/F2/F3 真机回归通过。
后文原 attach 测量保留为历史证据，不混作新的 launch 测量。

## 现有 OpenIDEA 可以复用什么

| 位置                                            | 已核实行为与 Android 边界                                                                                                                                                                                                                           |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates\ide-dap\src\adapter.rs`                 | `AdapterSpec`、`find_config`、`resolve`、`ProcessLauncher` 支持 stdio/TCP；Windows 查找 PATHEXT 可执行文件，不能直接执行 jar。新适配器应执行 JDK `java.exe --add-modules jdk.jdi -jar …`。`debugServer` 是 DAP 服务端口，不是 JDWP 端口。           |
| `crates\ide-dap\src\lib.rs`                     | `LaunchConfig.extra_json` 合并到 DAP 参数，`start_session` 接受 launch/attach；`configure` 顺序为 initialize、attach、initialized、所有断点、configurationDone。initialize 使用 1-based DAP；IPC 是 0-based。通用远程 attach 不依赖 Unix 进程枚举。 |
| `crates\ide-dap\src\session.rs`                 | `send_breakpoints` 发送绝对 source.path/name，line+1；响应与 breakpoint 事件更新验证状态；栈与变量由通用 DAP 请求驱动。已有 Kotlin SourceMirror 仅对 `kotlin-debug-adapter` 生效，新 adapter id 不走该分支。                                        |
| `crates\ide-dap\src\attach.rs`                  | `classify` 通过本机进程命令行发现 JDWP；`list_processes` 非 Unix 路径不可用。这不是 adb 进程发现，不能用此弹窗代替真机 pid/JDWP 列表。                                                                                                              |
| `languages\java.toml`、`languages\kotlin.toml`  | 分别指定 java-debug、kotlin-debug-adapter，不宜全局替换为 Android 适配器（仍保留普通 JVM 行为）。                                                                                                                                                   |
| `src\features\debugger\java.ts`                 | `javaAttachConfig` 先调用 `javaDebugServer` 启动 JDT LS 中 java-debug 的 DAP 服务；源码与项目名称解析来自 JVM 项目准备通路。v0 不应复用这个前置依赖。                                                                                               |
| `src\features\debugger\actions.ts`、`attach.ts` | 已有 Remote JVM Debug（host/port）与通用调试 actions；Android 入口应独立创建 `adapter=android-jdwp-dap, request=launch`，原 host/port attach 保留。                                                                                                 |
| `src\features\debugger\state.ts`、`ui\`         | 调试状态/线程/帧/变量 UI 可复用；不需要新造 Android 调试器面板。最终集成时还需审阅按 adapter capability 禁用未实现功能。                                                                                                                            |
| `docs\zh\guide\debugging.mdx`                   | 文档已说明 DAP、行断点、变量和步进；尚无 Android/adb 的运行语义。                                                                                                                                                                                   |

## 三条候选路径

| 路径                                          | 依据                                                                                                                                                                                                                                                                                                                                                                        | 决策                                                                                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| A：fwcd Kotlin Debug Adapter 直接 attach JDWP | [配置](https://github.com/fwcd/kotlin-debug-adapter/blob/main/CONFIGURATION.md) 有 `projectRoot,hostName,port,timeout`；[架构](https://github.com/fwcd/kotlin-debug-adapter/blob/main/README.md) 本来就是 DAP→JDI。OpenIDEA 已有安装、源码镜像和启动 relay。上游目标 Kotlin/JVM，ART 是否兼容不能从 README 推导。                                                           | 可作为后续复用对照；本次不下载/运行其完整依赖。不是已证明失败。                                                                               |
| B：Microsoft java-debug                       | [AttachRequestHandler](https://github.com/microsoft/java-debug/blob/main/com.microsoft.java.debug.core/src/main/java/com/microsoft/java/debug/core/adapter/handler/AttachRequestHandler.java) 直接 attach socket，但初始化 source/evaluation/HCR/completion providers；OpenIDEA 从 JDT LS 启动此 adapter。即使 sourcePaths 有回退，Android 无 AGP import 的行断点仍需实测。 | 与“不做 Java/Kotlin 语义 LSP、AGP model bridge”冲突；不选为 v0 前置。不是宣称它技术上无法调 ART。                                             |
| C：小型独立 JDI adapter                       | JDK 21 本机 `java --list-modules` 有 `jdk.jdi`；SocketAttach、ClassPrepare、locationsOfLine、局部变量和步进都是 JDI 标准 API。                                                                                                                                                                                                                                              | **选为可证伪 spike**：只做行调试、不解释源码表达式。最初 attach-only；后续增加自有样例的 launch/Stop 生命周期，不改变 attach 保留目标的语义。 |

本次 Java adapter 第三方库 **0**；JSON framing/codec 是本仓库新增原型代码。
运行依赖 Temurin JDK（OpenJDK GPLv2 + Classpath Exception）；测试 Python（PSF License）。
未打包 JDK/Python，未复制上游 adapter 代码。候选 fwcd 为 MIT、Microsoft
java-debug 为 EPL-1.0，Eclipse JDT LS 为 EPL-2.0；采用前应固定版本并完整盘点
传递依赖。本次样例 Gradle/AGP/Kotlin 依赖沿用已合入 fixture 的固定矩阵，
不属于 adapter 的运行依赖；Gradle/AGP/Kotlin 主项目为 Apache-2.0。

## 原型与本机复现

代码：`java\android-jdwp-dap\src\AndroidDap.java`，小型 JSON codec：
`src\Json.java`。`build.py` 仿现有 Java helper 的 Python+javac/jar 构建方式；
产物写入忽略目录 `build`，不提交 jar（无需网络下载编译依赖）。

```powershell
java --list-modules | Select-String jdk.jdi
python java\android-jdwp-dap\build.py
python java\android-jdwp-dap\tests\host.py
java --add-modules jdk.jdi -jar java\android-jdwp-dap\build\android-jdwp-dap.jar
```

最后一条是 stdio 服务，不能当交互 shell；测试使用
`tests\dap_client.py` 的 Content-Length framed client。attach 参数：
`hostName=127.0.0.1`、`port=<JDWP-forward>`、`sourceRoots=[绝对源码根目录]`、
`classFilters=[应用/库包名前缀*]`。initialize 必须 1-based（与现有 ide-dap 一致）。
支持 initialize/attach/launch/setBreakpoints/configurationDone/threads/stackTrace/scopes/
variables/continue/next/stepIn/stepOut/pause/terminate/disconnect，以及空的
setExceptionBreakpoints；stopped/continued/breakpoint/initialized/terminated/output
事件。未实现的命令或不支持的断点条件返回 DAP success=false。

| 本机命令                                          | 退出码/结果                                                                                                                                                                              |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `java --version`                                  | 0，Temurin 21.0.12；Node 24.22.1 可用（测试选择 Python）。                                                                                                                               |
| `java --list-modules \| Select-String jdk.jdi`    | 0，包含 jdk.jdi。                                                                                                                                                                        |
| `python java\android-jdwp-dap\tests\host.py` 初次 | 1，所有首次调试步骤成功，复连失败：HotSpot address=0 在 detach 后重新分配端口。修正测试为读取新监听端口，不改 adapter、无端口猜测。                                                      |
| 同一命令修正后                                    | 0，PASS；javac `-Xlint:all -Werror` 通过。最终改用 perf_counter：attach 33.9 ms，首停 8.1 ms，stepIn 1.5 ms，next 0.8/0.8 ms，stepOut 0.8 ms，reattach 32.1 ms。单次样本，不是性能预算。 |

`configurationDone.arguments=null` 已在测试中复现现有 ide-dap 的实际发送形状，
原型接受 null/缺省为空参数。与协议正确性的直接相关修正还有：不支持的
setBreakpoints 请求先校验再替换旧断点；无有效行号的 synthetic/native 帧
发 line=0、无 source、presentationHint=subtle，不谎报用户源码第 1 行。

### 生命周期补验与修正（2026-11-11）

针对 `29b1ebdc` 的两个具体缺陷补充实现，不重做 ART 探索，不操作手机：

1. **attach 原子化**：host/port、sourceRoots 数组与每个真实目录、
   classFilters 数组与每个非空字符串/受限通配符先校验到局部数据，再打开连接。
   不再把非法请求的部分 roots 写入会话。连接建立后的 suspend/ClassPrepare/
   VM metadata/事件线程启动若失败，只 dispose 本次 JDI 连接、清空未完成的会话
   状态，仍返回原始失败；dispose 自身失败附加 suppressed error 并写 stderr，
   不伪装成功、不退出目标进程。事件线程绑定它自己的 VM，不能在旧连接结束后
   清掉后续重试的新连接。正常成功 attach 的独立 suspend hold、configurationDone
   resume、step 语义不变。
2. **已删除源文件清理**：记住已接收 DAP 路径的规范化绝对路径→真实 canonical
   路径映射。空 setBreakpoints 优先使用已拥有的映射删除 JDI 请求，不要求文件
   仍存在，并删除对应断点/路径别名记录；未知缺失路径的空列表是无断点的清理。
   非空列表仍要求真实源文件，空白/非字符串/目录等无效输入仍明确失败。

`tests\host.py` 在现有协议回归后增加两组真实 HotSpot 验证；
`tests\spike\DebugTarget.java` 的测试专用 progress 模式用 stdin 新随机 token
请求心跳，目标主线程跨过 work() 后回显该 token。**不是只检查 pid 存活，也
不是读取已经缓存的旧 heartbeat**。

非法输入覆盖空 filters、非字符串项、空字符串、非法通配符，以及 roots 的
中途不存在路径、非字符串项、非数组和文件代替目录。每次拒绝后目标都能回答
新心跳；随后同一个 adapter 接受有效 attach、命中断点，stackTrace 不会因
前次 roots 泄漏而出现重复源码歧义。目标以 `suspend=n` 运行，避免把本来启动
就暂停的 `suspend=y` 状态误当成拒绝请求的冻结。

测试还通过一个仅在本机运行的透明 JDWP 转发器，向真实 JVM 的一次
ClassPrepare EventRequest.Set 注入 NOT_IMPLEMENTED 回复。此时已经建立连接并
调用 suspend；回归确认实际 VirtualMachine.Dispose 命令送到目标，目标回答新
心跳，同一 adapter 使用 JVM 重新分配的监听端口成功重试，保留 JDI 原始错误。
这覆盖连接建立后的回滚，而不只是前置参数校验。

源文件测试只复制到临时目录：设置/命中副本断点，将副本重命名，再用原 DAP
路径发送空列表。Windows 还用大小写变化的源路径验证 canonical 身份保留。
删除后非空请求明确失败；空列表成功后连续三个新心跳都经过曾经的断点行，
随后收到的停止原因是主动 pause 而非残留 breakpoint。disconnect 后再回答
一个新心跳；真实仓库源码/Android 样例没有被删除。

| 本轮验证                                            | 结果                                                                                                                                                                                                     |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 修正前 `python java\android-jdwp-dap\tests\host.py` | 退出 1；原协议用例通过，classFilters=[] 返回失败后新心跳超时，真实复现目标被冻结；finally 清理自有 JVM。                                                                                                 |
| `python java\android-jdwp-dap\build.py`             | 退出 0；执行 `javac --add-modules jdk.jdi -encoding UTF-8 -Xlint:all -Werror -d java\android-jdwp-dap\build java\android-jdwp-dap\src\AndroidDap.java java\android-jdwp-dap\src\Json.java` 及 jar 打包。 |
| 修正后 `python java\android-jdwp-dap\tests\host.py` | 退出 0；原协议完整回归、非法 attach/连接后回滚与重试/活心跳、删除源码清理/无再命中三组全部 PASS。                                                                                                        |
| `git diff --check`                                  | 退出 0。                                                                                                                                                                                                 |

本轮没有新增依赖/调试功能、Rust/Tauri 改动、手机操作、push 或发布。
既有 ART 成功证据保持为前一轮 USB 测量，没有把 host 补验冒充新真机测试。
剩余边界：断线导致 dispose 本身失败只能明确报告；未曾接收且已经失效的
symlink 别名无法推断原 canonical 文件；非空断点的逐类 JDI 安装失败仍不是
完整回滚事务。设备拔出、取消、类卸载等生产化限制仍见后文。

## 适配器内 launch 生命周期（真机补验完成）

实现位于 `java\android-jdwp-dap\src\AndroidLaunch.java`；
`AndroidDap.java` 共用原 JDI connect/断点/步进逻辑，新增 launch/terminate 和
会话资源清理。没有新增第三方依赖，没有改 Rust/Tauri/TOML/前端或安装 MSVC。

### launch 参数合同

IDE 构建并安装 debuggable APK 后，启动 stdio adapter，发送 initialize，再发：

```json
{
  "command": "launch",
  "arguments": {
    "adbPath": "C:\\Android\\Sdk\\platform-tools\\adb.exe",
    "serial": "<运行时选择的测试手机>",
    "packageName": "dev.openandroid.samples.java",
    "sourceRoots": ["C:\\project\\app\\src\\main\\java"],
    "classFilters": ["dev.openandroid.samples.*"]
  }
}
```

示例路径和 serial 是占位符，必须替换为实际本机路径/用户选择的设备，不写入
项目文件。`adbPath` 必须绝对且指向现有可执行文件；`serial` 必填、不得为
emulator serial；`packageName` 目前硬限制 `dev.openandroid.samples.*`，生产接入
前必须单独决定如何授权用户明确选择的目标包，不能宣称任意 App 已可用。
`component` 可选，格式为 `<packageName>/<activity>`，支持 `.MainActivity`
或完整类名，必须归属同一个 package；省略时 query-activities 和 resolve-activity
必须共同解析出唯一 MAIN/LAUNCHER，多个候选不猜测。sourceRoots 缺省空数组、
必须为存在的源码目录；classFilters 缺省 `["*"]`，不接受空数组，建议显式应用/
库包名前缀以控制 ART 类事件数量。所有输入在任何设备副作用前校验到局部数据。

适配器逐条使用 `adb -s <test-phone>`：get-state 检查在线/授权，getprop
只读拒绝模拟器，pm path 检查已安装；执行 `am start -S -D -n <component>`。
**-S 会先结束已有的目标 App，再以调试模式启动新进程**，因此 launch 不等于
“保留原运行进程的附加”；本轮 F2 从普通运行状态开始，确认新旧 PID 不同。
随后 pidof 最长轮询 10 秒、间隔 100 ms（单次命令受剩余 deadline 限制），
要求唯一进程，再 forward tcp:0 jdwp:<pid> 并连接 loopback JDWP。
普通 adb 命令有 30 秒超时，JDI attach 为 10 秒；launch 总耗时不是 10 秒上限。
不使用 adb jdwp 的 EOF 门槛，不安装 APK，不执行 SDK 下载。

launch 成功后才发 initialized；客户端设置断点，再 configurationDone。
保留原独立 suspend hold，确保 Waiting for debugger 启动不会先于断点配置恢复。
**从不发送 process/processid 事件，也不发送手机 systemProcessId/processId**。
`crates\ide-dap\src\session.rs` 会记录这类 PID，`lib.rs` 的 launch Stop 会对其
发本机 signal/kill；把手机 PID 填进去会误伤同号 Windows 进程。

### 分离、Stop 与失败语义

| 请求/情况                                      | 行为与本轮证据                                                                                                                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `disconnect(terminateDebuggee=false)`          | 先 JDI dispose，再移除本条 forward；App 继续运行。F1/F2/F3 均先 pause，分离后同 PID 输出新的 iteration，排除“只是进程还活着但被冻住”。                                                                  |
| `terminate` → terminated → `disconnect(false)` | initialize 宣告 supportsTerminateRequest；terminate 先分离、force-stop 自有样例并检查 pidof 为空、移除自有 forward，再发 terminated。后续 disconnect 是幂等清理，不再发第二个 terminated。F2 真机通过。 |
| `disconnect(true)`                             | 同样先分离再 force-stop，确认 PID 消失并移除自有 forward，再发 terminated。F2 真机通过，覆盖 IDE 不走 terminate 的 Stop 分支。                                                                          |
| 原 host/port attach                            | 不管理 Android 启动或 forward；disconnect(false)/EOF 保留目标，terminate 或附加状态的 disconnect(true) 明确拒绝。完整 host 协议回归仍通过。                                                             |
| launch 任一步骤失败                            | 返回原始错误；连接建立后的失败 dispose 本次连接；已尝试 -D 启动的自有包 force-stop，移除已确认的本条 forward。清理失败附加 suppressed error/写 stderr，保留资源所有权便于重试，不伪装成功。             |
| 无显式分离的 stdin EOF、目标退出/事件泵失败    | 实现主动清理自有 launch；EOF 不等于要求保留 App，想保留必须明确 disconnect(false)。本轮没有独立强杀/设备拔出测试，不以 finally 保证不可捕获的进程结束。                                                 |

forward 所有权来自本条 tcp:0 命令回执，不用全局 remove-all 或猜测删除其他
会话转发。即使回执含合法端口后又产生错误/损坏输出，也记住端口以便回滚；
本轮通过“真实分配 forward 后追加损坏输出”验证。若 adb 崩溃/设备拔出，
导致回执完全丢失或 force-stop/forward remove 无法执行，无法保证即时清理；
不能为了伪造清理成功而删除未知所有权的转发。这仍是生产化系统故障边界。

### 可重复回归与结果

先按前文只读 SDK/私有 Gradle home 构建样例；本轮复用已有 APK，未重建或下载。
`--evidence` 指向仓库外目录；以下证据目录名位于本会话 files 中，JSON 已脱敏。
测试仍负责安装、独立核实 PID/forward/Logcat 与最后卸载；launch 模式下不再
代替适配器执行正常启动/转发/分离。失败测试的临时 `.cmd` 只覆盖指定 adb 回复，
其余命令仍透传真实 `adb -s`，不修改 SDK、adb server 或 Android Studio。

| 实际命令（证据路径以目录名缩写）                                                                                                     | 退出码/结果                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `python java\android-jdwp-dap\tests\host.py`                                                                                         | 0；完整协议、非法 attach/连接后回滚/新心跳/重试、失效源文件断点清理三组 PASS；内部执行 javac `--add-modules jdk.jdi -encoding UTF-8 -Xlint:all -Werror` 和 jar 打包，包括 AndroidLaunch.java。                                         |
| `python java\android-jdwp-dap\tests\phone.py --launch --lambda-probe --evidence <launch-phone-evidence>`                             | 0；F1 Kotlin、F2 Java、F3 mixed 全部断点/stepIn/next/stepOut/变量及 detach 心跳 PASS，F1 lambda 捕获变量 PASS。                                                                                                                        |
| `python java\android-jdwp-dap\tests\phone.py --launch --case f2-java --start-running --evidence <launch-running-evidence>`           | 0；已运行 App 被 -S 换成新 PID；断点/步进/变量和分离心跳 PASS。                                                                                                                                                                        |
| `python java\android-jdwp-dap\tests\phone.py --launch --case f2-java --stop-mode terminate --evidence <launch-terminate-evidence>`   | 0；terminate→terminated→disconnect(false)，App 已结束、自有 forward 已清、既有 forward 保留。                                                                                                                                          |
| `python java\android-jdwp-dap\tests\phone.py --launch --case f2-java --stop-mode disconnect --evidence <launch-disconnect-evidence>` | 0；disconnect(true)，App 已结束、自有 forward 已清、既有 forward 保留。                                                                                                                                                                |
| `python java\android-jdwp-dap\tests\launch_failures.py --evidence <launch-failure-evidence>`                                         | 0；非法 filters、非法 roots、包未安装、无效组件、offline、unauthorized、pid 超时、真实 forward 后 JDWP handshake 失败、损坏 forward 输出，九个拒绝/回滚用例 PASS；同一个 adapter 随后成功 launch、新日志后 terminate/清理，重试 PASS。 |

失败回归最初有两次测试本身的退出 1：无效组件返回真实 adb exit=1/Activity does not
exist，而非测试最初期待的包装文案；成功重试后固定等 2.8 秒尚未收到日志
（样例 worker 自带 2 秒延迟加 ART 启动）。分别修正断言以保留真实错误、改为
10 秒有界 Logcat readiness，再全量通过；没有提高 adapter 超时掩盖失败。
pid 超时注入只让 pidof 报空，真实 -D App 确实已启动；失败后通过真实 adb
检查 PID 为空，证明 Waiting for debugger App 被清掉。整次失败用例
11,167.5 ms 包含检查/启动、10 秒轮询和回滚，不把它当成功 launch 延迟。
最后补验还遇到末次 pidof 命令耗尽剩余 deadline，测试因只得到 `adb shell
timed out` 而退出 1；现在错误补充 pid 等待上下文，同时保留真实命令错误/
cause，不放宽 deadline。最终 host 三组与真机失败/重试十组全部退出 0。
offline/unauthorized 为回复注入，不拔线/改变测试手机授权或设置。

| 真机 launch / detach 单次测量（ms） | launch 完成 | configurationDone→首停 | stepIn |  next | stepOut |
| ----------------------------------- | ----------: | ---------------------: | -----: | ----: | ------: |
| F1 Kotlin                           |      1049.4 |                 3588.9 |  184.3 | 155.7 |    74.2 |
| F2 Java                             |       873.1 |                 3769.1 |  163.1 |  85.7 |    70.2 |
| F3 mixed                            |       868.1 |                 3540.1 |  143.3 |  74.4 |    81.0 |

首停包含样例 worker 初始 2 秒等待，以上不是性能预算。两条 Stop 的 F2 launch
分别为 927.3/922.2 ms；完整断点步骤同样执行，不是只启动后立刻杀掉的替代测试。
每个成功用例还检查没有 process/processid 事件、自有 forward 消失、此前
forward 未被删除；测试结束卸载所有本任务样例，未记录设备标识。

### 将来的 builtin / IDE 边界

拟在 `crates\ide-dap\src\adapter.rs` 的 builtin 中增加 id
`android-jdwp-dap`：command 为解析到的 JDK `java.exe`，
args 为 `["--add-modules", "jdk.jdi", "-jar", "<bundled android-jdwp-dap.jar>"]`，
transport 为 **stdio**，不设置 debugServer，不传手机 PID。find_config 优先查
语言 debugger 再 builtin，因此必须独立选择新 adapter id，不修改 java/kotlin
默认 adapter。jar 构建/资源定位跟随现有 Java helper 机制，不安装 SDK/JDK。

IDE M2 只负责构建/安装；调试 action 构造 request=launch 的 extra_json 合同，
其余断点/线程/帧/变量复用现有 DAP。Rust 不再管理 JDWP/forward/调试 App Stop；
两条已有 launch Stop 协议由 adapter 处理。本任务没有真正添加 builtin、
Rust IPC、资源打包或 UI 入口，不能声称“一键 IDE 真机调试已完成”。

## 真机第二阶段（完成）

检测时只有一台已授权物理设备；不在文档/提交中记录设备标识。
已合入最新样例提交 `05751771`，F1 Kotlin、F2 Java、F3 mixed-module，
applicationId 均为 `dev.openandroid.samples.*`。原先早期矩阵 `f7f31c18`
已被样例负责人替换；本任务撤销尚未使用的临时 debug-target，直接验证最新
共享样例，不另建应用。样例构建/普通运行已有另一会话证据，本任务独立重建、
验证 DAP 断点；两者不混为一谈。真机使用权已由协调者确认释放。

### 可重复命令

PowerShell，仓库根目录；JDK、SDK 只读，Gradle 私有缓存位于仓库外短路径。
全部 JVM/脚本验证，不运行 Rust/MSVC/Tauri 构建。

```powershell
$env:JAVA_HOME = Split-Path (Split-Path (Get-Command java).Source)
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:GRADLE_USER_HOME = "$env:USERPROFILE\gdi"
$env:PYTHONIOENCODING = 'utf-8'
python fixtures\android\build-fixtures.py --evidence "$env:TEMP\oas-jdi-build"
python java\android-jdwp-dap\build.py
python java\android-jdwp-dap\tests\phone.py --lambda-probe --evidence "$env:TEMP\oas-jdi-phone"
```

可加 `--case f1-kotlin` / `f2-java` / `f3-mixed` 做单样例复现。
`--lambda-probe` 只为 F1 增加 lambda 体检查。读取 sample metadata/merged manifest
的逻辑复用 `fixtures\android\validate-run.py::host_contract`，不猜 APK 包名或
launcher。若包已经安装，立即拒绝覆盖（可能由另一个会话拥有）。
构建、host.py 与 phone.py **顺序执行**：Windows 正在运行的 java -jar 会锁住
该 jar，不能同时让 host.py 重建同一路径。

| 构建命令（由 build-fixtures.py 顺序执行）                                                                                                                      | 退出码       | 耗时                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------- |
| `.\fixtures\android\toolchains\conservative\gradlew.bat -p fixtures\android\f1-kotlin -Ptoolchain=conservative --no-daemon --console=plain :app:assembleDebug` | 0            | 156.094 s，冷缓存   |
| 同命令 `-p fixtures\android\f2-java`                                                                                                                           | 0            | 14.265 s            |
| 同命令 `-p fixtures\android\f3-mixed`                                                                                                                          | 0            | 17.078 s            |
| `python java\android-jdwp-dap\tests\phone.py --lambda-probe --evidence <外部目录>`                                                                             | 0，三例 PASS | 以下为 DAP 分段测量 |

AGP 8.13.2 / Gradle 8.14.6 / Kotlin 2.3.21；使用现有 android-36、
build-tools 36.0.0。没有下载/安装 SDK 包，没有改变 Android Studio/shared SDK，
没有操作共享 adb server。wrapper/编译依赖下载只在本任务私有 Gradle home 中。

脚本逐样例实际执行的 adb 合同（真实 serial 只存在进程参数）：

```powershell
adb devices -l
adb -s <test-phone> shell pm path dev.openandroid.samples.<case>
adb -s <test-phone> install -r <metadata-resolved-apk>
adb -s <test-phone> shell cmd package resolve-activity --brief -c android.intent.category.LAUNCHER <package>
adb -s <test-phone> shell am start -D -n <resolved-component>
adb -s <test-phone> shell pidof <package>
adb -s <test-phone> forward tcp:0 jdwp:<pid>
# adapter initialize / attach(127.0.0.1, allocated-port) / setBreakpoints / configurationDone
# threads / stackTrace / scopes / variables / stepIn / next / stepOut / continue / pause / disconnect(false)
adb -s <test-phone> shell pidof <package>
adb -s <test-phone> logcat --pid=<same-pid> -d -s OAS:I '*:S'
adb -s <test-phone> forward --remove tcp:<owned-port>
adb -s <test-phone> uninstall <package>
adb -s <test-phone> shell pm path <package>
```

install/launch/forward/logcat/remove/uninstall 均退出 0；install/uninstall 返回
Success。安装前与卸载后的 pm path 返回 1 且无输出，脚本仅对这种明确“包不存在”
结果允许非零。am start 是异步的；pidof 采用最长 10 秒、0.1 秒间隔的 app readiness
等待，不重新发现/轮询设备。失败 finally 仍执行自己拥有的 forward/包清理；
清理失败作为错误报告。最后一轮 39 个显式 adb 命令，三个专属 forward 均删除、
三个样例均卸载并确认不存在。

### 最后一轮真机测量与命中证据

毫秒，perf_counter；attach 为 attach request→response/initialized；
首停为 configurationDone→stopped，包括样例故意 sleep 2 秒及 ART 启动。
step 为请求→stopped，**不包含之后 stackTrace/variables 的 UI 往返**。
只做本次 USB 单机观测，未统计 p95，未测 IDE UI 延迟。

| 样例      | attach |   首停 | stepIn |  next | stepOut |
| --------- | -----: | -----: | -----: | ----: | ------: |
| F1 Kotlin |   92.8 | 3510.4 |  177.8 | 144.2 |    65.0 |
| F2 Java   |   93.3 | 3486.9 |  147.0 | 174.1 |    74.8 |
| F3 mixed  |  101.0 | 3499.7 |  183.3 |  76.4 |    78.1 |

F1：MainActivity.kt:37 `levelOne` → stepIn :42 `levelTwo` → next :43 →
stepOut :37；后续 :51 `levelThree` 断点读到 sum=9、count=2、even=false、
result=`kotlin-first:sum=9:count=2:even=false`。额外 :36
`MainActivity.levelOne$lambda$0` **lambda 体**断点读到 `$count=3, number=11`，
不是仅把 lambda 创建行命中当作函数体命中。

F2：MainActivity.java:44 `levelOne` → :49 `levelTwo` → next :50 → stepOut :44；
后续 :57 读到 sum=7、count=2、even=false、
result=`java-first:sum=7:count=2:even=false`。

F3：library/JavaProbe.java:13 `levelTwo` 命中；首次 Java→Kotlin stepIn
真实进入 KotlinProbe `<init>`:3，next 到 `<clinit>`（无可靠行号，
line=0/no source），stepOut 到 KotlinProbe.kt:6 `levelThree`。随后 KotlinProbe.kt:10
断点读到 sum=3、count=1、transformed=4、even=false、
result=`mixed-first:sum=4:count=1:even=false`。源码根覆盖 app 与 library，
无项目模型、无 ClassName=FileName 假设。

三例首停均读取 arguments/locals（iteration=0/count=1，F3 的 value.count=1）、
自定义对象 `.title/.count`、数组 `[0,1,2]`；List/Map 确实请求 variables 并获得
原始实现字段，但**没有集合语义格式化器**，不能声称有 Android Studio 的
List/Map 友好显示。

断开时先让 worker 恢复、读取日志，再 pause 并 `disconnect(false)`；两秒后
pidof 仍是同一 pid，新增 iteration 证明不是“存活但仍冻结”：
F1 `0..2 → 0..4`，F2 `0..1 → 0..3`，F3 `0 → 0..2`。随后卸载本任务样例。

### 失败尝试与 ART 实际差异

| 尝试/观察                                             | 结果与处理                                                                                                                                                                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 最初 `adb -s <test-phone> jdwp` 当有限列表读取        | 30 秒 TimeoutExpired。此版本/连接的输出没有 EOF；测试不再用阻塞列表门槛，直接用已验证 debuggable metadata 的单包 pid → JDWP forward → 真正 attach。未来若列多进程，使用有界读/track-jdwp，不以 EOF 为成功条件。样例已清理。 |
| 初版 setBreakpoints 扫描全部 ART 类并逐类 sourceNames | DAP 20 秒超时；退出/清理过程中 adapter 被结束。修正为先通过 package-directory 在本地筛出候选类，再查询 metadata；避免数千个 USB JDWP 往返。不是提高 timeout 掩盖问题。                                                      |
| `am start -D` 立即 pidof                              | 一次退出 1（进程尚未建立）；加上述有界 app readiness 后稳定通过。                                                                                                                                                           |
| F3 首次 stepIn 期待直接 levelThree                    | 实际 Kotlin object 首次触发 `<init>/<clinit>`，是正确 VM 语义，不是适配器失败；测试记录真实帧而非硬跳。                                                                                                                     |
| 请求 `<clinit>` variables                             | JDI AbsentInformationException；无局部变量表的 synthetic 帧显式报错，不能编造空 locals 或有效源码行。普通 Java/Kotlin 方法变量可读。                                                                                        |
| JDI stderr `Ignoring cmd …/199/1 from the VM`         | Android DDM 扩展包警告；本次标准 JDWP/JDI 操作全通过，不实现 DDMS/Profiler。不能由“无异常”宣称所有 ART JDWP 命令都支持。                                                                                                    |
| 最后补验误把 host.py 构建和 phone.py 并行             | jar 写入被 Windows 文件锁拒绝（build 子进程退出 1）；真机回归通过。手机 adapter 结束后顺序重跑 host.py 退出 0。复现说明要求顺序执行，不解除文件锁/杀其他进程。                                                              |

没有测无线 adb、多进程应用、release/minified APK、不同 ART/Android 版本、
Kotlin coroutine/suspend、用户 inline/跨文件 SMAP，以及 `FooKt` top-level
源码映射。lambda 的一个真实 Kotlin 2.3.21/D8 编译形式已通过，不推广到所有
lambda/匿名类布局。样例里的 inline library 调用可正常 next，但不保证 inline
函数内部的源级步进。

`am start -D` 的 waiting-for-debugger 状态通过 JDWP 附加解除；测试在后台 worker
命中。未拍摄手机 dialog、未验证前台 UI 文案/动画，不能将此协议证据当 GUI 截图。

完整原 attach 记录为本会话 `files\final-phone-evidence\phone-results.json`
及 `phone-commands.json`，已作为会话附件保留。
设备标识均替换为 `<test-phone>`；可重复测试代码与本文提交，构建产物不提交。

## 原型限制与集成建议

原型在 host/port attach 或 launch 创建的 loopback forward 上使用 JDI；用独立 suspend hold 避免
VMStart 在设置断点前恢复。ClassPrepare 在 SUSPEND_ALL 时安装延迟断点后恢复；
普通断点和步骤让所有线程停住。用 Java stratum 的文件名+package path+line
定位，不尝试 Kotlin SMAP 展开。源码根必须准确；同包同名、多 source-set
重复源文件不猜测，应显式报 ambiguous 或由当前构建 variant 选择根。
没有列断点、条件断点、表达式求值、HotSwap、方法调用、native 调试和
Kotlin suspend/inline/lambda 专用映射。对象字段读取不用 toString() 方法调用，
不会执行 target 代码。变量/帧句柄在恢复时失效。

原型直接按 ReferenceType.sourceNames("Java") 查询，不靠 `Foo`/`FooKt`/`Foo$…`
类名猜文件；因此算法对有标准 SourceFile/LineNumberTable 的 top-level/嵌套类
有设计支持，但上表明确区分了本次实测范围。ClassPrepare 的包名前缀只限制事件
量；源码查询仍按源文件+行匹配。大项目应从显式 source roots/实际 variant
筛选包名前缀，避免默认 `*` 全局 ClassPrepare 成本。

推荐后续按最小边界实现，不在本 spike 改 Rust：

1. `crates\ide-android` 仅负责 adb devices（明确 serial）、APK applicationId/
   launcher activity 输入、build/install；不再管理调试启动、pid/JDWP、forward
   或 Stop。后者集中在 adapter 的 launch 生命周期，不扫/导入 AGP model，
   不碰非目标包。build 用现有 Gradle process runner 和用户明确的 assemble task。
2. `crates\ide-dap\src\adapter.rs` 增加 android-jdwp-dap 配置；`ide-tools` 只定位
   已有 JDK 与自带 jar，不安装 Android SDK。Java helper 构建/打包与现有
   `java\*\build.py` 和 `crates\ide-sdk`/`ide-tools` 的资源机制保持一致。
3. `crates\ide-dap\src\lib.rs` 保留通用 launch/attach 配置顺序和 Stop 协议；
   Android forward 所有权留在 adapter，不新增 Rust 端重复生命周期。
   launch Stop 明确结束本次启动的 App；attach 必须 `terminateDebuggee=false`
   保留原目标。不能把手机 pid 当 Windows pid；原型不发任何手机 process/
   processid/systemProcessId 事件，避免现有 launch Stop 本机 kill 路径。
   原型接入前还应让该 adapter 的 setBreakpoints 错误像现有 Kotlin 特例一样向 UI
   传播，而不是通用分支仅 tracing 后返回未验证状态；禁用不支持的条件/
   expression/HCR 功能。不要为了 prototype 改动其他语言调试行为。
4. `src-tauri\commands\android.rs` 薄 typed IPC；变更类型后生成
   `src\bindings.ts`（本次不手改）。
5. 新 `src\features\android` 注册稳定 action id，通过
   contributions/services 与 debugger 通信；复用 editor gutter、debug store/
   panel。构造 adapter=android-jdwp-dap 的 LaunchConfig，不调用 java.ts 的
   JDT LS debugServer，也不覆盖 java/kotlin language 默认 adapter。
6. UI 文案进入 en/zh text catalog；补充 docs/zh 与 en 的真机调试说明。
   Rust/MSVC 环境可用后才做 Tauri/runtime UI 与取消/设备拔出自动化验证。

生产化必须补充设备断连、重启进程 pid 变化、退出、配置取消、已挂 debugger、
release APK/缺失 debug metadata、源码版本不匹配、类卸载与重复源文件错误路径。
当前 go/no-go 仅覆盖上述最小协议能力，不能承诺完整 Android Studio 调试体验。
