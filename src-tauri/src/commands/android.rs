//! Local Android devices, variant discovery and project-scoped Run.

use crate::state::AppState;
use ide_android::{AndroidDevice, LogcatLine};
use ide_core::{IdeError, IdeResult, RequestId};
use tauri::State;
use tauri::ipc::Channel;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| IdeError::internal(e.to_string()))?
}

/// Devices `adb` knows about, online ones first.
#[tauri::command]
#[specta::specta]
pub async fn android_devices() -> IdeResult<Vec<AndroidDevice>> {
    blocking(ide_android::devices).await
}

/// Follows `serial`'s log until the request is cancelled, in batches of lines.
/// `clear` empties the device's buffers first.
#[tauri::command]
#[specta::specta]
pub async fn android_logcat(
    state: State<'_, AppState>,
    request: RequestId,
    serial: String,
    clear: bool,
    pid: Option<u32>,
    since: Option<String>,
    on_lines: Channel<Vec<LogcatLine>>,
) -> IdeResult<()> {
    let cancel = state.begin_request(request);
    let result = blocking(move || {
        ide_android::scoped_logcat(&serial, clear, pid, since.as_deref(), &cancel, &mut |batch| {
            let _ = on_lines.send(batch);
        })
    })
    .await;
    state.end_request(request);
    result
}

use ide_build::android::{self, AndroidVariant};
use std::collections::BTreeMap;
use std::path::Path;
use tauri::Window;

// A cancelled window cannot keep writing to the snapshot another window is about to read.
static GRADLE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn sync<T: Send + 'static>(
    state: &AppState,
    window: &Window,
    request: RequestId,
    root: String,
    not_android: IdeResult<T>,
    work: impl FnOnce(&Path, &Path, &BTreeMap<String, String>, &ide_core::CancellationToken) -> IdeResult<T>
    + Send
    + 'static,
) -> IdeResult<T> {
    let label = window.label();
    let project = state.project(label)?;
    project.require_trust()?;
    if project.light || project.root != Path::new(&root) || state.remote_dev.get(label).is_some() {
        return Err(IdeError::invalid("Android sync requires the currently open local project"));
    }
    let cancel = state.begin_project_request(label, request);
    let result = async {
        let _guard = tokio::select! {
            _ = cancel.cancelled() => return Err(IdeError::cancelled()),
            lock = GRADLE.lock() => lock,
        };
        if state.remote_dev.get(label).is_some() || !std::sync::Arc::ptr_eq(&project, &state.project(label)?) {
            return Err(IdeError::cancelled());
        }
        project.require_trust()?;
        blocking(move || {
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            if !android::is_android_project(&project.root, &cancel)? {
                return not_android;
            }
            let mut env = ide_sdk::apply::android_gradle_env(&project.root, &project.settings.effective());
            if std::env::var_os("ANDROID_HOME").is_none()
                && std::env::var_os("ANDROID_SDK_ROOT").is_none()
                && let Some(sdk) = ide_android::installed_sdk()
            {
                env.insert("ANDROID_HOME".into(), sdk.to_string_lossy().into_owned());
            }
            work(&project.root, &project.cache_dir, &env, &cancel)
        })
        .await
    }
    .await;
    state.end_request(request);
    result
}

#[tauri::command]
#[specta::specta]
pub async fn android_discover_variants(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    root: String,
) -> IdeResult<Vec<AndroidVariant>> {
    sync(&state, &window, request, root, Ok(Vec::new()), android::discover).await
}

#[tauri::command]
#[specta::specta]
pub async fn android_index_variant(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    root: String,
    module: String,
    variant: String,
) -> IdeResult<String> {
    let missing = IdeError::invalid("Expected an Android Gradle project with its own wrapper");
    sync(&state, &window, request, root, Err(missing), move |root, cache, env, cancel| {
        android::index_variant(root, cache, &module, &variant, env, cancel)
    })
    .await
}

#[derive(Clone, Copy, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum AndroidRunStage {
    Building,
    Installing,
    Launching,
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AndroidRunResult {
    serial: String,
    module: String,
    variant: String,
    application_id: String,
    apk: String,
    component: String,
    pid: u32,
    log_since: String,
}

/// Builds exactly one selected AGP variant and deploys it to one explicit device.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn android_run_variant(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    root: String,
    module: String,
    variant: String,
    serial: String,
    on_progress: Channel<AndroidRunStage>,
) -> IdeResult<AndroidRunResult> {
    let missing = IdeError::invalid("Expected an Android Gradle project with its own wrapper");
    sync(&state, &window, request, root, Err(missing), move |root, cache, env, cancel| {
        ide_android::ensure_device(&serial, cancel)?;
        let _ = on_progress.send(AndroidRunStage::Building);
        let artifact = android::build_run_artifact(root, cache, &module, &variant, env, cancel)?;
        let _ = on_progress.send(AndroidRunStage::Installing);
        ide_android::install_apk(&serial, &root.join(&artifact.apk), &artifact.application_id, cancel)?;
        let _ = on_progress.send(AndroidRunStage::Launching);
        let app = ide_android::launch_app(&serial, &artifact.application_id, cancel)?;
        Ok(AndroidRunResult {
            serial,
            module,
            variant,
            application_id: artifact.application_id,
            apk: artifact.apk.to_string_lossy().replace('\\', "/"),
            component: app.component,
            pid: app.pid,
            log_since: app.log_since,
        })
    })
    .await
}
