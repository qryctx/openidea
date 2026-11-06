//! Install one AGP-produced APK and start its installed launcher on the selected device.
use super::{executable, process};
use ide_core::{CancellationToken, IdeError, IdeResult};
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

const QUERY: Duration = Duration::from_secs(15);

pub struct LaunchedApp {
    pub component: String,
    pub pid: u32,
    pub log_since: String,
}

fn device_command(adb: &Path, serial: &str) -> IdeResult<Command> {
    if serial.is_empty() || serial.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(IdeError::invalid("Select a connected Android device"));
    }
    let mut cmd = Command::new(adb);
    cmd.args(["-s", serial]);
    Ok(cmd)
}

fn checked(cmd: Command, timeout: Duration, cancel: &CancellationToken, action: &str) -> IdeResult<String> {
    let out = process::run(cmd, timeout, Some(cancel))?;
    if !out.success
        || out.stdout.lines().chain(out.stderr.lines()).any(|line| {
            let line = line.trim();
            line.starts_with("Error:") || line.starts_with("Error type ")
        })
    {
        let message = format!("{}\n{}", out.stderr, out.stdout);
        return Err(IdeError::unavailable(format!("{action} failed: {}", message.trim())));
    }
    Ok(out.stdout)
}

fn query(adb: &Path, serial: &str, args: &[&str], cancel: &CancellationToken, action: &str) -> IdeResult<String> {
    let mut cmd = device_command(adb, serial)?;
    cmd.args(args);
    checked(cmd, QUERY, cancel, action)
}

pub fn ensure_device(serial: &str, cancel: &CancellationToken) -> IdeResult<()> {
    let adb = executable()?;
    let state = query(&adb, serial, &["get-state"], cancel, "Checking device state")?;
    if state.trim() != "device" {
        return Err(IdeError::unavailable(format!("Android device is not ready: {}", state.trim())));
    }
    Ok(())
}

fn valid_package(s: &str) -> bool {
    s.contains('.')
        && s.split('.').all(|p| {
            p.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
                && p.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
        })
}

pub fn install_apk(serial: &str, apk: &Path, package: &str, cancel: &CancellationToken) -> IdeResult<()> {
    if !valid_package(package) {
        return Err(IdeError::invalid("AGP returned an invalid application ID"));
    }
    let mut cmd = device_command(&executable()?, serial)?;
    cmd.args(["install", "-r", "-t", "--user", "current"]).arg(apk);
    let out = checked(cmd, Duration::from_secs(300), cancel, "APK installation")?;
    if !out.lines().any(|line| line.trim() == "Success") {
        return Err(IdeError::unavailable(format!("APK installation did not succeed: {}", out.trim())));
    }
    Ok(())
}

// PackageManager dumps an ActivityInfo for the launcher selected on this device. It only prints
// processName when it differs from the application's default, including for activity aliases.
fn launcher(output: &str, package: &str) -> IdeResult<(String, String)> {
    let mut info = output.lines().skip_while(|l| l.trim() != "ActivityInfo:").skip(1).map(str::trim);
    let mut name = None;
    let mut owner = None;
    let mut process = None;
    for line in &mut info {
        if line == "ApplicationInfo:" {
            break;
        }
        if let Some(s) = line.strip_prefix("name=") {
            name = Some(s);
        }
        if let Some(s) = line.strip_prefix("packageName=") {
            owner = Some(s);
        }
        if let Some(s) = line.strip_prefix("processName=") {
            process = Some(s);
        }
    }
    if owner != Some(package) || !valid_package(package) {
        return Err(IdeError::unavailable(format!("No launchable MAIN/LAUNCHER activity for {package}")));
    }
    let name = name
        .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_alphanumeric() || matches!(c, '.' | '_' | '$')))
        .ok_or_else(|| IdeError::invalid("Invalid launcher activity from Android Package Manager"))?;
    let process = process.unwrap_or(package);
    if process.is_empty() || !process.chars().all(|c| c.is_alphanumeric() || matches!(c, '.' | '_' | ':')) {
        return Err(IdeError::invalid("Invalid launcher process from Android Package Manager"));
    }
    Ok((format!("{package}/{name}"), process.into()))
}

fn started_activity(output: &str) -> bool {
    let lines = || output.lines().map(str::trim);
    // Some ActivityManager results print both a warning that the start was rejected and Status: ok.
    lines().any(|s| s == "Status: ok") && !lines().any(|s| s.starts_with("Warning: Activity not started because"))
}

