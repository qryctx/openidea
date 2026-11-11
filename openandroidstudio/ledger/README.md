# G0 许可、身份与功能清点

基线 `fc75b15519f0c822f0a32905bc46714d3e989c3d`（OpenIDEA 0.1.41），核查日期 2026-11-11。本目录为 T02 与 T08 前置清点；只含文档，不改产品代码、配置、CI 或锁文件。结论按已核实 / 推断 / 待审核标记；许可清点不是法律意见。

**用户已确认的 v0 范围**：“只做真机，一切按简单处理”，只包含**查看代码改动、编译、断点、运行**。建议 Changes-first 布局，其他产品能力先隐藏，不直接删除共享依赖。**延期、不评估**：模拟器/AVD、AGP model bridge、Java/Kotlin 语义 LSP、Kotlin LSP 捆绑、Compose Preview、Profiler。

| 文档                                              | 用途                                                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [第三方账本](third-party-ledger.md)               | 全部主 Rust/npm 锁条目、插件/SDK 独立锁补充、JAR 编译输入、80 个语言及 60 个工具、字体/图标/插件、Kotlin/JDT/DAP/SDK 边界 |
| [身份隔离检查表](identity-isolation-checklist.md) | release/dev/nightly、目录/凭据/协议、更新与市场、发布权限的证据、风险、建议与验证                                         |
| [功能清单与布局](feature-inventory.md)            | 全部主激活、Settings/aux 窗口、IPC/Host 依赖、裁剪顺序修正与 Android 默认工作台建议                                       |

## Top-10 关键发现与计划修正

