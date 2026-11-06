//! Gradle/AGP discovery and on-demand semantic snapshots for local Android projects.
use crate::process;
use ide_core::{CancellationToken, IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, Type)]
pub struct AndroidVariant {
    pub module: String,
    pub name: String,
}

const SUPPORT: &[(&str, &[u8])] = &[
    ("discover.gradle", include_bytes!("../../../android-support/discover.gradle")),
    ("index.gradle", include_bytes!("../../../android-support/index.gradle")),
    ("settings.gradle.kts", include_bytes!("../../../android-support/settings.gradle.kts")),
    ("build.gradle.kts", include_bytes!("../../../android-support/build.gradle.kts")),
    (
        "src/main/java/dev/openandroidstudio/index/ReferenceRegistry.java",
        include_bytes!("../../../android-support/src/main/java/dev/openandroidstudio/index/ReferenceRegistry.java"),
    ),
    (
        "src/main/java/dev/openandroidstudio/index/ReferenceDetector.java",
        include_bytes!("../../../android-support/src/main/java/dev/openandroidstudio/index/ReferenceDetector.java"),
    ),
];

fn prepare_support(cache: &Path) -> IdeResult<PathBuf> {
    let mut hash = blake3::Hasher::new();
    for (name, bytes) in SUPPORT {
        hash.update(name.as_bytes());
        hash.update(bytes);
    }
    let dir = cache.join("android-companion").join(hash.finalize().to_hex().as_str());
    for (name, bytes) in SUPPORT {
        let path = dir.join(name);
        if !fs::read(&path).is_ok_and(|existing| existing == *bytes) {
            let parent = path.parent().unwrap();
            fs::create_dir_all(parent)?;
            let mut work = tempfile::NamedTempFile::new_in(parent)?;
            work.write_all(bytes)?;
            work.persist(&path).map_err(|e| e.error)?;
        }
    }
    Ok(dir)
}

fn wrapper(root: &Path) -> PathBuf {
    root.join(if cfg!(windows) { "gradlew.bat" } else { "gradlew" })
}

/// A cheap, read-only eligibility check before executing the trusted project's wrapper.
/// Variant names still come exclusively from the evaluated AGP model.
pub fn is_android_project(root: &Path, cancel: &CancellationToken) -> IdeResult<bool> {
    if !wrapper(root).is_file() || !["settings.gradle", "settings.gradle.kts"].iter().any(|n| root.join(n).is_file()) {
        return Ok(false);
    }
    let mut directories = vec![root.to_owned()];
    while let Some(dir) = directories.pop() {
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        if dir.join("src/main/AndroidManifest.xml").is_file() {
            return Ok(true);
        }
        let Ok(entries) = fs::read_dir(dir) else { continue };
        for entry in entries.flatten() {
            let Ok(ty) = entry.file_type() else { continue };
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') {
                continue;
            }
            if ty.is_dir() && !matches!(&*name, "src" | "build" | "out" | "target" | "node_modules" | "bin") {
                directories.push(entry.path());
            } else if ty.is_file()
                && (matches!(&*name, "build.gradle" | "build.gradle.kts" | "settings.gradle" | "settings.gradle.kts")
                    || name.ends_with(".versions.toml"))
            {
                let mut script = String::new();
                if fs::File::open(entry.path()).and_then(|f| f.take(512 * 1024).read_to_string(&mut script)).is_ok()
                    && ["com.android.application", "com.android.library", "libs.plugins.android"]
                        .iter()
                        .any(|s| script.contains(s))
                {
                    return Ok(true);
                }
            }
        }
    }
    Ok(false)
}

fn check_selection(module: &str, variant: &str) -> IdeResult<()> {
    let root_or_path = module == ":"
        || module.strip_prefix(':').is_some_and(|p| p.split(':').all(|s| !s.is_empty() && s != "." && s != ".."));
    if !root_or_path || module.contains(['/', '\\']) || module.chars().any(char::is_control) {
        return Err(IdeError::invalid("Invalid Android application module"));
    }
    if !variant.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
        || !variant.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    {
        return Err(IdeError::invalid("Invalid Android variant"));
    }
    Ok(())
}

