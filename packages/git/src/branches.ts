import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Repository, ReviewObservation } from "../../shared/src/index.js";
import type {
  BranchSwitchDirty,
  BranchSwitchFailure,
  BranchSwitchPreview,
  BranchSwitchPreviewRequest,
  BranchSwitchRequest,
  BranchSwitchResult,
  BranchSwitchStash,
} from "../../shared/src/branch-switch.js";
import { git, gitText, readIndexBytes, validPath } from "./git.js";
import { commitSelected } from "./commit.js";
import { getReview, StaleReviewError } from "./review.js";
import {
  exactText,
  GitActionError,
  RepositoryQueue,
  validateIdentity,
  validateWriteDestinations,
  writeBranchGit,
} from "./mutations.js";
import { fingerprint } from "../../review/src/fingerprint.js";

const TTL = 5 * 60 * 1000,
  PATH_LIMIT = 20000,
  BYTE_LIMIT = 64 * 1024 * 1024;
export class BranchSwitchError extends GitActionError {
  constructor(
    message: string,
    public reason: BranchSwitchFailure["reason"] = "unsupported",
    statusCode = 409,
    public recovery: Partial<
      Pick<
        BranchSwitchFailure,
        "stash" | "commit" | "remainingDirty" | "outcome" | "actual"
      >
    > = {},
  ) {
    super(message, statusCode);
  }
  response(): BranchSwitchFailure {
    return {
      error: this.message,
      reason: this.reason,
      outcome:
        this.recovery.stash || this.recovery.commit
          ? "saved-not-switched"
          : "not-switched",
      ...this.recovery,
    };
  }
}
type Access = (
  id: string,
  reviewId: string,
) => Promise<{ repository: Repository; observation: ReviewObservation }>;
interface Options {
  queue: RepositoryQueue;
  repositories: Map<string, Repository>;
  assertIdle: (repositoryId: string) => Promise<void> | void;
  now?: () => number;
}
interface TreeEntry {
  path: string;
  mode: string;
  oid: string;
}
interface Snapshot {
  from: { branch: string; head: string };
  target: { branch: string; head: string };
  dirty: BranchSwitchDirty;
  occupied?: BranchSwitchPreview["occupied"];
  stamp: string;
}
interface Plan {
  preview: BranchSwitchPreview;
  snapshot: Snapshot;
  staged: ReviewObservation;
  expires: number;
}
const isDirty = (dirty: BranchSwitchDirty) =>
  Object.values(dirty).some((paths) => paths.length > 0);

