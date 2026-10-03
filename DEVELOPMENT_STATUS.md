# Development status

Updated: 2026-10-03 (UTC). The approved workspace redesign is implemented. The Linux checks below passed; browser and platform limits remain explicit.

## Implemented

- Project tabs and a plus-button folder chooser, saved comparison context, scoped comment drafts and known agent-run handles across project navigation
- Wide searchable local/comparison branches followed by Pull, split Push, Fix with Agent and Settings; Refresh files immediately beside Unified/Split
- Hierarchical changed files with line counts, a Conflicts group, resizable panes and a comments-only collapsible right pane
- Immediate focused inline comments, safe range/draft retargeting, synchronized inline/right-side threads and correct CRLF rendering
- Unobtrusive file/hunk stage/unstage, previewed discard, selected-index commits and the existing guarded branch-switch workflow
- Bottom-right Fetch and durable status; five-minute background fetching for available registered projects, shared-directory exclusion, noninteractive authentication, backoff and safe shutdown
- Exact configured comparison Pull using merge, freshness-triggered Fetch, dirty-work refusal, stale-preview protection, actual Git conflict state and confirmed Continue/Abort
- Refresh distinguishes external edits from staged resolution and keeps pending MERGE_HEAD visible until the merge completes
- Same-name non-force Push on the saved remote, with a separate verified comparison-branch destination and explicit actual-recipient confirmation
- Project Settings with bounded canonical starting-folder selection, searchable project/global skills, saved adapter, exact digest/settings/folder/target validation and visible agent failures/permission denials
- System theme with live OS changes and persistent manual overrides; keyboard controls, saved pane widths and narrow-screen drawers remain available
- Durable comments, conservative attachment/export and backend history; native launcher/demo/smoke, Docker configuration and sanitized source packaging remain available

## Final verification

- `pnpm test --maxWorkers=2`: **616 tests passed in 59 files**
- `pnpm typecheck`: passed
- `pnpm build`: passed
- `pnpm smoke:native`: passed against the real CLI and authenticated loopback HTTP service
- Native smoke covers prior Git/comment/security workflows plus synchronization and agent-settings persistence, conflict source display, external edit/stage refresh, confirmed merge Continue and Abort
- Focused and final cross-feature reviews have no unresolved P1/P2 findings
- Tested runtime: Linux, Node 24.19.0, pnpm 11.19.0, Git 2.52.0

The existing Vite large-bundle advisory and React fixture `act` warnings remain. Tests use owned synthetic repositories, local bare remotes and fixture agent/native-dialog processes. No live provider or authenticated user remote was used for verification.

## Verification limits and conservative behavior

- Final rendered browser geometry and Obsidian webview compatibility remain unverified; the approved mockups are design references, not live app screenshots
- Actual macOS folder-dialog and permission behavior is unverified; process/UI fixtures cover the bridge
- Docker runtime validation is unavailable because this environment has no Docker engine
- Live provider execution and authenticated HTTPS/SSH Fetch/Pull/Push remain unverified
- OpenCode execution requires verified version 1.18.31; unsupported versions fail closed
- Worktree-specific remote overrides and custom merge/filter/encoding behavior require normal Git; shared remotes and validated tracking aliases are supported
- Unsupported authentication commands, unsafe metadata, symlink/submodule trees and other conservative Git refusals remain visible; there is no force push/reset, automatic stash/rebase or automatic conflict resolution
- Agent run/output recovery is session-local across project navigation; raw output and prompts are not persisted

See README.md for installation, native/Docker launch, folder/skill boundaries, synchronization and conflict workflows.