struct Launcher {
    component: String,
    process: String,
    log_since: String,
}

fn resolve_launcher(adb: &Path, serial: &str, package: &str, cancel: &CancellationToken) -> IdeResult<Launcher> {
    if !valid_package(package) {
        return Err(IdeError::invalid("Invalid Android application ID"));
    }
    let resolved = query(
        adb,
        serial,
        &[
            "shell",
            "cmd",
            "package",
            "resolve-activity",
            "--user",
            "current",
            "-a",
            "android.intent.action.MAIN",
            "-c",
            "android.intent.category.LAUNCHER",
            "-p",
            package,
        ],
        cancel,
        "Resolving launcher activity",
    )?;
    let (component, process) = launcher(&resolved, package)?;
    let now = query(adb, serial, &["shell", "date", "+%s"], cancel, "Reading device log time")?;
    let epoch = now.trim().parse::<u64>().map_err(|_| IdeError::unavailable("Invalid Android device clock"))?;
    Ok(Launcher { component, process, log_since: format!("{epoch}.000") })
}

fn start_launcher(
    adb: &Path,
    serial: &str,
    target: &Launcher,
    debug: bool,
    cancel: &CancellationToken,
) -> IdeResult<()> {
    let mut cmd = device_command(adb, serial)?;
    cmd.args(["shell", "am", "start", "--user", "current", "-S"]);
    if debug {
        // ART suspends all threads and emits VMStart before the Application is created.
        // -W would deadlock waiting for this Activity to draw before its debugger attaches.
        cmd.args(["-D", "--suspend"]);
    } else {
        cmd.arg("-W");
    }
    // adb shell joins arguments into a shell command: inner classes may contain a literal '$'.
    cmd.args([
        "-a",
        "android.intent.action.MAIN",
        "-c",
        "android.intent.category.LAUNCHER",
        "-n",
        &format!("'{}'", target.component),
    ]);
    let launch = checked(cmd, Duration::from_secs(60), cancel, "Starting launcher activity")?;
    if (!debug && !started_activity(&launch)) || (debug && launch.contains("Warning: Activity not started")) {
        return Err(IdeError::unavailable(format!("Activity did not start: {}", launch.trim())));
    }
    Ok(())
}

fn launcher_pid(adb: &Path, serial: &str, process_name: &str, cancel: &CancellationToken) -> IdeResult<Option<u32>> {
    let mut cmd = device_command(adb, serial)?;
    cmd.args(["shell", "pidof", process_name]);
    let out = process::run(cmd, QUERY, Some(cancel))?;
    if !out.success && !out.stderr.trim().is_empty() {
        return Err(IdeError::unavailable(format!("Reading launcher PID failed: {}", out.stderr.trim())));
    }
    let mut pids = out.stdout.split_whitespace();
    let pid = pids.next().and_then(|p| p.parse::<u32>().ok()).filter(|p| *p > 0);
    Ok(if pids.next().is_none() { pid } else { None })
}