async function directBranch(repo: Repository, ref: string): Promise<string> {
  if (
    !ref.startsWith("refs/heads/") ||
    ref.slice("refs/heads/".length).startsWith("-") ||
    ref.length > 4096 ||
    /[\x00-\x20\x7f]/.test(ref)
  )
    throw new BranchSwitchError(
      "Select an exact existing local branch",
      "unsupported",
      400,
    );
  try {
    await git(repo.root, ["check-ref-format", ref]);
    await git(repo.root, [
      "check-ref-format",
      "--branch",
      ref.slice("refs/heads/".length),
    ]);
  } catch {
    throw new BranchSwitchError(
      "Select a valid local branch",
      "unsupported",
      400,
    );
  }
  const rows = exactText(
    await git(repo.root, [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)",
      ref,
    ]),
  )
    .split("\n")
    .map((line) => line.split("\0"));
  const entry = rows.find(([name]) => name === ref);
  if (
    !entry ||
    entry[2] !== "commit" ||
    entry[3] ||
    !/^[a-f0-9]{40,64}$/.test(entry[1]!)
  )
    throw new BranchSwitchError(
      "Select an existing direct local branch; symbolic aliases are unsupported",
      "unsupported",
      400,
    );
  return entry[1]!;
}
function checkedPath(path: string) {
  try {
    validPath(path);
  } catch {
    throw new BranchSwitchError("Repository paths are unsafe or unsupported");
  }
  if (
    path
      .split("/")
      .some((part) => part.toLowerCase() === ".git" || part.includes("\\")) ||
    /[\x00-\x1f\x7f]/.test(path)
  )
    throw new BranchSwitchError("Repository paths are unsafe or unsupported");
}
async function tree(repo: Repository, oid: string): Promise<TreeEntry[]> {
  const records = exactText(
    await git(repo.root, ["ls-tree", "-rz", "--full-tree", oid]),
  )
    .split("\0")
    .filter(Boolean);
  if (records.length > PATH_LIMIT)
    throw new BranchSwitchError(
      "Branch tree exceeds the safe inspection limit",
    );
  return records.map((record) => {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(
      record,
    );
    if (!match || !["100644", "100755"].includes(match[1]!))
      throw new BranchSwitchError(
        "Branch switching currently supports regular files only; use Git for symlinks or submodules",
      );
    checkedPath(match[4]!);
    return { mode: match[1]!, oid: match[3]!, path: match[4]! };
  });
}
async function status(repo: Repository): Promise<BranchSwitchDirty> {
  const raw = exactText(
    await git(repo.root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
      "--no-renames",
    ]),
  );
  const dirty: BranchSwitchDirty = { staged: [], unstaged: [], untracked: [] };
  const rows = raw.split("\0").filter(Boolean);
  if (rows.length > PATH_LIMIT)
    throw new BranchSwitchError("Worktree exceeds the safe inspection limit");
  for (const row of rows) {
    if (!/^[ MADRCU?!]{2} /.test(row))
      throw new BranchSwitchError("Git status cannot be verified");
    const code = row.slice(0, 2),
      path = row.slice(3);
    checkedPath(path);
    if (code.includes("U") || ["AA", "DD"].includes(code))
      throw new BranchSwitchError(
        "Resolve conflicts before switching branches",
      );
    if (code === "??") dirty.untracked.push(path);
    else {
      if (code[0] !== " ") dirty.staged.push(path);
      if (code[1] !== " ") dirty.unstaged.push(path);
    }
  }
  return dirty;
}
async function optionalStat(path: string) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
/** Refuse existing aliases/shared append destinations and in-progress operations.
 * This is a repeated preflight; Git owns its normal index/ref locks at execution. */
