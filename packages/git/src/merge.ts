import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Repository } from "../../shared/src/index.js";
import type { MergeState } from "../../shared/src/sync.js";
import { git, gitText, safeStat, validPath } from "./git.js";
import { executionStamp } from "../../agents/src/target.js";
import {
  GitActionError,
  indexEntries,
  validateIdentity,
  validateWriteDestinations,
  writeMergeGit,
} from "./mutations.js";
import { StaleReviewError } from "./review.js";
import { getComparisonDestinations } from "./comparison-destinations.js";
import { getRemotes, readRemoteConfiguration } from "./remotes.js";
const controls = [
  "HEAD",
  "ORIG_HEAD",
  "MERGE_HEAD",
  "MERGE_MSG",
  "MERGE_MODE",
  "AUTO_MERGE",
  "MERGE_AUTOSTASH",
  "SQUASH_MSG",
  "index",
  "logs/ORIG_HEAD",
  "logs/AUTO_MERGE",
];
const otherOperations = [
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "BISECT_START",
  "rebase-merge",
  "rebase-apply",
  "sequencer",
];
const stale = () =>
  new GitActionError(
    "Repository state changed; refresh and preview again",
    409,
  );
async function stat(path: string) {
  try {
    return await lstat(path, { bigint: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
async function control(
  repo: Repository,
  name: string,
  directory = repo.gitDir,
): Promise<Buffer | null> {
  const path = join(directory, name),
    before = await stat(path);
  if (!before) return null;
  if (
    !before.isFile() ||
    before.nlink !== 1n ||
    before.size > 16n * 1024n * 1024n ||
    (await realpath(path)) !== path
  )
    throw new GitActionError(
      "Git metadata contains an unsafe alias or shared write destination",
      409,
    );
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat({ bigint: true });
    if (current.ino !== before.ino || current.dev !== before.dev) throw stale();
    const bytes = await handle.readFile();
    const after = await stat(path);
    if (!after || after.ino !== before.ino || after.ctimeNs !== before.ctimeNs)
      throw stale();
    return bytes;
  } finally {
    await handle.close();
  }
}
/** Raw bytes are authority: Git status alone can hide modifications through stat-cache settings. */
async function rawIndexState(repo: Repository) {
  const entries = await indexEntries(repo),
    dirty: string[] = [],
    hash = createHash("sha256");
  if (entries.length > 20000)
    throw new GitActionError(
      "Index exceeds the safe merge inspection limit",
      409,
    );
  let bytes = 0;
  for (const entry of entries) {
    if (entry.stage !== 0) continue;
    if (!["100644", "100755"].includes(entry.mode) || entry.intentToAdd)
      throw new GitActionError(
        "Unsupported index entries require merging with Git",
        409,
      );
    const before = await safeStat(repo.root, entry.path);
    hash.update(entry.path + "\0");
    if (!before) {
      dirty.push(entry.path);
      hash.update("missing");
      continue;
    }
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      bytes + Number(before.size) > 64 * 1024 * 1024
    )
      throw new GitActionError(
        "Shared files, symlinks or an oversized worktree require merging with Git",
        409,
      );
    const handle = await open(
      join(repo.root, entry.path),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const opened = await handle.stat({ bigint: true });
      if (
        opened.ino !== before.ino ||
        opened.dev !== before.dev ||
        opened.ctimeNs !== before.ctimeNs
      )
        throw stale();
      const buffer = Buffer.alloc(Number(before.size) + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          length,
          buffer.length - length,
          length,
        );
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== Number(before.size)) throw stale();
      const content = buffer.subarray(0, length);
      bytes += length;
      hash.update(content);
      const oid = createHash(entry.oid.length === 64 ? "sha256" : "sha1")
        .update(`blob ${length}\0`)
        .update(content)
        .digest("hex");
      const mode = before.mode & 0o111n ? "100755" : "100644";
      if (oid !== entry.oid || mode !== entry.mode) dirty.push(entry.path);
      const after = await safeStat(repo.root, entry.path);
      if (
        !after ||
        after.ino !== before.ino ||
        after.dev !== before.dev ||
        after.ctimeNs !== before.ctimeNs
      )
        throw stale();
    } finally {
      await handle.close();
    }
  }
  return { dirty, stamp: hash.digest("hex") };
}
export async function readMergeState(repo: Repository): Promise<MergeState> {
  await validateIdentity(repo);
  const heads = await control(repo, "MERGE_HEAD");
  const mergeHeads = heads ? heads.toString("utf8").trim().split("\n") : [];
  if (mergeHeads.some((h) => !/^[a-f0-9]{40,64}$/.test(h)))
    throw new GitActionError(
      "Merge bookkeeping cannot be verified; use Git directly",
      409,
    );
  const raw = (await git(repo.root, ["ls-files", "--unmerged", "-z"]))
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const conflicts = [
    ...new Set(raw.map((row) => row.slice(row.indexOf("\t") + 1))),
  ].sort();
  const unstaged =
    (await git(repo.root, ["diff-files", "--name-only", "-z"])).length > 0;
  const untracked =
    (await git(repo.root, ["ls-files", "--others", "--exclude-standard", "-z"]))
      .length > 0;
  const pending = mergeHeads.length > 0;
  const rawDirty =
    pending && !conflicts.length
      ? (await rawIndexState(repo)).dirty.length > 0
      : false;
  const canContinue =
    pending && !conflicts.length && !unstaged && !untracked && !rawDirty;
  return {
    pending,
    mergeHeads,
    conflicts,
    canContinue,
    reason: !pending
      ? null
      : conflicts.length
        ? "Resolve each conflict and stage its resolution with Git before continuing"
        : unstaged || untracked || rawDirty
          ? "Stage resolved changes and commit, stash or discard unrelated work with Git before continuing"
          : null,
  };
}
async function effectiveAttributes(repo: Repository, paths: string[]) {
  const sorted = [...new Set(paths)].sort(),
    hash = createHash("sha256");
  for (let at = 0; at < sorted.length; at += 128) {
    const bytes = await git(repo.root, [
      "check-attr",
      "--all",
      "-z",
      "--",
      ...sorted.slice(at, at + 128),
    ]);
    hash.update(bytes);
    const fields = bytes.toString("utf8").split("\0").filter(Boolean);
    if (fields.length % 3)
      throw new GitActionError("Effective attributes cannot be verified", 409);
    for (let index = 0; index < fields.length; index += 3)
      if (
        ["merge", "filter", "working-tree-encoding"].includes(
          fields[index + 1]!,
        )
      )
        throw new GitActionError(
          "Effective merge, filter or encoding attributes require merging with Git",
          409,
        );
  }
  return hash.digest("hex");
}
export async function mergeSnapshot(
  repo: Repository,
  allowMerge: boolean,
  extraPaths: string[] = [],
) {
  const identity = await validateIdentity(repo);
  if (!identity.branch?.startsWith("refs/heads/"))
    throw new GitActionError(
      "Pull requires an actual checked-out local branch; detached HEAD is unsupported",
      409,
    );
  await validateWriteDestinations(repo, {
    objects: true,
    branch: identity.branch,
  });
  const controlsHash = createHash("sha256");
  controlsHash.update(
    (await control(repo, "info/attributes", repo.commonDir)) ??
      "missing-attributes",
  );
  for (const name of controls) {
    controlsHash.update(name);
    controlsHash.update((await control(repo, name)) ?? "missing");
    if (await stat(join(repo.gitDir, name + ".lock")))
      throw new GitActionError(
        "Another Git operation holds a lock; finish it before merging",
        409,
      );
  }
  for (const name of otherOperations)
    if (await stat(join(repo.gitDir, name)))
      throw new GitActionError(
        "Finish the current rebase, cherry-pick, revert or bisect before merging",
        409,
      );
  for (const name of ["ORIG_HEAD", "AUTO_MERGE", identity.branch]) {
    try {
      await git(repo.root, ["symbolic-ref", "--quiet", "--no-recurse", name]);
      throw new GitActionError(
        "Symbolic merge bookkeeping or branch aliases are unsupported",
        409,
      );
    } catch (e) {
      if ((e as { code?: number }).code !== 1) throw e;
    }
  }
  if (
    (await control(repo, "HEAD"))?.toString("utf8") !==
    `ref: ${identity.branch}\n`
  )
    throw stale();
  if (await control(repo, "MERGE_AUTOSTASH"))
    throw new GitActionError(
      "A merge autostash is pending; finish it with Git before continuing",
      409,
    );
  const merge = await readMergeState(repo);
  if (!allowMerge && (merge.pending || merge.conflicts.length))
    throw new GitActionError(
      "A merge or unresolved index conflicts are pending; resolve and continue or explicitly abort first",
      409,
    );
  const config = await readRemoteConfiguration(repo);
  for (const [key, values] of config.values)
    if (
      (/^merge\..*\.driver$/.test(key) && values.some(Boolean)) ||
      (/^filter\..*\.(clean|smudge|process)$/.test(key) &&
        values.some(Boolean)) ||
      (["core.sparsecheckout", "core.sparsecheckoutcone"].includes(key) &&
        values.some((v) => !/^(false|no|off|0)$/i.test(v))) ||
      key === "core.alternaterefscommand" ||
      (/^branch\..*\.mergeoptions$/.test(key) && values.some(Boolean))
    )
      throw new GitActionError(
        "Custom merge drivers, branch merge options, filters, sparse checkouts or executable ref helpers require merging with Git",
        409,
      );
  const tagged = (await git(repo.root, ["ls-files", "-v", "-z"]))
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  if (tagged.some((row) => !row.startsWith("H ") && !row.startsWith("M ")))
    throw new GitActionError(
      "Unsupported index flags or sparse entries; use Git directly",
      409,
    );
  const paths = (
    await git(repo.root, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ])
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  if (paths.length > 20000)
    throw new GitActionError(
      "Worktree exceeds the safe merge inspection limit",
      409,
    );
  for (const path of new Set(paths)) {
    validPath(path);
    if (
      path
        .split("/")
        .some((p) => p.toLowerCase() === ".git" || p.includes("\\")) ||
      /[\x00-\x1f\x7f]/.test(path)
    )
      throw new GitActionError(
        "Unsafe worktree paths require merging with Git",
        409,
      );
    const s = await safeStat(repo.root, path);
    if (s && (!s.isFile() || s.nlink !== 1n))
      throw new GitActionError(
        "Symlinks, hard-linked files and submodules require merging with Git",
        409,
      );
    controlsHash.update(path);
    controlsHash.update(
      JSON.stringify(
        s
          ? [
              String(s.dev),
              String(s.ino),
              String(s.mode),
              String(s.size),
              String(s.mtimeNs),
              String(s.ctimeNs),
            ]
          : null,
      ),
    );
  }
  controlsHash.update(
    await effectiveAttributes(repo, [...paths, ...extraPaths]),
  );
  const rawState = await rawIndexState(repo);
  controlsHash.update(rawState.stamp);
  const status = await git(repo.root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=none",
    "--no-renames",
  ]);
  const stamp = createHash("sha256")
    .update(await executionStamp(repo))
    .update(controlsHash.digest())
    .update(status)
    .digest("hex");
  await validateIdentity(repo, identity);
  return { identity, merge, stamp, config, status, rawDirty: rawState.dirty };
}
export async function trackingComparison(repo: Repository, ref: string) {
  if (
    !ref.startsWith("refs/remotes/") ||
    ref.length > 4096 ||
    /[\x00-\x20\x7f]/.test(ref)
  )
    throw new GitActionError(
      "Select an exact configured remote-tracking comparison branch",
    );
  try {
    await git(repo.root, ["check-ref-format", ref]);
  } catch {
    throw new GitActionError(
      "Select a valid configured remote-tracking comparison branch",
    );
  }
  const config = await readRemoteConfiguration(repo),
    destinations = await getComparisonDestinations(repo, config.values);
  const selected = destinations.find((d) => d.trackingRef === ref);
  if (!selected)
    throw new GitActionError(
      "Comparison must be a direct branch mapped to one configured remote",
    );
  const remote = (await getRemotes(repo)).find(
    (r) => r.name === selected.remote,
  );
  if (!remote?.fetchAvailable)
    throw new GitActionError(
      remote?.reason ?? "Comparison remote is unavailable",
    );
  const row = (
    await gitText(repo.root, [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)",
      ref,
    ])
  )
    .split("\n")
    .map((s) => s.split("\0"))
    .find((r) => r[0] === ref);
  if (
    !row ||
    row[2] !== "commit" ||
    row[3] ||
    !/^[a-f0-9]{40,64}$/.test(row[1] ?? "")
  )
    throw new GitActionError(
      "Comparison must identify an existing direct commit branch",
    );
  return { remote: selected.remote, head: row[1]! };
}
async function inspectTree(repo: Repository, head: string) {
  const rows = (await git(repo.root, ["ls-tree", "-rz", "--full-tree", head]))
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  if (rows.length > 20000)
    throw new GitActionError("Comparison tree exceeds the safe merge limit");
  const paths: string[] = [];
  for (const row of rows) {
    const match = /^(100644|100755) blob [a-f0-9]{40,64}\t([\s\S]+)$/.exec(row);
    if (!match)
      throw new GitActionError(
        "Symlinks and submodules require merging with Git",
      );
    const path = match[2]!;
    paths.push(path);
    validPath(path);
    if (
      path
        .split("/")
        .some((p) => p.toLowerCase() === ".git" || p.includes("\\")) ||
      /[\x00-\x1f\x7f]/.test(path)
    )
      throw new GitActionError("Comparison has unsupported paths");
    const s = await safeStat(repo.root, path);
    if (s && !s.isFile())
      throw new GitActionError(
        "Comparison write paths are unsafe; use Git directly",
      );
    if (path.split("/").at(-1) === ".gitattributes") {
      const attrs = (
        await git(repo.root, ["show", `${head}:${path}`])
      ).toString("utf8");
      if (/(?:^|\s)[-!]?(?:merge|filter)(?:=|\s|$)/m.test(attrs))
        throw new GitActionError(
          "Custom merge or filter attributes require merging with Git",
        );
    }
  }
  return paths;
}
export async function preparePull(
  repo: Repository,
  ref: string,
  expected?: string,
) {
  const comparison = await trackingComparison(repo, ref);
  const identity = await validateIdentity(repo);
  const paths = [
    ...(await inspectTree(repo, identity.head)),
    ...(await inspectTree(repo, comparison.head)),
  ];
  const snapshot = await mergeSnapshot(repo, false, paths);
  if (expected !== undefined && snapshot.stamp !== expected) throw stale();
  if (snapshot.status.length || snapshot.rawDirty.length)
    throw new GitActionError(
      "Pull is blocked by local work. Commit, stash or discard changes explicitly with Git, then refresh and preview again",
      409,
    );
  return { ...snapshot, comparison };
}