fn run(
    root: &Path,
    project: &Path,
    options: &[String],
    env: &BTreeMap<String, String>,
    cancel: &CancellationToken,
) -> IdeResult<String> {
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    let mut args = vec![
        "--console=plain".into(),
        "--no-configuration-cache".into(),
        "--no-configure-on-demand".into(),
        "-q".into(),
        "-p".into(),
        project.to_string_lossy().into_owned(),
    ];
    args.extend_from_slice(options);
    let result = process::run(&wrapper(root).to_string_lossy(), &args, project, env, cancel, |_, _| {})?;
    if !result.success {
        let tail: Vec<_> = result.text.lines().rev().take(24).collect();
        return Err(IdeError::unavailable(format!(
            "Android Gradle task failed:\n{}",
            tail.into_iter().rev().collect::<Vec<_>>().join("\n")
        )));
    }
    Ok(result.text)
}

pub fn discover(
    root: &Path,
    cache: &Path,
    env: &BTreeMap<String, String>,
    cancel: &CancellationToken,
) -> IdeResult<Vec<AndroidVariant>> {
    let support = prepare_support(cache)?;
    let options = [
        "--init-script".into(),
        support.join("discover.gradle").to_string_lossy().into_owned(),
        ":openAndroidVariants".into(),
    ];
    let output = run(root, root, &options, env, cancel)?;
    let mut models = output.lines().filter_map(|s| s.strip_prefix("OPENANDROIDSTUDIO_VARIANTS="));
    let model = models.next().ok_or_else(|| IdeError::unavailable("Gradle did not return an Android variant model"))?;
    if models.next().is_some() {
        return Err(IdeError::invalid("Gradle returned multiple Android variant models"));
    }
    let mut variants: Vec<AndroidVariant> =
        serde_json::from_str(model).map_err(|e| IdeError::invalid(format!("Invalid Android variant model: {e}")))?;
    // One unsupported module or variant must not hide valid siblings in the model.
    variants.retain(|v| check_selection(&v.module, &v.name).is_ok());
    Ok(variants)
}

pub fn index_variant(
    root: &Path,
    cache: &Path,
    module: &str,
    variant: &str,
    env: &BTreeMap<String, String>,
    cancel: &CancellationToken,
) -> IdeResult<String> {
    check_selection(module, variant)?;
    let key: String = module.bytes().map(|b| format!("{b:02x}")).collect();
    let relative_dir = format!("build/openandroidstudio/variants/{key}");
    let relative = format!("{relative_dir}/{variant}.json");
    let canonical = root.join(&relative);
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    // A failed refresh must not expose the previous model's snapshot on reopening the project.
    if existing_snapshot(&canonical, module, variant)? {
        fs::remove_file(&canonical)?;
    }
    let support = prepare_support(cache)?;
    // Checking only for the JAR would also accept a partial output left by a cancelled build.
    run(root, &support, &["jar".into()], env, cancel)?;
    let token = uuid::Uuid::new_v4().simple().to_string();
    let pending = root.join(&relative_dir).join(".requests").join(format!("{token}.json"));
    let options = [
        "--init-script".into(),
        support.join("index.gradle").to_string_lossy().into_owned(),
        format!("-PopenAndroidSupportDir={}", support.display()),
        format!("-PopenAndroidApplication={module}"),
        format!("-PopenAndroidIndexRequest={token}"),
        format!("-PopenAndroidVariant={variant}"),
        ":openAndroidIndex".into(),
    ];
    // An old or cancelled Gradle client can only write its own pending snapshot.
    // The manifest consumed by Find Usages is published by the serialized IDE job.
    let result = (|| {
        run(root, root, &options, env, cancel)?;
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        if !pending.is_file() || dunce::canonicalize(&pending)? != pending {
            return Err(IdeError::unavailable("Gradle did not produce a project-local Android index"));
        }
        validate_snapshot(&pending, module, variant)?;
        existing_snapshot(&canonical, module, variant)?;
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        fs::rename(&pending, &canonical)?;
        Ok(relative)
    })();
    // Only unlink our own request file under the genuine, project-local staging directory.
    let staging = pending.parent().unwrap();
    if result.is_err() && dunce::canonicalize(staging).is_ok_and(|p| p == staging) {
        let _ = fs::remove_file(pending);
    }
    result
}

