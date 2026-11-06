//! A bad Gradle result must never hand an APK for a different target to ADB.
#![cfg(unix)]
use ide_build::android::build_run_artifact;
use ide_core::CancellationToken;
use std::{collections::BTreeMap, fs, os::unix::fs::PermissionsExt};

#[test]
fn accepts_only_one_local_apk_for_the_requested_variant() {
    let project = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(project.path()).unwrap();
    let cache = tempfile::tempdir().unwrap();
    fs::write(root.join("debug.apk"), "apk").unwrap();
    let wrapper = root.join("gradlew");
    fs::write(&wrapper, "#!/bin/sh\ncat result\n").unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
    let marker = "OPENANDROIDSTUDIO_RUN_ARTIFACT=";
    let record = r#"{"module":":app","variant":"demoDebug","applicationId":"dev.example.demo","apk":"debug.apk"}"#;
    let resolve =
        || build_run_artifact(&root, cache.path(), ":app", "demoDebug", &BTreeMap::new(), &CancellationToken::new());
    fs::write(root.join("result"), format!("{marker}{record}\n")).unwrap();
    assert_eq!(resolve().unwrap().application_id, "dev.example.demo");
    for bad in [
        record.replace("demoDebug", "fullDebug"),
        record.replace(":app", ":second"),
        record.replace("debug.apk", "../debug.apk"),
        record.replace("debug.apk", "missing.apk"),
        format!("{record}\n{marker}{record}"),
    ] {
        fs::write(root.join("result"), format!("{marker}{bad}\n")).unwrap();
        assert!(resolve().is_err(), "{bad}");
    }
    let external = tempfile::NamedTempFile::new().unwrap();
    std::os::unix::fs::symlink(external.path(), root.join("linked.apk")).unwrap();
    fs::write(root.join("result"), format!("{marker}{}", record.replace("debug.apk", "linked.apk"))).unwrap();
    assert!(resolve().is_err());
}
