# M5 前置切片：v0 updater 隔离

## 当前结论

隔离代码和前端/脚本验证已完成；**原生验收未完成**，不能据此前端 build 宣称已经验证原生零请求或 Cargo 缓存切换。当前 Rust 1.99.1 已存在于用户的 `.cargo\bin`，但尚未收到 G0 的 MSVC/Windows SDK 安装完成通知；检查时 Windows Kits 10 的 Lib 目录不存在。遵照协调约定，未启动重型 Rust/Tauri 编译，也未自行安装工具链。

分支建立在 `4386d4bc`（changes-first v0 工作台）之上，只处理 updater 隔离；未改名、未打包/发布、未使用设备、未修改 Android/run/build 或 editor/workspace，也未改变 Actions 权限。

## 根因及入口核对

原实现仅依赖配置端点或 `OPENIDEA_UPDATE_ENDPOINT` 判断可更新，没有产品构建边界，因此任何旧窗口、持久化自动检查设置或自定义端点都可以越过前端隐藏。

| 实际入口                                            | v0 的后端行为                                                                                |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `app_build_info` / 原生菜单及 Windows 菜单模型      | 共用 `updates_configured`；硬返回 false，`BuildInfo.updates=false`                           |
| `app_update_window_ready` / 自动循环                | 在读取窗口、设置、协调器状态或启动任务前返回，不启动检查任务                                 |
| `updates::check(None)`                              | 返回明确的 disabled 结果：`enabled=false, update=null`，不读取设置或缓存                     |
| `app_check_update` / `updates::check(Some(source))` | 返回 `IdeError::Unavailable`，不是“没有新版本”或检查成功                                     |
| 共享 `check_update` / updater 工厂                  | 在构造 updater、客户端或解析端点前返回 `Unavailable`                                         |
| `app_install_update`                                | 在读取 AppState、获取安装锁、分配请求或构造 updater 前返回 `Unavailable`；不检查、下载或安装 |
| 旧更新通知中的安装按钮、旧设置页或菜单动作          | 即使仍发出 IPC，也必须经过上述后端边界                                                       |
| 配置 / 环境自定义地址 / Github 和 CNB 来源          | v0 端点解析返回空集合，环境读取返回 None；不能重新启用                                       |
| Tauri updater 插件                                  | v0 不注册插件，避免插件自带入口成为另一路径                                                  |

默认构建保留已有官方端点、CNB fallback、nightly 不走镜像、非空环境 override 优先等行为。基础 `tauri.conf.json` 未修改。

## 构建边界

- 唯一选择仍是构建时 `VITE_OPENIDEA_PROFILE=v0`，不是网页参数或运行时设置。未知 profile 与前端现有规则一样明确报错。
- `scripts\tauri.ts` 先按 Vite 的 development/production `.env` 规则和进程环境优先级解析 profile，再将同一值传给 Vite 和 Cargo。现有 `pnpm tauri dev/build` 与 `pnpm dev:app` 入口继续使用。
- `src-tauri\build.rs` 声明 `VITE_OPENIDEA_PROFILE` 和 `TAURI_CONFIG` 的 Cargo 重建依赖，发出编译时 `openidea_v0` cfg。unset/default 与 v0 切换必须重新运行 build script，而不是读取运行时网页参数。
- v0 overlay 使用 Tauri 的 RFC 7396 merge：`plugins.updater=null` 删除上游更新公钥和端点，`bundle.createUpdaterArtifacts=false` 禁止 updater artifacts。wrapper 将其置于用户 config 之后；build script 也清洗 `TAURI_CONFIG` 并传给 `tauri-build` 与 `generate_context!`，保护直接设置 profile 的 Cargo 构建。
- `DevSession` 增加可选 `profile` 字段，旧记录按 default 处理；同一工作树正在运行不同 profile 时明确要求先停止，而不复用错误后端。
- v0 禁止独立 `tauri bundle`：该命令不重编译后端，可能包装此前的默认二进制。打包只能通过会重编译的 `pnpm tauri build`；本切片未执行打包。
- 未改变前端 `src\platform\productProfile.ts` 的接口。直接 Cargo 验证需显式设置同一个 profile；日常 dev/build 使用 wrapper，不能分别用不同环境构建前后端。

## 已执行的验证

