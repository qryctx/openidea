/** Build-time product boundary; not a user setting or a backend capability switch. */
export function isV0Profile(): boolean {
  const profile = import.meta.env.VITE_OPENIDEA_PROFILE;
  if (profile && profile !== "default" && profile !== "v0") {
    throw new Error(`Unknown OpenIDEA product profile: ${profile}`);
  }
  return profile === "v0";
}

const V0_FEATURES = new Set([
  "project-trust",
  "editor",
  "app",
  "welcome",
  "project-tree",
  "search",
  "vcs",
  "terminal",
  "run",
  "debugger",
  "logcat",
  "build",
  "settings",
]);

export function featureEnabled(id: string): boolean {
  return !isV0Profile() || V0_FEATURES.has(id);
}

const V0_TOOL_WINDOWS = new Set([
  "project",
  "commit",
  "git",
  "find",
  "build",
  "run",
  "debug",
  "logcat",
  "terminal",
  "notifications",
]);

export function toolWindowEnabled(id: string): boolean {
  return !isV0Profile() || V0_TOOL_WINDOWS.has(id);
}

const V0_SETTINGS_PAGES = new Set([
  "appearance",
  "general",
  "general.language",
  "general.dateFormats",
  "notifications",
  "keymap",
  "editor.files",
  "editor.font",
  "editor.general",
  "editor.general.appearance",
  "editor.general.breadcrumbs",
  "editor.general.codeFolding",
  "editor.general.editorTabs",
  "editor.general.gutterIcons",
  "editor.general.richTextCopy",
  "editor.general.smartKeys",
  "editor.general.stickyLines",
  "editor.colorScheme",
  "editor.colorScheme.general",
  "editor.colorScheme.language-defaults",
  "editor.colorScheme.debugger",
  "vcs",
  "vcs.commit",
  "vcs.confirmation",
  "vcs.mappings",
  "vcs.git",
  "vcs.log",
  "vcs.shelf",
  "build.console",
  "build.debugger",
  "build.debugger.dataViews",
  "build.debugger.stepping",
  "build.run",
  "tools.terminal",
]);

export function settingsPageEnabled(id: string): boolean {
  return !isV0Profile() || V0_SETTINGS_PAGES.has(id.split("#")[0]!);
}

export function settingsPageTarget(id: string): string {
  return settingsPageEnabled(id) ? id : "appearance";
}

/** A separate namespace preserves default-profile layouts and documents when trying v0. */
export function profileStorageKey(key: string): string {
  return isV0Profile() ? `openidea.profile.v0:${key}` : key;
}

export function projectConfigDir(): string {
  return isV0Profile() ? ".openidea-v0" : ".openidea";
}
