//! Local Android devices, variant discovery and project-scoped Run.

use crate::state::AppState;
use ide_android::{AndroidDevice, LogcatLine};
use ide_core::{CancellationToken, IdeError, IdeResult, RequestId};
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
    let cancel = state.begin_project_request(window.label(), request);
    let result = with_project(state, window, root, cancel, not_android, work).await;
    state.end_request(request);
    result
}

async fn with_project<T: Send + 'static>(
    state: &AppState,
    window: &Window,
    root: String,
    cancel: CancellationToken,
    not_android: IdeResult<T>,
    work: impl FnOnce(&Path, &Path, &BTreeMap<String, String>, &CancellationToken) -> IdeResult<T> + Send + 'static,
) -> IdeResult<T> {
    let label = window.label();
    let project = state.project(label)?;
    project.require_trust()?;
    if project.light || project.root != Path::new(&root) || state.remote_dev.get(label).is_some() {
        return Err(IdeError::invalid("Android deployment requires the currently open local project"));
    }
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
    let devices = state.android_debug.clone();
    let deploy = Deploy { serial, module, variant, on_progress, debug: false };
    let missing = IdeError::invalid("Expected an Android Gradle project with its own wrapper");
    sync(&state, &window, request, root, Err(missing), move |root, cache, env, cancel| {
        devices.check_free(&deploy.serial)?;
        let artifact = deploy.install(root, cache, env, cancel)?;
        let app = ide_android::launch_app(&deploy.serial, &artifact.application_id, cancel)?;
        Ok(deploy.result(artifact, &app))
    })
    .await
}

struct Deploy {
    serial: String,
    module: String,
    variant: String,
    on_progress: Channel<AndroidRunStage>,
    debug: bool,
}

impl Deploy {
    fn install(
        &self,
        root: &Path,
        cache: &Path,
        env: &BTreeMap<String, String>,
        cancel: &CancellationToken,
    ) -> IdeResult<android::AndroidRunArtifact> {
        ide_android::ensure_device(&self.serial, cancel)?;
        let _ = self.on_progress.send(AndroidRunStage::Building);
        let artifact = android::build_run_artifact(root, cache, &self.module, &self.variant, env, cancel)?;
        if self.debug && !artifact.debuggable {
            return Err(IdeError::invalid(format!(
                "{} / {} produces an APK that is not debuggable",
                self.module, self.variant
            )));
        }
        let _ = self.on_progress.send(AndroidRunStage::Installing);
        ide_android::install_apk(&self.serial, &root.join(&artifact.apk), &artifact.application_id, cancel)?;
        let _ = self.on_progress.send(AndroidRunStage::Launching);
        Ok(artifact)
    }

    fn result(self, artifact: android::AndroidRunArtifact, app: &ide_android::LaunchedApp) -> AndroidRunResult {
        AndroidRunResult {
            serial: self.serial,
            module: self.module,
            variant: self.variant,
            application_id: artifact.application_id,
            apk: artifact.apk.to_string_lossy().replace('\\', "/"),
            component: app.component.clone(),
            pid: app.pid,
            log_since: app.log_since.clone(),
        }
    }
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AndroidDebugTarget {
    run: AndroidRunResult,
    port: u16,
}

/// Keeps the forward and waiting process owned by the originating project until cancellation.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn android_debug_variant(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    root: String,
    module: String,
    variant: String,
    serial: String,
    on_progress: Channel<AndroidRunStage>,
    on_ready: Channel<AndroidDebugTarget>,
) -> IdeResult<()> {
    let cancel = state.begin_project_request(window.label(), request);
    let result = async {
        let _lease = state.android_debug.reserve(&serial, &cancel)?;
        let deploy = Deploy { serial, module, variant, on_progress, debug: true };
        let missing = IdeError::invalid("Expected an Android Gradle project with its own wrapper");
        let (session, ready) =
            with_project(&state, &window, root, cancel.clone(), Err(missing), move |root, cache, env, cancel| {
                let artifact = deploy.install(root, cache, env, cancel)?;
                let session = ide_android::launch_debug(&deploy.serial, &artifact.application_id, cancel)?;
                let ready = AndroidDebugTarget { run: deploy.result(artifact, &session.app), port: session.port() };
                Ok((session, ready))
            })
            .await?;
        if !cancel.is_cancelled() && on_ready.send(ready).is_ok() {
            cancel.cancelled().await;
        }
        blocking(move || session.close()).await
    }
    .await;
    state.end_request(request);
    result
}

#[derive(Default)]
pub(crate) struct DebugSessions {
    devices: parking_lot::Mutex<BTreeMap<String, CancellationToken>>,
    released: parking_lot::Condvar,
}

impl DebugSessions {
    fn check_free(&self, serial: &str) -> IdeResult<()> {
        if self.devices.lock().contains_key(serial) {
            return Err(IdeError::invalid("Stop the active Android debugger on this device first"));
        }
        Ok(())
    }

    fn reserve<'a>(&'a self, serial: &str, cancel: &CancellationToken) -> IdeResult<DebugDevice<'a>> {
        let mut devices = self.devices.lock();
        if devices.contains_key(serial) {
            return Err(IdeError::invalid("Stop the active Android debugger on this device first"));
        }
        devices.insert(serial.into(), cancel.clone());
        Ok(DebugDevice { sessions: self, serial: serial.into() })
    }

    // App termination can precede WebView disposal. Give outstanding ADB cleanup time to finish.
    pub(crate) fn shutdown(&self) {
        let mut devices = self.devices.lock();
        for cancel in devices.values() {
            cancel.cancel();
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !devices.is_empty() {
            if self.released.wait_until(&mut devices, deadline).timed_out() {
                tracing::warn!("Android debugger cleanup did not finish before app exit");
                break;
            }
        }
    }
}

struct DebugDevice<'a> {
    sessions: &'a DebugSessions,
    serial: String,
}
impl Drop for DebugDevice<'_> {
    fn drop(&mut self) {
        self.sessions.devices.lock().remove(&self.serial);
        self.sessions.released.notify_all();
    }
}
