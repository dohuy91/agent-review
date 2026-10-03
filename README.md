# Agent Review

A local Git reviewer with syntax diffs, durable line/range comments, reviewed marks, and skill profile configuration. Phase 1 never executes skills or agents.

Requires Node **22.22.0 or newer**, pnpm **10+**, and Git on PATH. Tested with Node 22.22.0 and pnpm 10.31.0.

```sh
pnpm install --frozen-lockfile
pnpm build
REVIEW_DATA_DIR=/absolute/private/review-state pnpm start /absolute/path/to/repository --base main --mode full --no-open
```

`pnpm exec review-app` exposes the same CLI without global installation. `pnpm dev <path> --base <ref> --no-open` runs the TypeScript server; rebuild with `pnpm build` after changing the web UI. Default port is 7373; `--port 7384` selects another. Without `--base`, the UI starts with HEAD: choose a local branch/base in the toolbar to include committed branch changes. Modes: branch compares merge-base to HEAD, working compares index to worktree, staged compares HEAD to index, full compares merge-base to worktree. `--mode` chooses the initial mode.

Explicitly supply an existing Git worktree with a commit. Additional roots can be explicitly registered in the left sidebar. Branch/base selection changes comparison without checking out files. The process binds only 127.0.0.1. Open the printed launch URL locally; its fragment contains a private one-time session token. Do not share the URL or terminal output. The browser removes the fragment after exchanging it for an HttpOnly SameSite session cookie; restart requires a fresh launch URL. Ctrl+C closes the process and database.

State defaults to `~/.local/share/agent-review/review.sqlite`. Set `REVIEW_DATA_DIR` to a private directory **outside every reviewed root**, including the demo root. State contains comment bodies, hashes and target metadata, reviewed fingerprints, and profile configuration; it does not store source snapshots or diffs. Back up the state directory only while the app is stopped. Comment text and exported local paths may themselves be sensitive.

Use light/dark and unified/split controls in the toolbar. Select an old/new line gutter, then Shift-click another line on the same side to comment on a range. Comments support severity, edit, resolve/reopen, delete, This file/All notes, current/outdated anchors and historical availability. Historical availability indicates an existing Git blob; Phase 1 does not expose historical source reconstruction. Profiles accept an explicit skill locator and SHA256 digest: project defaults are overridden by branch, then exact worktree+branch; each change advances the durable revision. No Send to agent action exists.

Keyboard: j/k select files, n/p select hunks, c opens comments, r toggles reviewed, ? shows help, Escape dismisses compose/dialog. Navigation shortcuts leave typing alone. Narrow layouts support 700px minimum using project/change drawer buttons. Appearance preferences are session-local.

## Export saved comments

Stop the app first for a stable snapshot, then choose a **new** output path:

```sh
REVIEW_DATA_DIR=/absolute/private/review-state pnpm exec review-app /absolute/path/to/repository --export-comments /absolute/private/comments.json
```

No server or browser starts. Export uses the latest saved comment's base and mode; without comments it uses HEAD/full. Launch flags (`--base`, `--mode`, `--port`, `--no-open`) cannot accompany export. All comments for the registered worktree are included, with current/outdated attachment evaluated against that context. Restore missing base Git objects before exporting. Existing output paths are refused (including symlinks); choose another filename. JSON schemaVersion 1 includes exact target root/IDs/branch/HEAD/base/merge-base/mode/fingerprint, original old/new ranges, severity/status, hash anchors, attachment/history status, and effective profile/config revision. It excludes source bodies, diffs and snapshots, apart from intentional user-authored comment text.

## Synthetic demo and portable source

Use a new directory; the script refuses existing directories, writes only synthetic files, makes local commits and never uses the network:

```sh
pnpm demo /tmp/agent-review-demo
REVIEW_DATA_DIR=/tmp/agent-review-demo-state pnpm start /tmp/agent-review-demo --base demo-base --mode full --no-open
```

The demo includes committed TypeScript changes, a staged deleted file/CSS change and an unstaged TypeScript change. Switch staged/working/branch/full to inspect each comparison. Keep its state separate from the demo root.

After committing source changes, create a portable source bundle from tracked HEAD (uncommitted changes are excluded):

```sh
pnpm package:source /tmp/agent-review-source.tar.gz
```

Output must be outside the repository and must not exist. Git archive includes only tracked source; `.git`, dependencies, build outputs, `.superpowers`, databases and secrets are excluded by repository tracking rules. Extract in a separate directory, then run the install/build/start commands above. Do not expose localhost remotely or weaken session security to use another computer; run another local copy there.

## Verification and limits

```sh
pnpm test
pnpm typecheck
pnpm build
```