1. **查看改动：已有刷新链路，但 dirty buffer 不是自动合并。** Git status、并排/unified diff、hunk 导航、暂存/撤销暂存/提交均有静态实现；外部脚本/AI 写入经 watcher 刷新。**已核实风险**：编辑器未保存时只警告，继续保存会覆盖外部修改；必须实测冲突保护。证据：`src/features/vcs/DiffEditor.tsx:327`；`src/features/vcs/store.ts:297`；`crates/ide-workspace/src/documents.rs:925`–`crates/ide-workspace/src/documents.rs:939`。
2. **编译：默认 Build 不是 Android APK build。** **已核实**：Gradle BuildKind::Build 固定 `classes/testClasses`；任务树走 Run action，而 matcher/Problems 属另一条 buildRun 流。**建议**：v0 绑定用户选定 APK 任务，并接通输出/诊断/取消，资源编译错误另验。证据：`crates/ide-build/src/compile/mod.rs:309`–`crates/ide-build/src/compile/mod.rs:329`；`src/features/build-tools/store.ts:563`；`crates/ide-host/src/ops/build.rs:620`。
3. **真机运行：设备和 Logcat 已有，安装/启动缺口仍在。** **已核实（检查范围内）**：ide-android 公共 API 仅查 adb/枚举/日志，无 APK install/launch；现有 serial 选择服务 Logcat。**建议**：最小 APK + package/activity + serial 配置，不先建完整模型；授权失败、编译失败和拔线不得继续运行。证据：`crates/ide-android/src/lib.rs:57`、`crates/ide-android/src/lib.rs:101`、`crates/ide-android/src/lib.rs:118`、`crates/ide-android/src/lib.rs:142`；`src-tauri/src/commands/android.rs:16`、`src-tauri/src/commands/android.rs:24`。
4. **断点：DAP/JVM TCP attach 存在，不等于真机 ART 调试。** **已核实**：DAP adapter 的 debugServer 与 JDWP 的 hostName/port 是两种连接；Java attach 要启动 JDT 内 java-debug。未找到 adb JDWP/PID/forward/等待调试启动链路。**待验证**：真机 verified/命中/单步/变量及清理；语义 LSP 延期不等于可立即删除现有调试依赖。证据：`src/features/debugger/java.ts:209`–`src/features/debugger/java.ts:244`；`crates/ide-dap/src/lib.rs:50`–`crates/ide-dap/src/lib.rs:53`。
5. **Windows：本机进程附加明确未实现，不能靠 UI 存在判定可用。** **已核实**：non-Unix list_processes 返回 Unavailable；TCP adapter 有跨平台静态路径和 PATHEXT 查找。设备 PID 应由 adb 获取，不能使用 host process picker。真机运行仍未实测。证据：`crates/ide-dap/src/attach.rs:203`–`crates/ide-dap/src/attach.rs:205`；`crates/ide-dap/src/adapter.rs:254`、`crates/ide-dap/src/adapter.rs:501`。
6. **Changes-first 先隐藏，不做大规模物理删除。** **已核实**：主激活、独立 Settings/Deployment/Diff 入口、Host/desktop 强依赖、保存上传 hook 仍存在。**建议修正**：只显露四支柱，非核心入口和自动副作用一起关；先不新增项目向导。新建项目本来只是空文件夹，.NET/GraphQL 没有独立对应 crate。证据：`src/features/index.ts:60`、`src/features/index.ts:145`、`src/features/index.ts:158`；`crates/ide-host/src/project.rs:1583`；`src/features/app/NewProject.tsx:2`。
7. **共享边界不能粗删。** **已核实**：ide-http 提供代理 client，ide-ssh 被 Git askpass/代理/DB secrets 装配复用，ide-vcs 并非直接 Cargo→ide-ssh；工具下载也不全经 ide-http。MCP 默认 false，应纠正“原版默认公网开启”；外部改动刷新不依赖 AI activation。证据：`crates/ide-http/src/client.rs:12`；`src-tauri/src/state.rs:179`、`src-tauri/src/state.rs:203`；`crates/ide-host/src/lib.rs:84`；`crates/ide-core/src/settings.rs:261`。
8. **更新源和身份仍有上游回落风险。** **已核实**：stable 有 CNB 回退，nightly 重写 ID/URL，插件市场/server 另指上游；数据、CLI、凭据与项目 `.openidea` 不只由标题控制。**建议**：独立包前禁用完整 updater 或全链路 fork；绝不生成私钥。证据：`src-tauri/src/commands/window.rs:408`、`src-tauri/src/commands/window.rs:425`；`scripts/nightly-prepare.ts:26`；`crates/ide-ssh/src/secrets.rs:97`；`crates/ide-core/src/project_dir.rs:6`。
9. **工作名和 SDK 分发仍是发布门禁。** **已核实**：Google 应用命名指南限制 Android 的命名使用；SDK 下载不证明可再分发。OpenAndroidStudio 为工作名，名称待审核；v0 引用用户 adb/SDK/JDK，不复制安装版 Android Studio 或本机 SDK。证据：https://developer.android.com/distribute/marketing-tools/brand-guidelines、https://developer.android.com/studio/terms（2026-11-11）。
10. **许可账本不是安装包 SBOM 或法律批准。** **已核实**：1051 Rust / 453 npm 主锁条目，另有插件/SDK 独立锁；405 Rust 查询 HTTP 429。字体 OFL、Graphviz Wasm EPL、修改 Lombok 随包及各 DAP 许可都须单列。Kotlin LSP Alpha/实验性 AGP/部分闭源只保留前次许可事实，捆绑与语义评估已延期。证据：`Cargo.toml:4`；`plugins/official/graphviz/NOTICE.md:5`；`crates/ide-tools/src/registry.rs:729`；https://github.com/Kotlin/kotlin-lsp（2026-11-11）；[逐版本账本](third-party-ledger.md#主-cargo-锁文件逐版本清单)。

## G0 本轮验证与未完成的发布审核

**已执行**：git baseline/status、文件/行号静态核对；Python 标准库解析 Cargo/TOML 与 pnpm package headings；逐版本公共 crates.io/npm 元数据查询（失败保留为待审核）；提交的三个 Java JAR ZIP/manifest/类路径/SHA-256 检查；官方 SDK terms/Android 品牌/Kotlin LSP/JDT LS/适配器源码许可证只读查询；文档结构/引用范围和 git diff 检查。

**未执行**：cargo/pnpm install、构建、GUI、cargo tree/deny、knip、真机四支柱闭环、真实安装包解包、动态下载 JAR/SDK、网络运行采样。精确待执行命令和真机门禁列在 [功能清单](feature-inventory.md)。未改任何运行行为，未 push、未开 PR、未读取或生成签名私钥。

**待审核**：实际发行二进制许可/源码提供、所选 DAP/JDT 二进制、正式名称与分发平台、独立更新/插件签名治理；缺注册表许可字段或 HTTP 429 的条目须补证。延期内容不阻断本轮静态文档交付，也不因此获得发布授权。本轮不能解除发布门禁，不能宣称 Android 四支柱已经可用。
