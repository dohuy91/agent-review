# Development status

Updated: 2026-10-03 (UTC). The requested implementation is complete. The Linux verification below passed; platform and live-authentication limits are listed explicitly.

## Implemented

- Persistent repositories and comparison context, an obvious project selector, and a server folder chooser; native macOS has an explicit system-dialog path
- Changed-file/folder hierarchy with added/deleted counts, status and review/comment badges; wide searchable local/remote branch selectors
- Resizable panes with saved widths, collapsible right-side sections, System theme with saved Light/Dark overrides and unified/split views, configurable keyboard controls, and 700px drawer behavior
- Visible shared inline/right-pane comments with old/new line or range anchors, edit/resolve/reopen/delete, draft preservation and stale-context protection
- Real local branch switching: clean switch, explicitly confirmed Stash & switch, selected-staged Commit & switch with a required message, and Cancel; retained recovery information and no automatic stash restore
- Exact file/hunk stage/unstage, previewed discard, selected-index commits, explicit HTTPS/SSH Fetch, and confirmed single-branch non-force Push
- Same-name Push by default; a separate comparison-branch option uses verified configured mappings and the actual push recipient
- Codex, Claude Code and OpenCode adapter contracts, exact skill/profile targeting, live refresh, explicit Send/Stop and bounded transient output
- Conservative Git/hash comment attachment, durable metadata and export; history remains available to backend safety/reconstruction without a right-side History panel
- Native launcher/demo/smoke, Docker read-only defaults and an explicit writable override, portable source packaging, and updated usage documentation

## Final verification

- `pnpm test`: **516 tests passed in 47 files**
- `pnpm typecheck`: passed
- `pnpm build`: passed
- `pnpm smoke:native`: passed against the real CLI and loopback HTTP service, including security checks, Git actions, comments, restart persistence, folder browsing, counts, clean/stash switching and explicit stash recovery
- Focused independent reviews are closed for the implemented UI, Push, branch switching, final folder-picker corrections and System-theme preference
- Tested cloud runtime: Linux, Node 24.19.0, pnpm 11.19.0, Git 2.52.0

The existing Vite large-bundle advisory and React fixture `act` warnings remain; they did not cause failures. Tests use owned synthetic repositories, local bare remotes and fixture agent/native-dialog processes.

## Verification limits

- Live provider execution and authenticated HTTPS/SSH Fetch/Push have not been exercised
- Actual macOS folder-dialog/permission behavior is unverified; its process and UI handling were fixture-tested
- Docker image/runtime validation could not run because no Docker engine is available in the test environment
- Final rendered browser geometry and Obsidian webview compatibility remain unverified
- OpenCode execution currently requires the verified version 1.18.31; unsupported versions fail closed
- Guarded branch switching conservatively refuses unsupported trees/configurations and never force-switches or discards work

See README.md for native/Docker launch commands, folder roots, credentials, branch switching, retained stashes and explicit Push behavior.
