//! Exercise the adb command boundary without installing anything on a developer's connected devices.
#![cfg(unix)]
use ide_core::CancellationToken;
use std::{fs, os::unix::fs::PermissionsExt, path::Path, process::Command};

#[test]
fn binds_deployment_and_logcat_to_the_selected_transport() {
    // Set the fake adb for a child process, leaving the parent test process and real adb untouched.
    if let Some(dir) = std::env::var_os("OPENIDEA_TEST_RUN_ADB") {
        exercise(Path::new(&dir));
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let fake = dir.path().join("adb");
    fs::write(&fake, r#"#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$OPENIDEA_TEST_RUN_ADB/commands"
test "$1" = '-s' && test "$2" = 'selected' || exit 2
shift 2
case "$1 ${2:-}" in
  'get-state ') echo device ;;
  'install -r') if test -f "$OPENIDEA_TEST_RUN_ADB/conflict"; then
    echo 'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]' >&2; exit 1
    else echo Success; fi ;;
  'shell cmd') printf '%s\n' '  ActivityInfo:' '    name=sample.Launcher$Alias' '    packageName=dev.sample.demo' '    processName=dev.sample.demo:ui' ;;
  'shell date') echo 1800000000 ;;
  'shell am') if test -f "$OPENIDEA_TEST_RUN_ADB/am-error"; then echo "Error: start refused" >&2; fi; echo 'Status: ok' ;;
  'shell pidof') test "$3" = 'dev.sample.demo:ui'; echo 431 ;;
  'logcat -v') echo '11-06 10:00:00.000  432  432 I Other   : namesake'; echo '11-06 10:00:00.000  431  432 I Sample  : startup' ;;
  *) exit 3 ;;
esac
"#).unwrap();
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
    let status = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "binds_deployment_and_logcat_to_the_selected_transport"])
        .env("OPENIDEA_TEST_RUN_ADB", dir.path())
        .env("OPENIDEA_ADB", &fake)
        .status()
        .unwrap();
    assert!(status.success());
}

fn exercise(dir: &Path) {
    let cancel = CancellationToken::new();
    let apk = dir.join("example.apk");
    fs::write(&apk, "sample").unwrap();
    ide_android::ensure_device("selected", &cancel).unwrap();
    ide_android::install_apk("selected", &apk, "dev.sample.demo", &cancel).unwrap();
    let app = ide_android::launch_app("selected", "dev.sample.demo", &cancel).unwrap();
    assert_eq!(app.component, "dev.sample.demo/sample.Launcher$Alias");
    assert_eq!(app.pid, 431);
    assert_eq!(app.log_since, "1800000000.000");
    let mut lines = vec![];
    ide_android::scoped_logcat("selected", false, Some(app.pid), Some(&app.log_since), &cancel, &mut |batch| {
        lines.extend(batch)
    })
    .unwrap();
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].pid, 431);
    assert_eq!(lines[0].message, "startup");
    fs::write(dir.join("am-error"), "").unwrap();
    assert!(ide_android::launch_app("selected", "dev.sample.demo", &cancel).is_err());
    fs::write(dir.join("conflict"), "").unwrap();
    let error = ide_android::install_apk("selected", &apk, "dev.sample.demo", &cancel).unwrap_err();
    assert!(error.message.contains("INSTALL_FAILED_UPDATE_INCOMPATIBLE"));
    let trace = fs::read_to_string(dir.join("commands")).unwrap();
    assert!(trace.lines().all(|cmd| cmd.starts_with("-s selected ")));
    assert!(trace.contains("logcat -v threadtime --pid=431 -T 1800000000.000"));
    assert!(!trace.contains("uninstall") && !trace.contains("logcat -c"));
    cancel.cancel();
    assert!(ide_android::install_apk("selected", &apk, "dev.sample.demo", &cancel).is_err());
    assert_eq!(trace, fs::read_to_string(dir.join("commands")).unwrap());
}
