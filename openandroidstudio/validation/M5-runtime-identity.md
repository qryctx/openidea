# M5：内部开发身份与数据隔离

2026-11-11。依赖 [updater PR #4](https://github.com/qryctx/openidea/pull/4)，当前分支已确认包含
`6a97156865f4e322bdbafea07ba63f4678dfe752`。该依赖本身的 Rust/Tauri 原生验收仍未完成。

本记录交付的是 T07/M5 的代码及前端/静态检查，不是原生共存验收结论。内部标识可在未来集中更换；
没有进行 OpenAndroidStudio 正式命名、商标审查或发行包品牌变更。

## 选择合同与共享边界

沿用 `VITE_OPENIDEA_PROFILE=v0` 的 build-time opt-in。unset、空值及 `default` 保持默认产品；
非法值仍报错，没有新增运行时 profile、全局可变选择器或 profile flag。

Rust 选择合同从 updater 的 build helper 提取到 `crates/ide-core/build_profile.rs`，
由 `ide-core/build.rs` 和 `src-tauri/build_profile.rs` 共用。共享身份为 `ide_core::product`；
项目路径消费者继续使用 `ide_core::project_dir::{DIR, path}`，不自行推断产品。

| 边界                                     | default                                       | v0                                                  | 本轮证据                                                                    |
| ---------------------------------------- | --------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------- |
| release app identifier                   | `ai.l0ng.openidea`                            | `dev.qryctx.openidea.v0`                            | 已实现；Tauri overlay 与 Cargo overlay 都固定 v0 ID；原生待验收             |
| dev identifier                           | 原 ID + `.dev.w<hash>`                        | v0 ID + `.dev.w<hash>`                              | 已实现；TS 测试通过；Rust 对等测试已添加、未执行                            |
| worktree hash                            | 编译时 canonical worktree 路径，FNV-1a 64-bit | 同一算法/路径合同                                   | TS 同/不同 worktree、Unicode、不同启动 cwd 的子进程测试通过                 |
| 单实例、AppUserModelID、CLI socket、日志 | 原 context identifier                         | 隔离后的 context identifier                         | 静态追踪原调用链；未实际启动两产品                                          |
| Cargo 输出                               | 原行为                                        | wrapper 使用 `target/v0` 或 `<CARGO_TARGET_DIR>/v0` | TS 测试通过；避免同 worktree 覆盖/锁住同一开发二进制                        |
| dev launcher / Vite origin               | 原身份及首选端口区间                          | 独立身份与首选端口区间                              | TCP 锁碰撞、同 worktree 双 profile、重复启动测试通过                        |
| app config / data / logs                 | 原 OS app dirs                                | v0 identifier 下的 OS app dirs                      | 静态调用链；实际路径与共存待验收                                            |
| rebuildable local data override          | `OPENIDEA_LOCAL_DATA_DIR`                     | 仅 `OPENIDEA_V0_LOCAL_DATA_DIR`                     | 已实现；注入环境读取的 Rust 测试已添加、未执行                              |
| Windows/Linux WebView 存储               | 原行为                                        | 所有主/辅助窗口使用本 app local dir 下的 `webview`  | 已实现；Tauri API/配置静态核查；localStorage/IndexedDB 原生隔离待验收       |
| 项目目录                                 | `.openidea`                                   | `.openidea-v0`                                      | 已实现；实际 Rust 文件读写测试已添加、未执行                                |
| credential service                       | `ai.l0ng.openidea/<index UUID>`               | `dev.qryctx.openidea.v0/<index UUID>`               | 已实现；FakeVault 测试已添加、未执行，不触碰真实凭据                        |
| 可选 CLI                                 | `openidea` / `openidea.cmd`                   | `openidea-v0` / `openidea-v0.cmd`                   | 已实现；不覆盖另一产品 launcher 的 Rust 测试已添加、未执行；TS 文案测试通过 |

v0 override 沿用现有绝对路径和可写性校验；无效路径是错误，不静默回退。旧变量不会被 v0 读取，
也不会创建它指向的目录。专用 override 仍在根路径下附加本实例 identifier，区分 release/dev/worktree。
日志及 WebView 保留各自 OS app dir，不因工具缓存 override 而搬迁浏览器状态。

`AppState::new` 的 roaming → local 迁移只收到当前 context 的 app data 与当前 identifier 的 local data。
这是同产品可重建缓存迁移，不是跨产品导入；没有新增读取、搬迁或复制默认产品数据/凭据索引的逻辑。

## 项目路径及保留功能

settings、workspace manifest、run/run.local、模板、private `.gitignore`、changelists、shelf、
SDK 派生 Maven settings、项目插件路径均沿共享 `project_dir` 边界选择目录。
workspace 常量和真实的 attachment/delete 调用同步适配；没有扫描或导入旧 workspace manifest。
v0 索引、搜索及相关 Kotlin walkers 排除两产品元数据目录，忽略匹配覆盖 Windows 大小写变体。
当前产品自己的 run 文件仍可产生 watcher 事件；TS reload 判定只接收 v0 run/run.local，
不把旧 `.openidea/run.toml` 或其内部 build 文件作为 v0 配置输入。default reload 判定保持原行为。

Git HTTPS、SSH、HTTP proxy 保留原凭据底层及索引 UUID；测试使用模拟 Vault 和临时目录。
插件 Keychain namespace 和插件 CLI 的默认安装目录也适配产品身份，但不恢复 v0 隐藏的插件/远程入口。
本地 plugin host 的 app/project 路径来自隔离边界，没有为此新增远程或插件能力。
远程服务器部署协议、手动启动 `openidea-server` 的远程 home override 不属于此本地切片；
没有执行远程启动/导入/部署，没有触碰真机。

CLI 安装保留文件打开和单实例协议。Windows 使用独立 `OpenIDEA-v0/bin`；
macOS v0 使用独立用户 wrapper，不安装/卸载原版 bundle launcher 的命令名称。
显示名保留 OpenIDEA，仅路径/CLI 文案注明内部 v0；未改 Cargo crate、npm package、Logo、网站或事件协议。

交叉点：`src-tauri/src/windows.rs` 仅增加共用 WebView 存储适配；
`src-tauri/src/commands/plugin.rs` 仅调整必要 credential namespace；
`crates/ide-host/src/project.rs` 调整必要目录/排除边界。
M3 的 `crates/ide-workspace/src/documents.rs` **未修改**，未重复实现保存守卫，没有 IPC 类型变更，
没有手动编辑 `src/bindings.ts`。

## 已执行检查

Windows 使用 `pnpm.cmd`，避开本机 PowerShell 对 `pnpm.ps1` 的执行策略限制；未改系统执行策略。
Rust 命令每次仅将 `%USERPROFILE%\.cargo\bin` 临时加入该 shell PATH。

| 命令                                                                                                                                                                                                                                        | 结果                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `git merge-base --is-ancestor 6a97156865f4e322bdbafea07ba63f4678dfe752 HEAD`                                                                                                                                                                | 通过                                                                          |
| `pnpm.cmd vitest run scripts\dev-session.test.ts scripts\tauri-profile.test.ts src\platform\productProfile.test.ts src\platform\locales\textCatalog.test.ts src\features\run\configs.test.ts src\features\app\__tests__\cliCommand.test.ts` | 通过：6 文件，85 passed、6 skipped；跳过项来自现有用例，不是 Rust/native 验收 |
| `pnpm.cmd typecheck`                                                                                                                                                                                                                        | 通过，含 frontend/scripts/perf/smoke                                          |
| `pnpm.cmd lint`                                                                                                                                                                                                                             | 通过；存在未修改文件中的既有 warnings                                         |
| `pnpm.cmd knip`                                                                                                                                                                                                                             | 通过；既有 ignore 配置提示                                                    |
| `pnpm.cmd build`（unset/default）                                                                                                                                                                                                           | 通过，含 Safari startup/bundle 检查                                           |
| `$env:VITE_OPENIDEA_PROFILE = 'v0'; pnpm.cmd build`                                                                                                                                                                                         | 通过，含 Safari startup/bundle 检查；不是 Tauri 原生 build                    |
| `cargo fmt --all --check`                                                                                                                                                                                                                   | 通过；仅格式/解析，不是 Rust typecheck 或链接                                 |
| `cargo metadata --offline --format-version 1`                                                                                                                                                                                               | 通过，保留锁定版本，仅为 ide-cli 增加已有 ide-core 依赖                       |
| `git diff --check`                                                                                                                                                                                                                          | 通过                                                                          |
| `pnpm.cmd format:check`                                                                                                                                                                                                                     | 未通过：唯一问题为未修改的 `CLAUDE.md`；没有为本切片修改它                    |
| `pnpm.cmd exec oxfmt --check <本切片已修改的 TS/TSX/JSON 与 CONTRIBUTING.md>`                                                                                                                                                               | 通过                                                                          |

`cargo generate-lockfile --offline` 的初次尝试因缓存中的 yanked `async-executor` 失败；
随后 `cargo metadata --offline --format-version 1` 使用现有 lock 成功，没有升级依赖来绕过问题。
未执行全量 `pnpm test` 或 e2e；本轮可见变更仅为路径/CLI 文案，未提供截图，
实际原生行为仍需以下独立验收。

## 原生待验收及阻塞

协调者报告：VS BuildTools 实例仍 incomplete，不可启动，Windows SDK/link 尚无最小链接成功证明。
按协调安排本会话未安装工具链、未重启、未运行 Rust 重型构建，未使用共享 Cargo 输出，
未在主 checkout 执行命令。

因此以下 **均未通过验收、未执行**，不是用配置检查替代：

1. 在 default 与 v0 下分别运行 `cargo test -p ide-core -p ide-cli -p ide-workspace -p ide-run -p ide-index -p ide-ssh --lib`、
   `cargo test -p ide-run --test config`、`cargo test -p ide-host --lib data_dirs::tests`、
   `cargo test -p ide-host --test workspaces` 和 `cargo test -p openidea --test build_profile`。
   需要串行安排本 worktree 构建；v0 使用独立 target，credential 用例仅 mock store。
2. 执行相关 Rust clippy/CI；检查 backend cfg 与 overlay 一致，profile 切换确实重编译正确二进制。
3. 使用隔离的测试 OS 用户/临时 app 环境，实际验证同 worktree 的 default/v0、
   不同 v0 worktree、不同启动 cwd 的 identifier、单实例、Windows AppUserModelID 和 CLI 文件路由。
4. 验证真实 app config/data/local/log 与 WebView localStorage/IndexedDB 不串用；
   旧 override 不生效；两个产品对同一临时项目保存 settings/workspace/run/run.local 不互改。
5. 验证 launcher 安装/卸载不覆盖默认命令，实际窗口和后端 profile 对应。
   不操作真实用户凭据/设置；macOS/Linux 的 native storage、launcher 共存也未验收，
   特别是 macOS WKWebView 数据存储没有本轮平台运行证明。

本切片不包含正式命名/商标结论、完整产品打包/安装器共存、跨产品数据导入、真实设备操作、
Android APK/JDI 功能，也不宣称依赖 PR 或整个 v0 产品已通过验收。PR 仅供代码审查，
是否验收、转状态及合并由用户决定。
