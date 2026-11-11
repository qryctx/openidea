mod build_profile;

fn main() {
    println!("cargo:rerun-if-env-changed=VITE_OPENIDEA_PROFILE");
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    println!("cargo:rerun-if-changed=build_profile.rs");
    println!("cargo:rerun-if-changed=../crates/ide-core/build_profile.rs");
    println!("cargo:rerun-if-changed=tauri.v0.conf.json");
    println!("cargo:rustc-check-cfg=cfg(openidea_v0)");
    let profile = build_profile::profile(std::env::var("VITE_OPENIDEA_PROFILE").ok().as_deref());
    if profile == "v0" {
        println!("cargo:rustc-cfg=openidea_v0");
        let config = build_profile::v0_config(std::env::var("TAURI_CONFIG").ok().as_deref());
        // Build scripts are single-threaded here; both tauri-build and generate_context
        // must see the same sanitized overlay, including for a direct Cargo build.
        unsafe { std::env::set_var("TAURI_CONFIG", &config) };
        println!("cargo:rustc-env=TAURI_CONFIG={config}");
    }
    // Read when the script runs: a path compiled into the script would outlive a move of the checkout.
    let manifest_dir =
        std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let root = dunce::canonicalize(manifest_dir.parent().unwrap()).expect("worktree root");
    println!("cargo:rustc-env=OPENIDEA_WORKTREE_ROOT={}", root.display());
    // Windows (MSVC): link the Common-Controls v6 manifest into every binary of
    // this package, not only the app's resources, so test executables such as
    // `export_bindings` can load comctl32 and don't exit with
    // STATUS_ENTRYPOINT_NOT_FOUND.
    let mut windows = tauri_build::WindowsAttributes::new();
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        windows = tauri_build::WindowsAttributes::new_without_app_manifest();
        let manifest = manifest_dir.join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows)).expect("tauri build");
}
