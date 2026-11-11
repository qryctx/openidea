# G1 / T06：Windows 真机断点调试可行性

## 结论与当前证据

2026-11-11，第一阶段 **通过**：独立 JDK 21 JDI → stdio DAP 原型，无 Android
Studio、无 JDT LS、无第三方 Java 依赖。在本机 JVM 上验证延迟类加载断点、
已加载类断点、删除断点、stepIn/next/stepOut、参数/局部变量/对象字段/数组、
pause、过期句柄拒绝、disconnect 与 stdin EOF 后进程存活。

第二阶段尚未执行；此处不能把 HotSpot 成功等同于 ART 成功。最终 v0 go/no-go
等待真机证据。本次仅验证协议原型，不声称 OpenIDEA UI 已接入。

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

| 本机命令                                          | 退出码/结果                                                                                                                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `java --version`                                  | 0，Temurin 21.0.12；Node 24.22.1 可用（测试选择 Python）。                                                                                                                  |
| `java --list-modules \| Select-String jdk.jdi`    | 0，包含 jdk.jdi。                                                                                                                                                           |
| `python java\android-jdwp-dap\tests\host.py` 初次 | 1，所有首次调试步骤成功，复连失败：HotSpot address=0 在 detach 后重新分配端口。修正测试为读取新监听端口，不改 adapter、无端口猜测。                                         |
| 同一命令修正后                                    | 0，PASS；javac `-Xlint:all -Werror` 通过；attach 47 ms，首停 16 ms，stepIn <16 ms，next <16 ms，stepOut 16 ms，reattach 32 ms。Windows 时间分辨率和单次样本，不是性能预算。 |

## 真机第二阶段（待执行）

检测时只有一台已授权物理设备；不在文档/提交中记录设备标识。
已合入最新样例提交 `05751771`，F1 Kotlin、F2 Java、F3 mixed-module，
applicationId 均为 `dev.openandroid.samples.*`。原先早期矩阵 `f7f31c18`
已被样例负责人替换；本任务撤销尚未使用的临时 debug-target，直接验证最新
共享样例，不另建应用。样例构建/普通运行已有另一会话证据，本任务独立重建、
验证 DAP 断点；两者不混为一谈。真机使用权已由协调者确认释放。

## 原型限制与集成建议

原型只在 attach 到 loopback 后使用 JDI；用独立 suspend hold 避免
VMStart 在设置断点前恢复。ClassPrepare 在 SUSPEND_ALL 时安装延迟断点后恢复；
普通断点和步骤让所有线程停住。用 Java stratum 的文件名+package path+line
定位，不尝试 Kotlin SMAP 展开。源码根必须准确；同包同名、多 source-set
重复源文件不猜测，应显式报 ambiguous 或由当前构建 variant 选择根。
没有列断点、条件断点、表达式求值、HotSwap、方法调用、native 调试和
Kotlin suspend/inline/lambda 专用映射。对象字段读取不用 toString() 方法调用，
不会执行 target 代码。变量/帧句柄在恢复时失效。

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
   不应让“Stop”意外结束用户 app。与 Android 运行生命周期分别管理。
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
