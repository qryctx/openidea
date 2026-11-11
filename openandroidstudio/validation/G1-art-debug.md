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

## 现有 OpenIDEA 可以复用什么

| 位置                                            | 已核实行为与 Android 边界                                                                                                                                                                                                                           |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates\ide-dap\src\adapter.rs`                 | `AdapterSpec`、`find_config`、`resolve`、`ProcessLauncher` 支持 stdio/TCP；Windows 查找 PATHEXT 可执行文件，不能直接执行 jar。新适配器应执行 JDK `java.exe --add-modules jdk.jdi -jar …`。`debugServer` 是 DAP 服务端口，不是 JDWP 端口。           |
| `crates\ide-dap\src\lib.rs`                     | `LaunchConfig.extra_json` 合并到 DAP 参数，`start_session` 接受 launch/attach；`configure` 顺序为 initialize、attach、initialized、所有断点、configurationDone。initialize 使用 1-based DAP；IPC 是 0-based。通用远程 attach 不依赖 Unix 进程枚举。 |
| `crates\ide-dap\src\session.rs`                 | `send_breakpoints` 发送绝对 source.path/name，line+1；响应与 breakpoint 事件更新验证状态；栈与变量由通用 DAP 请求驱动。已有 Kotlin SourceMirror 仅对 `kotlin-debug-adapter` 生效，新 adapter id 不走该分支。                                        |
| `crates\ide-dap\src\attach.rs`                  | `classify` 通过本机进程命令行发现 JDWP；`list_processes` 非 Unix 路径不可用。这不是 adb 进程发现，不能用此弹窗代替真机 pid/JDWP 列表。                                                                                                              |
| `languages\java.toml`、`languages\kotlin.toml`  | 分别指定 java-debug、kotlin-debug-adapter，不宜全局替换为 Android 适配器（仍保留普通 JVM 行为）。                                                                                                                                                   |
| `src\features\debugger\java.ts`                 | `javaAttachConfig` 先调用 `javaDebugServer` 启动 JDT LS 中 java-debug 的 DAP 服务；源码与项目名称解析来自 JVM 项目准备通路。v0 不应复用这个前置依赖。                                                                                               |
| `src\features\debugger\actions.ts`、`attach.ts` | 已有 Remote JVM Debug（host/port）与通用调试 actions；Android 入口应独立创建 `adapter=android-jdwp-dap, request=attach`。                                                                                                                           |
| `src\features\debugger\state.ts`、`ui\`         | 调试状态/线程/帧/变量 UI 可复用；不需要新造 Android 调试器面板。最终集成时还需审阅按 adapter capability 禁用未实现功能。                                                                                                                            |
| `docs\zh\guide\debugging.mdx`                   | 文档已说明 DAP、行断点、变量和步进；尚无 Android/adb 的运行语义。                                                                                                                                                                                   |

## 三条候选路径

| 路径                                          | 依据                                                                                                                                                                                                                                                                                                                                                                        | 决策                                                                                                                       |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| A：fwcd Kotlin Debug Adapter 直接 attach JDWP | [配置](https://github.com/fwcd/kotlin-debug-adapter/blob/main/CONFIGURATION.md) 有 `projectRoot,hostName,port,timeout`；[架构](https://github.com/fwcd/kotlin-debug-adapter/blob/main/README.md) 本来就是 DAP→JDI。OpenIDEA 已有安装、源码镜像和启动 relay。上游目标 Kotlin/JVM，ART 是否兼容不能从 README 推导。                                                           | 可作为后续复用对照；本次不下载/运行其完整依赖。不是已证明失败。                                                            |
| B：Microsoft java-debug                       | [AttachRequestHandler](https://github.com/microsoft/java-debug/blob/main/com.microsoft.java.debug.core/src/main/java/com/microsoft/java/debug/core/adapter/handler/AttachRequestHandler.java) 直接 attach socket，但初始化 source/evaluation/HCR/completion providers；OpenIDEA 从 JDT LS 启动此 adapter。即使 sourcePaths 有回退，Android 无 AGP import 的行断点仍需实测。 | 与“不做 Java/Kotlin 语义 LSP、AGP model bridge”冲突；不选为 v0 前置。不是宣称它技术上无法调 ART。                          |
| C：小型独立 JDI adapter                       | JDK 21 本机 `java --list-modules` 有 `jdk.jdi`；SocketAttach、ClassPrepare、locationsOfLine、局部变量和步进都是 JDI 标准 API。                                                                                                                                                                                                                                              | **选为可证伪 spike**：不解释源码表达式、不启动 app、不杀 target，只做行调试。生产化是否继续自研需结合 ART 结果与维护成本。 |

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
支持 initialize/attach/setBreakpoints/configurationDone/threads/stackTrace/scopes/
variables/continue/next/stepIn/stepOut/pause/disconnect，以及空的
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

完整本轮记录可查看
[真机 DAP 结果](C:\Users\admin.copilot\session-state\a6f5ce33-ccbc-4a33-b429-967a89938164\files\final-phone-evidence\phone-results.json)
及
[显式命令与清理证据](C:\Users\admin.copilot\session-state\a6f5ce33-ccbc-4a33-b429-967a89938164\files\final-phone-evidence\phone-commands.json)。
设备标识均替换为 `<test-phone>`；可重复测试代码与本文提交，构建产物不提交。

## 原型限制与集成建议

原型只在 attach 到 loopback 后使用 JDI；用独立 suspend hold 避免
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

1. `crates\ide-android` 负责 adb devices（明确 serial）、显式 APK applicationId/
   launcher activity 输入、install、am start -D、pid/JDWP 选择、tcp:0 forward
   分配与 RAII 单条清理；不扫/导入 AGP model，不碰非目标包。build 用现有
   Gradle process runner 和用户明确的 assemble task。
2. `crates\ide-dap\src\adapter.rs` 增加 android-jdwp-dap 配置；`ide-tools` 只定位
   已有 JDK 与自带 jar，不安装 Android SDK。Java helper 构建/打包与现有
   `java\*\build.py` 和 `crates\ide-sdk`/`ide-tools` 的资源机制保持一致。
3. `crates\ide-dap\src\lib.rs` 保留通用 attach 配置顺序；Android session 保存
   forward 所有权，只在结束/错误/取消时清理本条 forward。审计 stop/shutdown：
   attach 必须 `terminateDebuggee=false`，不能把手机 pid 当 Windows pid，也
   不应让“Stop”意外结束用户 app。当前 shutdown 已按 request=attach 发送 false；
   原型刻意不发手机 process/systemProcessId 事件。与 Android 运行生命周期分别管理。
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
