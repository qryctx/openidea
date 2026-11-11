//! Logcat tool window: Android devices and their logs (`ide-android`).

use crate::state::AppState;
use ide_android::{AndroidDevice, LogcatLine};
use ide_core::{IdeError, IdeResult, RequestId};
use std::path::PathBuf;
use tauri::ipc::Channel;
use tauri::{State, Window};

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| IdeError::internal(e.to_string()))?
}

/// Devices `adb` knows about, online ones first.
#[tauri::command]
#[specta::specta]
pub async fn android_devices() -> IdeResult<Vec<AndroidDevice>> {
    blocking(ide_android::devices).await
}

/// Devices discovered with an optional user-selected SDK/adb path.
#[tauri::command]
#[specta::specta]
pub async fn android_devices_at(sdk_or_adb: Option<PathBuf>) -> IdeResult<Vec<AndroidDevice>> {
    blocking(move || ide_android::devices_at(sdk_or_adb.as_deref())).await
}

/// Existing Java, Android SDK, and adb paths visible to the desktop process.
#[tauri::command]
#[specta::specta]
pub async fn android_environment() -> IdeResult<ide_android::AndroidEnvironment> {
    blocking(|| Ok(ide_android::environment())).await
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
    on_lines: Channel<Vec<LogcatLine>>,
) -> IdeResult<()> {
    let cancel = state.begin_request(request);
    let result = blocking(move || {
        ide_android::logcat(&serial, clear, &cancel, &mut |batch| {
            let _ = on_lines.send(batch);
        })
    })
    .await;
    state.end_request(request);
    result
}

/// Builds the selected Android variant with the project wrapper, installs its
/// metadata-selected APK, and launches its sole LAUNCHER activity.
#[tauri::command]
#[specta::specta]
pub async fn android_build_install_launch(
    window: Window,
    state: State<'_, AppState>,
    module: String,
    variant: String,
    serial: String,
    sdk_or_adb: Option<PathBuf>,
    java_home: Option<PathBuf>,
    override_path_check: bool,
    request: RequestId,
    on_event: Channel<ide_android::AndroidRunEvent>,
) -> IdeResult<ide_android::AndroidRunResult> {
    let root: PathBuf = state.project(window.label())?.root.clone();
    let cancel = state.begin_request(request);
    let result = blocking(move || {
        ide_android::build_install_launch(
            &root,
            &module,
            &variant,
            &serial,
            sdk_or_adb.as_deref(),
            java_home.as_deref(),
            override_path_check,
            &cancel,
            &mut |event| {
                let _ = on_event.send(event);
            },
        )
    })
    .await;
    state.end_request(request);
    result
}

/// Streams only the selected app's process from the chosen device.
#[tauri::command]
#[specta::specta]
pub async fn android_app_logcat(
    state: State<'_, AppState>,
    request: RequestId,
    serial: String,
    pid: i32,
    sdk_or_adb: Option<PathBuf>,
    on_lines: Channel<Vec<LogcatLine>>,
) -> IdeResult<()> {
    let cancel = state.begin_request(request);
    let result = blocking(move || {
        ide_android::logcat_app(&serial, pid, sdk_or_adb.as_deref(), &cancel, &mut |batch| {
            let _ = on_lines.send(batch);
        })
    })
    .await;
    state.end_request(request);
    result
}

/// Stops only the selected package on the selected device.
#[tauri::command]
#[specta::specta]
pub async fn android_stop_app(serial: String, application_id: String, sdk_or_adb: Option<PathBuf>) -> IdeResult<()> {
    blocking(move || ide_android::stop_app(&serial, &application_id, sdk_or_adb.as_deref())).await
}