Binary, symlink, submodule and conflict files show an unsupported message instead of source diffs. Conservative anchors can become outdated after edits/renames. Reviewed marks clear when target fingerprints/mode/base change. Node's SQLite API emits an experimental warning on Node 22. Obsidian webview compatibility remains unverified. Vite reports a large CodeMirror bundle warning; it does not prevent building.

## Docker

Docker is an additional launch option. The pinned multi-stage image uses official Node 22.22.0 with Debian trixie (Git supports the guarded read commands), frozen pnpm 10.31.0 installation and a built web UI. The runtime uses an unprivileged `reviewer` user. Native launch still binds 127.0.0.1; `--container` explicitly binds 0.0.0.0 inside the container and disables browser opening. Host, exact Origin, token and session checks remain local-only. Keep the container port at 7373 and publish **127.0.0.1:7373:7373**.

Supply a canonical absolute repository path (`pwd -P`), readable by the runtime user, and mount only that root read-only. Keep state on a separate named volume:

```sh
REVIEW_REPO=/absolute/path/to/repository
# Default UID/GID 10001; Linux hosts with private files can use their own numeric IDs.
docker build --build-arg REVIEW_UID="$(id -u)" --build-arg REVIEW_GID="$(id -g)" -t agent-review:local .
docker volume create agent-review-state
docker run --name agent-review --cap-drop=ALL --security-opt=no-new-privileges \
  -p 127.0.0.1:7373:7373 \
  --mount "type=bind,source=$REVIEW_REPO,target=$REVIEW_REPO,readonly" \
  --mount type=volume,source=agent-review-state,target=/state \
  agent-review:local "$REVIEW_REPO" --base main --mode full
# Private launch URL appears in logs; open it locally.
docker logs agent-review
docker stop agent-review
# Restart preserves notes, but requires the fresh launch URL/session.
docker start agent-review
```

Build UID/GID must be positive nonroot numbers. A new empty named volume inherits `/state` ownership and mode 0700 from the image. Keep the same build UID/GID when reusing it. If an existing volume needs ownership repair, stop the service and explicitly initialize **only that state volume** with an administrative container; never change ownership of repository files:

```sh
docker run --rm --user 0:0 --entrypoint sh \
  --mount type=volume,source=agent-review-state,target=/state \
  agent-review:local -c 'chown -R reviewer:reviewer /state && chmod 700 /state'
```

Bind-mounted state directories instead require you to create a private directory outside the repository with matching UID/GID on the host. Repository readability is the host's responsibility; do not mount the Docker socket, home directory, or a broader source parent. The container entrypoint trusts ownership only for the exact canonical launch root using `safe.directory`; it never adds wildcard trust. For additional UI-registered roots, use matching ownership or explicitly configure only that mounted canonical path inside the container.

Compose uses the same absolute path on both sides, refuses to create missing host directories, and provides a separate persistent state volume:

```sh
export REVIEW_REPO=/absolute/path/to/repository
export REVIEW_UID="$(id -u)" REVIEW_GID="$(id -g)"
docker compose up --build -d
docker compose logs review
docker compose stop
# Keep volumes for durable comments; do not use down -v unless discarding notes.
```

Linked worktrees have `.git` files pointing at metadata outside the worktree. On the host run `git -C "$REVIEW_REPO" rev-parse --absolute-git-dir` and `git -C "$REVIEW_REPO" rev-parse --path-format=absolute --git-common-dir`. Add explicit read-only mounts for those paths at the **same absolute paths** inside the container (mounting the common directory also covers an enclosed gitDir). For `docker run`, add `--mount "type=bind,source=/exact/common/.git,target=/exact/common/.git,readonly"`; for Compose add a bind entry with the exact source/target, `read_only: true`, and `bind.create_host_path: false` in a local override. Do not relocate or rewrite `.git`. Missing metadata causes an actionable startup refusal; no automatic parent mount or filesystem escape is attempted.

After the pnpm workspace install, plain npm launch commands also work:

```sh
pnpm install --frozen-lockfile
npm run build
REVIEW_DATA_DIR=/absolute/private/review-state npm start -- /absolute/path/to/repository --no-open
npm run demo -- /tmp/new-review-demo
```

`npm install` alone is not the installation path for this pnpm workspace (`workspace:*`). Build still requires pnpm on PATH. To verify an actual Docker engine against an owned synthetic repository, run `node scripts/docker-smoke.mjs` from the project root. It builds an image, checks diff access, rejected Host/Origin/token, old-side range persistence across restart, read-only source and unchanged Git metadata, nonroot UID/private state permissions, and loopback publishing. It removes only its generated fixture/container/image/volume. Port 7373 must be free. Docker image build and runtime smoke were **not verified on the authoring Mac**, which has no running Docker engine.
