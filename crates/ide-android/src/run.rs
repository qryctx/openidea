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

// adb shell arguments are passed to the device shell as one command. Quote the explicit
// component even for ordinary Java names: inner activity classes may contain a literal '$'.
pub fn launch_app(serial: &str, package: &str, cancel: &CancellationToken) -> IdeResult<LaunchedApp> {
    let adb = executable()?;
    if !valid_package(package) {
        return Err(IdeError::invalid("Invalid Android application ID"));
    }
    let resolved = query(
        &adb,
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
    let (component, process_name) = launcher(&resolved, package)?;
    let now = query(&adb, serial, &["shell", "date", "+%s"], cancel, "Reading device log time")?;
    let epoch = now.trim().parse::<u64>().map_err(|_| IdeError::unavailable("Invalid Android device clock"))?;
    let log_since = format!("{epoch}.000");
    let mut cmd = device_command(&adb, serial)?;
    cmd.args([
        "shell",
        "am",
        "start",
        "--user",
        "current",
        "-W",
        "-S",
        "-a",
        "android.intent.action.MAIN",
        "-c",
        "android.intent.category.LAUNCHER",
        "-n",
        &format!("'{component}'"),
    ]);
    let launch = checked(cmd, Duration::from_secs(60), cancel, "Starting launcher activity")?;
    if !started_activity(&launch) {
        return Err(IdeError::unavailable(format!("Activity did not start: {}", launch.trim())));
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let mut cmd = device_command(&adb, serial)?;
        cmd.args(["shell", "pidof", &process_name]);
        let out = process::run(cmd, QUERY, Some(cancel))?;
        if !out.success && !out.stderr.trim().is_empty() {
            return Err(IdeError::unavailable(format!("Reading launcher PID failed: {}", out.stderr.trim())));
        }
        let pids: Vec<_> = out.stdout.split_whitespace().collect();
        if let [pid] = pids.as_slice()
            && let Ok(pid) = pid.parse::<u32>()
            && pid > 0
        {
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            return Ok(LaunchedApp { component, pid, log_since });
        }
        if Instant::now() >= deadline {
            return Err(IdeError::unavailable(format!("Could not identify one running PID for {process_name}")));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
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
