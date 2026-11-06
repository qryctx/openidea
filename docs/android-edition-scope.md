# OpenAndroidStudio 默认发行范围

面向已有 Gradle 工程、主要用真机的 Java/Kotlin 开发者。建议复用 OpenIDEA 的编辑器和 JVM 工具链，由本项目负责 Android 工程模型、当前变体、设备部署和源码调试。以下清单用于设计 Android 发行版。测量基准是提交 `6909d6c8` 对应的 macOS arm64 Pilot。

首批 source map 拆分与 Android 自动工程同步已经实施，签名对照实测减少 9.39 MiB。[当前发行版及验证方法](android-project-sync.md)

## 哪些东西真正占空间

| 基线实测                | 数值                                                                                                                | 如何用于决定                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 签名 Pilot 的磁盘分配量 | 147.43 MiB                                                                                                          | 比较发行包时固定架构、release 优化、签名方式和测量口径。                                          |
| 主可执行文件            | 154,453,632 字节，占包内所有文件逻辑字节的 99.92%                                                                   | Tauri 把前端资源嵌在这里，Rust 也链接到这里。删除仓库目录或隐藏工具窗不会自动得到相同的成品收益。 |
| 前端 source map         | 337 份，原始 41.03 MiB，成品内经 Brotli 压缩的载荷为 **9.37 MiB**                                                   | 排在第一批。用户版可以把映射按构建版本另存供诊断，开发版继续使用。                                |
| Tree-sitter 解析表      | 已识别 37 套原生语法，三类解析表共 40.27 MiB。其中 C#、OCaml 及其接口语法、Haskell、Swift、Scala 合计 **22.35 MiB** | 优先对这六套语法做编译期开关。Java、Kotlin 等保留语法也计入 40.27 MiB 总数。                      |
| 工作台                  | 主窗口注册 43 项功能，语言目录有 77 份定义                                                                          | 减少启动注册、空闲预取和菜单噪音。功能数量、语言定义数量和包体字节是三个不同指标。                |

测量时从签名 Mach-O 的 Tauri 资源表取出 337 段独立数据，逐份解压，与现有 `dist` 的映射文件逐字节比较。语法数据按每个已链接 Tree-sitter 语言描述符指向的大状态表、小状态表及小状态索引表计数，范围互不重叠，并用上述六套语法的生成 C 源码复核尺寸。这些数字描述现有载荷，最终净节省量要实编、签名 Android 精简包后再测。

这六套候选解析表中，OCaml 实现与接口合计 7.69 MiB，C# 为 4.81 MiB，Haskell 为 3.32 MiB，Swift 为 3.31 MiB，Scala 为 3.23 MiB。作为对照，Java 和 Kotlin 的同类解析表合计约 3.24 MiB，应在 Android 默认配置中保留。

另在两个临时目录对同一提交做了 Vite 对照构建。开启映射产生 735 个文件、58,875,695 字节，关闭映射产生 398 个文件、15,717,230 字节。这是前端构建目录的变化。SDK、JDK、语言服务、Gradle 缓存以及编译 IDE 自身的 Rust 缓存需要单独计量。普通用户的机器应优先复用已有 SDK/JDK，默认真机配置不下载系统镜像。[Vite 构建配置](../vite.config.ts) · [工作台入口](../src/features/index.ts) · [语法注册表](../crates/ide-language/src/syntax/grammars.rs)

## 默认保留、移出与按需启用

| 处置建议               | 对象                                                                                                                                                                   | 要保住的使用方式                                                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 默认保留               | 编辑器、文件树、搜索和跳转、Git/diff、终端、项目可信状态、设置、构建输出、错误定位及取消                                                                               | 开发者能安全打开工程、改代码、看差异，用工程自己的 Wrapper 排查构建失败。                                                                                            |
| 默认保留               | Java、Kotlin（含 `.kts`）、Groovy Gradle 脚本、Manifest/资源 XML、TOML 版本目录、properties、JSON、Shell、基础 YAML/Markdown、图片查看、JAR/JDK 源码浏览、JVM 单元测试 | 能维护应用源码、构建逻辑、依赖、资源、README 和测试。保留 LSP/DAP 通道，JDT、Java Debug 或 Kotlin 语言服务可在需要其能力时启用。                                     |
| 首批移出默认发行       | Jupyter Notebook/内核、通用 SQL 数据库工作台、多数据库驱动                                                                                                             | Notebook 有独立的 Jupyter/ZMQ 服务，适合做第一项跨前后端裁剪。数据库管理界面可独立裁剪。源码索引使用独立的 redb，Android 项目依然可以使用 Room、SQLite 和 SQL 文件。 |
| 移出默认工作台         | Docker 管理、远程工作区和服务器部署、HTTP 请求运行器、GraphQL 工具、AI Agents、GitHub PR 审阅、Web 框架专属开发工具                                                    | 保留本地 Git、Gradle 下载所需的 HTTP/代理/证书、Run 的服务视图，以及 Git 使用的凭据功能。Docker 管理入口与 Android 真机设备列表分别处理。                            |
| 移出默认运行配置       | Tomcat、Spring Boot 服务端部署，以及独立 Go/Python 等应用的运行与调试模板                                                                                              | Android 工程的辅助脚本仍可在终端执行。保留 JVM 测试和 Java 调试共用逻辑。                                                                                            |
| 保留基础，拆出高级界面 | Markdown 的 Mermaid 图表、Maven 专属面板、桌面 JVM/Node/Python Profiler、通用覆盖率报表、宏/Vim 等偏好功能                                                             | Markdown 文本/图片、Gradle 对 Maven 仓库的依赖解析、JUnit 和基础 JVM 调试分别保留。宏/Vim 等先按需求调整默认入口，体积收益另测。                                     |
| 工程需要时启用         | NDK 的 C/C++、CMake 和 LLDB，Protobuf，WebView 的 JS/TS/HTML/CSS，Flutter/Dart 或跨平台配套语法                                                                        | 纯 Java/Kotlin 工程轻装启动，含 native、混合页面或跨平台模块的工程按技术栈扩展。模拟器和系统镜像同样按需。                                                           |
| 延后评估               | Wasm 第三方插件运行时、插件市场、所有其他语言运行器                                                                                                                    | 先盘点正在使用的语言、主题和插件贡献。插件 UI、扩展元数据与 Wasmtime/Cranelift 运行时分别决定去留。第一阶段可通过构建配置提供不同组合。                              |

