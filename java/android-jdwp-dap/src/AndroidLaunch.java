import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Owns only the sample app started by this launch and its single JDWP forward. */
final class AndroidLaunch {
    private final Path adb;
    private final String serial, packageName;
    private String component, forward;
    private boolean started;

    private AndroidLaunch(Path adb, String serial, String packageName, String component) {
        this.adb = adb;
        this.serial = serial;
        this.packageName = packageName;
        this.component = component;
    }

    static AndroidLaunch create(Map<String, Object> args) throws IOException {
        Path path = Path.of(AndroidDap.stringArgument(args.get("adbPath"), "adbPath"));
        if (!path.isAbsolute()) throw new IllegalArgumentException("adbPath must be absolute");
        path = path.toRealPath();
        if (!Files.isRegularFile(path) || !Files.isExecutable(path))
            throw new IllegalArgumentException("adbPath must be an executable file");
        String serial = AndroidDap.stringArgument(args.get("serial"), "serial");
        if (!serial.matches("[A-Za-z0-9._:-]+") || serial.startsWith("emulator-"))
            throw new IllegalArgumentException("serial must identify a physical device");
        String name = AndroidDap.stringArgument(args.get("packageName"), "packageName");
        if (!name.matches("dev\\.openandroid\\.samples\\.[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)*"))
            throw new IllegalArgumentException("Only dev.openandroid.samples.* packages are allowed");
        String component = args.get("component") == null ? null
                : normalizeComponent(AndroidDap.stringArgument(args.get("component"), "component"), name);
        return new AndroidLaunch(path, serial, name, component);
    }

    private static String normalizeComponent(String component, String name) {
        String prefix = name + "/";
        if (!component.startsWith(prefix)) throw new IllegalArgumentException("component must belong to packageName");
        String activity = component.substring(prefix.length());
        if (!activity.matches("\\.?[A-Za-z_$][A-Za-z0-9_$]*(\\.[A-Za-z_$][A-Za-z0-9_$]*)*"))
            throw new IllegalArgumentException("Invalid component activity");
        if (activity.startsWith(".")) activity = name + activity;
        else if (!activity.contains(".")) activity = name + "." + activity;
        return prefix + activity;
    }

    int start() throws IOException {
        String state = run("get-state");
        if (!state.equals("device")) throw new IOException("Device is not online: " + state);
        if (run("shell", "getprop", "ro.kernel.qemu").equals("1"))
            throw new IOException("Emulators are outside this launch contract");
        String installed = execute(true, "shell", "pm", "path", packageName);
        if (installed.isEmpty()) throw new IOException("App is not installed: " + packageName);
        if (!installed.lines().allMatch(line -> line.startsWith("package:")))
            throw new IOException("Cannot inspect installed app: " + installed);
        if (component == null) {
            String queried = run("shell", "cmd", "package", "query-activities", "--brief", "--components",
                    "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-p", packageName);
            var candidates = components(queried);
            if (candidates.size() != 1) throw new IOException("Expected one MAIN/LAUNCHER component, found " + candidates.size());
            var resolved = components(run("shell", "cmd", "package", "resolve-activity", "--brief",
                    "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-p", packageName));
            if (resolved.size() != 1 || !resolved.equals(candidates))
                throw new IOException("Launcher query and resolve-activity disagree");
            component = candidates.iterator().next();
        }
        started = true;
        String output = run("shell", "am", "start", "-S", "-D", "-n", component);
        if (output.contains("Error") || output.contains("Exception") || !output.contains("Starting:"))
            throw new IOException("Cannot start debug app: " + output);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        String pid;
        while (true) {
            pid = pid(deadline, "Sample pid did not become ready within 10 seconds");
            if (!pid.isEmpty()) break;
            if (System.nanoTime() >= deadline) throw new IOException("Sample pid did not become ready within 10 seconds");
            sleep();
        }
        if (!pid.matches("[0-9]+")) throw new IOException("Expected exactly one app process: " + pid);
        String port = run("forward", "tcp:0", "jdwp:" + pid);
        if (!port.matches("[0-9]+")) throw new IOException("adb did not report its allocated forward port: " + port);
        int number = Integer.parseInt(port);
        if (number < 1 || number > 65535) throw new IOException("adb reported an invalid forward port");
        forward = "tcp:" + port;
        return number;
    }

