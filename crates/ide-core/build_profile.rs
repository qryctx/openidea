pub fn profile(value: Option<&str>) -> &'static str {
    match value {
        None | Some("") | Some("default") => "default",
        Some("v0") => "v0",
        Some(value) => panic!("Unknown OpenIDEA product profile: {value}"),
    }
}
