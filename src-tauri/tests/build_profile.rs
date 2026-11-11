#[path = "../build_profile.rs"]
mod build_profile;

#[test]
fn cargo_profile_matches_the_current_environment_not_the_previous_build() {
    let expected = build_profile::profile(std::env::var("VITE_OPENIDEA_PROFILE").ok().as_deref()) == "v0";
    assert_eq!(cfg!(openidea_v0), expected);
    assert_eq!(ide_core::product::V0, expected);
    let context: tauri::Context<tauri::Wry> = tauri::generate_context!();
    if expected {
        assert_eq!(context.config().identifier, ide_core::product::APP_ID);
        assert!(!context.config().plugins.0.contains_key("updater"));
        assert!(matches!(context.config().bundle.create_updater_artifacts, tauri::utils::config::Updater::Bool(false)));
    } else {
        assert!(context.config().plugins.0.contains_key("updater"));
        assert!(matches!(context.config().bundle.create_updater_artifacts, tauri::utils::config::Updater::Bool(true)));
    }
}

#[test]
fn v0_removes_upstream_and_custom_updaters_without_changing_other_config() {
    for existing in [
        None,
        Some(
            r#"{"plugins":{"updater":{"pubkey":"upstream","endpoints":["https://example.com/update"]},"other":{"enabled":true}},"bundle":{"createUpdaterArtifacts":true,"active":true},"identifier":"custom"}"#,
        ),
    ] {
        let overlay: serde_json::Value = serde_json::from_str(&build_profile::v0_config(existing)).unwrap();
        assert_eq!(overlay["plugins"]["updater"], serde_json::Value::Null);
        assert_eq!(overlay["bundle"]["createUpdaterArtifacts"], false);
        if existing.is_some() {
            assert_eq!(overlay["identifier"], "dev.qryctx.openidea.v0");
            assert_eq!(overlay["plugins"]["other"]["enabled"], true);
            assert_eq!(overlay["bundle"]["active"], true);
        }
    }
    let cli_overlay: serde_json::Value = serde_json::from_str(include_str!("../tauri.v0.conf.json")).unwrap();
    let cargo_overlay: serde_json::Value = serde_json::from_str(&build_profile::v0_config(None)).unwrap();
    assert_eq!(cli_overlay, cargo_overlay);
}
