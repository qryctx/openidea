# Contributing to OpenIDEA

These rules apply to everyone, and to any coding agent working on their behalf.
Project layout, coding rules, commands and checks are in [AGENTS.md](AGENTS.md).

## Issues

- One problem or request per issue. Use the issue forms.
- Bugs: steps that reproduce the problem from a fresh start. A minimal sample
  project is the fastest way to get a fix.
- Features: state the problem and the acceptance criteria. A feature is ready to
  build once a maintainer labels it `planned`.
- Labels track status: `needs-info` waits on the reporter, `needs-decision` waits
  on a maintainer, `planned` is accepted, `needs-acceptance` has a fix waiting to be
  checked.

## Pull requests

- One problem per PR. If it resolves an issue, link it with `Closes #123`.
- Reproduce the problem first, or write a test that fails before the fix.
- Fix the cause, and check whether the same cause breaks anything nearby.
- Keep the diff focused. Unrelated refactors go in their own PR.
- Title: [Conventional Commits](https://www.conventionalcommits.org/), e.g.
  `fix(editor): keep the caret visible after folding`.
- Fill in the template. Keep the description short and in plain words. If it
  doesn't fit in a few sentences, the PR is probably too big.
- **How it was verified** is required: the commands you ran and their results,
  and what else the change could affect. Changes to what users see need before/after
  screenshots; multi-step interactions need a recording. UI that goes away with a removed
  feature, copy-only and non-visual changes don't; say what you checked instead.
- If a change needs a product decision you can't make, ask in the issue and stop
  rather than guessing.

Plugins: pull requests here add or change official plugins (`plugins/official/`)
and the plugin API. Community plugins live in their authors' repositories and
are listed through [l0ng-ai/openidea-plugins](https://github.com/l0ng-ai/openidea-plugins);
see [`plugins/README.md`](plugins/README.md) § 8.1.

A check on each PR adds `needs-info` when the verification section is missing, and removes it once it's filled in.

## Opt-in v0 frontend profile

The default build is unchanged. To try the bounded changes-first frontend on
Windows PowerShell, run `$env:VITE_OPENIDEA_PROFILE = "v0"; pnpm build` (or
`pnpm tauri dev` when native prerequisites are available). Remove the environment
variable to return to the default product. All auxiliary windows use the same
bundle/profile; this is not a runtime setting.

v0 activates only the local shell, trust, text editor, Project, search, Git,
Terminal, Build, Run, Debug, Logcat and basic Settings. Fresh layouts start with
Commit (including Changes); Project remains available and Terminal is on-demand.
Non-modal Commit is enforced in memory, without rewriting the saved preference.
Language-server-based commit analysis and modifications are off in v0; Git
warnings, hooks and the changed-line TODO check remain available.
Tool-window layouts, named layouts and editor sessions have separate v0 storage
keys: trying v0 neither migrates nor overwrites the default layout or open tabs.
Source files are still shared; ordinary save/close safeguards apply.

The internal v0 application identity is `dev.qryctx.openidea.v0`; debug identities
append the existing canonical-worktree hash. This is a replaceable development
identifier, not a release brand or trademark decision. App config/data/logs and
Windows/Linux webview storage are separate from the default product. Rebuildable
local data accepts only `OPENIDEA_V0_LOCAL_DATA_DIR` in v0 (the same absolute-path
and writeability checks as the default override); `OPENIDEA_LOCAL_DATA_DIR` is
ignored there. Roaming-to-local migration stays inside this product's app dirs,
not an import from the default product.

v0 reads/writes project settings, workspace, run configurations and private state
only under `.openidea-v0`, without importing `.openidea`. Credentials use the
same OS store implementation with an isolated service namespace and the existing
per-index UUID. The optional launcher is `openidea-v0` (`openidea-v0.cmd` on
Windows), never a replacement for `openidea`. Both profiles are build-time choices.
The Tauri wrapper puts v0 binaries under `target/v0` (or `<CARGO_TARGET_DIR>/v0`)
and leaves default output unchanged, so the two launchers cannot replace each
other's executable. Distinct profile launchers and Vite origins do not reuse the
other product's backend. Direct Cargo invocations must choose separate output
directories themselves when keeping both profiles running.

AI, MCP, remote/deployment, marketplace/plugins, notebooks, databases, HTTP,
GraphQL and advanced feature activations are excluded, not CSS-hidden. Settings
pages, search entries, restored tool windows and the frontend main menu follow
the same boundary. Native menus can only disable absent actions with the existing
IPC; removing their native items requires a later backend integration.

This does **not** disable or remove backend services, binaries or dependencies.
Java/Kotlin semantic LSP activation is outside this frontend profile. Existing
generic Build/Run/Debug implementations and language adapters remain intact:
Build Project compiles sources/tests, not an Android APK. APK packaging,
real-device install/launch and the independent JDI-to-DAP pipeline are not yet
integrated into the IDE. No Android capability is claimed by this profile.
External-change Git refresh is retained; dirty-buffer overwrite/conflict
protection is not solved here. Native Rust/Tauri acceptance requires MSVC and the
Windows SDK and must be recorded separately from frontend checks.