async function metadata(
  repo: Repository,
  source: string,
  target: string,
  ownedIndexLock = false,
) {
  await validateWriteDestinations(repo, { branch: source });
  await validateWriteDestinations(repo, { branch: target });
  for (const ref of ["refs/stash", "ORIG_HEAD"]) {
    let symbolic = false;
    try {
      await git(repo.root, ["symbolic-ref", "--quiet", "--no-recurse", ref]);
      symbolic = true;
    } catch (error) {
      if ((error as { code?: number }).code !== 1) throw error;
    }
    if (symbolic)
      throw new BranchSwitchError(
        "Stash or reset bookkeeping references are symbolic; repair them with Git before switching",
      );
  }
  for (const [root, paths] of [
    [
      repo.gitDir,
      ["HEAD", "index", "logs/HEAD", "ORIG_HEAD", "logs/ORIG_HEAD"],
    ],
    [
      repo.commonDir,
      ["refs/stash", "logs/refs/stash", "config", "config.worktree"],
    ],
  ] as const) {
    for (const path of paths) {
      let at = root;
      const parts = path.split("/");
      for (let index = 0; index < parts.length; index++) {
        at = join(at, parts[index]!);
        const s = await optionalStat(at);
        if (!s) break;
        if (
          s.isSymbolicLink() ||
          (await realpath(at)) !== at ||
          (index === parts.length - 1
            ? !s.isFile() || s.nlink !== 1n
            : !s.isDirectory())
        )
          throw new BranchSwitchError(
            "Git metadata contains an unsafe alias or shared write destination",
          );
      }
      if (
        !(ownedIndexLock && root === repo.gitDir && path === "index") &&
        (await optionalStat(join(root, path + ".lock")))
      )
        throw new BranchSwitchError(
          "Another Git operation holds a lock; finish it before switching",
          "busy",
        );
    }
  }
  for (const path of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "REBASE_HEAD",
    "BISECT_START",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
  ])
    if (await optionalStat(join(repo.gitDir, path)))
      throw new BranchSwitchError(
        "Finish the current merge, rebase, cherry-pick or bisect before switching",
        "busy",
      );
  const head = await open(
    join(repo.gitDir, "HEAD"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    if ((await head.readFile("utf8")) !== `ref: ${source}\n`)
      throw new BranchSwitchError("Actual worktree branch changed", "stale");
  } finally {
    await head.close();
  }
}
async function configuration(repo: Repository) {
  const raw = await git(repo.root, ["config", "--null", "--list"]);
  for (const row of exactText(raw).split("\0").filter(Boolean)) {
    const newline = row.indexOf("\n"),
      key = row.slice(0, newline).toLowerCase(),
      value = row.slice(newline + 1);
    if (
      (/^filter\..*\.(clean|smudge|process)$/.test(key) && value) ||
      (["core.sparsecheckout", "core.sparsecheckoutcone"].includes(key) &&
        !/^(false|no|off|0)$/i.test(value)) ||
      key === "core.alternaterefscommand"
    )
      throw new BranchSwitchError(
        "Custom filters, sparse checkouts or configured executable ref helpers require switching with Git",
      );
  }
  const tags = exactText(await git(repo.root, ["ls-files", "-v", "-z"]))
    .split("\0")
    .filter(Boolean);
  if (tags.some((entry) => !entry.startsWith("H ")))
    throw new BranchSwitchError(
      "Resolve conflicts, sparse or assume-unchanged index entries before switching",
    );
  return raw;
}
async function worktrees(
  repo: Repository,
  target: string,
  repositories: Map<string, Repository>,
) {
  const raw = exactText(
    await git(repo.root, ["worktree", "list", "--porcelain", "-z"]),
  );
  let record: Record<string, string> = {},
    occupied: BranchSwitchPreview["occupied"];
  for (const field of raw.split("\0")) {
    if (!field) {
      if (record.branch === target && record.worktree !== repo.root) {
        if (!record.worktree || !/^[a-f0-9]{40,64}$/.test(record.HEAD ?? ""))
          throw new BranchSwitchError(
            "Linked worktree identity cannot be verified",
          );
        const registered = [...repositories.values()].find(
          (r) => r.root === record.worktree && r.commonDir === repo.commonDir,
        );
        let repositoryId: string | undefined;
        if (registered) {
          const current = await validateIdentity(registered);
          if (current.branch === target && current.head === record.HEAD)
            repositoryId = registered.id;
        }
        occupied = {
          root: record.worktree,
          branch: target,
          head: record.HEAD!,
          ...(repositoryId ? { repositoryId } : {}),
        };
      }
      record = {};
      continue;
    }
    const space = field.indexOf(" ");
    record[space < 0 ? field : field.slice(0, space)] =
      space < 0 ? "" : field.slice(space + 1);
  }
  return { raw, occupied };
}
async function sourceStamp(
  repo: Repository,
  paths: string[],
  objectFormat: "sha1" | "sha256",
) {
  if (paths.length > PATH_LIMIT)
    throw new BranchSwitchError("Worktree exceeds the safe inspection limit");
  const hash = createHash("sha256"),
    files = new Map<string, { oid: string; mode: string }>();
  let bytes = 0;
  for (const path of paths.sort()) {
    checkedPath(path);
    hash.update(path + "\0");
    let at = repo.root;
    const parts = path.split("/");
    let stat = null;
    for (let index = 0; index < parts.length; index++) {
      at = join(at, parts[index]!);
      stat = await optionalStat(at);
      if (!stat) break;
      if (
        stat.isSymbolicLink() ||
        (index < parts.length - 1 && !stat.isDirectory()) ||
        (!stat.isFile() && !stat.isDirectory())
      )
        throw new BranchSwitchError(
          "Worktree paths contain symlinks or unsupported files",
        );
    }
    if (!stat) {
      hash.update("missing");
      continue;
    }
    hash.update(
      [
        stat.dev,
        stat.ino,
        stat.mode,
        stat.size,
        stat.mtimeNs,
        stat.ctimeNs,
      ].join(":"),
    );
    if (stat.isDirectory()) continue;
    if (stat.nlink !== 1n || Number(stat.size) + bytes > BYTE_LIMIT)
      throw new BranchSwitchError(
        "Shared files or an oversized worktree require switching with Git",
      );
    const handle = await open(at, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true });
      if (
        before.dev !== stat.dev ||
        before.ino !== stat.ino ||
        before.ctimeNs !== stat.ctimeNs
      )
        throw new StaleReviewError();
      const buffer = Buffer.alloc(Number(stat.size) + 1);
      let length = 0;
      while (length < buffer.length) {
        const result = await handle.read(
          buffer,
          length,
          buffer.length - length,
          length,
        );
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length !== Number(stat.size)) throw new StaleReviewError();
      const content = buffer.subarray(0, length);
      bytes += content.length;
      if (bytes > BYTE_LIMIT)
        throw new BranchSwitchError("Worktree exceeds the safe byte limit");
      hash.update(content);
      files.set(path, {
        oid: createHash(objectFormat)
          .update(`blob ${content.length}\0`)
          .update(content)
          .digest("hex"),
        mode: stat.mode & 0o111n ? "100755" : "100644",
      });
      const after = await optionalStat(at);
      if (
        !after ||
        after.dev !== stat.dev ||
        after.ino !== stat.ino ||
        after.ctimeNs !== stat.ctimeNs
      )
        throw new StaleReviewError();
    } finally {
      await handle.close();
    }
  }
  return { stamp: hash.digest("hex"), files };
}

