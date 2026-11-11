//! Development identity is tied to the compiled worktree, never the launch cwd.

pub fn configure(mut context: tauri::Context<tauri::Wry>) -> tauri::Context<tauri::Wry> {
    context.config_mut().identifier = ide_core::product::dev_identifier(env!("OPENIDEA_WORKTREE_ROOT"));
    context
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_matches_launcher_and_separates_worktrees() {
        let id = ide_core::product::dev_identifier(env!("OPENIDEA_WORKTREE_ROOT"));
        assert_eq!(configure(tauri::generate_context!()).config().identifier, id);
    }
}