export async function applyPull(
  repo: Repository,
  ref: string,
  expected: string,
  comparisonHead: string,
) {
  const current = await preparePull(repo, ref, expected);
  if (current.stamp !== expected || current.comparison.head !== comparisonHead)
    throw stale();
  try {
    await writeMergeGit(repo, "pull", comparisonHead);
  } catch (e) {
    const state = await readMergeState(repo);
    if (state.pending && state.conflicts.length) return "conflicts" as const;
    throw e;
  }
  const state = await readMergeState(repo);
  if (state.pending) return "conflicts" as const;
  return "merged" as const;
}
export async function prepareMerge(
  repo: Repository,
  action: "continue" | "abort",
) {
  const snapshot = await mergeSnapshot(repo, true);
  if (!snapshot.merge.pending)
    throw new GitActionError(
      "No merge is pending; refresh before previewing",
      409,
    );
  if (action === "continue" && !snapshot.merge.canContinue)
    throw new GitActionError(
      snapshot.merge.reason ?? "Stage all resolutions before continuing",
      409,
    );
  if (action === "continue")
    for (const key of ["user.name", "user.email"]) {
      let value = "";
      try {
        value = await gitText(repo.root, ["config", "--get", key]);
      } catch {}
      if (!value.trim() || /[\x00-\x1f<>]/.test(value))
        throw new GitActionError(
          "Configure Git user.name and user.email before continuing",
        );
    }
  return snapshot;
}
export async function applyMerge(
  repo: Repository,
  action: "continue" | "abort",
  expected: string,
) {
  const guard = await mergeSnapshot(repo, true);
  if (guard.stamp !== expected) throw stale();
  const current = await prepareMerge(repo, action);
  if (current.stamp !== expected) throw stale();
  await writeMergeGit(repo, action);
  if ((await readMergeState(repo)).pending)
    throw new GitActionError(
      "Merge is still pending; refresh and inspect it with Git",
      409,
    );
  return action === "continue" ? ("continued" as const) : ("aborted" as const);
}
