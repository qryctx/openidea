//! Internal build-time identities; not a release brand or runtime preference.

pub const V0: bool = cfg!(openidea_v0);
pub const APP_ID: &str = if V0 { "dev.qryctx.openidea.v0" } else { "ai.l0ng.openidea" };
pub const PROJECT_DIR: &str = if V0 { ".openidea-v0" } else { ".openidea" };
pub const WORKSPACE_FILE: &str = if V0 { ".openidea-v0/workspace.json" } else { ".openidea/workspace.json" };
pub const DEV_PLUGINS_DIR: &str = if V0 { ".openidea-v0/plugins" } else { ".openidea/plugins" };
pub const LOCAL_DATA_ENV: &str = if V0 { "OPENIDEA_V0_LOCAL_DATA_DIR" } else { "OPENIDEA_LOCAL_DATA_DIR" };
pub const CLI_COMMAND: &str = if V0 { "openidea-v0" } else { "openidea" };
pub const CLI_WINDOWS_COMMAND: &str = if V0 { "openidea-v0.cmd" } else { "openidea.cmd" };
pub const CLI_WINDOWS_BIN: &str = if V0 { "OpenIDEA-v0/bin" } else { "OpenIDEA/bin" };

pub fn dev_identifier(root: &str) -> String {
    // FNV-1a, shared with scripts/dev-session.ts.
    let hash =
        root.bytes().fold(0xcbf29ce484222325_u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3));
    format!("{APP_ID}.dev.w{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_identity_uses_the_compiled_root_and_product() {
        assert_eq!(dev_identifier("/repo/idea"), format!("{APP_ID}.dev.w158e9c5954b7bf64"));
        assert_ne!(dev_identifier("/repo/idea"), dev_identifier("/repo/idea-other"));
        assert_ne!(dev_identifier("/repo/项目"), dev_identifier("/repo/项目2"));
    }
}
