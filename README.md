# Agent Review

A local Git reviewer with syntax diffs, durable line/range comments, reviewed marks, persistent projects, installed-agent workflows, and explicit Git controls. Offline review needs no provider account or remote authentication.

Requires Node **22.22.0 or newer**, pnpm **10+**, and Git on PATH. Native development checks have run with Node 22.22.0/pnpm 10.31.0 and Linux Node 24.19.0/pnpm 11.19.0.

```sh
pnpm install --frozen-lockfile
pnpm build
REVIEW_DATA_DIR=/absolute/private/review-state pnpm start /absolute/path/to/repository --base main --mode full --no-open
```

`pnpm exec review-app` exposes the same CLI without global installation. `pnpm dev <path> --base <ref> --no-open` runs the TypeScript server; rebuild with `pnpm build` after changing the web UI. Default port is 7373; `--port 7384` selects another. Without explicit `--base` or `--mode`, the UI restores that worktree’s last successful live comparison (HEAD/full for a new root): choose the local branch and remote comparison base in the toolbar to include committed branch changes. Branch mode compares the merge-base of the chosen endpoints through the local branch commit. Working compares index to worktree, Staged compares HEAD to index, and Full compares merge-base to worktree. Mutable modes apply only to the checked-out branch. `--mode` chooses the initial mode.

Explicitly supply an existing Git worktree with a commit. Additional roots can be explicitly registered using Open repository. Registered roots, their physical directory identities, last selection, and last successful live base/mode are saved locally. Restart restores only previously authorized canonical roots with matching physical identities; missing/unmounted, aliased, or replaced roots are shown as unavailable and their saved records/notes are retained. Explicitly reopening a root through the CLI or UI authorizes its current identity. The explicit CLI launch root takes precedence over the saved selection; explicit `--base` and `--mode` take precedence for the initial launch. After a successful live comparison, browser reload uses the current accepted base/mode instead of reapplying launch flags. The remote/base selector changes comparison; selecting another local branch uses the guarded checkout flow described below. The process binds only 127.0.0.1. Open the printed launch URL locally; its fragment contains a private per-launch reusable, bounded bootstrap token (up to 32 session exchanges). Do not share the URL or terminal output. The browser removes the fragment after exchanging it for an HttpOnly SameSite session cookie; restart requires a fresh launch URL. Ctrl+C closes the process and database.

State defaults to `~/.local/share/agent-review/review.sqlite`. Set `REVIEW_DATA_DIR` to a private directory **outside every reviewed root**, including the demo root. State contains user-authored comment bodies, hash anchors and target metadata, reviewed fingerprints, profile configuration, and metadata-only agent/review/project history and comparison preferences. It does not persist source snapshots, diffs, prompts, raw agent logs, or credentials. Live agent output is bounded and transient; it is not recoverable after restart. Back up the state directory only while the app is stopped. Comment text and exported local paths may themselves be sensitive.

The left pane shows changed files as a folder tree, including added/deleted line counts, status, review marks and comment counts. Unknown binary/unsupported counts are shown without inventing line totals. Use the project tabs across the top to switch projects; full paths distinguish repositories with the same folder name. The plus tab opens the folder chooser on the server machine and registers only the folder you explicitly select after Git validation. Comparison context and comment drafts remain scoped to the selected project.

The top local and remote branch controls search their respective inventories as you type. Arrow keys and Enter select an exact branch; Escape cancels search. The remote side lists remote-tracking branches across configured remotes, without symbolic HEAD aliases. Advanced base selection in Settings accepts an explicit local ref or commit. Remote selection changes the comparison. Pull, split Push, Fix with Agent and Settings follow the branch selectors. Refresh files sits directly left of Unified/Split, and Fetch is at bottom right.

With writes enabled, selecting a different local branch switches the actual checkout. Clean branches switch directly. With local changes, a dialog preselects **Stash & switch** but waits for confirmation; **Commit & switch** lets you choose staged files and supply a required message, or **Cancel** leaves the branch and work unchanged. A commit that leaves other changes does not switch: choose a new explicit stash decision or cancel. Stash includes staged, unstaged and untracked files, excludes ignored files, and retains its exact object ID and source branch for recovery. The app never automatically reapplies or drops a stash. Active agent processes, conflicts, another worktree using the branch, and unsupported repository layouts block switching. The guarded switch supports regular-file trees up to 20,000 paths and 64 MiB of inspected source; symlink/submodule trees, sparse or assume-unchanged entries, and conversion-filter configurations require normal Git. A registered occupied worktree can be opened explicitly. Force checkout and automatic commits are unavailable.

