# M2 应用内构建与运行（阶段性记录）

## 已实现

- 新增 Android 工具窗口：可选择物理真机，输入 Gradle 模块（默认 `app`）与变体（默认 `debug`），使用工程自带 wrapper 运行 `:<模块>:assemble<Variant>`。
- 从对应模块的 `output-metadata.json` 中按 `variantName` 解析单 APK 与 `applicationId`，随后执行设备限定的安装、Launcher 解析和启动；再次运行会先结束该包的旧进程。
- Logcat 按启动后取得的应用 PID 过滤。停止构建会显示“已请求取消”“Gradle 构建已停止”“Gradle 进程清理完成”不同阶段；停止应用只对所选设备执行 `am force-stop`。
- v0 工具窗口可查看/编辑现有 JDK、Android SDK 或 adb 路径；不自动下载工具链。中文/非 ASCII 工程路径默认给出 AGP 诊断，只有用户明确勾选后才传入 `-Pandroid.overridePathCheck=true`。
- v0 白名单加入 Android 工具窗口。设备列表隐藏模拟器，保留未授权/离线设备状态；检测到多台在线真机时要求用户选择。

## 已运行的验证

| 命令                                                                                                                                                                                              | 结果                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `pnpm.cmd exec vitest run src/features/run/androidRunState.test.ts src/platform/locales/textCatalog.test.ts`                                                                                      | 通过：24 项通过，6 项跳过 |
| `pnpm.cmd exec oxlint src/features/run/AndroidBuildRun.tsx src/features/run/androidRunState.ts src/features/run/androidRunState.test.ts src/features/run/index.ts src/platform/productProfile.ts` | 通过                      |
| `cargo fmt --all -- --check`                                                                                                                                                                      | 通过                      |
| `pnpm.cmd exec oxfmt --check`（本次修改的前端文件）                                                                                                                                               | 通过                      |
| `git diff --check`                                                                                                                                                                                | 通过                      |

## 阻塞与待验收

`cargo test -p ide-android --lib` 因找不到 MSVC `link.exe` 在编译依赖时退出（101），Rust 单元测试未实际运行。`pnpm.cmd typecheck` 被尚未生成的 Tauri IPC 绑定阻断，提示新 Android 命令和类型尚未出现在 `src/bindings.ts`；不得手改生成文件，需在工具链可用后运行 `pnpm gen:bindings`，再重跑类型检查。G0 最新状态为 Build Tools 安装器仍在运行、VS 实例不完整，`link.exe` 与 Windows SDK 均未验证；尚不能启动原生桌面应用。

尚未启动原生桌面应用，也未执行真机 F1/F2/F3 的构建、安装、启动、应用专属 Logcat、重复运行替换、运行中停止和 Gradle 取消验收。协调者已确认调试会话卸载样例并释放真机；本会话因缺少 `link.exe` 未启动桌面应用，未在设备上执行操作，**设备当前保持已释放状态**。本记录不包含设备序列号。**当前不能据此判定 M2 完成。**
