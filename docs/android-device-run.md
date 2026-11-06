# 在真机上运行选中的 Android 变体

1. 连接已开启 USB 调试的手机，解锁并接受这台电脑的调试授权。在 OpenAndroidStudio 中打开并信任[双模块示例](../examples/android-variants)的 Gradle 根目录。本机需要项目要求的 JDK、Android SDK、Platform Tools 和可执行的 Gradle Wrapper。
2. 在状态栏的 **Android reference variant** 中选 `:app` 的 `demoDebug`。工具栏会显示 `:app · demoDebug`。只有一台在线真机时 IDE 会选中它。有多台时，在 Run 旁边的设备菜单中选择目标设备。设备掉线后可在菜单中刷新。
3. 点工具栏绿色 **Run**，或按 **⌃R**。IDE 保存编辑、通过 Wrapper 构建所选变体，把 APK 安装到选中设备的当前 Android 用户，解析并启动该包的 launcher Activity。工具栏依次显示构建、安装、启动和已启动；失败时可在状态提示或通知中查看原因。
4. Logcat 会打开并显示包名和启动进程的 PID。输入 `tag:OpenAndroidStudioRun` 即可定位示例的启动行。切换到 `fullDebug`，在同一台手机上再次点 Run。两种 flavor 有独立的应用 ID，所以可以同时安装。

## 双模块示例的验收

| 选中变体    | Android 安装包名          | 手机页面第三行                                |
| ----------- | ------------------------- | --------------------------------------------- |
| `demoDebug` | `dev.openide.sample.demo` | `Demo: Hello from Java! / Hello from Kotlin!` |
| `fullDebug` | `dev.openide.sample.full` | `Full: Hello from Java! / Hello from Kotlin!` |

手机页面前两行分别显示实际变体和运行时包名。第三行由应用的 flavor 源码调用 `:contract` 中的 Java 和 Kotlin 实现生成。两次启动日志都采用 `launch variant=<变体> package=<包名> greeting=<页面第三行>`，tag 为 `OpenAndroidStudioRun`。

2026-11-06 在同一台 USB Pixel 6（Android 17，API 37）上完成三轮 demo → full。前两轮分别验证开发版的首次安装和覆盖安装。最后从 macOS 签名发行包的绿色 Run 按钮启动，Demo 的 PID 为 29072，Full 的 PID 为 29396。选中 Full、尚未点击 Run 时，Demo 日志和 PID 已清空。两次均独立核对了手机前台包、三行页面文字、IDE 与手机的启动日志，以及本机与已安装 APK 的 SHA-256。[逐项验收记录](validation/android-device-run.json)

签名应用在本机占用 138.31 MiB，比上一版工程同步包增加 100 KiB。包内有零份 source map，337 份匹配映射单独归档。两份示例 APK 均为 879,264 字节。

## 复验

在仓库根目录启动 `pnpm dev:app`。在另一个交互式终端执行下面的命令，把设备序列号改为这台手机在 `adb devices` 中的值。

```sh
ANDROID_SERIAL=<设备序列号> node android-support/verify-desktop.mjs /tmp/openandroidstudio-run-report --device-run
```

驱动会打开一份干净的示例副本、通过桌面控件选变体并点 Run。每次暂停时先检查手机上的页面，再按 Enter。报告包含桌面截图、前台组件、进程、两端 APK 摘要和 Logcat 结果；手机截图需在每次暂停时另存。自动测试不会清除手机日志或卸载应用。

## 当前范围

- Run 使用 AGP 提供的单一通用 APK，校验 APK manifest 的包名后再安装。带过滤条件的 split APK、动态功能模块和 AAB 部署尚待支持。
- 更新安装保留应用数据。签名冲突会报告安装失败；用户可以据此选择处理现有安装。
- 切换应用模块、变体、设备或关闭工程会结束旧 Run 的日志订阅。手动打开的整机 Logcat 可以独立使用。
- 自动 Logcat 跟随这次启动的 PID。应用重启并换 PID 后，再点 Run 即可重新连接。需要在启动时停住或单步查看代码时，使用工具栏的 Debug。[Android 真机 Debug](android-device-debug.md)
