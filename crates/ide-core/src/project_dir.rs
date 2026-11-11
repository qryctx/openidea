//! The per-project config folder (`<root>/.openidea/`).

use std::path::{Path, PathBuf};

/// Folder name under the project root.
pub const DIR: &str = crate::product::PROJECT_DIR;

/// Where `rel` (e.g. `settings.toml`) is read from and written to.
pub fn path(root: &Path, rel: impl AsRef<Path>) -> PathBuf {
    root.join(DIR).join(rel)
}

/// v0 must not scan the other product's metadata either.
pub fn is_metadata_name(name: &str) -> bool {
    if crate::product::V0 {
        name.eq_ignore_ascii_case(".openidea") || name.eq_ignore_ascii_case(DIR)
    } else {
        name == ".openidea"
    }
}