fn wait_for_pid(adb: &Path, serial: &str, target: &Launcher, cancel: &CancellationToken) -> IdeResult<u32> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(pid) = launcher_pid(adb, serial, &target.process, cancel)? {
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            return Ok(pid);
        }
        if Instant::now() >= deadline {
            return Err(IdeError::unavailable(format!("Could not identify one running PID for {}", target.process)));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

pub fn launch_app(serial: &str, package: &str, cancel: &CancellationToken) -> IdeResult<LaunchedApp> {
    let adb = executable()?;
    let target = resolve_launcher(&adb, serial, package, cancel)?;
    start_launcher(&adb, serial, &target, false, cancel)?;
    let pid = wait_for_pid(&adb, serial, &target, cancel)?;
    Ok(LaunchedApp { component: target.component, pid, log_since: target.log_since })
}

/// Owns one suspended process and its ADB forward until its debugger ends. All methods block.
pub struct DebugLaunch {
    adb: std::path::PathBuf,
    serial: String,
    package: String,
    process: String,
    pub app: LaunchedApp,
    port: Option<u16>,
}

impl DebugLaunch {
    pub fn port(&self) -> u16 {
        self.port.expect("debug target published only after forwarding")
    }

    pub fn close(self) -> IdeResult<()> {
        let cleanup = CancellationToken::new();
        let remove = (|| {
            if let Some(port) = self.port {
                let local = format!("tcp:{port}");
                let remote = format!("jdwp:{}", self.app.pid);
                let list = query(&self.adb, &self.serial, &["forward", "--list"], &cleanup, "Listing debug forwards")?;
                if list
                    .lines()
                    .any(|l| l.split_whitespace().eq([self.serial.as_str(), local.as_str(), remote.as_str()]))
                {
                    query(
                        &self.adb,
                        &self.serial,
                        &["forward", "--remove", &local],
                        &cleanup,
                        "Removing debug forward",
                    )?;
                }
            }
            Ok(())
        })();
        let stop = (|| {
            if launcher_pid(&self.adb, &self.serial, &self.process, &cleanup)? == Some(self.app.pid) {
                query(
                    &self.adb,
                    &self.serial,
                    &["shell", "am", "force-stop", "--user", "current", &self.package],
                    &cleanup,
                    "Stopping debug application",
                )?;
            }
            Ok(())
        })();
        remove.and(stop)
    }
}

fn is_debuggable(package_dump: &str) -> bool {
    package_dump
        .lines()
        .filter_map(|line| line.trim().strip_prefix("flags=[").or_else(|| line.trim().strip_prefix("pkgFlags=[")))
        .any(|flags| flags.trim_end_matches(']').split_whitespace().any(|f| f == "DEBUGGABLE"))
}

pub fn launch_debug(serial: &str, package: &str, cancel: &CancellationToken) -> IdeResult<DebugLaunch> {
    let adb = executable()?;
    let target = resolve_launcher(&adb, serial, package, cancel)?;
    let installed =
        query(&adb, serial, &["shell", "dumpsys", "package", package], cancel, "Checking installed debug flags")?;
    if !is_debuggable(&installed) {
        return Err(IdeError::invalid(format!("Installed application {package} is not debuggable")));
    }
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    // Once Android accepts the start it must be possible to stop the waiting process, even if the
    // user closes the project between the start and pidof. This short ownership transfer is bounded.
    let ownership = CancellationToken::new();
    start_launcher(&adb, serial, &target, true, &ownership)?;
    let pid = wait_for_pid(&adb, serial, &target, &ownership)?;
    let mut session = DebugLaunch {
        adb,
        serial: serial.into(),
        package: package.into(),
        process: target.process,
        port: None,
        app: LaunchedApp { component: target.component, pid, log_since: target.log_since },
    };
    let result = (|| {
        let deadline = Instant::now() + Duration::from_secs(10);
        let remote = format!("jdwp:{pid}");
        let expected_pid = pid.to_string();
        loop {
            let mut cmd = device_command(&session.adb, serial)?;
            cmd.arg("jdwp");
            if process::wait_for_line(cmd, &expected_pid, deadline, cancel)? {
                break;
            }
            if Instant::now() >= deadline {
                return Err(IdeError::unavailable(format!(
                    "Android did not publish a debugger transport for PID {pid}"
                )));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        // tcp:0 is allocated by the adb server; never claim a port that another window already owns.
        let port = query(
            &session.adb,
            serial,
            &["forward", "--no-rebind", "tcp:0", &remote],
            &ownership,
            "Forwarding Android debugger port",
        )?;
        session.port = Some(
            port.trim()
                .parse::<u16>()
                .ok()
                .filter(|p| *p > 0)
                .ok_or_else(|| IdeError::unavailable("ADB did not assign a debugger port"))?,
        );
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        Ok(())
    })();
    if let Err(error) = result {
        session.close()?;
        return Err(error);
    }
    Ok(session)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_a_successful_activity_start() {
        assert!(started_activity("Status: ok\nActivity: dev.sample/.Launcher"));
        assert!(!started_activity("Status: timeout"));
        assert!(!started_activity(
            "Warning: Activity not started because the current activity is being kept for the user.\nStatus: ok"
        ));
    }

    #[test]
    fn selects_installed_launcher_and_its_process() {
        let output = "priority=0\n  ActivityInfo:\n    name=dev.sample.Entry$Alias\n    packageName=dev.sample.demo\n    processName=dev.sample.demo:ui\n    ApplicationInfo:\n      name=Other\n      processName=another";
        assert_eq!(
            launcher(output, "dev.sample.demo").unwrap(),
            ("dev.sample.demo/dev.sample.Entry$Alias".into(), "dev.sample.demo:ui".into())
        );
        assert!(launcher(output, "dev.sample.full").is_err());
        assert!(launcher("No activity found", "dev.sample.demo").is_err());
    }
}
