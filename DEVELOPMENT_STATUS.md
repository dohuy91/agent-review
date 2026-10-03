# Development status

Updated: 2026-10-03 (UTC). This is an in-progress build, not the final release.

## Implemented and checked

- Local Git review: branch, working, staged, and full comparisons; unified/split diffs; light/dark themes; line/range comments; reviewed marks; durable SQLite metadata; comment export
- Feedback workflow: explicit Send/Stop, exact worktree and skill validation, live repository refresh, and bounded transient provider output
- Codex, Claude Code, and OpenCode adapter contracts with fixture-tested completion, failure, permission-denial, and cancellation behavior
- Conservative Git-proven rename attachment and metadata-only review/run history; retained branch comparisons reopen their original Git endpoints read-only
- OpenCode public sharing disabled for each run; only verified OpenCode version 1.18.31 is currently accepted, with the installed version checked again before execution
- Native launcher, synthetic demo, Docker configuration, and a Docker smoke-test script

## Verification at this milestone

Code milestone: `a4499102a9bb3a5d93dd85f6c7ccfbc8efd92084`

- `pnpm test`: 148 tests passed across 16 test files
- `pnpm typecheck`: passed
- `pnpm build`: passed; the existing large JavaScript bundle warning remains
- Tested environment: Linux, Node 24.19.0, pnpm 11.19.0, Git 2.52.0

## Next milestones

1. Safe local Git actions: file/hunk stage and unstage, previewed discard, selected-file commit, and explicit HTTPS/SSH remote fetch
2. Git-action UI, persistent project navigation, configurable shortcuts, and updated native/Docker usage documentation
3. Final integration checks and portable source packaging

## Known verification limits

- Provider tests use local fixtures. Live provider authentication, permissions, and source transmission have not been exercised
- Docker image/runtime checks have not run because no Docker engine is available in the current test environment
- Final end-to-end browser and Obsidian webview checks remain unverified
- Historical uncommitted source is not stored or reconstructed; missing Git objects produce an unavailable result

The README still includes earlier-stage descriptions and will be refreshed with the remaining UI and launch documentation milestone.