export class BranchSwitchService {
  private plans = new Map<string, Plan>();
  private now: () => number;
  constructor(
    private access: Access,
    private options: Options,
  ) {
    this.now = options.now ?? Date.now;
  }
  private async idle(id: string) {
    try {
      await this.options.assertIdle(id);
    } catch {
      throw new BranchSwitchError(
        "An agent or execution is still active; wait for it to finish before switching",
        "busy",
      );
    }
  }
  private async snapshot(
    repo: Repository,
    targetRef: string,
    ownedIndexLock = false,
  ): Promise<Snapshot> {
    await this.idle(repo.id);
    const current = await validateIdentity(repo);
    if (!current.branch)
      throw new BranchSwitchError(
        "Check out a local branch before using branch switching",
      );
    const source = await directBranch(repo, current.branch),
      target = await directBranch(repo, targetRef);
    if (source !== current.head)
      throw new BranchSwitchError(
        "Actual branch changed during inspection",
        "stale",
      );
    await metadata(repo, current.branch, targetRef, ownedIndexLock);
    const config = await configuration(repo);
    const sourceTree = await tree(repo, source),
      targetTree = await tree(repo, target);
    const index = await git(repo.root, ["ls-files", "--stage", "-z"]);
    const entries: TreeEntry[] = [];
    for (const record of exactText(index).split("\0").filter(Boolean)) {
      const match = /^(100644|100755) ([a-f0-9]{40,64}) 0\t([\s\S]+)$/.exec(
        record,
      );
      if (!match)
        throw new BranchSwitchError(
          "Only regular non-conflicted staged files are supported",
        );
      entries.push({ mode: match[1]!, oid: match[2]!, path: match[3]! });
    }
    const paths = exactText(
      await git(repo.root, [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ]),
    )
      .split("\0")
      .filter(Boolean);
    const dirty = await status(repo),
      linked = await worktrees(repo, targetRef, this.options.repositories);
    const refs = await git(repo.root, [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(symref)",
    ]);
    const rawIndex = await readIndexBytes(repo.gitDir);
    const sources = await sourceStamp(
      repo,
      [
        ...new Set([
          ...paths,
          ...sourceTree.map((entry) => entry.path),
          ...targetTree.map((entry) => entry.path),
        ]),
      ],
      source.length === 64 ? "sha256" : "sha1",
    );
    // Status is a presentation aid, not authority: stat-cache settings can hide
    // changed bytes. Compare the raw blob/mode to every actual index entry too.
    for (const entry of entries) {
      const actual = sources.files.get(entry.path);
      if (
        (!actual || actual.oid !== entry.oid || actual.mode !== entry.mode) &&
        !dirty.unstaged.includes(entry.path)
      )
        dirty.unstaged.push(entry.path);
    }
    dirty.unstaged.sort();
    const identities = [];
    for (const path of [
      repo.root,
      repo.gitDir,
      repo.commonDir,
      join(repo.gitDir, "HEAD"),
    ]) {
      const identity = await lstat(path, { bigint: true });
      identities.push([path, String(identity.dev), String(identity.ino)]);
    }
    const stamp = fingerprint([
      identities,
      current.root,
      current.gitDir,
      current.commonDir,
      current.branch,
      source,
      targetRef,
      target,
      config.toString("base64"),
      index.toString("base64"),
      rawIndex?.toString("base64"),
      refs.toString("base64"),
      linked.raw,
      dirty,
      sources.stamp,
    ]);
    await validateIdentity(repo, { branch: current.branch, head: source });
    return {
      from: { branch: current.branch, head: source },
      target: { branch: targetRef, head: target },
      dirty,
      ...(linked.occupied ? { occupied: linked.occupied } : {}),
      stamp,
    };
  }
  async preview(
    repositoryId: string,
    request: BranchSwitchPreviewRequest,
  ): Promise<BranchSwitchPreview> {
    if (this.options.queue.isBusy(repositoryId))
      throw new BranchSwitchError(
        "A Git operation is already pending; wait before switching",
        "busy",
      );
    return this.options.queue.run(repositoryId, async () => {
      const { repository: repo, observation } = await this.access(
        repositoryId,
        request.reviewId,
      );
      if (observation.historical)
        throw new BranchSwitchError(
          "Historical reviews cannot authorize switching",
          "stale",
        );
      const first = await this.snapshot(repo, request.targetRef);
      const observed = observation.worktree ?? observation;
      if (
        observed.head !== first.from.head ||
        observed.branch !== first.from.branch
      )
        throw new BranchSwitchError(
          "Actual checkout changed; refresh and select again",
          "stale",
        );
      const staged = await getReview(repo, first.from.head, "staged");
      const after = await this.snapshot(repo, request.targetRef);
      if (first.stamp !== after.stamp)
        throw new BranchSwitchError(
          "Repository changed during inspection; refresh and select again",
          "stale",
        );
      const expires = this.now() + TTL;
      const preview: BranchSwitchPreview = {
        previewId: randomUUID(),
        expiresAt: new Date(expires).toISOString(),
        repositoryId,
        reviewId: request.reviewId,
        from: after.from,
        target: after.target,
        dirty: after.dirty,
        status:
          after.from.branch === after.target.branch
            ? "same-branch"
            : after.occupied
              ? "occupied"
              : isDirty(after.dirty)
                ? "dirty"
                : "clean",
        ...(after.occupied ? { occupied: after.occupied } : {}),
      };
      this.options.repositories.set(repositoryId, {
        ...repo,
        branch: after.from.branch,
        head: after.from.head,
      });
      for (const [id, plan] of this.plans)
        if (plan.expires <= this.now()) this.plans.delete(id);
      this.plans.set(preview.previewId, {
        preview,
        snapshot: after,
        staged,
        expires,
      });
      while (this.plans.size > 128)
        this.plans.delete(this.plans.keys().next().value!);
      return preview;
    });
  }
  private async safeStash(
    repo: Repository,
    plan: Plan,
    check: () => Promise<void>,
  ): Promise<BranchSwitchStash> {
    // Stash's cleanup resets HEAD files even if a staged deletion has turned
    // their replacements into ignored files. Inspect only those bounded source
    // paths, rather than walking unrelated ignored dependency directories.
    const deleted = exactText(
      await git(repo.root, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--cached",
        "--name-only",
        "--diff-filter=D",
        "-z",
        plan.snapshot.from.head,
        "--",
      ]),
    )
      .split("\0")
      .filter(Boolean);
    if (deleted.length > PATH_LIMIT)
      throw new BranchSwitchError(
        "Stash source paths exceed the safe inspection limit",
      );
    const replacements: string[] = [];
    for (const path of deleted) {
      checkedPath(path);
      const replacement = await optionalStat(join(repo.root, path));
      if (!replacement) continue;
      if (!replacement.isFile())
        throw new BranchSwitchError(
          "Stash cannot preserve a replaced source path removed from the index; save it with Git before switching",
        );
      replacements.push(path);
    }
    for (let start = 0; start < replacements.length; start += 128) {
      const ignored = await git(repo.root, [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "-z",
        "--",
        ...replacements.slice(start, start + 128),
      ]);
      if (ignored.length)
        throw new BranchSwitchError(
          "Stash cannot preserve ignored files removed from the index; move or save them with Git before switching",
        );
    }
    // Porcelain stash converts worktree content through attributes. Refuse byte
    // transformations so the saved worktree/index/untracked trees are recoverable.
    let autocrlf = "false";
    try {
      autocrlf = await gitText(repo.root, ["config", "--get", "core.autocrlf"]);
    } catch {}
    if (!/^(false|no|off|0)$/i.test(autocrlf))
      throw new BranchSwitchError(
        "Stash requires a repository without automatic line-ending conversion; save this work with Git",
      );
    const paths = [...new Set(Object.values(plan.snapshot.dirty).flat())];
    if (paths.length) {
      const attrs = exactText(
        await git(repo.root, [
          "check-attr",
          "-z",
          "text",
          "eol",
          "ident",
          "filter",
          "working-tree-encoding",
          "--",
          ...paths,
        ]),
      ).split("\0");
      for (let i = 0; i + 2 < attrs.length; i += 3)
        if (!["unspecified", "unset"].includes(attrs[i + 2]!))
          throw new BranchSwitchError(
            "Stash byte conversion attributes are unsupported; save this work with Git",
          );
    }
    await validateWriteDestinations(repo, {
      objects: true,
      branch: plan.snapshot.from.branch,
    });
    const message = `agent-review branch switch ${plan.preview.previewId} from ${plan.snapshot.from.branch}`;
    await check();
    let failure: unknown;
    try {
      await writeBranchGit(repo, [
        "stash",
        "push",
        "--include-untracked",
        "--message",
        message,
      ]);
    } catch (error) {
      failure = error;
    }
    let oid = "",
      subject = "";
    try {
      oid = await gitText(repo.root, [
        "rev-parse",
        "--verify",
        "refs/stash^{commit}",
      ]);
      subject = await gitText(repo.root, ["show", "-s", "--format=%s", oid]);
    } catch {}
    if (!/^[a-f0-9]{40,64}$/.test(oid) || !subject.endsWith(": " + message)) {
      throw new BranchSwitchError(
        "Stash could not be verified; inspect the worktree and stash list before retrying",
        "git-refused",
        409,
        { outcome: "uncertain" },
      );
    }
    const stash = { oid, sourceBranch: plan.snapshot.from.branch, message };
    if (
      (await gitText(repo.root, ["rev-parse", `${oid}^1`])) !==
      plan.snapshot.from.head
    )
      throw new BranchSwitchError(
        "Saved stash has an unexpected source; inspect it before retrying",
        "stale",
        409,
        { stash, outcome: "uncertain" },
      );
    if (failure)
      throw new BranchSwitchError(
        "Work was saved to a stash, but Git could not finish cleaning the source worktree; inspect it before retrying",
        "git-refused",
        409,
        { stash },
      );
    return stash;
  }
  async execute(
    repositoryId: string,
    request: BranchSwitchRequest,
  ): Promise<BranchSwitchResult> {
    if (this.options.queue.isBusy(repositoryId))
      throw new BranchSwitchError(
        "A Git operation is already pending; wait before switching",
        "busy",
      );
    return this.options.queue.run(repositoryId, async () => {
      const plan = this.plans.get(request.previewId);
      if (
        !plan ||
        plan.preview.repositoryId !== repositoryId ||
        plan.expires <= this.now()
      )
        throw new BranchSwitchError(
          "Switch preview expired or is unavailable; select the branch again",
          "stale",
        );
      this.plans.delete(request.previewId);
      const { repository: repo, observation } = await this.access(
        repositoryId,
        plan.preview.reviewId,
      );
      if (observation.historical)
        throw new BranchSwitchError(
          "Historical reviews cannot authorize switching",
          "stale",
        );
      const check = async (ownedIndexLock = false) => {
        const current = await this.snapshot(
          repo,
          plan.preview.target.branch,
          ownedIndexLock,
        );
        if (current.stamp !== plan.snapshot.stamp)
          throw new BranchSwitchError(
            "Branch-switch context changed; refresh and select again",
            "stale",
          );
      };
      await check();
      if (plan.preview.status === "same-branch")
        return {
          ok: true,
          outcome: "same-branch",
          branch: plan.snapshot.from.branch,
          head: plan.snapshot.from.head,
        };
      if (plan.snapshot.occupied)
        throw new BranchSwitchError(
          "This branch is checked out in another worktree; open its registered worktree instead",
          "occupied",
        );
      if (request.strategy === "clean" && isDirty(plan.snapshot.dirty))
        throw new BranchSwitchError(
          "Choose Stash & switch, Commit & switch, or Cancel to preserve your uncommitted work",
          "dirty",
        );
      if (request.strategy !== "clean" && request.confirmed !== true)
        throw new BranchSwitchError(
          "Confirm the chosen save operation before switching",
          "unsupported",
          400,
        );
      let stash: BranchSwitchStash | undefined, commit: string | undefined;
      let checkoutAttempted = false;
      try {
        if (request.strategy === "stash" && isDirty(plan.snapshot.dirty))
          stash = await this.safeStash(repo, plan, check);
        if (request.strategy === "commit") {
          const selection = request.commit;
          if (
            !selection ||
            !selection.message.trim() ||
            selection.message.length > 8192 ||
            selection.message.includes("\0") ||
            !selection.paths.length ||
            selection.paths.length > 128 ||
            new Set(selection.paths).size !== selection.paths.length ||
            selection.paths.some(
              (path) => !plan.snapshot.dirty.staged.includes(path),
            )
          )
            throw new BranchSwitchError(
              "Select staged files and enter a non-empty commit message",
              "unsupported",
              400,
            );
          // commitSelected owns and verifies the index lock throughout this callback.
          const result = await commitSelected(
            repo,
            plan.staged,
            selection.paths,
            selection.message,
            () => check(true),
          );
          commit = result.commit;
        }
        const saved = stash || commit;
        const after = saved
          ? await this.snapshot(repo, plan.preview.target.branch)
          : plan.snapshot;
        if (
          after.from.branch !== plan.snapshot.from.branch ||
          after.target.head !== plan.snapshot.target.head ||
          after.from.head !== (commit ?? plan.snapshot.from.head)
        )
          throw new BranchSwitchError(
            "Branch identity changed after saving; inspect the saved work before retrying",
            "stale",
          );
        if (isDirty(after.dirty))
          throw new BranchSwitchError(
            commit
              ? "Selected staged files were committed; remaining edits need a new Stash & switch or Cancel decision"
              : "Work was saved, but the worktree still has changes; inspect it before a new switch decision",
            "remaining-dirty",
            409,
            { remainingDirty: after.dirty },
          );
        if (after.occupied)
          throw new BranchSwitchError(
            "Target branch became occupied by another worktree",
            "occupied",
          );
        // The final stamp is repeated immediately before Git. This is not an atomic
        // defense against an adversarial external filesystem writer; normal Git
        // no-force/index-lock checks are the final protection against lost work.
        const immediate = await this.snapshot(repo, plan.preview.target.branch);
        if (immediate.stamp !== after.stamp)
          throw new BranchSwitchError(
            "Repository changed before checkout; select again",
            "stale",
          );
        try {
          checkoutAttempted = true;
          await writeBranchGit(repo, [
            "switch",
            "--no-guess",
            "--no-recurse-submodules",
            "--no-overwrite-ignore",
            "--",
            plan.preview.target.branch.slice("refs/heads/".length),
          ]);
        } catch {
          let unchanged = false,
            actual: BranchSwitchFailure["actual"];
          try {
            const stopped = await this.snapshot(
              repo,
              plan.preview.target.branch,
            );
            unchanged = stopped.stamp === immediate.stamp;
            actual = { ...stopped.from, dirty: stopped.dirty };
          } catch {
            try {
              const current = await validateIdentity(repo);
              actual = { branch: current.branch, head: current.head };
            } catch {}
          }
          throw new BranchSwitchError(
            unchanged
              ? "Git refused the switch; inspect local changes, ignored-file collisions or locks before trying again"
              : "Git stopped during checkout; refresh the actual worktree and inspect the saved work before retrying",
            "git-refused",
            409,
            {
              outcome: unchanged
                ? saved
                  ? "saved-not-switched"
                  : "not-switched"
                : "uncertain",
              ...(actual ? { actual } : {}),
            },
          );
        }
        const final = await validateIdentity(repo);
        if (
          final.branch !== plan.snapshot.target.branch ||
          final.head !== plan.snapshot.target.head
        )
          throw new BranchSwitchError(
            "Checkout outcome could not be verified; refresh actual worktree state before retrying",
            "stale",
            409,
            { outcome: "uncertain" },
          );
        this.options.repositories.set(repositoryId, final);
        return {
          ok: true,
          outcome: "switched",
          branch: final.branch,
          head: final.head,
          ...(stash ? { stash } : {}),
          ...(commit ? { commit } : {}),
        };
      } catch (error) {
        let verifiedActual: BranchSwitchFailure["actual"];
        if (
          checkoutAttempted ||
          stash ||
          commit ||
          (error instanceof BranchSwitchError &&
            error.recovery.outcome === "uncertain")
        ) {
          try {
            const current = await validateIdentity(repo);
            this.options.repositories.set(repositoryId, current);
            verifiedActual = { branch: current.branch, head: current.head };
            if (error instanceof BranchSwitchError)
              error.recovery.actual ??= verifiedActual;
          } catch {
            if (error instanceof BranchSwitchError)
              error.recovery.outcome = "uncertain";
          }
        }
        if (error instanceof BranchSwitchError) {
          if (checkoutAttempted && error.recovery.outcome === undefined)
            error.recovery.outcome = "uncertain";
          error.recovery = {
            ...(stash ? { stash } : {}),
            ...(commit ? { commit } : {}),
            ...error.recovery,
          };
          throw error;
        }
        throw new BranchSwitchError(
          "Switching stopped; inspect the current worktree before trying again",
          "git-refused",
          409,
          {
            ...(checkoutAttempted ? { outcome: "uncertain" } : {}),
            ...(verifiedActual ? { actual: verifiedActual } : {}),
            ...(stash ? { stash } : {}),
            ...(commit ? { commit } : {}),
          },
        );
      }
    });
  }
}