    private Set<String> components(String output) {
        var result = new LinkedHashSet<String>();
        for (String line : output.lines().map(String::trim).toList())
            if (line.startsWith(packageName + "/")) result.add(normalizeComponent(line, packageName));
        return result;
    }

    private String pid(long deadline, String timeoutMessage) throws IOException {
        long remaining = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime());
        if (remaining <= 0) throw new IOException(timeoutMessage);
        try { return execute(true, remaining, "shell", "pidof", packageName); }
        catch (IOException error) {
            if (System.nanoTime() >= deadline)
                throw new IOException(timeoutMessage + ": " + error.getMessage(), error);
            throw error;
        }
    }

    void cleanup(boolean stop) throws IOException {
        IOException failure = null;
        if (stop && started) {
            try {
                run("shell", "am", "force-stop", packageName);
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
                while (!pid(deadline, "App still has a process after force-stop").isEmpty()) {
                    if (System.nanoTime() >= deadline) throw new IOException("App still has a process after force-stop");
                    sleep();
                }
                started = false;
            } catch (IOException error) { failure = error; }
        }
        if (forward != null) {
            try {
                run("forward", "--remove", forward);
                forward = null;
            } catch (IOException error) {
                if (failure == null) failure = error;
                else failure.addSuppressed(error);
            }
        }
        if (!stop) started = false;
        if (failure != null) throw failure;
    }

    boolean isClean() { return forward == null && !started; }

    private static void sleep() throws IOException {
        try { Thread.sleep(100); }
        catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IOException("Android lifecycle interrupted", error);
        }
    }

    private String run(String... args) throws IOException { return execute(false, args); }

    private String execute(boolean absentAllowed, String... args) throws IOException {
        return execute(absentAllowed, 30000, args);
    }

    private String execute(boolean absentAllowed, long timeoutMs, String... args) throws IOException {
        var command = new ArrayList<String>(List.of(adb.toString(), "-s", serial));
        command.addAll(List.of(args));
        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        var output = new ByteArrayOutputStream();
        var readError = new AtomicReference<IOException>();
        Thread reader = new Thread(() -> {
            try (InputStream stream = process.getInputStream()) { stream.transferTo(output); }
            catch (IOException error) { readError.set(error); }
        }, "adb-output");
        reader.start();
        boolean completed;
        try {
            completed = process.waitFor(timeoutMs, TimeUnit.MILLISECONDS);
            if (!completed) {
                process.destroyForcibly();
                process.waitFor();
            }
            reader.join();
        } catch (InterruptedException error) {
            process.destroyForcibly();
            Thread.currentThread().interrupt();
            throw new IOException("adb " + args[0] + " interrupted", error);
        }
        String text = output.toString(StandardCharsets.UTF_8).strip().replace(serial, "<test-phone>");
        // Preserve an acknowledged allocation even if adb later fails or adds malformed output.
        if (args.length > 1 && args[0].equals("forward") && args[1].equals("tcp:0")) {
            for (String line : text.lines().toList()) {
                if (line.matches("[0-9]{1,5}") && Integer.parseInt(line) > 0 && Integer.parseInt(line) <= 65535) {
                    forward = "tcp:" + line;
                    break;
                }
            }
        }
        if (!completed) throw new IOException("adb " + args[0] + " timed out");
        if (readError.get() != null) throw readError.get();
        int code = process.exitValue();
        if (code != 0 && !(absentAllowed && code == 1 && text.isEmpty()))
            throw new IOException("adb " + args[0] + " failed (" + code + "): " + text);
        return text;
    }
}