Use the theme and unified/split controls in the toolbar. Theme defaults to System and follows the operating system’s light/dark setting as it changes; explicit Light or Dark choices override it and survive browser reload. Existing saved Light/Dark choices are retained. Select an old/new line gutter, then Shift-click another line on the same side to comment on a range. Selecting the line or range immediately opens and focuses the inline editor below it, without an extra reveal button. It shares its draft with the right-pane composer. Saved inline markers and right-side threads share edit, resolve/reopen and delete actions. Nonempty drafts keep their original range until you explicitly retarget them; refresh preserves the text but may require selecting current lines again. The right pane contains collapsible review comments only. File actions and selected-index commit controls remain available from the file toolbar. **Fix with Agent** has one top-toolbar entry point, and **Settings → Agents** contains the per-project starting folder, adapter and searchable skill selection. Historical source is never reconstructed from uncommitted snapshots; backend historical comparisons require retained Git objects and remain read-only.

Drag the main pane dividers to resize the file tree and right pane. Width preferences survive reload/restart in the same browser; viewport fitting keeps the center usable. Focus a divider and use arrow keys (Shift for larger steps), or Home/double-click to reset. Narrow layouts retain the 700px minimum and drawer controls. Collapsing a right-side section preserves its mounted form state.

Keyboard defaults: j/k select files, n/p select hunks, c opens comments, r toggles reviewed, ? opens shortcut settings, Escape dismisses compose/dialog. Settings validate configurable keys and reject collisions. Git shortcuts are initially unassigned and can be configured explicitly. Commands leave inputs, editable fields, and CodeMirror alone and pause while a dialog is open. Theme, split/unified view, shortcut settings and pane widths are versioned browser-local preferences.

On native macOS, Open repository offers an explicit system folder dialog; cancellation adds nothing. On Linux, the in-app folder browser defaults to the canonical parent of the launched repository when it is a suitable project location. Use repeated `--browse-root /absolute/project/location` arguments to choose other bounded locations. Broad system roots, virtual filesystems, hidden/system folders, symlinks and paths escaping those roots are unavailable. The directory API lists folders only and never reads file contents or automatically grants a reviewed repository. Docker starts with the exact mounted launch repository as its chooser location; add explicit same-path mounts and `--browse-root` for other locations. Folder selection always happens on the server machine; browser directory-upload APIs are not used. The macOS bridge is covered by process fixtures, but its actual OS dialog and permission behavior have not been exercised in the cloud workspace.


## Git actions and remote metadata

Stage/Unstage file always target the exact selected current path. Stage hunk is available only in Working; Unstage hunk only in Staged. Unsupported kinds, renames or non-lossless text may require a whole-file action or normal Git. A no-op is reported as no index changes. Native launches enable these local writes by default; Docker disables writes unless explicitly opted in.

Discard first shows an exact worktree/path, branch, full HEAD, Git directories and review fingerprint. Confirm discard is a separate destructive action. For tracked files, unstaged changes are replaced by the staged/index version, never an arbitrary comparison base. For a genuinely untracked regular file, the file is deleted and Git cannot restore it. Stale/expired previews must be refreshed before retrying.

In Staged, check the explicit paths and write a commit message. Commit selected uses only those current-index bytes, preserves other staged and unstaged changes, and requires an attached local branch plus configured Git user.name/user.email. Current-repository changes invalidate old targets; drafts remain available while line selections must be renewed after refresh. Foreign index locks and conservative filesystem/configuration refusals require resolving the underlying Git condition, rather than bypassing checks.

Remote metadata shows existing configured names and sanitized effective HTTPS/SSH destinations. The bottom-right **Fetch** refreshes all eligible configured remotes, updates their status and refreshes comparison data. It does not checkout, merge, push, prune or change the local branch, worktree or index. Offline comparison stays available without Fetch.

**Settings → Git** contains the app-wide auto-fetch switch and per-project default Push remote. Auto-fetch runs every five minutes while the app server is running, for available registered projects. It skips unavailable roots, prevents overlapping fetches in the same common Git directory, and backs off failures. Last attempt, successful fetch and sanitized failure metadata persist across restart. Background and manual fetch are noninteractive; configure existing credentials and SSH host trust separately. Authentication failures are visible and do not trigger hidden prompts. Read-only launches do not fetch.

**Pull** merges the selected remote-tracking comparison into the actual current local branch. If that remote has no successful fetch or its latest success is older than five minutes, Pull fetches first, revalidates the targets, then shows an exact confirmation. The operation uses merge, never rebase. Dirty work blocks with guidance to save or stash it explicitly; no automatic stash, commit, reset or conflict resolution occurs.

