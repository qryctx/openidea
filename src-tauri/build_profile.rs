pub fn profile(value: Option<&str>) -> &'static str {
    match value {
        None | Some("") | Some("default") => "default",
        Some("v0") => "v0",
        Some(value) => panic!("Unknown OpenIDEA product profile: {value}"),
    }
}

/// RFC 7396 overlay: null removes the updater, rather than retaining its public key.
pub fn v0_config(existing: Option<&str>) -> String {
    let mut config: serde_json::Value = serde_json::from_str(existing.unwrap_or("{}")).expect("valid TAURI_CONFIG");
    let object = config.as_object_mut().expect("TAURI_CONFIG object");
    let bundle = object.entry("bundle").or_insert_with(|| serde_json::json!({}));
    bundle.as_object_mut().expect("bundle object").insert("createUpdaterArtifacts".into(), false.into());
    let plugins = object.entry("plugins").or_insert_with(|| serde_json::json!({}));
    plugins.as_object_mut().expect("plugins object").insert("updater".into(), serde_json::Value::Null);
    config.to_string()
}