fn existing_snapshot(path: &Path, module: &str, variant: &str) -> IdeResult<bool> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() && dunce::canonicalize(path)? == path => {
            validate_snapshot(path, module, variant)?;
            Ok(true)
        }
        Ok(_) => Err(IdeError::invalid("Refusing to replace an unrelated Android index")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}

fn validate_snapshot(path: &Path, module: &str, variant: &str) -> IdeResult<()> {
    #[derive(Deserialize)]
    struct Header {
        schema: u32,
        #[serde(rename = "files")]
        _files: BTreeMap<String, serde::de::IgnoredAny>,
        #[serde(rename = "declarations")]
        _declarations: Vec<serde::de::IgnoredAny>,
        #[serde(rename = "references")]
        _references: Vec<serde::de::IgnoredAny>,
        application: String,
        variant: String,
    }
    let header: Header = serde_json::from_reader(fs::File::open(path)?)
        .map_err(|e| IdeError::invalid(format!("Invalid Android index at {}: {e}", path.display())))?;
    if header.schema != 1 || header.application != module || header.variant != variant {
        return Err(IdeError::invalid("Android index does not match the requested application and variant"));
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn wrapper_script(root: &Path, script: &str) {
        fs::write(wrapper(root), format!("#!/bin/sh\nset -eu\n{script}\n")).unwrap();
        fs::set_permissions(wrapper(root), fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn accepts_safe_separators_and_rejects_unsafe_selections() {
        for variant in ["demoDebug", "internal_canaryDebug", "internal-canaryDebug"] {
            assert!(check_selection(":feature:app", variant).is_ok());
        }
        for (module, variant) in [(":app", "../outside"), (":app", "debug release"), (":../outside", "debug")] {
            assert!(check_selection(module, variant).is_err());
        }
    }

    #[test]
    fn plain_wrapper_projects_are_skipped_before_gradle_runs() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path();
        wrapper_script(root, "exit 100");
        fs::write(root.join("settings.gradle.kts"), "rootProject.name = \"sample\"").unwrap();
        fs::write(root.join("build.gradle.kts"), "plugins { java }").unwrap();
        assert!(!is_android_project(root, &CancellationToken::new()).unwrap());
        fs::create_dir_all(root.join("library/src/main")).unwrap();
        fs::write(root.join("library/src/main/AndroidManifest.xml"), "<manifest/>").unwrap();
        assert!(is_android_project(root, &CancellationToken::new()).unwrap());
    }

    #[test]
    fn only_a_successful_request_may_publish_its_snapshot() {
        let project = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(project.path()).unwrap();
        let script = r#"
case "$*" in
  *:openAndroidVariants) echo 'OPENANDROIDSTUDIO_VARIANTS=[{"module":":app","name":"demoDebug"}]' ;;
  *:openAndroidIndex)
    for arg; do case "$arg" in -PopenAndroidIndexRequest=*) token=${arg#*=};; esac; done
    dir=build/openandroidstudio/variants/3a617070/.requests
    mkdir -p "$dir"
    echo '{"application":":app","variant":"demoDebug","schema":1,"files":{},"references":[],"declarations":[]}' > "$dir/$token.json"
    test ! -f fail
    ;;
esac
"#;
        wrapper_script(&root, script);
        let cancel = CancellationToken::new();
        let env = BTreeMap::new();
        assert_eq!(discover(&root, cache.path(), &env, &cancel).unwrap()[0].module, ":app");
        let index = || index_variant(&root, cache.path(), ":app", "demoDebug", &env, &cancel);
        let path = root.join(index().unwrap());
        validate_snapshot(&path, ":app", "demoDebug").unwrap();
        fs::write(root.join("fail"), "").unwrap();
        assert!(index().is_err());
        assert!(!path.exists());
        fs::write(&path, "an unrelated user file").unwrap();
        assert!(index().is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "an unrelated user file");
    }
}
