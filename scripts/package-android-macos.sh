#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm tauri build --bundles app --config src-tauri/tauri.android.conf.json
bundle="${CARGO_TARGET_DIR:-target}/release/bundle/macos/OpenAndroidStudio.app"
codesign --force --sign - --timestamp=none --entitlements src-tauri/Entitlements.plist "$bundle"
codesign --verify --deep --strict "$bundle"
