//! The minimal single-application Android workflow: wrapper build, metadata
//! lookup, device install, launcher resolution, and launch.

use crate::process;
use ide_core::{CancellationToken, IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::io::{BufRead, BufReader, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AndroidRunEvent {
    pub phase: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AndroidRunResult {
    pub application_id: String,
    pub apk: PathBuf,
    pub activity: String,
    pub pid: i32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AndroidEnvironment {
    pub java_home: Option<PathBuf>,
    pub sdk_root: Option<PathBuf>,
    pub adb_path: Option<PathBuf>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutputMetadata {
    variant_name: String,
    application_id: String,
    elements: Vec<OutputElement>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutputElement {
    output_file: String,
}

fn emit(on_event: &mut dyn FnMut(AndroidRunEvent), phase: &str, message: impl Into<String>) {
    on_event(AndroidRunEvent { phase: phase.to_owned(), message: message.into() });
}

/// Existing local toolchain paths for the Android build view.
pub fn environment() -> AndroidEnvironment {
    let java_home = std::env::var_os("JAVA_HOME")
        .map(PathBuf::from)
        .or_else(|| which::which(if cfg!(windows) { "java.exe" } else { "java" }).ok().map(java_home_from_path));
    let adb_path = crate::adb_executable();
    let sdk_root = adb_path.as_deref().and_then(|adb| sdk_root(None, adb));
    AndroidEnvironment { java_home, sdk_root, adb_path }
}

fn java_home_from_path(path: PathBuf) -> PathBuf {
    let path = path.canonicalize().unwrap_or(path);
    if path.file_name().is_some_and(|name| name == "java" || name == "java.exe") {
        path.parent().and_then(Path::parent).unwrap_or(path.as_path()).to_path_buf()
    } else {
        path
    }
}

fn is_compatible_jdk(home: &Path) -> bool {
    ["java", "javac"].iter().all(|tool| {
        home.join("bin").join(if cfg!(windows) { format!("{tool}.exe") } else { (*tool).to_owned() }).is_file()
    })
}

pub(crate) fn adb_executable(sdk_or_adb: Option<&Path>) -> IdeResult<PathBuf> {
    if let Some(path) = sdk_or_adb.filter(|path| !path.as_os_str().is_empty()) {
        let explicit = if path.is_file() {
            path.to_path_buf()
        } else {
            path.join("platform-tools").join(if cfg!(windows) { "adb.exe" } else { "adb" })
        };
        return explicit.is_file().then_some(explicit).ok_or_else(|| {
            IdeError::unavailable(format!("adb was not found at the selected SDK/adb path: {}", path.display()))
        });
    }
    crate::executable()
}

fn sdk_root(sdk_or_adb: Option<&Path>, adb: &Path) -> Option<PathBuf> {
    if let Some(selected) = sdk_or_adb.filter(|path| !path.as_os_str().is_empty()) {
        if !selected.is_file() {
            return Some(selected.to_path_buf());
        }
        let platform_tools = selected.parent()?;
        if platform_tools.file_name().is_some_and(|name| name == "platform-tools") {
            return platform_tools.parent().map(Path::to_path_buf);
        }
        return None;
    }
    adb.parent()
        .filter(|platform_tools| platform_tools.file_name().is_some_and(|name| name == "platform-tools"))
        .and_then(Path::parent)
        .map(Path::to_path_buf)
}

fn module_path(module: &str) -> IdeResult<PathBuf> {
    let parts: Vec<_> = module.trim_matches(':').split(':').collect();
    if parts.is_empty()
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
    {
        return Err(IdeError::invalid("Android module must be a Gradle path such as app or :feature:app"));
    }
    Ok(parts.iter().collect())
}

fn task_name(variant: &str) -> IdeResult<String> {
    if variant.is_empty() || !variant.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(IdeError::invalid("Android variant must contain only letters and numbers"));
    }
    let mut chars = variant.chars();
    let first = chars.next().expect("non-empty variant");
    Ok(format!("assemble{}{}", first.to_ascii_uppercase(), chars.as_str()))
}

fn gradle_task(module: &str, variant: &str) -> IdeResult<String> {
    module_path(module)?;
    Ok(format!(":{}:{}", module.trim_matches(':'), task_name(variant)?))
}

fn contains_non_ascii(path: &Path) -> bool {
    path.as_os_str().to_string_lossy().chars().any(|c| !c.is_ascii())
}

fn build_apk_dir(root: &Path, module: &Path) -> PathBuf {
    root.join(module).join("build").join("outputs").join("apk")
}

/// Reads AGP's generated metadata; it never guesses APK names from the build script.
pub fn apk_from_metadata(root: &Path, module: &str, variant: &str) -> IdeResult<(String, PathBuf)> {
    let module = module_path(module)?;
    let output_root = build_apk_dir(root, &module);
    if !output_root.is_dir() {
        return Err(IdeError::unavailable(format!("APK output directory not found: {}", output_root.display())));
    }
    let mut files = Vec::new();
    collect_metadata(&output_root, &mut files)?;
    for file in files {
        let text = std::fs::read_to_string(&file)?;
        let metadata: OutputMetadata = serde_json::from_str(&text)
            .map_err(|e| IdeError::invalid(format!("Invalid Android output metadata {}: {e}", file.display())))?;
        if !metadata.variant_name.eq_ignore_ascii_case(variant) {
            continue;
        }
        if metadata.elements.len() != 1 {
            return Err(IdeError::unavailable(format!(
                "Variant {} produced multiple APK outputs; split APKs are not supported",
                metadata.variant_name
            )));
        }
        let relative = Path::new(&metadata.elements[0].output_file);
        if relative.is_absolute()
            || relative
                .components()
                .any(|component| matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
        {
            return Err(IdeError::invalid("Android output metadata contains an unsafe APK path"));
        }
        let apk = file.parent().unwrap_or(&output_root).join(relative);
        if apk.extension().and_then(|ext| ext.to_str()) != Some("apk") || !apk.is_file() {
            return Err(IdeError::unavailable(format!("APK listed by metadata was not found: {}", apk.display())));
        }
        return Ok((metadata.application_id, apk));
    }
    Err(IdeError::unavailable(format!(
        "No output-metadata.json for Android variant '{variant}' under {}",
        output_root.display()
    )))
}

fn collect_metadata(dir: &Path, out: &mut Vec<PathBuf>) -> IdeResult<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            collect_metadata(&entry.path(), out)?;
        } else if kind.is_file() && entry.file_name() == "output-metadata.json" {
            out.push(entry.path());
        }
    }
    out.sort();
    Ok(())
}

fn run_gradle(
    root: &Path,
    task: &str,
    override_path_check: bool,
    java_home: Option<&Path>,
    android_sdk: Option<&Path>,
    cancel: &CancellationToken,
    on_event: &mut dyn FnMut(AndroidRunEvent),
) -> IdeResult<()> {
    let wrapper_name = if cfg!(windows) { "gradlew.bat" } else { "gradlew" };
    let wrapper = root.join(wrapper_name);
    if !wrapper.is_file() {
        return Err(IdeError::unavailable(format!(
            "This project has no Gradle wrapper ({wrapper_name}); Android builds must use the project's wrapper"
        )));
    }
    let mut args = vec!["--console=plain".to_owned(), task.to_owned()];
    if override_path_check {
        args.push("-Pandroid.overridePathCheck=true".to_owned());
    }
    emit(on_event, "build-started", format!("{} {}", wrapper.display(), args.join(" ")));
    let active_java_home = java_home
        .map(Path::to_path_buf)
        .or_else(|| std::env::var_os("JAVA_HOME").map(PathBuf::from))
        .or_else(|| which::which(if cfg!(windows) { "java.exe" } else { "java" }).ok().map(java_home_from_path));
    if let Some(home) = active_java_home {
        if !is_compatible_jdk(&home) {
            return Err(IdeError::unavailable(format!(
                "JDK is missing or incompatible at {} (expected bin/java and bin/javac). Enter an existing JDK path in the Android tool window; the IDE will not install one.",
                home.display()
            )));
        }
    } else {
        return Err(IdeError::unavailable(
            "No JDK was detected. Enter an existing JDK path in the Android tool window; the IDE will not install one.",
        ));
    }
    ide_android_command(&wrapper, &args, root, java_home, android_sdk, cancel, on_event)
}

fn ide_android_command(
    program: &Path,
    args: &[String],
    cwd: &Path,
    java_home: Option<&Path>,
    android_sdk: Option<&Path>,
    cancel: &CancellationToken,
    on_event: &mut dyn FnMut(AndroidRunEvent),
) -> IdeResult<()> {
    let env = std::collections::BTreeMap::new();
    let encoding = ide_core::output_encoding::fix(
        &program.to_string_lossy(),
        args,
        &env,
        |key| std::env::var(key).ok(),
        "UTF-8",
        cfg!(windows),
    );
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .envs(encoding.env.iter().map(|(key, value)| (key, value)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(java_home) = java_home {
        command.env("JAVA_HOME", java_home);
    }
    if let Some(android_sdk) = android_sdk {
        command.env("ANDROID_HOME", android_sdk).env("ANDROID_SDK_ROOT", android_sdk);
    }
    ide_core::process::prepare(ide_core::process::own_group(&mut command));
    let mut child = command
        .spawn()
        .map_err(|e| IdeError::unavailable(format!("Cannot start Gradle wrapper {}: {e}", program.display())))?;
    let (tx, rx) = mpsc::channel::<String>();
    let pump = |stream: Box<dyn Read + Send>, tx: mpsc::Sender<String>| {
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stream);
            let mut bytes = Vec::new();
            loop {
                bytes.clear();
                match reader.read_until(b'\n', &mut bytes) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let line = ide_core::output_encoding::decode_tool_output(&bytes);
                        if tx.send(line.trim_end_matches(['\r', '\n']).to_owned()).is_err() {
                            break;
                        }
                    }
                }
            }
        })
    };
    let stdout = child.stdout.take().map(|stream| pump(Box::new(stream), tx.clone()));
    let stderr = child.stderr.take().map(|stream| pump(Box::new(stream), tx.clone()));
    let readers = [stdout, stderr];
    drop(tx);
    let mut exit = None;
    loop {
        if cancel.is_cancelled() {
            ide_core::process::kill_tree(&mut child);
            return Err(IdeError::cancelled());
        }
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(line) if encoding.notice.as_ref() == Some(&line) => {}
            Ok(line) => emit(on_event, "output", line),
            Err(mpsc::RecvTimeoutError::Timeout) => exit = child.try_wait()?.or(exit),
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    for reader in readers.into_iter().flatten() {
        let _ = reader.join();
    }
    let status = match exit {
        Some(status) => status,
        None => child.wait()?,
    };
    if status.success() {
        Ok(())
    } else {
        Err(IdeError::unavailable(format!("Gradle build failed with exit status {status}")))
    }
}

fn adb_run(
    serial: &str,
    args: &[String],
    sdk_or_adb: Option<&Path>,
    cancel: Option<&CancellationToken>,
) -> IdeResult<String> {
    let mut command = Command::new(adb_executable(sdk_or_adb)?);
    command.arg("-s").arg(serial).args(args);
    let out = process::run(command, Duration::from_secs(60), cancel)?;
    if !out.success {
        let detail = [out.stdout.trim(), out.stderr.trim()].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>();
        return Err(IdeError::unavailable(if detail.is_empty() {
            format!("adb {} failed", args.join(" "))
        } else {
            format!("adb {} failed: {}", args.join(" "), detail.join("\n"))
        }));
    }
    Ok(out.stdout)
}

/// Build, install, replace any existing app process, and start its launcher.
pub fn build_install_launch(
    root: &Path,
    module: &str,
    variant: &str,
    serial: &str,
    sdk_or_adb: Option<&Path>,
    java_home: Option<&Path>,
    override_path_check: bool,
    cancel: &CancellationToken,
    on_event: &mut dyn FnMut(AndroidRunEvent),
) -> IdeResult<AndroidRunResult> {
    let task = gradle_task(module, variant)?;
    if contains_non_ascii(root) && !override_path_check {
        return Err(IdeError::invalid(
            "AGP rejects project paths containing non-ASCII characters. Explicitly enable 'android.overridePathCheck' to retry; this option is not enabled automatically.",
        ));
    }
    let adb = adb_executable(sdk_or_adb)?;
    let android_sdk = sdk_root(sdk_or_adb, &adb);
    let mut build_complete = false;
    let result = (|| {
        run_gradle(root, &task, override_path_check, java_home, android_sdk.as_deref(), cancel, on_event)?;
        build_complete = true;
        let (application_id, apk) = apk_from_metadata(root, module, variant)?;
        emit(on_event, "installing", format!("Installing {} on selected device", apk.display()));
        adb_run(
            serial,
            &["install".into(), "-r".into(), apk.to_string_lossy().into_owned()],
            Some(&adb),
            Some(cancel),
        )?;
        emit(on_event, "launching", format!("Resolving launcher for {application_id}"));
        let resolved = adb_run(
            serial,
            &[
                "shell".into(),
                "cmd".into(),
                "package".into(),
                "resolve-activity".into(),
                "--brief".into(),
                "-c".into(),
                "android.intent.category.LAUNCHER".into(),
                application_id.clone(),
            ],
            Some(&adb),
            Some(cancel),
        )?;
        let mut activities = resolved.lines().map(str::trim).filter(|line| line.contains('/')).collect::<Vec<_>>();
        activities.dedup();
        if activities.len() != 1 {
            return Err(IdeError::unavailable(format!(
                "Expected one LAUNCHER activity for {application_id}, found {}",
                activities.len()
            )));
        }
        let activity = activities[0].to_owned();
        adb_run(
            serial,
            &["shell".into(), "am".into(), "force-stop".into(), application_id.clone()],
            Some(&adb),
            Some(cancel),
        )?;
        adb_run(
            serial,
            &["shell".into(), "am".into(), "start".into(), "-W".into(), "-n".into(), activity.clone()],
            Some(&adb),
            Some(cancel),
        )?;
        let pids =
            adb_run(serial, &["shell".into(), "pidof".into(), application_id.clone()], Some(&adb), Some(cancel))?;
        let pid =
            pids.split_whitespace().next().and_then(|pid| pid.parse::<i32>().ok()).ok_or_else(|| {
                IdeError::unavailable(format!("Could not find the running process for {application_id}"))
            })?;
        emit(on_event, "running", format!("{application_id} started"));
        Ok(AndroidRunResult { application_id, apk, activity, pid })
    })();
    if result.as_ref().is_err_and(|error| error.kind == ide_core::error::ErrorKind::Cancelled) {
        if !build_complete {
            emit(on_event, "build-stopped", "Gradle build process stopped");
            emit(on_event, "cleanup-complete", "Owned Gradle process tree cleanup complete");
        } else {
            emit(on_event, "operation-stopped", "Android operation stopped");
        }
    }
    result
}

/// Stops only the selected app's package on the selected device.
pub fn stop_app(serial: &str, application_id: &str, sdk_or_adb: Option<&Path>) -> IdeResult<()> {
    if application_id.is_empty()
        || !application_id
            .split('.')
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
    {
        return Err(IdeError::invalid("Invalid Android application id"));
    }
    adb_run(serial, &["shell".into(), "am".into(), "force-stop".into(), application_id.to_owned()], sdk_or_adb, None)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata(root: &Path, variant_dir: &str, variant: &str, apk_name: &str) {
        let dir = root.join("app/build/outputs/apk").join(variant_dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(apk_name), b"apk").unwrap();
        std::fs::write(
            dir.join("output-metadata.json"),
            format!(
                r#"{{"version":3,"artifactType":{{"type":"APK","kind":"Directory"}},"applicationId":"dev.test.app","variantName":"{variant}","elements":[{{"type":"SINGLE","outputFile":"{apk_name}","filters":[]}}]}}"#
            ),
        )
        .unwrap();
    }

    #[test]
    fn finds_flavored_variant_from_metadata_not_directory_name() {
        let root = tempfile::tempdir().unwrap();
        metadata(root.path(), "free/debug", "freeDebug", "app-free-debug.apk");
        let (id, apk) = apk_from_metadata(root.path(), "app", "freeDebug").unwrap();
        assert_eq!(id, "dev.test.app");
        assert!(apk.ends_with("app-free-debug.apk"));
    }

    #[test]
    fn requires_a_matching_variant_metadata_file() {
        let root = tempfile::tempdir().unwrap();
        metadata(root.path(), "debug", "debug", "app-debug.apk");
        assert!(apk_from_metadata(root.path(), "app", "release").is_err());
    }

    #[test]
    fn validates_gradle_module_and_variant_inputs() {
        assert!(module_path(":feature:app").is_ok());
        assert!(module_path("../app").is_err());
        assert!(task_name("freeDebug").is_ok());
        assert!(task_name("debug;clean").is_err());
        assert_eq!(gradle_task("feature:app", "freeDebug").unwrap(), ":feature:app:assembleFreeDebug");
    }

    #[test]
    fn resolves_an_explicit_adb_executable_or_sdk_root() {
        let root = tempfile::tempdir().unwrap();
        let adb_dir = root.path().join("platform-tools");
        std::fs::create_dir_all(&adb_dir).unwrap();
        let adb = adb_dir.join(if cfg!(windows) { "adb.exe" } else { "adb" });
        std::fs::write(&adb, b"").unwrap();
        assert_eq!(adb_executable(Some(root.path())).unwrap(), adb);
        assert_eq!(adb_executable(Some(&adb)).unwrap(), adb);
        assert_eq!(sdk_root(Some(root.path()), &adb), Some(root.path().to_path_buf()));
        assert_eq!(sdk_root(Some(&adb), &adb), Some(root.path().to_path_buf()));
    }

    #[test]
    fn rejects_a_jre_without_a_compiler_as_a_jdk() {
        let root = tempfile::tempdir().unwrap();
        let bin = root.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join(if cfg!(windows) { "java.exe" } else { "java" }), b"").unwrap();
        assert!(!is_compatible_jdk(root.path()));
        std::fs::write(bin.join(if cfg!(windows) { "javac.exe" } else { "javac" }), b"").unwrap();
        assert!(is_compatible_jdk(root.path()));
    }

    #[test]
    fn non_ascii_path_detection_matches_agp_diagnostic_gate() {
        assert!(contains_non_ascii(Path::new(r"C:\work\示例")));
        assert!(!contains_non_ascii(Path::new(r"C:\work\sample")));
    }

    #[test]
    fn non_ascii_project_path_diagnostic_names_the_explicit_override() {
        let error = build_install_launch(
            Path::new(r"C:\work\示例"),
            "app",
            "debug",
            "device",
            None,
            None,
            false,
            &CancellationToken::new(),
            &mut |_| {},
        )
        .unwrap_err();
        assert!(error.message.contains("android.overridePathCheck"));
        assert!(error.message.contains("not enabled automatically"));
    }
}