Windows 上使用 `pnpm.cmd`，避免当前 PowerShell 的脚本执行策略阻止 `pnpm.ps1`；没有修改系统执行策略或全局 PATH。

| 命令                                                                                                                                                           | 结果                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `pnpm.cmd vitest run scripts\tauri-profile.test.ts scripts\dev-session.test.ts src\platform\productProfile.test.ts src\features\app\__tests__\updates.test.ts` | 4 个文件、76 个测试通过：profile 解析、模式环境优先级、overlay 顺序、运行参数保持、旧 bundle 拒绝、默认配置与已有更新前端回归 |
| `pnpm.cmd typecheck`                                                                                                                                           | 通过，包括 scripts 项目                                                                                                       |
| `pnpm.cmd lint`                                                                                                                                                | 通过；现有 React hooks/compiler warnings，非本切片改动                                                                        |
| `pnpm.cmd knip`                                                                                                                                                | 通过；现有 ignore 配置提示                                                                                                    |
| `pnpm.cmd exec oxfmt --check scripts\tauri.ts scripts\tauri-profile.ts scripts\tauri-profile.test.ts scripts\dev-session.ts src-tauri\tauri.v0.conf.json`      | 通过                                                                                                                          |
| `pnpm.cmd format:check`                                                                                                                                        | 未通过：已有 `CLAUDE.md` 格式问题；未修改该无关文件                                                                           |
| `$env:VITE_OPENIDEA_PROFILE='v0'; pnpm.cmd build`                                                                                                              | 通过，仅前端 typecheck/bundle/WebKit 检查，不是原生证明                                                                       |
| `cargo fmt --all --check`（只给当前 shell 添加用户 cargo bin 到 PATH）                                                                                         | 通过，不需要 MSVC 链接                                                                                                        |
| `git diff --check`                                                                                                                                             | 通过                                                                                                                          |

## 已加入但尚未执行的原生测试

- `commands::window::tests`：保留原来源/镜像/nightly 测试，新增 default/v0 的官方配置与空、空白、非空环境 override 解析矩阵。
- v0 专用测试使用 Tauri 现有 MockRuntime 和真实 localhost TCP listener，注入旧上游 updater 配置，调用实际自动 window-ready/check、手动协调检查、共享检查及安装实现；不管理 AppState、不注册 updater 插件，验证这些路径在访问设置、构造 updater 或下载前拒绝，listener 零连接。
- `updates::tests`：验证自动 disabled 状态与手动 `Unavailable`，default 继续进入原协调器。
- `tests\build_profile.rs`：验证 CLI/build-script overlay 一致、保留其他配置，以及实际 `generate_context!` 的 updater/artifacts 状态与当前环境对应。

收到工具链完成通知后，按以下顺序在同一个工作树、同一个默认 target 中逐条执行，不共享 `CARGO_TARGET_DIR`。每条 Cargo 命令单独运行，不并行重型编译：

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
$env:VITE_OPENIDEA_PROFILE = "default"
cargo test -p openidea --test build_profile
cargo test -p openidea --lib commands::window::tests
cargo test -p openidea --lib updates::tests

$env:VITE_OPENIDEA_PROFILE = "v0"
$env:OPENIDEA_UPDATE_ENDPOINT = "http://127.0.0.1:1/latest.json"
cargo test -p openidea --test build_profile
cargo test -p openidea --lib commands::window::tests
cargo test -p openidea --lib updates::tests

$env:VITE_OPENIDEA_PROFILE = "default"
Remove-Item Env:OPENIDEA_UPDATE_ENDPOINT
cargo test -p openidea --test build_profile
cargo clippy -p openidea --all-targets -- -D warnings
```

default → v0 → default 三次 `build_profile` 必须不清理 Cargo 缓存，以验证实际重编译而非静态声明。以上命令目前均**未执行**；Rust 测试编译结果和真实 profile 缓存切换仍待确认。

随后还需通过本工作树 Tauri MCP 验证 debug/release 后端的 `BuildInfo.updates`、手动/安装的禁用错误、非空环境 override 与旧设置/旧窗口状态的零请求，并确认默认产品的更新入口不受影响。未进行原生应用启动、release 构建、完整 workspace tests/clippy、bindings 生成或 e2e；没有生成密钥、签名资料或安装包。