A conflicted merge keeps local work and displays **Merge paused**, a **Conflicts** file group and per-file badges. Resolve the files and stage their resolutions using normal Git, then click Refresh files. Refresh reloads actual Git state as well as the file list and diff. Merely editing/removing conflict markers leaves the path unresolved until it is staged. Once all unmerged index entries are gone, the banner still shows the pending merge and enables a separately previewed **Continue merge**. **Abort merge** also requires explicit confirmation of the current merge state. Stale or changed states must be refreshed and previewed again.

Remotes overridden through worktree-specific Git configuration are explicitly ineligible for app Fetch/Pull; shared configured remotes remain supported. Custom merge/filter/encoding attributes, unsupported metadata layouts or custom authentication commands can require normal Git. These refusals are shown rather than silently weakening the safety checks.

Live authenticated HTTPS/SSH Fetch, Pull and Push have not been verified; availability metadata is not proof of working credentials.

The main **Push** button defaults to the current local branch name on the saved configured remote. The adjacent arrow exposes **Push to comparison branch** as a separate option, available only when the current remote-tracking base maps unambiguously to a configured remote branch. Local/commit advanced bases do not imply a push destination. The preview shows the actual push recipient (which may differ from the fetch URL), source commit, destination branch, observed remote commit and outgoing branch-relative commits. Different destination names and commonly protected branch names are highlighted; server-side protection still applies.

Preview explicitly inspects the remote using existing HTTPS/SSH authentication. Only **Confirm push** sends one exact non-force branch update. It does not push tags/all branches, change tracking configuration, delete branches, or push agent results automatically. The one-use plan expires after five minutes and is rejected when source/index/refs/config/recipient/remote tip changes. Missing remote-tip objects require an explicit fetch; divergent history must be reconciled in Git. A lost acknowledgment is reported as uncertain: inspect the remote before making another attempt. There is no automatic retry, force-push or pull-request feature. Tests use disposable local transports; live authenticated Push/Fetch remains unverified.

Browser navigation shares one latest-intent order across root selection, registration and comparison context. Successfully registered roots may remain in inventory after dismissal; an older/dismissed registration cannot switch the selected root. For API clients, GET /api/repositories adds navigationRevision. An optional positive monotonic X-Review-Navigation header orders registration, selection and live-review requests even if delivery/handlers are reordered. Versioned registration adds inventory only; selection uses the existing empty PUT /api/repositories/:id/selection body and returns {ok, accepted, navigationRevision}. A stale selection is a no-op. Unversioned local clients remain supported using request-admission order. The existing session/Host/Origin/root boundaries still apply.

## Installed agents and fix skills

Install Codex, Claude or OpenCode using the provider’s official distribution and make its executable available on PATH. The app displays executable/version availability. This does not prove that credentials, provider routing, quota, runtime access or a permission request will succeed. Provider identity can remain unknown when it is controlled by the local CLI’s settings. Normal provider permission denials are reported as needs-attention; the app does not bypass approval or sandbox rules. Stop terminates the owned run, and restart marks unfinished runs interrupted. Known run handles and Stop controls stay with their original project across tab changes; returning reconnects the current status and bounded output. Permission denials and failed runs remain visible even after the launch dialog closes.

In **Settings → Agents**, choose a starting folder within the current registered worktree, an installed adapter, and a skill. The folder chooser is bounded to that worktree and rejects symlink escapes, nested repositories and changed folder identities. Search groups skills by Project and Global source. Project discovery is bounded to skill directories beneath the chosen folder; global discovery uses ~/.codex/skills, ~/.agents/skills and explicit `--skills-dir /absolute/exact/skills` roots. Settings save per project without storing credentials.

The confirmation shows the actual cwd, branch, provider and exact selected skill. The starting-folder identity, settings revision, SHA-256 skill digest, HEAD, branch, index and source are checked again before execution. A folder in another linked worktree is not silently substituted. The legacy profile API retains project → branch → exact worktree+branch overrides for existing clients. There is no fallback skill or permission bypass.

Only explicit Send to agent executes the selected installed agent. Its prompt includes the approved target, skill and selected review context, which that CLI may transmit to its configured provider. Review data is otherwise local. Do not use real source/provider credentials for synthetic verification. No raw prompt or agent output is persisted by this app.

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

Output must be outside the repository and must not exist. The command pins committed HEAD and filters known private coordination, credential/state, dependency and build-output paths, even if accidentally tracked. It refuses unsupported nonregular source entries and never overwrites an existing output. Inspect your own tracked sources before packaging: filename filters cannot identify arbitrary secrets inside ordinary code. Extract in a separate directory, then run the install/build/start commands above. Do not expose localhost remotely or weaken session security to use another computer; run another local copy there.

## Verification and limits

```sh
pnpm test
pnpm typecheck
pnpm build
pnpm smoke:native
```

