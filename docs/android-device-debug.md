# 在 Android 真机上打启动断点

1. 打开并信任[双模块示例](../examples/android-variants)，连接已授权 USB 调试的手机。在状态栏选择 `:app · demoDebug`，在工具栏选择该手机。
2. 打开 `libraries/contracts/src/main/java/dev/openide/sample/contract/JavaGreeting.java`，点击 `return "Hello from Java";` 所在行的行号设置断点。
3. 点击工具栏的 **Debug**。首次需要安装调试适配器时，按 IDE 的 Install 提示安装 **Kotlin Debug Adapter**，完成后再次点 Debug。可在 Settings → Languages & Frameworks → Language Servers 中查看安装状态。同一适配器处理 Java 和 Kotlin。
4. 调试器停下后，在 **Debug → Threads & Variables** 查看调用栈和当前源码行。点 **Resume** 完成页面启动，点 **Stop** 结束会话。去掉 Java 断点并切到 `fullDebug`。
5. 打开 `libraries/contracts/src/main/kotlin/dev/openide/sample/contract/KotlinGreeting.kt`，在 `val greeting = "Hello from Kotlin"` 上设断点，点 **Debug**。停下后点 **Step Over**，检查当前行变成 `return greeting`，局部变量 `greeting` 显示 `Hello from Kotlin`。调用者应来自 `app/src/full`。

Debug 需要可调试的单一 APK、可用的 JDK，以及支持 `am start --suspend` 的 Android 系统。本版使用设备的启动挂起能力，让调试器在应用执行启动代码前绑定断点。IDE 只映射选中应用模块和变体的已索引 Java/Kotlin 源文件。断点、调用栈和单步沿用桌面调试窗口。停止调试会清理本次会话的端口转发，并终止本次启动的目标进程。真机调试覆盖应用的托管进程。[Android 官方调试说明](https://developer.android.com/studio/debug) · [Kotlin Debug Adapter 源码与许可](https://github.com/fwcd/kotlin-debug-adapter)

在本仓库运行 `pnpm dev:app`，从另一个终端执行以下命令可复验两个变体。在输出目录中检查逐次 JSON 和断点、单步截图。驱动通过桌面 Debug 按钮启动，独立读取手机上的 PID、端口和应用日志。

```sh
ANDROID_SERIAL=<设备序列号> node android-support/verify-desktop.mjs /tmp/openandroidstudio-debug --device-debug
```

在同一台 Pixel 6 上，`demoDebug` 首次进入 Java 的 `message()` 就停在第 5 行。切到 `fullDebug` 后的调用栈从 `KotlinGreeting.message()` 回到 `app/src/full` 的 `JavaCaller.kotlinMessage()`、`flavorGreeting()` 和 `MainActivity.onCreate()`。单步从第 5 行移到第 6 行，两次暂停都只计一次命中。[逐项验收记录](validation/android-device-debug.json)

签名 macOS 应用也通过同一轮验收。首次通过 IDE 提示安装了 Kotlin Debug Adapter 0.4.4，之后两次直接点 Debug。Demo 的 PID 为 3693，Full 的 PID 为 4087。每个进程暂停期间各有一条调用前日志，点 Resume 后才出现页面完成日志，Stop 后两次对应转发都已释放。应用本机占用 138.45 MiB，比前一版增加 144 KiB。调试适配器另占 9.41 MiB。

本机首次恢复已有窗口时，工程信任弹窗出现在另一窗口后方，可用 macOS 的 Window → Bring All to Front 显示。安装适配器后，通知面板可能还保留第一次尝试的失败通知，当前会话状态见工具栏与 Debug 面板。