有三处特别容易误裁。Git HTTPS 凭据目前经 `ide_ssh` 初始化，先分离凭据再裁远程部署。Docker 与 Run 共用 Services，保留运行服务供应方。Gradle 与 Maven 的工作台共享部分入口，Gradle 的版本目录补全、依赖解析和 JVM 测试应各自验收。[宿主状态](../src-tauri/src/state.rs) · [Run 服务注册](../src/features/run/index.ts) · [Gradle 版本目录](../src/features/build-tools/versionCatalog.ts)

工作台还会在空闲时预取已注册的延迟视图。要降低后台加载，应同时调整功能注册、设置页、独立窗口入口和预取列表。要减小发行包，还需让相关前端导入、原生命令与专用依赖退出该发行配置。Docker 集成调用外部 CLI，停用它的主要收益是工作台更简单；空间收益待实测。[预取实现](../src/ui/lazy.tsx) · [启动入口](../src/main.tsx)

## Android 部分由谁负责

| Android 功能   | 复用现有实现                                                                       | OpenAndroidStudio 自研                                                                                             |
| -------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 项目同步与变体 | Gradle Wrapper、刷新入口、任务与取消、构建日志                                     | 由 AGP 读取应用模块、变体、源集、依赖与生成目录，维护同一个“应用模块＋变体”选择，供查引用、Run 和 Debug 共用。     |
| 代码与资源     | 编辑器、Java/Kotlin 语言协议，以及当前已验证的 AGP/lint 构造调用和普通成员方法索引 | 将索引生成、更新、过期和失败接到同步；随后增加 Android 资源、Manifest 合并结果与 `R` 跳转。                        |
| 真机 Run       | 已有 ADB 设备发现和 Logcat，Gradle 构建执行                                        | 选择设备，取当前变体的真实产物和 application ID，安装、启动、停止并定位该应用的日志。先验单 APK，多 APK 单列验收。 |
| 真机 Debug     | 断点 UI、调用栈、变量查看、DAP 与已有 Java 调试适配器                              | 选择 ART 进程、建立并清理该会话的 JDWP 转发，将栈帧映射回所选变体的 Java/Kotlin 源码和行号。                       |

当前原生 Android 命令已经提供设备列表和 Logcat。当前变体索引用于类构造调用和普通成员方法直接调用。自动同步、变体驱动部署和真机源码映射是下一阶段的功能。[Android 命令](../src-tauri/src/commands/android.rs) · [引用索引能力](../android-support/README.md) · [Java 调试器](../src/features/debugger/java.ts)

## 实施顺序与验收

1. **先分发行配置。** 保留通用上游配置，新增 Android 构建选项。将诊断映射存放在 Tauri 的 `frontendDist` 外，并检查用户版资源清单中没有 `.map`。用同一提交、架构、优化和签名设置构建对照包。记录签名包 `du -sk`、可执行文件逻辑长度及独立诊断文件大小。
2. **按语言裁剪，再以 Notebook 验证整条路径。** 语言选择覆盖 Rust grammar 依赖、前端编辑器、diff 和 Markdown 代码块的加载入口。Notebook 裁剪覆盖工作台、独立窗口与设置、快捷键、Tauri 命令、宿主工程生命周期和 Cargo 依赖。用 `cargo tree` 核对 Notebook 依赖、检查产物和实际运行，再逐项处理数据库、Docker 等。[桌面依赖](../src-tauri/Cargo.toml) · [宿主依赖](../crates/ide-host/Cargo.toml) · [命令注册](../src-tauri/src/commands/mod.rs) · [工程服务初始化](../crates/ide-host/src/project.rs)
3. **让 Android 同步并行推进。** 每个精简包均须通过公开双模块样例的两个 flavor 构建、Java/Kotlin 双向查引用及切换后清除旧结果。补测 Gradle Groovy/Kotlin 脚本、版本目录、JVM 测试、Git、终端、设备列表和 Logcat。Run/Debug 开发完成后，加入真机安装、正确源码断点、局部变量和单步；记录首次同步、首次调试新增的工具及缓存。[已通过的验收基线](android-variant-pilot.md)