The native smoke creates and removes its own synthetic repository and state, launches the real CLI on an ephemeral loopback port, and verifies session checks, source/index actions, comments, restart persistence, folder browsing, counts, clean/stash switching, synchronization and agent-settings persistence, external conflict edit/stage refresh, and confirmed merge Continue/Abort. It makes no provider or remote Git calls. It does not automate a native macOS folder dialog; that requires a manual check. The smoke has been run on Linux with Node 24.19.0 and Git 2.52.0.

Binary, symlink and submodule files show an unsupported message instead of source diffs. Working and Full modes can display bounded regular UTF-8 conflict worktree contents with actual new-side line numbers; staged conflict source is unavailable because there is no single staged version. Unsafe, missing, oversized and malformed conflict source is withheld. Conservative anchors can become outdated after edits/renames. Reviewed marks clear when target fingerprints/mode/base change. Node's SQLite API emits an experimental warning on Node 22. Obsidian webview compatibility remains unverified. Vite reports a large CodeMirror bundle warning; it does not prevent building.

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
# Restart preserves registered projects, comparison metadata and notes with the same state volume and explicit mounts, but requires the fresh launch URL/session.
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
# Keep volumes for durable projects/history/comments; do not use down -v unless discarding notes.
```

Linked worktrees have `.git` files pointing at metadata outside the worktree. On the host run `git -C "$REVIEW_REPO" rev-parse --absolute-git-dir` and `git -C "$REVIEW_REPO" rev-parse --path-format=absolute --git-common-dir`. Add explicit read-only mounts for those paths at the **same absolute paths** inside the container (mounting the common directory also covers an enclosed gitDir). For `docker run`, add `--mount "type=bind,source=/exact/common/.git,target=/exact/common/.git,readonly"`; for Compose add a bind entry with the exact source/target, `read_only: true`, and `bind.create_host_path: false` in a local override. Do not relocate or rewrite `.git`. Missing metadata causes an actionable startup refusal; no automatic parent mount or filesystem escape is attempted.

### Explicit writable container override

The default compose.yaml keeps repository mounts read-only and never passes `--enable-writes`. A writable mount alone does not enable app writes, and `--enable-writes` alone cannot make a read-only mount writable. For an owned worktree, opt in to both explicitly:

```sh
export REVIEW_REPO=/absolute/path/to/owned/repository
export REVIEW_UID="$(id -u)" REVIEW_GID="$(id -g)"
docker compose -f compose.yaml -f compose.writable.yaml up --build -d
```

compose.writable.yaml changes only the exact repository mount to read/write and passes `--enable-writes`; the retained review-state volume is unchanged. Linked worktrees additionally need exact same-path read/write mounts of the Git metadata destinations identified above. Never mount a broader source parent. To restore previously added projects after a container restart, retain the state volume and provide the same explicit root and linked-metadata mounts; unavailable mounts remain visible without granting access to another root. Changed filesystem identities require explicit reopening.

The shipped image contains Git and this app, not provider CLIs or installed skills. An operator-controlled image may install official provider CLIs; mount only exact skill directories read-only and explicitly pass repeated `--skills-dir` arguments. Container default skill roots are empty. Writes/Send remain disabled without `--enable-writes`, even if an agent executable is present.

The default image/Compose files bundle no credentials, host home directory, private SSH keys, SSH agent socket or Docker socket. Fetch and provider authentication inside Docker require a separate, explicit operator-controlled setup. Host OS credential helpers may not exist or function in the container. A permitted SSH setup may expose only an exact existing agent socket and exact known_hosts/config files with the required environment; this still grants the container use of that agent’s identities, so review the exposure. HTTPS requires an available trusted helper and only its necessary configuration/data. Use least-privilege exact mounts/environment in a private local override; never bake secrets into the image/source bundle or mount a whole home directory. Host UID/GID, file permissions, host-key trust, helper behavior and noninteractive authentication are the operator’s responsibility. Existing local auth does not guarantee container auth works; live container HTTPS/SSH/provider auth remains unverified.

After the pnpm workspace install, plain npm launch commands also work:

```sh
pnpm install --frozen-lockfile
npm run build
REVIEW_DATA_DIR=/absolute/private/review-state npm start -- /absolute/path/to/repository --no-open
npm run demo -- /tmp/new-review-demo
```

`npm install` alone is not the installation path for this pnpm workspace (`workspace:*`). Build still requires pnpm on PATH. To verify an actual Docker engine against an owned synthetic repository, run `node scripts/docker-smoke.mjs` from the project root. It builds an image, checks diff access, rejected Host/Origin/token, old-side range persistence across restart, read-only source and unchanged Git metadata, nonroot UID/private state permissions, and loopback publishing. It removes only its generated fixture/container/image/volume. Port 7373 must be free. Docker image build and runtime smoke remain **unverified**: neither the authoring Mac nor the cloud verification workspace provided a running Docker engine.
